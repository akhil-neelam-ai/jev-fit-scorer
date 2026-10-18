"""Score the test jobs with a local model, the way Jev scores them.

The model gets the same resume, the same job text and the same nine questions
the extension sends to Jev (read from scoring.js). For each answer it reads the
model's probability for every allowed option, so the fit and scorecard scores
come out probability-weighted like Jev's. Results land in the shape
eval/score-jev.mjs writes, so eval/report.mjs and eval/compare-versions.mjs
grade the model exactly as they grade Jev.

Everything runs on this Mac. No resume or job text leaves it.

  model/.venv/bin/python model/teacher_eval.py --out eval/private/teacher-qwen38 --limit 3
"""

import argparse
import json
import time
from datetime import datetime, timezone
from pathlib import Path

import mlx.core as mx
from mlx_lm import load
from mlx_lm.models.cache import make_prompt_cache

from teacher_prompt import rubric  # the questions from scoring.js, shared with the label stamp

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MODEL = Path.home() / ".lmstudio/models/lmstudio-community/Qwen3.8-27B-MLX-4bit"
LEVELS = ["Weak", "Moderate", "Strong"]
CHUNK = 2048  # prompt tokens fed per step, to keep memory flat on long jobs
SYSTEM = ("You score how well a candidate fits a job, using only the resume and the job description. "
          "Answer every question on its own. Reply only in the format asked for.")


def build_state(resume, job, max_chars):
    """A copy of scoring.js's buildState, so the model reads what Jev reads."""
    title, company = str(job.get("title") or ""), str(job.get("company") or "")
    description, page_url = str(job.get("description") or "")[:max_chars], str(job.get("pageUrl") or "")
    lines = ["CANDIDATE RESUME:", resume.strip(), "", "JOB:", f"{title} at {company}"]
    if page_url:
        lines.append("Source: " + page_url)
    if description:
        lines.append("FULL JOB DESCRIPTION:\n" + description)
    return "\n".join(lines)


def build_prompt(state, r):
    q, labels = r["questions"], r["labels"]
    dims = list(labels)
    parts = [
        state,
        "",
        "QUESTIONS. Answer each one on its own.",
        "",
        f"fit: {q['fit']['instructions']} Answer 0, 1, 2, 3 or 4.",
        f"why: {q['why']['instructions']} Answer with one of these names: {', '.join(dims)}.",
    ]
    for d in dims:
        parts.append(f"{d}: {q['dim_' + d]['instructions']} Answer 0 for Weak, 1 for Moderate, or 2 for Strong.")
    parts.append(f"visa: {q['visa']['instructions']} Answer yes if it is likely, or no if it is not.")
    parts += ["", "Reply with exactly these lines and nothing else:", "fit=<0-4>", "why=<one of the names>"]
    parts += [f"{d}=<0-2>" for d in dims] + ["visa=<yes or no>"]
    return "\n".join(parts)


class Reader:
    """Feeds a prompt once, then reads one answer at a time from the model's next-token probabilities."""

    def __init__(self, model, tok):
        self.model, self.tok = model, tok
        self.ids = {}

    def first_token(self, text):
        """The first token of `text`, as text. Lets a multi-token answer be read from its first step."""
        return self.tok.decode([self.tok.encode(text, add_special_tokens=False)[0]])

    def token(self, text):
        if text not in self.ids:
            ids = self.tok.encode(text, add_special_tokens=False)
            if len(ids) != 1:
                raise SystemExit(f"{text!r} is {len(ids)} tokens for this tokenizer; pick single-token options.")
            self.ids[text] = ids[0]
        return self.ids[text]

    def start(self, prompt_text):
        self.cache = make_prompt_cache(self.model)
        ids = self.tok.encode(prompt_text, add_special_tokens=False)
        for i in range(0, len(ids), CHUNK):
            logits = self.model(mx.array([ids[i:i + CHUNK]]), cache=self.cache)
        self.last = logits[0, -1]
        return len(ids)

    def feed(self, text):
        ids = self.tok.encode(text, add_special_tokens=False)
        self.last = self.model(mx.array([ids]), cache=self.cache)[0, -1]

    def ask(self, prefix, options):
        """Feeds `prefix`, returns {option: probability} over `options` and the share of mass they held."""
        self.feed(prefix)
        probs = mx.softmax(self.last.astype(mx.float32))
        raw = {o: probs[self.token(o)].item() for o in options}
        mass = sum(raw.values())
        return {o: p / mass for o, p in raw.items()}, mass

    def ask_groups(self, prefix, groups):
        """Like ask, but each answer may be spelled several ways, such as yes and Yes."""
        self.feed(prefix)
        probs = mx.softmax(self.last.astype(mx.float32))
        raw = {label: sum(probs[self.token(t)].item() for t in spellings) for label, spellings in groups.items()}
        mass = sum(raw.values())
        return {label: p / mass for label, p in raw.items()}, mass

    def answer(self, text):
        self.feed(text)


