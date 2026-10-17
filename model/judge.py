"""A blind second opinion on the teacher's labels, from Claude Opus 5.5 at max effort.

--prepare picks 120 pairs from the front of the labeling order: 40 likely fits,
40 partial fits and 40 mismatches, spread across the functions. The teacher
labels them first, so the comparison is ready early in its run. For each pair it
writes the exact text the teacher reads, and it writes the nine questions once,
from scoring.js. The judge sees nothing else: no teacher answers, no personas.

--compare lines up the judge's answers with the teacher's.

The judge's answers only measure the teacher. They never become training labels
and never decide which pairs we keep. That keeps Claude's output out of the
training targets, which Anthropic's terms rule out (LEARNING.md, lesson 5).

  python3 model/judge.py --prepare
  python3 model/judge.py --compare
"""

import argparse
import json
import math
import subprocess
from collections import Counter, defaultdict
from pathlib import Path

from build_pairs import label_order

ROOT = Path(__file__).resolve().parent.parent
PAIRS = ROOT / "model/private/pairs"
RESUMES = ROOT / "model/private/resumes/generated"
LABELS = ROOT / "model/private/labels"
JUDGE = ROOT / "model/private/judge"
PER_ROLE = 40
PER_FUNCTION = 10
DIMS = ["required_qualifications", "function", "role_level", "customer_type", "company_stage", "domain"]


def node(script, payload=None):
    out = subprocess.run(["node", "--input-type=module", "-e", script], cwd=ROOT, input=json.dumps(payload or {}),
                         capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def prepare():
    jobs = {j["id"]: j for j in map(json.loads, (PAIRS / "jobs.jsonl").read_text().splitlines())}
    order = label_order(json.loads(line) for line in (PAIRS / "pairs.jsonl").read_text().splitlines())
    by_role, by_function, sample = Counter(), Counter(), []
    for pair in order:
        function = jobs[pair["job_id"]]["function"]
        if by_role[pair["role"]] < PER_ROLE and by_function[function] < PER_FUNCTION:
            sample.append(pair)
            by_role[pair["role"]] += 1
            by_function[function] += 1
        if len(sample) == 3 * PER_ROLE:
            break
    last = order.index(sample[-1]) + 1

    # The state and questions come from scoring.js itself, so the judge reads what the extension sends.
    batch = [{"resume": (RESUMES / f"{p['resume_id']}.txt").read_text(),
              "job": {"title": jobs[p["job_id"]]["title"], "company": jobs[p["job_id"]]["company"],
                      "description": jobs[p["job_id"]]["description"], "pageUrl": jobs[p["job_id"]]["url"]}} for p in sample]
    states = node("import { buildState } from './scoring.js'; let s = ''; process.stdin.on('data', d => s += d);"
                  "process.stdin.on('end', () => console.log(JSON.stringify(JSON.parse(s).map(buildState))));", batch)
    rubric = node("import { buildQuestions } from './scoring.js';"
                  "console.log(JSON.stringify(buildQuestions({ needsSponsorship: true })));")

    (JUDGE / "inputs").mkdir(parents=True, exist_ok=True)
    (JUDGE / "opus").mkdir(parents=True, exist_ok=True)
    for pair, state in zip(sample, states):
        (JUDGE / "inputs" / f"{pair['pair_id']}.txt").write_text(state + "\n")
    lines = ["# Questions", "", "Answer each question on its own, using only the resume and the job description.", ""]
    for name, q in rubric.items():
        lines += [f"## {name} ({q['type']})", "", q["instructions"], ""]
        if name == "fit":
            lines += [f"- {i}: {label}" for i, label in enumerate(q["criteria"])] + [""]
        elif name == "why":
            lines += [f"- {key}: {label}" for key, label in q["criteria"].items()] + [""]
        elif name.startswith("dim_"):
            lines += ["- 0: Weak", "- 1: Moderate", "- 2: Strong", ""]
        elif name == "visa":
            lines += ["Answer with a probability from 0 to 100 that the job is sponsorship-friendly.", ""]
    (JUDGE / "rubric.md").write_text("\n".join(lines))
    (JUDGE / "sample.json").write_text(json.dumps([p["pair_id"] for p in sample], indent=1))
    print(f"sample: {len(sample)} pairs {dict(by_role)}, {len(by_function)} functions, all within the first {last} pairs the teacher labels")


def spearman(xs, ys):
    def ranks(values):
        order = sorted(range(len(values)), key=lambda i: values[i])
        out = [0.0] * len(values)
        i = 0
        while i < len(order):
            j = i
            while j + 1 < len(order) and values[order[j + 1]] == values[order[i]]:
                j += 1
            for k in range(i, j + 1):
                out[order[k]] = (i + j) / 2
            i = j + 1
        return out
    rx, ry = ranks(xs), ranks(ys)
    mx, my = sum(rx) / len(rx), sum(ry) / len(ry)
    cov = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    return cov / math.sqrt(sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry))


