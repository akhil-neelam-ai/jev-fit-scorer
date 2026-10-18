"""Pick the training jobs and pair each one with three of the generated resumes.

Each job gets three resumes. The likely fit has the same function and a level
the job hires at. The partial fit has the same function at the wrong level, or a
nearby function at the right level. The mismatch has an unrelated function. The
teacher decides the real answers. The roles only make every answer from 0 to 4
show up often.

A job is left out when it matches a test job by URL, by company and title, or by
shared text, so the student never studies the exam. About 1 in 5 pairs is
marked for copy-paste damage, and about half ask the visa question. Both are
decided here so every later step agrees.

  python3 model/build_pairs.py      # writes model/private/pairs/jobs.jsonl and pairs.jsonl
"""

import argparse
import json
import random
import re
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
JOBS_DIR = Path.home() / "coding-projects/job-descriptions"
RESUMES = ROOT / "model/private/resumes"
TEST = ROOT / "eval/private/lenny"
OUT = ROOT / "model/private/pairs"
LABELS = ROOT / "model/private/labels"
SEED = 20261017
ORDER_SEED = 20261018  # the order the teacher labels pairs in
PER_BUCKET = 25  # jobs per seniority bucket in each function, so 75 per function
NICHE_JOBS = 25  # Deployment Strategist postings, kept small so one rare title can't dominate
DAMAGE_SHARE = 0.2
VISA_SHARE = 0.5
DAMAGE_KINDS = ["flattened", "columns", "page_breaks", "bullets"]
SHINGLE = 13  # words per shingle when comparing a job's text with the test jobs
MAX_SHARED = 0.2  # a job sharing more than this share of its shingles with a test job is left out

LEVELS = ["student", "new grad", "early career", "mid level", "senior", "leader"]
# Functions close enough that a resume from one is a partial fit for the other.
NEAR = {
    "product": ["design", "data", "engineering", "strategy"],
    "engineering": ["data", "product", "support"],
    "design": ["product", "marketing"],
    "data": ["engineering", "product", "finance", "strategy"],
    "marketing": ["sales", "partnerships", "design", "product"],
    "sales": ["partnerships", "marketing", "support"],
    "partnerships": ["sales", "strategy", "marketing"],
    "finance": ["strategy", "operations", "data"],
    "strategy": ["operations", "finance", "product", "partnerships"],
    "operations": ["strategy", "support", "finance", "people"],
    "people": ["operations", "legal"],
    "legal": ["people", "operations", "finance"],
    "support": ["operations", "sales", "engineering"],
}
# Deployment Strategist postings have no function tag. Strategy resumes are the
# closest match, since the persona titles include Deployment Strategist.
NICHE_FOLDER, NICHE_FUNCTION = "deployment-strategist", "strategy"


def front_matter(text):
    match = re.match(r"^---\n(.*?)\n---\n?(.*)$", text, re.S)
    if not match:
        return None, text
    meta = {}
    for line in match.group(1).splitlines():
        if ":" not in line or line.startswith(" "):
            continue
        key, value = line.split(":", 1)
        value = value.strip()
        try:
            meta[key.strip()] = json.loads(value) if value else None
        except ValueError:
            meta[key.strip()] = value
    return meta, match.group(2)


def plain(body):
    """The description as page text: no title heading, bold markers, star bullets or HTML tags."""
    lines = body.strip().splitlines()
    if lines and lines[0].startswith("# "):
        lines = lines[1:]
    text = "\n".join(lines).replace("**", "")
    text = re.sub(r"^(\s*)\* ", r"\1- ", text, flags=re.M)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def norm_url(url):
    url = re.sub(r"^https?://(www\.)?", "", (url or "").strip().lower())
    return re.sub(r"[?#].*$", "", url).rstrip("/")


def norm_role(company, title):
    return re.sub(r"[^a-z0-9]+", " ", f"{company} {title}".lower()).strip()


def shingles(text):
    words = re.findall(r"[a-z0-9]+", (text or "").lower())
    return {" ".join(words[i:i + SHINGLE]) for i in range(len(words) - SHINGLE + 1)}