def score_job(reader, chat_prompt, r):
    """Returns the result in eval/score-jev.mjs's shape, the prompt length, each answer's
    option mass, and every question's full probabilities (what a student learns from)."""
    dims = list(r["labels"])
    started = time.perf_counter()
    n_tokens = reader.start(chat_prompt)
    mass, dist = {}, {}

    fit_p, mass["fit"] = reader.ask("fit=", [str(i) for i in range(5)])
    dist["fit"] = fit_p
    fit_choice = max(fit_p, key=fit_p.get)
    reader.answer(fit_choice)

    # The factor names differ in their first token, so that step decides the answer.
    starts = {reader.first_token(d): d for d in dims}
    if len(starts) != len(dims):
        raise SystemExit("Two factor names start with the same token; the why answer can't tell them apart.")
    why_p, mass["why"] = reader.ask("\nwhy=", list(starts))
    dist["why"] = {starts[token]: p for token, p in why_p.items()}
    why_choice = starts[max(why_p, key=why_p.get)]
    reader.answer(why_choice)

    scorecard = {}
    for d in dims:
        p, mass[d] = reader.ask(f"\n{d}=", ["0", "1", "2"])
        dist["dim_" + d] = p
        choice = max(p, key=p.get)
        reader.answer(choice)
        score = sum(int(k) * v for k, v in p.items())
        scorecard[d] = {"score": score, "label": LEVELS[max(0, min(2, round(score)))], "confidence": max(p.values())}

    # The model also writes Yes or No, and sometimes "unknown". Both spellings
    # count, and the probability is yes over yes plus no.
    visa_p, mass["visa"] = reader.ask_groups("\nvisa=", {"yes": ["yes", "Yes"], "no": ["no", "No"]})
    dist["visa"] = visa_p
    elapsed = round((time.perf_counter() - started) * 1000)

    fit = sum(int(k) * v for k, v in fit_p.items())
    result = {
        "fit": fit,
        "fitConfidence": max(fit_p.values()),
        "scorecard": scorecard,
        "fitLabel": r["fitCriteria"][round(fit)],
        "why": why_choice,
        "visa": visa_p["yes"],
        "inputTokens": n_tokens,
        "elapsedMs": elapsed,
        "ts": int(time.time() * 1000),
    }
    return result, n_tokens, {k: round(v, 3) for k, v in mass.items()}, dist


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--records", default="eval/private/lenny")
    ap.add_argument("--resume", default="eval/private/resume.txt")
    ap.add_argument("--out", default="eval/private/teacher-qwen38")
    ap.add_argument("--model", default=str(DEFAULT_MODEL))
    ap.add_argument("--limit", type=int)
    args = ap.parse_args()

    records_dir, out_dir = ROOT / args.records, ROOT / args.out
    out_dir.mkdir(parents=True, exist_ok=True)
    resume = (ROOT / args.resume).read_text()
    r = rubric()

    files = sorted(p for p in records_dir.glob("*.json"))
    todo = [p for p in files if not (out_dir / p.name).exists()]
    if args.limit:
        todo = todo[: args.limit]
    print(f"to score: {len(todo)} (already scored: {len(files) - len([p for p in files if not (out_dir / p.name).exists()])})", flush=True)

    model, tok = load(args.model)
    reader = Reader(model, tok)

    ok = skipped = 0
    for path in todo:
        record = json.loads(path.read_text())
        job_in = record.get("job") or {}
        if not job_in.get("description"):
            print(f"SKIP {record.get('key', path.stem)}  no job description", flush=True)
            skipped += 1
            continue
        job = {
            "title": job_in.get("title") or (record.get("card") or {}).get("title") or "",
            "company": job_in.get("company") or "",
            "description": job_in["description"],
            "pageUrl": job_in.get("pageUrl") or "",
        }
        state = build_state(resume, job, r["maxChars"])
        messages = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": build_prompt(state, r)}]
        chat = tok.apply_chat_template(messages, add_generation_prompt=True, tokenize=False, enable_thinking=False)
        result, n_tokens, mass, dist = score_job(reader, chat, r)
        out = {
            "key": record.get("key"), "scoredAt": datetime.now(timezone.utc).isoformat(),
            "scoringVersion": f"teacher:{Path(args.model).name}",
            "sentTitle": job["title"], "sentCompany": job["company"], "descriptionChars": len(job["description"]),
            "result": result, "usage": {"input_tokens": n_tokens}, "optionMass": mass, "probabilities": dist,
        }
        tmp = out_dir / (path.name + ".tmp")
        tmp.write_text(json.dumps(out, indent=2))
        tmp.rename(out_dir / path.name)
        ok += 1
        # Visa often goes partly to "unknown", so it gets a lower bar than the rest.
        low = {k: v for k, v in mass.items() if v < (0.5 if k == "visa" else 0.9)}
        print(f"ok   {record.get('key')}  fit={result['fit']:.2f}/4  {result['elapsedMs']}ms  {n_tokens} tok"
              f"{'  LOW OPTION MASS ' + str(low) if low else ''}", flush=True)
    print(f"done: {ok} scored, {skipped} skipped", flush=True)


if __name__ == "__main__":
    main()
