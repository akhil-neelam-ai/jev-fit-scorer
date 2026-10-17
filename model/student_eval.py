"""Score the 101 test jobs with the trained student, in the shape the Jev and teacher results use.

The student reads exactly what the extension sends Jev: the state and the
questions come from scoring.js through node. Fit and the scorecard are
probability-weighted, as Jev reports them. So eval/compare-versions.mjs grades
the student with the same cross-validated method as Jev and the teacher:

  model/.venv-train/bin/python model/student_eval.py --model model/private/student/run1/merged
  node eval/compare-versions.mjs --extra eval/private/student-run1 --extra-name student-run1

A results folder belongs to one model and one version of this script. A restart
picks up where it stopped, and results from anything else are refused, because
the grade would silently mix two models. --fresh sets the old folder aside.

Everything runs on this Mac. No resume or job text leaves it.
"""

import argparse
import hashlib
import json
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

from label_pairs import refuse_if_labeling

ROOT = Path(__file__).resolve().parent.parent
PRIVATE = ROOT / "eval/private"
LEVELS = ["Weak", "Moderate", "Strong"]
STAMP = ".run-stamp"  # not .json, because eval/report.mjs reads every .json file in a results folder
RELOAD_TOLERANCE = 0.02


def node(script, payload=None):
    out = subprocess.run(["node", "--input-type=module", "-e", script], cwd=ROOT, input=json.dumps(payload or {}),
                         capture_output=True, text=True)
    if out.returncode:
        raise SystemExit(f"node failed: {out.stderr.strip()[:500]}")
    return json.loads(out.stdout)


def expected(probabilities):
    return sum(int(k) * v for k, v in probabilities.items())


def result_from_answers(answers, questions, criteria):
    """The student's answers in the shape of a Jev result, which is what eval/compare-versions.mjs reads."""
    fit_p = answers["fit"]["probabilities"]
    fit = expected(fit_p)
    scorecard = {}
    for key in [k[len("dim_"):] for k in questions if k.startswith("dim_")]:
        p = answers["dim_" + key]["probabilities"]
        score = expected(p)
        scorecard[key] = {"score": score, "label": LEVELS[max(0, min(2, round(score)))], "confidence": max(p.values())}
    why_p = answers["why"]["probabilities"]
    return {
        "fit": fit, "fitConfidence": max(fit_p.values()), "scorecard": scorecard,
        "fitLabel": criteria[round(fit)], "why": max(why_p, key=why_p.get),
        "visa": answers["visa"]["probabilities"].get("true"),
    }


def model_stamp(model_dir):
    """What ties a results folder to one model and one version of this script."""
    files = sorted(p for p in Path(model_dir).iterdir() if p.is_file())
    return {
        "model": str(Path(model_dir).resolve()),
        "files": {p.name: [p.stat().st_size, int(p.stat().st_mtime)] for p in files},
        "script": hashlib.sha1(Path(__file__).read_bytes()).hexdigest(),
    }


def largest_change(before, after):
    """The largest probability change between two sets of answers. A NaN counts as infinite."""
    worst = 0.0
    for name, answer in before.items():
        for option, p in answer["probabilities"].items():
            change = abs(p - after[name]["probabilities"][option])
            worst = max(worst, change if change == change else float("inf"))
    return worst


def load(model_dir, FastDecisionModel):
    """The model as its run trained it. A run over a 4-bit base is only reproduced by its adapters
    folder loaded in 4-bit, since the merged model is always 16-bit."""
    summary = Path(model_dir).resolve().parent / "summary.json"
    four_bit = json.loads(summary.read_text()).get("load_in_4bit", False) if summary.exists() else False
    model, tokenizer = FastDecisionModel.from_pretrained(model_dir, load_in_4bit=four_bit)
    FastDecisionModel.for_inference(model)
    return model, tokenizer


