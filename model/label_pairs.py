"""Label the training pairs with the teacher, one pair at a time.

For each pair from build_pairs.py, the teacher reads the clean resume and the
job. It answers the same nine questions the extension sends to Jev, and we keep
its full probabilities for every question. Damaged copies of a resume are made
later and keep the clean copy's label, because formatting doesn't change fit.

Each pair file runs in its own fixed shuffled order, so a run that stops early
still covers every function and level evenly. Each label is its own file in
model/private/labels/, and a restart skips the ones already done. A pair that
fails is logged and skipped, and the next run tries it again. Keep the Mac
awake with caffeinate:

  caffeinate -is model/.venv/bin/python model/label_pairs.py --limit 3
  caffeinate -is model/.venv/bin/python model/label_pairs.py     # every pair file, strong matches first
"""

import argparse
import fcntl
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

from build_pairs import label_order

ROOT = Path(__file__).resolve().parent.parent
PAIRS = ROOT / "model/private/pairs"
RESUMES = ROOT / "model/private/resumes"
LABELS = ROOT / "model/private/labels"
LOCK = ROOT / "model/private/label_pairs.lock"
# Strong matches first, so they are labeled even if a run stops early.
PAIR_FILES = ["tailored_pairs.jsonl", "tailored_cross_pairs.jsonl", "pairs.jsonl"]
MAX_FAILURES_IN_A_ROW = 5  # past this, the model itself is likely broken, so stop and let a restart reload it


def resume_path(pair):
    return RESUMES / pair.get("resume_dir", "generated") / f"{pair['resume_id']}.txt"


def refuse_if_labeling():
    """Stop another script from loading a model while a labeling run holds the teacher in memory."""
    if not LOCK.exists():
        return
    with open(LOCK) as f:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit("label_pairs.py is running. The teacher and the student can't share the Mac's memory, so wait for it.")
        fcntl.flock(f, fcntl.LOCK_UN)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", help="the teacher model folder (default: teacher_eval.py's)")
    ap.add_argument("--pairs", nargs="+", default=PAIR_FILES, help="pair files in model/private/pairs/, labeled in this order")
    ap.add_argument("--limit", type=int, help="label at most this many pairs, then stop")
    args = ap.parse_args()

    jobs = {j["id"]: j for j in map(json.loads, (PAIRS / "jobs.jsonl").read_text().splitlines())}
    pairs = []
    for name in args.pairs:
        pairs += label_order(json.loads(line) for line in (PAIRS / name).read_text().splitlines())
    todo = [p for p in pairs if not (LABELS / f"{p['pair_id']}.json").exists()]
    done_before = len(pairs) - len(todo)
    waiting = {p["pair_id"] for p in todo if p["job_id"] not in jobs or not resume_path(p).exists()}
    todo = [p for p in todo if p["pair_id"] not in waiting]
    if args.limit is not None:
        todo = todo[: max(0, args.limit)]
    print(f"to label: {len(todo)} (already labeled: {done_before} of {len(pairs)}; "
          f"waiting on a missing job or resume file: {len(waiting)})", flush=True)
    if not todo:
        return

    # One run at a time. Two would load two 27B models and work through the same pairs.
    LABELS.mkdir(parents=True, exist_ok=True)
    with open(LOCK, "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit("Another label_pairs.py is already running.")
        label(todo, jobs, args.model, len(waiting))


def label(todo, jobs, model_arg, waiting):
    from mlx_lm import load

    from teacher_eval import DEFAULT_MODEL, SYSTEM, Reader, build_prompt, build_state, rubric, score_job

    model_path = model_arg or str(DEFAULT_MODEL)
    r = rubric()
    model, tok = load(model_path)
    reader = Reader(model, tok)
    started, failed, in_a_row = time.time(), 0, 0
    for i, pair in enumerate(todo, 1):
        try:
            job = jobs[pair["job_id"]]
            resume = resume_path(pair).read_text()
            state = build_state(resume, {"title": job["title"], "company": job["company"],
                                         "description": job["description"], "pageUrl": job["url"]}, r["maxChars"])
            messages = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": build_prompt(state, r)}]
            chat = tok.apply_chat_template(messages, add_generation_prompt=True, tokenize=False, enable_thinking=False)
            result, n_tokens, mass, dist = score_job(reader, chat, r)
        except Exception as e:  # one bad pair shouldn't end an overnight run
            failed, in_a_row = failed + 1, in_a_row + 1
            print(f"FAIL {pair['pair_id']}: {type(e).__name__}: {e}", flush=True)
            if in_a_row >= MAX_FAILURES_IN_A_ROW:
                raise SystemExit(f"{in_a_row} pairs failed in a row; stopping so a restart can reload the model.")
            continue
        in_a_row = 0
        out = {
            "pair_id": pair["pair_id"], "job_id": pair["job_id"], "resume_id": pair["resume_id"], "role": pair["role"],
            "labeledAt": datetime.now(timezone.utc).isoformat(), "teacher": Path(model_path).name,
            "probabilities": dist, "optionMass": mass, "fit": result["fit"],
            "inputTokens": n_tokens, "elapsedMs": result["elapsedMs"],
        }
        path = LABELS / f"{pair['pair_id']}.json"
        tmp = path.parent / f"{path.name}.{os.getpid()}.tmp"
        tmp.write_text(json.dumps(out, indent=2))
        tmp.rename(path)
        hours_left = (time.time() - started) / i * (len(todo) - i) / 3600
        low = {k: v for k, v in mass.items() if v < (0.5 if k == "visa" else 0.9)}
        print(f"{i}/{len(todo)}  {pair['pair_id']:<16} {pair['role']:<8} fit={result['fit']:.2f}  {result['elapsedMs']}ms"
              f"  {n_tokens} tok  about {hours_left:.1f} h left{'  LOW OPTION MASS ' + str(low) if low else ''}", flush=True)
    print(f"done: {len(todo) - failed} labeled, {failed} failed, {waiting} waiting on a missing file "
          f"(rerun to retry them)", flush=True)
    if failed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
