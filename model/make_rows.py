"""Turn the teacher's labels into training rows for Unsloth's decision trainer.

Each row holds what the extension sends Jev: the state (resume and job, built by
scoring.js) and the questions. The teacher's full probabilities are the gold
answers, so the student learns how sure the teacher was, not only its pick.

Before any row is written, three checks run, and each one stops the build when it fails:
- A coverage gate. Every pair file must exist, and nearly every pair in each one must have a label.
- A leak audit, stricter than the one in build_pairs.py. It decodes HTML
  entities, compares every company and title spelling, and measures shared text
  against both postings' lengths. Any job it flags is left out of every row, and
  so is every pair of a tailored resume written from a flagged job.
- No training resume may share a 13-word run with the real test resume.

Then a confidence filter runs. If the teacher's allowed options for any non-visa
answer held under 90% of its probability, the whole row is dropped. A visa answer
under 50% (where "unknown" is common) is removed, and the row stays.

Pairs marked for copy-paste damage get a damaged resume in the state but keep
the clean resume's label, because formatting doesn't change fit. The job side
looks like what the extension's page reader sends. Most descriptions are
collapsed to one line, URLs lose their query strings, and most rows carry no
company, because extract.js finds one on few sites. The visa question appears
only in pairs that ask it.

Validation holds out a tenth of the jobs and a tenth of the resumes, with all
their pairs. It measures both new postings and new people. A tailored resume
counts as held out when the job it was written from is, so text written from a
validation job never reaches training.

  python3 model/make_rows.py                     # writes model/private/rows/train.jsonl and valid.jsonl
  python3 model/make_rows.py --allow-partial     # build from whatever is labeled so far
"""

import argparse
import hashlib
import html
import json
import random
import re
import subprocess
from collections import Counter, defaultdict
from pathlib import Path

from build_pairs import norm_role, norm_url, shingles
from label_pairs import PAIR_FILES

ROOT = Path(__file__).resolve().parent.parent
PAIRS = ROOT / "model/private/pairs"
RESUMES = ROOT / "model/private/resumes"
LABELS = ROOT / "model/private/labels"
TAILORED_PLAN = ROOT / "model/private/tailored/plan.json"
TEST = ROOT / "eval/private/lenny"
REAL_RESUME = ROOT / "eval/private/resume.txt"
OUT = ROOT / "model/private/rows"
HOLDOUT = 10  # one job in this many, and one resume in this many, go to validation
SHUFFLE_SEED = 20261020
MIN_COVERAGE = 0.95
MIN_MASS, MIN_VISA_MASS = 0.9, 0.5
MAX_SHARED = 0.2
JD_FLAT_SHARE = 8  # out of 10 job descriptions collapsed to one line, like extract.js sends
NO_COMPANY_SHARE = 19  # out of 20 rows send no company. 104 of the 109 test jobs reached Jev without one.


def node(script, payload=None):
    out = subprocess.run(["node", "--input-type=module", "-e", script], cwd=ROOT, input=json.dumps(payload or {}),
                         capture_output=True, text=True)
    if out.returncode:
        raise SystemExit(f"node failed: {out.stderr.strip()[:500]}")
    return json.loads(out.stdout)


def seeded_share(pair_id, salt, share, out_of):
    """True for a stable `share` out of every `out_of` pairs, the same on every run."""
    return int(hashlib.sha256(f"{pair_id}:{salt}".encode()).hexdigest(), 16) % out_of < share


def page_text(text):
    """Job text as a page shows it: HTML entities decoded and non-breaking spaces made plain."""
    return html.unescape(text or "").replace("\xa0", " ")


def job_text(description, pair_id):
    """The description as the student will see it. extract.js collapses all whitespace, so most rows do too."""
    text = page_text(description)
    return re.sub(r"\s+", " ", text).strip() if seeded_share(pair_id, "jd", JD_FLAT_SHARE, 10) else text


def page_url(url):
    """The page address without its query string or fragment, as the extension reports it."""
    return re.sub(r"[?#].*$", "", url or "")