def test_index():
    """What identifies each test job: its URLs, its company and title, and its text."""
    files = sorted(TEST.glob("*.json"))
    if not files:
        raise SystemExit(f"No test jobs in {TEST}, so no leak check is possible. Restore that folder from the machine "
                         "that collected it. Don't make stand-in test jobs.")
    urls, roles, by_shingle = set(), set(), defaultdict(set)
    for path in files:
        record = json.loads(path.read_text())
        job, card = record.get("job") or {}, record.get("card") or {}
        for url in (job.get("pageUrl"), card.get("url")):
            if url:
                urls.add(norm_url(url))
        for title in {job.get("title"), card.get("title")} - {None, ""}:
            roles.add(norm_role(job.get("company") or card.get("company") or "", title))
        for shingle in shingles(job.get("description")):
            by_shingle[shingle].add(path.stem)
    return urls, roles, by_shingle


def leak(job, urls, roles, by_shingle):
    """Why a job counts as a test job, or None."""
    if norm_url(job["url"]) in urls:
        return "url"
    if norm_role(job["company"], job["title"]) in roles:
        return "company and title"
    own = shingles(job["description"])
    if own:
        shared = Counter(test for s in own for test in by_shingle.get(s, ()))
        if shared and shared.most_common(1)[0][1] / len(own) > MAX_SHARED:
            return "shared text"
    return None


def read_jobs():
    jobs = []
    for folder in sorted(p for p in JOBS_DIR.iterdir() if (p / "jds").is_dir()):
        for path in sorted((folder / "jds").glob("*.md")):
            meta, body = front_matter(path.read_text(encoding="utf-8"))
            if not meta:
                continue
            seniority = str(meta.get("seniority") or "").lower()
            title = str(meta.get("title") or "")
            bucket = meta.get("seniorityBucket") or {
                "intern": "entry", "associate": "entry", "": "mid", "mid": "mid",
            }.get(seniority, "senior")
            jobs.append({
                "id": str(meta.get("id")),
                "folder": folder.name,
                "function": NICHE_FUNCTION if folder.name == NICHE_FOLDER else (meta.get("jobFunction") or folder.name),
                "bucket": bucket,
                "internship": meta.get("employmentType") == "internship" or seniority == "intern" or bool(re.search(r"\bintern(ship)?\b", title, re.I)),
                "leader": seniority in ("director", "vp", "head", "principal") or bool(re.search(r"\b(director|vp|vice president|head of|chief)\b", title, re.I)),
                "title": title,
                "company": str(meta.get("company") or ""),
                "url": str(meta.get("jobUrl") or ""),
                "region": meta.get("region"),
                "description": plain(body),
            })
    return jobs


def levels_for(job):
    """The resume levels this job hires at."""
    if job["internship"]:
        return {"student"}
    if job["bucket"] == "entry":
        return {"new grad", "early career"}
    if job["bucket"] == "mid":
        return {"early career", "mid level"}
    return {"senior", "leader"} if job["leader"] else {"mid level", "senior"}


def pick(candidates, used, rng):
    """The least-used candidate, ties broken at random, so every resume gets used about equally."""
    least = min(used[p["id"]] for p in candidates)
    choice = rng.choice([p for p in candidates if used[p["id"]] == least])
    used[choice["id"]] += 1
    return choice


def label_order(pairs):
    """The pairs in the fixed shuffled order the teacher labels them in.
    Any prefix of it covers every function and level evenly."""
    order = list(pairs)
    random.Random(ORDER_SEED).shuffle(order)
    return order


