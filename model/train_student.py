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
MAX_SKIPPED = 0.02  # share of answers the dataset builder may skip before the run stops


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
    ap.add_argument("--max-seq", type=int, default=6144, help="longer prompts are cut from the end of the resume and job")
    ap.add_argument("--four-bit", action="store_true",
                    help="train over a 4-bit base. Faster, but the 16-bit merged model then differs from the trained one")
    ap.add_argument("--base", default=BASE)
    ap.add_argument("--revision", default=BASE_REVISION)
    args = ap.parse_args()
    refuse_if_labeling()

    # Settle the run folder before the slow model load.
    out = OUT / ("smoke" if args.smoke else args.name)
    if out.exists() and not args.resume:
        if not args.smoke:
            raise SystemExit(f"{out} already exists. Pick a new --name, or pass --resume to continue it.")
        shutil.rmtree(out)  # a fresh smoke run starts clean, so old checkpoints can't be picked up
    if args.resume and not any((out / "checkpoints").glob("checkpoint-*")):
        raise SystemExit(f"No checkpoint to resume in {out / 'checkpoints'}.")
    # The rows are read and checked before the slow load, and a resumed run must see the same rows.
    train_rows, valid_rows, rows = read_rows(args.smoke)
    if args.resume and (out / "rows.json").exists() and json.loads((out / "rows.json").read_text())["sha1"] != rows["sha1"]:
        raise SystemExit(f"The rows changed since {out.name} started, so it can't resume. Start a new --name.")
    out.mkdir(parents=True, exist_ok=True)
    (out / "rows.json").write_text(json.dumps(rows, indent=2))

    from transformers import TrainingArguments
    from unsloth import DecisionTrainer, FastDecisionModel

    started = time.time()
    # The merged model is always 16-bit. Adapters trained over a 4-bit base answer differently once
    # merged (0.13 in one smoke run), so the default trains over the same 16-bit base that ships.
    model, tokenizer = FastDecisionModel.from_pretrained(args.base, revision=args.revision,
                                                         max_seq_length=args.max_seq, load_in_4bit=args.four_bit)
    model = FastDecisionModel.get_peft_model(model, r=16, lora_alpha=16, lora_dropout=0,
                                             use_gradient_checkpointing="unsloth", random_state=3407)
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
    trainer = DecisionTrainer(
        model=model,
        processing_class=tokenizer,
        train_dataset=train_items,
        eval_dataset=valid_items,
        args=TrainingArguments(
            output_dir=str(out / "checkpoints"),
            per_device_train_batch_size=2,
            gradient_accumulation_steps=4,
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
            seed=3407,
            report_to="none",
        ),
    )
    trainer.train(resume_from_checkpoint=True if args.resume else None)
    # Save the trained adapters first, so a problem in calibration or merging can't lose the run.
    # They stay as they are, so the student can also be graded without calibration later.
    model.save_pretrained(str(out / "adapters-uncalibrated"))
    metrics = FastDecisionModel.calibrate(model, tokenizer, valid_items)
    print("held-out metrics after calibration:", json.dumps(metrics, default=str), flush=True)
    model.save_pretrained(str(out / "adapters"))
    model.save_pretrained_merged(str(out / "merged"))
    # Calibration fits its temperatures to the teacher's top answers, so record them for the grade.
    temperatures = {k: v for k, v in getattr(model, "decision_config", {}).items() if "temperature" in k}
    # A few validation answers from the model in memory, with their inputs, for student_eval.py --check-reload.
    preview = [{"id": r["id"], "state": r["state"], "questions": r["questions"],
                "answers": FastDecisionModel.predict(model, tokenizer, r["state"], r["questions"])}
               for r in valid_rows[:3]]
    (out / "preview.json").write_text(json.dumps(preview, indent=1, default=str))
    (out / "summary.json").write_text(json.dumps({
        "base": args.base, "revision": args.revision, "load_in_4bit": args.four_bit, "epochs": args.epochs,
        "lr": args.lr, "max_seq": args.max_seq, "steps": args.steps, "train_items": len(train_items), "valid_items": len(valid_items),
        "rows": rows,
        "metrics": metrics, "temperatures": temperatures, "minutes": round((time.time() - started) / 60, 1),
    }, indent=2, default=str))
    print(f"saved to {out} in {(time.time() - started) / 60:.1f} minutes", flush=True)


if __name__ == "__main__":
    main()