def company_for(company, pair_id):
    """extract.js finds a company on few sites, so most rows send none, as most test jobs did."""
    return "" if seeded_share(pair_id, "company", NO_COMPANY_SHARE, 20) else company


# ---------- Leak audit ----------

def audit_index():
    """Every way a test job can be recognized, built from the test records."""
    files = sorted(TEST.glob("*.json"))
    if not files:
        raise SystemExit(f"No test jobs in {TEST}. Refusing to build rows without the leak audit.")
    urls, roles, texts = set(), set(), {}
    for path in files:
        record = json.loads(path.read_text())
        job, card = record.get("job") or {}, record.get("card") or {}
        urls |= {norm_url(u) for u in (job.get("pageUrl"), card.get("url")) if u}
        for company in {job.get("company"), card.get("company")} - {None, ""}:
            for title in {job.get("title"), card.get("title")} - {None, ""}:
                roles.add(norm_role(company, title))
        own = shingles(page_text(job.get("description")))
        if own:
            texts[path.stem] = own
    by_shingle = defaultdict(set)
    for key, own in texts.items():
        for s in own:
            by_shingle[s].add(key)
    return urls, roles, texts, by_shingle


def audit_reason(job, index):
    urls, roles, texts, by_shingle = index
    if norm_url(job["url"]) in urls:
        return "url"
    if norm_role(job["company"], job["title"]) in roles:
        return "company and title"
    own = shingles(page_text(job["description"]))
    shared = Counter(key for s in own for key in by_shingle.get(s, ()))
    for key, n in shared.items():
        # Against the shorter text, so a test job copied inside a longer posting is still caught.
        if n / min(len(own), len(texts[key])) > MAX_SHARED:
            return "shared text"
    return None


def real_resume_overlap(paths):
    """The training resumes that share any 13-word run with the real test resume. There should be none."""
    real = shingles(REAL_RESUME.read_text())
    return sorted(str(p.relative_to(RESUMES)) for p in paths if real & shingles(p.read_text()))


def tailored_sources():
    """The job each tailored resume was written from, from make_tailored.py's plan."""
    if not TAILORED_PLAN.exists():
        return {}
    return {p["id"]: p["job_id"] for p in json.loads(TAILORED_PLAN.read_text())}


# ---------- Copy-paste damage ----------
# Each kind mimics what copying a resume out of a PDF or a web form does to it.

def flattened(text, rng):
    """Every line break lost, as when a PDF copies out as one paragraph."""
    return re.sub(r"\s+", " ", text).strip()


def columns(text, rng):
    """A two-column layout read straight across, so the halves interleave line by line."""
    lines = [line for line in text.splitlines() if line.strip()]
    half = (len(lines) + 1) // 2
    left, right = lines[:half], lines[half:]
    return "\n".join(f"{a}   {right[i]}" if i < len(right) else a for i, a in enumerate(left))