def needs_writing(new, force=False):
    """Whether the new {file name: text} output should be written over what's in OUT.

    An unchanged output isn't rewritten. A changed one is refused while any labels exist,
    because labels are keyed by pair id and the tailored pairs depend on jobs.jsonl too.
    """
    changed = [name for name, text in new.items() if not (OUT / name).exists() or (OUT / name).read_text() != text]
    if not changed:
        return False
    labels = sum(1 for _ in LABELS.glob("*.json"))
    if labels and not force:
        raise SystemExit(f"This run would rewrite {', '.join(changed)}, but {labels} labels depend on them. "
                         f"Move the labels aside with mv {LABELS} {LABELS}-old, or pass --force to rewrite anyway.")
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="rewrite the pairs even though labels depend on them")
    args = ap.parse_args()
    from label_pairs import refuse_if_labeling  # here, since label_pairs imports this module

    refuse_if_labeling()  # even with --force: a run in progress reads these files
    rng = random.Random(SEED)
    people = [p for p in json.loads((RESUMES / "personas.json").read_text()) if (RESUMES / "generated" / f"{p['id']}.txt").exists()]

    urls, roles, by_shingle = test_index()
    seen_roles, dropped, pool = set(), Counter(), defaultdict(list)
    for job in read_jobs():
        reason = leak(job, urls, roles, by_shingle)
        if reason:
            dropped["matches a test job by " + reason] += 1
            continue
        if len(job["description"]) < 500:
            dropped["description under 500 characters"] += 1
            continue
        if len(job["description"]) > 15000:
            dropped["description over 15,000 characters"] += 1
            continue
        role = norm_role(job["company"], job["title"])
        if role in seen_roles:
            dropped["same company and title as another job"] += 1
            continue
        seen_roles.add(role)
        key = ("niche", "all") if job["folder"] == NICHE_FOLDER else (job["function"], job["bucket"])
        pool[key].append(job)

    chosen = []
    for key in sorted(pool):
        size = NICHE_JOBS if key[0] == "niche" else PER_BUCKET
        jobs = sorted(pool[key], key=lambda j: j["id"])
        chosen += rng.sample(jobs, min(size, len(jobs)))

    used, pairs = Counter({p["id"]: 0 for p in people}), []
    for job in chosen:
        f, want = job["function"], levels_for(job)
        level = {name: i for i, name in enumerate(LEVELS)}
        far = [p for p in people if p["function"] == f and min(abs(level[p["level"]] - level[w]) for w in want) >= 2]
        near = [p for p in people if p["function"] in NEAR[f] and p["level"] in want]
        options = {
            "fit": [p for p in people if p["function"] == f and p["level"] in want],
            "partial": rng.choice([c for c in (far, near) if c]),
            "mismatch": [p for p in people if p["function"] != f and p["function"] not in NEAR[f]],
        }
        for role, candidates in options.items():
            person = pick(candidates, used, rng)
            pairs.append({
                "pair_id": f"{job['id']}-{person['id']}",
                "job_id": job["id"],
                "resume_id": person["id"],
                "role": role,
                "damage": rng.choice(DAMAGE_KINDS) if rng.random() < DAMAGE_SHARE else None,
                "visa": rng.random() < VISA_SHARE,
            })

    new = {"jobs.jsonl": "".join(json.dumps(j) + "\n" for j in chosen),
           "pairs.jsonl": "".join(json.dumps(p) + "\n" for p in pairs)}
    written = needs_writing(new, args.force)
    if written:
        OUT.mkdir(parents=True, exist_ok=True)
        for name, text in new.items():
            (OUT / name).write_text(text)

    print(f"jobs: {len(chosen)} chosen from {sum(len(v) for v in pool.values())} usable")
    for reason, n in dropped.most_common():
        print(f"  left out {n:>4}: {reason}")
    by_function = Counter(j["function"] if j["folder"] != NICHE_FOLDER else "deployment strategist" for j in chosen)
    print("  by function:", dict(sorted(by_function.items())))
    print("  internships:", sum(j["internship"] for j in chosen), "| leader roles:", sum(j["leader"] for j in chosen),
          "| outside the US:", sum(j["region"] not in ("us", None) for j in chosen))
    print(f"pairs: {len(pairs)} ({dict(Counter(p['role'] for p in pairs))})")
    print(f"  resume use: min {min(used.values())}, max {max(used.values())} | damaged: {sum(1 for p in pairs if p['damage'])}"
          f" | visa asked: {sum(p['visa'] for p in pairs)}")
    print(f"written to {OUT}" if written else f"unchanged, so nothing was written to {OUT}")


if __name__ == "__main__":
    main()
