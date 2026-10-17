"""Label the training pairs with the teacher, one pair at a time.

For each pair from build_pairs.py, the teacher reads the clean resume and the
job with the same nine questions the extension sends to Jev, and we keep its
full probabilities for every question. Damaged copies of a resume are made
later and keep the clean copy's label, because formatting doesn't change fit.

Pairs run in a fixed shuffled order, so a run that stops early still covers
every function and level evenly. Each label is its own file in
model/private/labels/, and a restart skips the ones already done. Keep the Mac
awake with caffeinate:

  caffeinate -is model/.venv/bin/python model/label_pairs.py --limit 3
"""

import argparse
import json
import random
import time
from datetime import datetime, timezone
from pathlib import Path

from mlx_lm import load

from teacher_eval import DEFAULT_MODEL, SYSTEM, Reader, build_prompt, build_state, rubric, score_job

ROOT = Path(__file__).resolve().parent.parent
PAIRS = ROOT / "model/private/pairs"
RESUMES = ROOT / "model/private/resumes/generated"
LABELS = ROOT / "model/private/labels"
ORDER_SEED = 20261018


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=str(DEFAULT_MODEL))
    ap.add_argument("--limit", type=int, help="label at most this many pairs, then stop")
    args = ap.parse_args()

    jobs = {j["id"]: j for j in map(json.loads, (PAIRS / "jobs.jsonl").read_text().splitlines())}
    pairs = [json.loads(line) for line in (PAIRS / "pairs.jsonl").read_text().splitlines()]
    random.Random(ORDER_SEED).shuffle(pairs)
    LABELS.mkdir(parents=True, exist_ok=True)
    todo = [p for p in pairs if not (LABELS / f"{p['pair_id']}.json").exists()]
    done_before = len(pairs) - len(todo)
    if args.limit:
        todo = todo[: args.limit]
    print(f"to label: {len(todo)} (already labeled: {done_before} of {len(pairs)})", flush=True)

    r = rubric()
    model, tok = load(args.model)
    reader = Reader(model, tok)
    started = time.time()
    for i, pair in enumerate(todo, 1):
        job = jobs[pair["job_id"]]
        resume = (RESUMES / f"{pair['resume_id']}.txt").read_text()
        state = build_state(resume, {"title": job["title"], "company": job["company"],
                                     "description": job["description"], "pageUrl": job["url"]}, r["maxChars"])
        messages = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": build_prompt(state, r)}]
        chat = tok.apply_chat_template(messages, add_generation_prompt=True, tokenize=False, enable_thinking=False)
        result, n_tokens, mass, dist = score_job(reader, chat, r)
        out = {
            "pair_id": pair["pair_id"], "job_id": pair["job_id"], "resume_id": pair["resume_id"], "role": pair["role"],
            "labeledAt": datetime.now(timezone.utc).isoformat(), "teacher": Path(args.model).name,
            "probabilities": dist, "optionMass": mass, "fit": result["fit"],
            "inputTokens": n_tokens, "elapsedMs": result["elapsedMs"],
        }
        path = LABELS / f"{pair['pair_id']}.json"
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(out, indent=2))
        tmp.rename(path)
        hours_left = (time.time() - started) / i * (len(todo) - i) / 3600
        low = {k: v for k, v in mass.items() if v < (0.5 if k == "visa" else 0.9)}
        print(f"{i}/{len(todo)}  {pair['pair_id']:<16} {pair['role']:<8} fit={result['fit']:.2f}  {result['elapsedMs']}ms"
              f"  {n_tokens} tok  about {hours_left:.1f} h left{'  LOW OPTION MASS ' + str(low) if low else ''}", flush=True)
    print("done", flush=True)


if __name__ == "__main__":
    main()