def expected(dist):
    return sum(int(k) * v for k, v in dist.items())


def compare():
    sample = json.loads((JUDGE / "sample.json").read_text())
    rows = []
    for pid in sample:
        judged, labeled = JUDGE / "opus" / f"{pid}.json", LABELS / f"{pid}.json"
        if judged.exists() and labeled.exists():
            rows.append((json.loads(judged.read_text()), json.loads(labeled.read_text())))
    print(f"pairs with both answers: {len(rows)} of {len(sample)}")
    if not rows:
        return

    def fit_report(name, subset):
        teacher = [expected(t["probabilities"]["fit"]) for _, t in subset]
        judge = [float(j["fit"]) for j, _ in subset]
        gaps = [a - b for a, b in zip(teacher, judge)]
        within = sum(1 for g in gaps if abs(g) <= 1)
        exact = sum(1 for a, b in zip(teacher, judge) if round(a) == b)
        print(f"{name:<14} n={len(subset):>3}  teacher {sum(teacher) / len(teacher):.2f}  judge {sum(judge) / len(judge):.2f}"
              f"  gap {sum(abs(g) for g in gaps) / len(gaps):.2f}  bias {sum(gaps) / len(gaps):+.2f}"
              f"  within 1: {within}/{len(subset)}  exact: {exact}/{len(subset)}"
              + (f"  rank agreement {spearman(teacher, judge):.2f}" if len(subset) > 4 and len(set(judge)) > 1 else ""))

    print("\nfit, teacher's probability-weighted score against the judge's whole score (bias > 0: teacher higher)")
    fit_report("all", rows)
    by_role, by_function = defaultdict(list), defaultdict(list)
    jobs = {j["id"]: j for j in map(json.loads, (PAIRS / "jobs.jsonl").read_text().splitlines())}
    for j, t in rows:
        by_role[t["role"]].append((j, t))
        by_function[jobs[t["job_id"]]["function"]].append((j, t))
    for role in ("fit", "partial", "mismatch"):
        if by_role[role]:
            fit_report(role, by_role[role])
    for function in sorted(by_function):
        fit_report(function, by_function[function])

    print("\nscorecard, exact level agreement and bias (teacher minus judge, on 0 to 2)")
    for d in DIMS:
        teacher = [expected(t["probabilities"]["dim_" + d]) for _, t in rows]
        judge = [float(j["dims"][d]) for j, _ in rows]
        exact = sum(1 for a, b in zip(teacher, judge) if round(a) == b)
        print(f"  {d:<24} exact {exact}/{len(rows)}  bias {sum(a - b for a, b in zip(teacher, judge)) / len(rows):+.2f}")
    why = sum(1 for j, t in rows if j["why"] == max(t["probabilities"]["why"], key=t["probabilities"]["why"].get))
    print(f"\nmain factor: same answer on {why}/{len(rows)}")
    visa = [(t["probabilities"]["visa"]["yes"], j["visa"] / 100) for j, t in rows]
    agree = sum(1 for a, b in visa if (a >= 0.5) == (b >= 0.5))
    print(f"visa: same side of 50% on {agree}/{len(rows)}  (teacher mean {sum(a for a, _ in visa) / len(visa):.0%}, judge mean {sum(b for _, b in visa) / len(visa):.0%})")


def main():
    ap = argparse.ArgumentParser()
    group = ap.add_mutually_exclusive_group(required=True)
    group.add_argument("--prepare", action="store_true")
    group.add_argument("--compare", action="store_true")
    args = ap.parse_args()
    prepare() if args.prepare else compare()


if __name__ == "__main__":
    main()
