"""Train the student: Qwen3.5 2B with a Clef decision head, on the teacher's probabilities.

Runs on Apple Silicon through Unsloth's MLX trainer, in model/.venv-train. That
environment is pinned in model/requirements-train.txt, copied from the Unsloth
app's own setup so an app update can't change it mid-project.

The base model gets LoRA adapters (rank 16) and a fresh joint head that scores
every question's options from one prompt. The gold answers are the teacher's
full probabilities, so the student learns how sure the teacher was. Training
reads model/private/rows/train.jsonl and checks itself on valid.jsonl, which
holds every pair with a held-out job or a held-out resume.

  model/.venv-train/bin/python model/train_student.py --smoke                    # 20 steps on a few rows
  model/.venv-train/bin/python model/train_student.py --smoke --resume --steps 24  # resume the smoke run
  caffeinate -is model/.venv-train/bin/python model/train_student.py --name run1   # a full run

The smoke run saves and evaluates every 10 steps, so the full run's checkpoint,
evaluation and resume paths are all tried in minutes first. Each full run gets
its own folder under model/private/student/, so a retrain never overwrites the
model an earlier grade came from.

--laya trains Laya instead, an mmBERT encoder with a decision head that already
picks from options. It is about a twentieth of the 2B's working size (LEARNING.md,
lesson 19). It reads each question in its own pass, so its rows become one item
per question, and LoRA goes on the encoder:

  model/.venv-train/bin/python model/train_student.py --laya --smoke
  caffeinate -is model/.venv-train/bin/python model/train_student.py --laya --name laya1
"""

import argparse
import hashlib
import json
import shutil
import time
from pathlib import Path

from label_pairs import refuse_if_labeling

ROOT = Path(__file__).resolve().parent.parent
ROWS = ROOT / "model/private/rows"
OUT = ROOT / "model/private/student"
BASE = "unsloth/Qwen3.5-2B"
BASE_REVISION = "fffbc0d8711cf87df6d1f97938c5e50ef94aadc7"  # the exact commit downloaded on 2026-10-16
LAYA = "convaiinnovations/laya"
LAYA_SUBFOLDER = "multilingual"  # the variant the Unsloth app downloaded, built on mmBERT-base
LAYA_REVISION = "7b928d828b7b0e022f929d9bd2e44165aa270148"  # the commit the app downloaded on 2026-10-18
MAX_SKIPPED = 0.02  # share of answers the dataset builder may skip before the run stops
# MLX settings for Laya runs. The first full run stopped after about 270 steps on Metal's limit of
# 499,000 buffers. Laya's many short batches come in thousands of padded lengths. MLX compiles each
# of the step's 47 functions again for every new length, and keeps every trace. It also keeps freed
# buffers by size for reuse, and the trainer lets that cache grow to peak memory. So Laya trains
# uncompiled, with a 4 GB cache cap. A Clef keeps the trainer's defaults, as run1 did.
LAYA_MLX = {"compile_mode": "eager", "cache_limit_gb": 4}


def model_settings(args):
    """What a run trains: a Clef on --base by default, or the pinned Laya with --laya.

    A Clef item is a whole row, so 2 x 4 items make 8 rows a step. A Laya item is one question,
    about 8.5 to a row, so 4 x 8 items make about 4 rows a step. Laya defaults to 8,192 tokens,
    its encoder's limit. Batches pad only to their longest item, so the limit costs no training
    time. It is saved with the model, so grading and serving read whole test inputs too.
    """
    if args.laya:
        if args.four_bit:
            raise SystemExit("Laya trains in 16-bit only, so --four-bit doesn't apply.")
        if args.base or args.revision:
            raise SystemExit("--laya trains the pinned Laya checkpoint. Leave out --base and --revision.")
        if args.max_seq and args.max_seq > 8192:
            raise SystemExit("Laya's encoder reads at most 8,192 tokens, so --max-seq can't be larger.")
        return {"kind": "laya", "base": LAYA, "subfolder": LAYA_SUBFOLDER, "revision": LAYA_REVISION,
                "max_seq": args.max_seq or 8192, "batch": 4, "accumulation": 8, "mlx": LAYA_MLX}
    base = args.base or BASE
    return {"kind": "clef", "base": base, "subfolder": None,
            "revision": args.revision or (BASE_REVISION if base == BASE else None),
            "max_seq": args.max_seq or 6144, "batch": 2, "accumulation": 4, "mlx": {}}


def run_folder(args, kind):
    """A full run's own folder, or the smoke folder for its kind, so a Laya smoke run never clears a Clef one."""
    if args.smoke:
        return OUT / ("smoke-laya" if kind == "laya" else "smoke")
    return OUT / args.name