def check_reload(model_dir, FastDecisionModel):
    """Saving and loading must not change the answers. The run's preview.json holds a few validation
    rows with the answers the trained model gave in memory. The reloaded model must give the same."""
    preview = json.loads((Path(model_dir).resolve().parent / "preview.json").read_text())
    if not preview:
        raise SystemExit("preview.json is empty, so there is nothing to compare.")
    model, tokenizer = load(model_dir, FastDecisionModel)
    worst = max(largest_change(item["answers"], FastDecisionModel.predict(model, tokenizer, item["state"], item["questions"]))
                for item in preview)
    print(f"largest probability change after reload: {worst:.4f} over {len(preview)} rows", flush=True)
    return worst < RELOAD_TOLERANCE


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, help="a student's merged or adapters folder from train_student.py")
    ap.add_argument("--records", default="eval/private/lenny")
    ap.add_argument("--resume", default="eval/private/resume.txt")
    ap.add_argument("--out", help="results folder under eval/private (default: eval/private/student-<run name>)")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--fresh", action="store_true", help="set an existing results folder aside and start over")
    ap.add_argument("--check-reload", action="store_true",
                    help="reload the merged model and compare its answers with the run's preview.json, then stop")
    args = ap.parse_args()
    refuse_if_labeling()

    run = Path(args.model).resolve().parent.name
    out_dir = (ROOT / (args.out or f"eval/private/student-{run}")).resolve()
    # The results name real test jobs, so they stay where git ignores them.
    if not out_dir.is_relative_to(PRIVATE.resolve()):
        raise SystemExit(f"Results must go under {PRIVATE}, which git ignores.")

    from unsloth import FastDecisionModel

    if args.check_reload:
        raise SystemExit(0 if check_reload(args.model, FastDecisionModel) else 1)

    stamp = model_stamp(args.model)
    if args.fresh and out_dir.exists():
        out_dir.rename(out_dir.with_name(f"{out_dir.name}.old-{int(time.time())}"))
    if out_dir.exists() and any(out_dir.glob("*.json")):
        before = json.loads((out_dir / STAMP).read_text()) if (out_dir / STAMP).exists() else None
        if before != stamp:
            raise SystemExit(f"{out_dir} holds results from another model or another version of this script. "
                             "Pass --fresh to set them aside, or --out for a new folder.")
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / STAMP).write_text(json.dumps(stamp, indent=1))

    resume = (ROOT / args.resume).read_text()
    records = [(p, json.loads(p.read_text())) for p in sorted((ROOT / args.records).glob("*.json"))]
    no_text = [p for p, r in records if not (r.get("job") or {}).get("description")]
    records = [(p, r) for p, r in records if (r.get("job") or {}).get("description")]
    done = sum(1 for p, _ in records if (out_dir / p.name).exists())
    todo = [(p, r) for p, r in records if not (out_dir / p.name).exists()]
    if args.limit is not None:
        todo = todo[: max(0, args.limit)]
    print(f"to score: {len(todo)} (already scored: {done} of {len(records)}; "
          f"skipped without a description: {len(no_text)})", flush=True)
    if not todo:
        return

    criteria = node("import { FIT_CRITERIA } from './scoring.js'; console.log(JSON.stringify(FIT_CRITERIA));")
    questions = node("import { buildQuestions } from './scoring.js';"
                     "console.log(JSON.stringify(buildQuestions({ needsSponsorship: true })));")
    jobs = [{"title": r["job"].get("title") or (r.get("card") or {}).get("title") or "", "company": r["job"].get("company") or "",
             "description": r["job"]["description"], "pageUrl": r["job"].get("pageUrl") or ""} for _, r in todo]
    states = node("import { buildState } from './scoring.js'; let s = ''; process.stdin.on('data', d => s += d);"
                  "process.stdin.on('end', () => console.log(JSON.stringify(JSON.parse(s).map(j => buildState(j)))));",
                  [{"resume": resume, "job": j} for j in jobs])

    model, tokenizer = load(args.model, FastDecisionModel)
    for (path, record), job, state in zip(todo, jobs, states):
        started = time.perf_counter()
        answers = FastDecisionModel.predict(model, tokenizer, state, questions)
        elapsed = round((time.perf_counter() - started) * 1000)
        result = {**result_from_answers(answers, questions, criteria), "elapsedMs": elapsed, "ts": int(time.time() * 1000)}
        out = {"key": record.get("key"), "scoredAt": datetime.now(timezone.utc).isoformat(),
               "scoringVersion": f"student:{run}", "sentTitle": job["title"], "sentCompany": job["company"],
               "descriptionChars": len(job["description"]), "result": result}
        tmp = out_dir / (path.name + ".tmp")
        tmp.write_text(json.dumps(out, indent=2))
        tmp.rename(out_dir / path.name)
        print(f"ok   {record.get('key')}  fit={result['fit']:.2f}/4  {elapsed}ms", flush=True)
    print(f"done: scored {len(todo)}, so {done + len(todo)} of {len(records)} are in {out_dir}", flush=True)


if __name__ == "__main__":
    main()