def page_breaks(text, rng):
    """Page footers and a repeated header dropped into the middle of the text."""
    lines = text.splitlines()
    header = next((line.strip() for line in lines if line.strip()), "")
    cut = rng.randint(len(lines) // 3, max(len(lines) // 3, 2 * len(lines) // 3))
    return "\n".join(lines[:cut] + ["", "Page 1 of 2", "", header] + lines[cut:] + ["", "Page 2 of 2"])


def bullets(text, rng):
    """Bullet glyphs turned into stray symbols, and long lines hard-wrapped mid-sentence."""
    glyph = rng.choice(["", "●", "▪", "➢", "Ø", "*"])
    out = []
    for line in text.splitlines():
        line = re.sub(r"^(\s*)[-•▪◦‣o]\s+", lambda m: m.group(1) + glyph + " ", line)
        while len(line) > 70:
            cut = line.rfind(" ", 40, 70)
            cut = cut if cut > 0 else 70
            out.append(line[:cut])
            line = line[cut:].lstrip()
        out.append(line)
    return "\n".join(out)


DAMAGE = {"flattened": flattened, "columns": columns, "page_breaks": page_breaks, "bullets": bullets}


def damaged(text, kind, pair_id):
    # Seeded by the pair, so the same pair always gets the same damage.
    return DAMAGE[kind](text, random.Random(pair_id))


# ---------- Gold answers and splits ----------

def gold_for(probabilities, questions):
    """The teacher's probabilities in the shape the trainer reads: {name: {label, probabilities}}."""
    gold = {}
    for name in questions:
        if name == "visa":
            yes = probabilities["visa"]["yes"]
            dist = {"true": yes, "false": 1 - yes}
        else:
            dist = probabilities[name]
        gold[name] = {"label": max(dist, key=dist.get), "probabilities": dist}
    return gold


def mass_key(question):
    """optionMass in a label is keyed fit, why, visa and the bare dimension names."""
    return question[len("dim_"):] if question.startswith("dim_") else question


def row_for(pair, state, label, questions):
    """(row, visa_removed) for one labeled pair. The row is None when the teacher was too unclear to teach.

    `questions` maps "does this pair ask about visa" to that question set. A missing or NaN
    option mass counts as unclear, so a renamed key drops rows instead of passing them all.
    """
    mass = label.get("optionMass", {})

    def clear(key, floor):
        return mass.get(key, 0) >= floor  # NaN >= floor is False

    if not all(clear(mass_key(q), MIN_MASS) for q in questions[True] if q != "visa"):
        return None, False
    qs = dict(questions[bool(pair.get("visa"))])
    visa_removed = "visa" in qs and not clear("visa", MIN_VISA_MASS)
    if visa_removed:
        del qs["visa"]
    return {"id": pair["pair_id"], "state": state, "questions": qs, "gold": gold_for(label["probabilities"], qs)}, visa_removed


def held_out(key):
    """A stable tenth of jobs or resumes, the same on every run and every machine."""
    return int(hashlib.sha256(key.encode()).hexdigest(), 16) % HOLDOUT == 0


def split_for(pair, sources):
    """("train", None), or ("valid", the slice it measures). A pair is held out when its job or its
    resume is. A tailored resume also counts as held out when the job it was written from is."""
    job_out = held_out(pair["job_id"])
    source = sources.get(pair["resume_id"]) if pair.get("resume_dir") == "tailored" else None
    resume_out = held_out(pair["resume_id"]) or (source is not None and held_out(source))
    if not (job_out or resume_out):
        return "train", None
    return "valid", "new job and new resume" if job_out and resume_out else "new job" if job_out else "new resume"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pairs", nargs="+", default=PAIR_FILES, help="pair files in model/private/pairs/")
    ap.add_argument("--allow-partial", action="store_true", help="build even when a pair file is missing or not fully labeled")
    ap.add_argument("--skip-resume-check", action="store_true", help="build even without the real test resume to check against")
    args = ap.parse_args()

    jobs = {j["id"]: j for j in map(json.loads, (PAIRS / "jobs.jsonl").read_text().splitlines())}
    pairs, short = [], []
    for name in args.pairs:
        if not (PAIRS / name).exists():
            print(f"  {name}: missing")
            short.append(name)
            continue
        mine = [json.loads(line) for line in (PAIRS / name).read_text().splitlines()]
        done = sum(1 for p in mine if (LABELS / f"{p['pair_id']}.json").exists())
        print(f"  {name}: {done} of {len(mine)} labeled")
        if done < MIN_COVERAGE * len(mine):
            short.append(name)
        pairs += mine
    if short and not args.allow_partial:
        raise SystemExit(f"Missing or under {MIN_COVERAGE:.0%} labeled: {', '.join(short)}. "
                         "Run label_pairs.py, or pass --allow-partial.")
    labeled = [p for p in pairs if (LABELS / f"{p['pair_id']}.json").exists()]

    sources = tailored_sources()
    unplanned = sorted({p["resume_id"] for p in labeled if p.get("resume_dir") == "tailored"} - set(sources))
    if unplanned:
        raise SystemExit(f"Tailored resumes with no source job in {TAILORED_PLAN}: {', '.join(unplanned)}")
    audited = {p["job_id"] for p in labeled} | set(sources.values())
    if audited - set(jobs):
        raise SystemExit(f"Jobs missing from jobs.jsonl: {', '.join(sorted(audited - set(jobs)))}")
    index = audit_index()
    flagged = {jid: r for jid in audited if (r := audit_reason(jobs[jid], index))}
    from_flagged = {rid for rid, jid in sources.items() if jid in flagged}
    before = len(labeled)
    labeled = [p for p in labeled if p["job_id"] not in flagged
               and not (p.get("resume_dir") == "tailored" and p["resume_id"] in from_flagged)]
    print(f"leak audit: {len(flagged)} jobs flagged ({dict(Counter(flagged.values()))}), "
          f"{len(from_flagged)} of them the source of a tailored resume; {before - len(labeled)} pairs left out")

    resume_files = {RESUMES / p.get("resume_dir", "generated") / f"{p['resume_id']}.txt" for p in labeled}
    if REAL_RESUME.exists():
        overlap = real_resume_overlap(resume_files)
        print(f"training resumes sharing a 13-word run with the real test resume: {len(overlap)}")
        if overlap:
            raise SystemExit(f"These resumes share text with the real test resume: {', '.join(overlap)}")
    elif not args.skip_resume_check:
        raise SystemExit(f"No {REAL_RESUME} to check the training resumes against. Pass --skip-resume-check to build anyway.")

    questions = {v: node("import { buildQuestions } from './scoring.js';"
                         f"console.log(JSON.stringify(buildQuestions({{ needsSponsorship: {str(v).lower()} }})));")
                 for v in (False, True)}

    resumes = []
    for p in labeled:
        text = (RESUMES / p.get("resume_dir", "generated") / f"{p['resume_id']}.txt").read_text()
        resumes.append(damaged(text, p["damage"], p["pair_id"]) if p.get("damage") else text)
    batch = [{"resume": text, "job": {"title": jobs[p["job_id"]]["title"],
                                      "company": company_for(jobs[p["job_id"]]["company"], p["pair_id"]),
                                      "description": job_text(jobs[p["job_id"]]["description"], p["pair_id"]),
                                      "pageUrl": page_url(jobs[p["job_id"]]["url"])}}
             for p, text in zip(labeled, resumes)]
    # One node call builds every state with scoring.js, the same code the extension runs.
    states = node("import { buildState } from './scoring.js'; let s = ''; process.stdin.on('data', d => s += d);"
                  "process.stdin.on('end', () => console.log(JSON.stringify(JSON.parse(s).map(buildState))));", batch)

    files = {"train": [], "valid": []}
    spread = {split: defaultdict(Counter) for split in files}
    slices, dropped_rows, dropped_visa = Counter(), 0, 0
    for p, state in zip(labeled, states):
        row, visa_removed = row_for(p, state, json.loads((LABELS / f"{p['pair_id']}.json").read_text()), questions)
        if row is None:
            dropped_rows += 1
            continue
        dropped_visa += visa_removed
        split, measures = split_for(p, sources)
        if measures:
            slices[measures] += 1
        files[split].append(row)
        spread[split][p["role"]][row["gold"]["fit"]["label"]] += 1
    empty = [split for split, rows in files.items() if not rows]
    if empty:
        raise SystemExit(f"No {' or '.join(empty)} rows, so nothing was written.")

    OUT.mkdir(parents=True, exist_ok=True)
    rng = random.Random(SHUFFLE_SEED)
    for split, rows in files.items():
        rng.shuffle(rows)
        (OUT / f"{split}.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
    print(f"train rows: {len(files['train'])}, valid rows: {len(files['valid'])} ({dict(slices)})")
    print(f"rows dropped for an unclear teacher answer: {dropped_rows}; visa answers dropped: {dropped_visa}")
    print("teacher's top fit answer in training rows, by pair type:")
    for role in sorted(spread["train"]):
        counts = spread["train"][role]
        print(f"  {role:<15} " + "  ".join(f"{k}: {counts[k]:>4}" for k in "01234") + f"   ({sum(counts.values())})")
    for split in files:
        total = sum(spread[split].values(), Counter())
        print(f"  {'all ' + split:<15} " + "  ".join(f"{k}: {total[k]:>4}" for k in "01234"))
    print(f"written to {OUT}")


if __name__ == "__main__":
    main()