def read_rows(smoke=False, rows_dir=None):
    """The training and validation rows, each file read once, with the hash of the bytes parsed.

    The rows must match the manifest make_rows.py wrote with them. That ties the run to
    the prompt and labels the rows came from, and catches rows changed or half-written since.
    """
    rows_dir = rows_dir or ROWS
    manifest_path = rows_dir / "manifest.json"
    if not manifest_path.exists():
        raise SystemExit(f"No {manifest_path}. Rebuild the rows with python3 model/make_rows.py.")
    manifest = json.loads(manifest_path.read_text())
    rows, sha1 = {}, {}
    for name, limit in (("train", 64), ("valid", 16)):
        data = (rows_dir / f"{name}.jsonl").read_bytes()
        sha1[name] = hashlib.sha1(data).hexdigest()
        if sha1[name] != manifest.get(f"{name}_sha1"):
            raise SystemExit(f"{name}.jsonl doesn't match its manifest. Rebuild the rows with python3 model/make_rows.py.")
        parsed = [json.loads(line) for line in data.decode().splitlines()]
        rows[name] = parsed[:limit] if smoke else parsed
    return rows["train"], rows["valid"], {"sha1": sha1, "manifest": manifest}


def too_many_skipped(report):
    """The builder's report counts skipped answers, about nine per row, against all answers."""
    return report.get("skipped", 0) > MAX_SKIPPED * max(1, report.get("total", 0))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", action="store_true", help="a few steps on 64 rows, to check the setup end to end")
    ap.add_argument("--steps", type=int, help="stop after this many steps (default: 20 with --smoke, else every epoch)")
    ap.add_argument("--name", default="run1", help="the run's folder under model/private/student/")
    ap.add_argument("--resume", action="store_true", help="continue the named run from its last checkpoint")
    ap.add_argument("--epochs", type=float, default=2)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--max-seq", type=int,
                    help="longer prompts are cut from the end of the resume and job (default: 6144, or 8192 with --laya)")
    ap.add_argument("--four-bit", action="store_true",
                    help="train over a 4-bit base. Faster, but the 16-bit merged model then differs from the trained one")
    ap.add_argument("--base", help=f"the language model under the Clef head (default: {BASE})")
    ap.add_argument("--revision", help="the base model's commit (default: the pinned one for the default base)")
    ap.add_argument("--laya", action="store_true", help="train the pinned Laya checkpoint instead of a Clef")
    ap.add_argument("--seed", type=int, default=3407, help="a second run with another seed checks that a result wasn't luck")
    args = ap.parse_args()
    refuse_if_labeling()
    settings = model_settings(args)

    # Settle the run folder before the slow model load.
    out = run_folder(args, settings["kind"])
    if out.exists() and not args.resume:
        if not args.smoke:
            raise SystemExit(f"{out} already exists. Pick a new --name, or pass --resume to continue it.")
        shutil.rmtree(out)  # a fresh smoke run starts clean, so old checkpoints can't be picked up
    if args.resume and not any((out / "checkpoints").glob("checkpoint-*")):
        raise SystemExit(f"No checkpoint to resume in {out / 'checkpoints'}.")
    # The rows are read and checked before the slow load, and a resumed run must see the same rows.
    train_rows, valid_rows, rows = read_rows(args.smoke)
    rows["seed"], rows["kind"] = args.seed, settings["kind"]
    if args.resume and (out / "rows.json").exists():
        started_with = json.loads((out / "rows.json").read_text())
        if started_with["sha1"] != rows["sha1"]:
            raise SystemExit(f"The rows changed since {out.name} started, so it can't resume. Start a new --name.")
        if started_with.get("seed", 3407) != args.seed:
            raise SystemExit(f"{out.name} started with --seed {started_with.get('seed', 3407)}. Resume it with that seed.")
        if started_with.get("kind", "clef") != settings["kind"]:
            raise SystemExit(f"{out.name} started as a {started_with.get('kind', 'clef')} run. "
                             f"Resume it {'with' if started_with.get('kind') == 'laya' else 'without'} --laya.")
    out.mkdir(parents=True, exist_ok=True)
    (out / "rows.json").write_text(json.dumps(rows, indent=2))

    from transformers import TrainingArguments
    from unsloth import DecisionTrainer, FastDecisionModel

    started = time.time()
    # The merged model is always 16-bit. Adapters trained over a 4-bit base answer differently once
    # merged (0.13 in one smoke run), so the default trains over the same 16-bit base that ships.
    # The seed also sets a fresh Clef head's starting weights. Laya's head comes trained.
    model, tokenizer = FastDecisionModel.from_pretrained(settings["base"], subfolder=settings["subfolder"],
                                                         revision=settings["revision"], max_seq_length=settings["max_seq"],
                                                         load_in_4bit=args.four_bit, random_state=args.seed)
    # The kind comes from a flag, so check it against what loaded. A Laya model run as a Clef
    # would train for hours, then fail at the adapters save.
    if getattr(model, "is_clef", False) != (settings["kind"] == "clef"):
        raise SystemExit(f"{settings['base']} loaded as a {'Clef' if getattr(model, 'is_clef', False) else 'Laya'} model. "
                         "Pass --laya for the pinned Laya checkpoint, or point --base at a language model.")
    # Clef: adapters on the language model under a fresh head. Laya: adapters on the encoder, under its trained head.
    model = FastDecisionModel.get_peft_model(model, r=16, lora_alpha=16, lora_dropout=0,
                                             use_gradient_checkpointing="unsloth", random_state=args.seed)
    train_items, train_report = FastDecisionModel.build_dataset(train_rows, tokenizer, model)
    valid_items, valid_report = FastDecisionModel.build_dataset(valid_rows, tokenizer, model)
    print(f"train items: {len(train_items)} {train_report}", flush=True)
    print(f"valid items: {len(valid_items)} {valid_report}", flush=True)
    for name, items, report in (("training", train_items, train_report), ("validation", valid_items, valid_report)):
        if not items:
            raise SystemExit(f"No {name} items were built. Check the report above.")
        if too_many_skipped(report):
            raise SystemExit(f"{report['skipped']} of {report.get('total')} {name} answers were skipped. Check the report above.")

    every = 10 if args.smoke else 100
    training_args = TrainingArguments(
        output_dir=str(out / "checkpoints"),
        per_device_train_batch_size=settings["batch"],
        gradient_accumulation_steps=settings["accumulation"],
        warmup_steps=2 if args.smoke else 10,
        num_train_epochs=args.epochs,
        max_steps=args.steps or (20 if args.smoke else -1),
        learning_rate=args.lr,
        lr_scheduler_type="cosine",
        weight_decay=0.01,
        eval_strategy="steps" if args.smoke else "epoch",
        eval_steps=every,
        save_strategy="steps",
        save_steps=every,
        logging_steps=1 if args.smoke else 10,
        seed=args.seed,
        report_to="none",
    )
    # These aren't TrainingArguments fields, so they can't go in the call above, which would raise.
    # Unsloth copies any attribute named like one of its MLX trainer's settings into that trainer's config.
    for name, value in settings["mlx"].items():
        setattr(training_args, name, value)
    trainer = DecisionTrainer(
        model=model,
        processing_class=tokenizer,
        train_dataset=train_items,
        eval_dataset=valid_items,
        args=training_args,
    )
    # A later Unsloth could stop copying them, and the run would then fail hours in. So check now.
    for name, value in settings["mlx"].items():
        if getattr(trainer.args, name, None) != value:
            raise SystemExit(f"Unsloth's MLX trainer didn't receive {name} = {value!r}. Check its argument conversion.")
    if "cache_limit_gb" in settings["mlx"]:
        # The trainer applies the cap only while it trains, then puts back the limit it found. Calibration
        # scores every validation item afterwards, in as many lengths. Under the default limit, laya1's
        # calibration ran the Mac out of memory. Set here, the cap is also the limit the trainer puts back.
        import mlx.core as mx
        mx.set_cache_limit(int(settings["mlx"]["cache_limit_gb"] * 1e9))
    trainer.train(resume_from_checkpoint=True if args.resume else None)
    # Save the trained model before calibrating, and keep that copy, so the student can also be
    # graded without calibration. A Clef saves its adapters here, so a failed merge can't lose
    # the run. Laya has no adapters-only save, so its copy is merged (about 0.6 GB), and the
    # trainable weights in its last checkpoint are the fallback.
    laya = settings["kind"] == "laya"
    if laya:
        model.save_pretrained_merged(str(out / "merged-uncalibrated"))
    else:
        model.save_pretrained(str(out / "adapters-uncalibrated"))
    metrics = FastDecisionModel.calibrate(model, tokenizer, valid_items)
    print("held-out metrics after calibration:", json.dumps(metrics, default=str), flush=True)
    if not laya:
        model.save_pretrained(str(out / "adapters"))
    model.save_pretrained_merged(str(out / "merged"))
    # Calibration fits temperatures on the validation rows, so record them for the grade.
    temperatures = {k: v for k, v in getattr(model, "decision_config", {}).items() if "temperature" in k}
    # A few validation answers from the model in memory, with their inputs, for student_eval.py --check-reload.
    preview = [{"id": r["id"], "state": r["state"], "questions": r["questions"],
                "answers": FastDecisionModel.predict(model, tokenizer, r["state"], r["questions"])}
               for r in valid_rows[:3]]
    (out / "preview.json").write_text(json.dumps(preview, indent=1, default=str))
    (out / "summary.json").write_text(json.dumps({
        "kind": settings["kind"], "base": settings["base"], "subfolder": settings["subfolder"], "revision": settings["revision"],
        "seed": args.seed, "load_in_4bit": args.four_bit, "epochs": args.epochs, "lr": args.lr, "max_seq": settings["max_seq"],
        "batch": settings["batch"], "accumulation": settings["accumulation"], "mlx": settings["mlx"], "steps": args.steps,
        "train_items": len(train_items), "valid_items": len(valid_items),
        "rows": rows,
        "metrics": metrics, "temperatures": temperatures, "minutes": round((time.time() - started) / 60, 1),
    }, indent=2, default=str))
    print(f"saved to {out} in {(time.time() - started) / 60:.1f} minutes", flush=True)


if __name__ == "__main__":
    main()
