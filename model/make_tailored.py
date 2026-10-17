"""Write prompts for resumes tailored to real job postings, so the training set has strong matches.

The generated resumes weren't written for particular jobs, so strong fits are
rare. A blind Opus judge gave only 5 of 120 pairs a 3 or a 4. Here each writer
gets one posting and a target fit from 2 to 4. It writes a resume for a person
who fits at that level. Writing quality is drawn separately, so a polished
resume can't stand in for a good fit.

Names are assigned here from mixed pools and checked against every name already
in use. Left to choose, parallel writers picked the same "unusual" names
(LEARNING.md, lesson 8).

  python3 model/make_tailored.py                  # prompts, plus pairs/tailored_pairs.jsonl
  python3 model/make_tailored.py --cross          # pairs/tailored_cross_pairs.jsonl (see cross_pairs)
  python3 model/make_tailored.py --check          # checks the written resumes
"""

import argparse
import json
import random
from collections import Counter
from pathlib import Path

from make_resumes import BULLET, LENGTHS, QUALITY, WORDS, contact_issues, name_line, within_band

ROOT = Path(__file__).resolve().parent.parent
PAIRS = ROOT / "model/private/pairs"
RESUMES = ROOT / "model/private/resumes"
LABELS = ROOT / "model/private/labels"
PROMPTS = ROOT / "model/private/tailored/prompts"
SEED = 20261019
PER_FUNCTION = 11  # jobs per function, about 150 in all
TARGETS = [4, 3, 4, 3, 2]  # cycled, so about 40% aim for 4, 40% for 3 and 20% for 2
DAMAGE_SHARE, VISA_SHARE = 0.2, 0.5
DAMAGE_KINDS = ["flattened", "columns", "page_breaks", "bullets"]

TARGET_TEXT = {
    4: "an exceptional match. They have done this job's core work at the same level, and the resume shows every explicitly required qualification: the years, skills, tools and degrees the posting asks for.",
    3: "a strong match. They have done the core work and show most of the required qualifications, with one or two gaps that a tailored resume could address.",
    2: "a moderate match. Their experience overlaps credibly with the core work, but several required qualifications are not shown.",
}
# First and last names by region, mixed so no single culture dominates.
NAMES = {
    "us": (["Adrienne", "Bryce", "Celeste", "Dorian", "Elise", "Garrett", "Harlan", "Imani", "Joelle", "Keaton", "Lorena", "Malik",
            "Nadia", "Owen", "Paige", "Quinn", "Renata", "Silas", "Talia", "Vaughn", "Whitney", "Xavier", "Yvette", "Zane",
            "Abigail", "Dante", "Esme", "Gideon", "Hollis", "Ingrid", "Jasper", "Kendra", "Leland", "Marcy", "Nolan", "Odette",
            "Priscilla", "Rhett", "Sabrina", "Tobias", "Ulyana", "Vivian", "Wesley", "Yolanda", "Ansel", "Bianca"],
           ["Abernathy", "Bellamy", "Calloway", "Dempsey", "Easterly", "Fairbanks", "Gallagher", "Holloway", "Ingram", "Jessup",
            "Kincaid", "Lockhart", "Mayhew", "Northcutt", "Okafor", "Prescott", "Quarles", "Radcliffe", "Sandoval", "Thornbury",
            "Underhill", "Valdez", "Whitlock", "Yoder", "Zamora", "Ashby", "Brennan", "Castillo", "Drummond", "Esposito",
            "Fenwick", "Garland", "Hargrove", "Iverson", "Langford", "Merriweather", "Pennington", "Rutledge", "Stroud", "Winslow"]),
    "india": (["Aarav", "Bhavna", "Chetan", "Devika", "Eshan", "Gauri", "Harsh", "Ishita", "Jatin", "Kavya", "Lakshmi", "Mihir",
               "Nandini", "Omkar", "Pallavi", "Rohan", "Sanika", "Tanmay", "Urvi", "Varun"],
              ["Bhattacharya", "Chandrasekar", "Deshpande", "Ganguly", "Iyengar", "Kulkarni", "Menon", "Nair", "Pillai",
               "Raghunathan", "Subramanian", "Thakkar", "Venkatesh", "Walia", "Joshi"]),
    "east_asia": (["Haruto", "Mei", "Jiwoo", "Takeshi", "Xinyi", "Minseo", "Ren", "Yuna", "Hao", "Sora", "Wen", "Daichi"],
                  ["Nakamura", "Zhao", "Han", "Fujita", "Lin", "Seo", "Tanaka", "Guo", "Kwon", "Watanabe", "Xu", "Shimizu"]),
    "africa": (["Chidi", "Amara", "Kwame", "Zainab", "Tendai", "Folake", "Kofi", "Nia", "Obinna", "Wanjiru", "Sefa", "Thandiwe"],
               ["Adeyemi", "Mensah", "Okonjo", "Kamau", "Banda", "Afolabi", "Owusu", "Mwangi", "Nkosi", "Eze", "Achebe", "Otieno"]),
    "latam_europe": (["Mateo", "Luana", "Thiago", "Ines", "Joaquin", "Clara", "Matthias", "Sofie", "Lukas", "Elena", "Rafael", "Greta"],
                     ["Oliveira", "Moreau", "Schreiber", "Varga", "Lindqvist", "Rossetti", "Ferreira", "Novak", "Huber", "Duarte", "Larsen", "Peralta",
                      "Bergmann", "Castellano", "Dvorak", "Eriksen", "Fontaine", "Kowalski"]),
}


def used_names():
    """Every first and last name already on a generated resume."""
    firsts, lasts = set(), set()
    for path in (RESUMES / "generated").glob("*.txt"):
        parts = name_line(path.read_text()).replace(".", "").split()
        if parts:
            firsts.add(parts[0].lower())
            lasts.add(parts[-1].lower())
    return firsts, lasts


def assign_names(n, rng):
    firsts_used, lasts_used = used_names()
    regions = list(NAMES)
    out, seen_first, seen_last = [], Counter(), Counter()
    for _ in range(200_000):
        if len(out) == n:
            break
        firsts, lasts = NAMES[rng.choice(regions)]
        first, last = rng.choice(firsts), rng.choice(lasts)
        if first.lower() in firsts_used or last.lower() in lasts_used:
            continue
        if seen_first[first] >= 2 or seen_last[last] >= 2 or (first, last) in out:
            continue
        seen_first[first] += 1
        seen_last[last] += 1
        out.append((first, last))
    if len(out) < n:
        raise SystemExit(f"Only {len(out)} unused names for {n} resumes. Add names to NAMES.")
    return [f"{a} {b}" for a, b in out]


def prompt_for(job, target, quality, length, name):
    return "\n".join([
        f"Write a realistic plain-text resume for {name}, a person applying to the job below.",
        f"Make them {TARGET_TEXT[target]}",
        QUALITY[quality],
        f"Length: {LENGTHS[length]}.",
        "Describe their experience in their own words. Don't copy sentences or keyword lists from the posting.",
        "They live where the job is based, or anywhere if the job is remote. Today is October 2026, and every date must fit that.",
        f"Use the name {name}. Use an example.com email, a 555 phone number, and example.com for any links.",
        "Schools and large, well-known employers can be real. Invent the names of startups and small firms.",
        "Use simple text with section headings and bullet points. No markdown symbols such as # or **.",
        "Output only the resume text.",
        "",
        "THE JOB",
        f"{job['title']} at {job['company']}",
        job["description"],
    ])


def build(force=False):
    # The resumes are written from these prompts. Rebuilding after that would orphan them.
    if not force and any((RESUMES / "tailored").glob("*.txt")):
        raise SystemExit("Tailored resumes already exist. Pass --force to rebuild the prompts anyway.")
    rng = random.Random(SEED)
    jobs = [json.loads(line) for line in (PAIRS / "jobs.jsonl").read_text().splitlines()]
    by_function = {}
    for job in sorted(jobs, key=lambda j: j["id"]):
        by_function.setdefault(job["function"], []).append(job)
    chosen = []
    for function in sorted(by_function):
        chosen += rng.sample(by_function[function], min(PER_FUNCTION, len(by_function[function])))
    rng.shuffle(chosen)
    names = assign_names(len(chosen), rng)

    PROMPTS.mkdir(parents=True, exist_ok=True)
    (RESUMES / "tailored").mkdir(parents=True, exist_ok=True)
    plan, pairs = [], []
    for i, (job, name) in enumerate(zip(chosen, names)):
        rid = f"t{i + 1:03d}"
        target = TARGETS[i % len(TARGETS)]
        quality = rng.choices(list(QUALITY), weights=[0.4, 0.4, 0.2])[0]
        length = rng.choice(list(LENGTHS))
        (PROMPTS / f"{rid}.txt").write_text(prompt_for(job, target, quality, length, name) + "\n")
        plan.append({"id": rid, "job_id": job["id"], "function": job["function"], "target": target,
                     "quality": quality, "length": length, "name": name})
        pairs.append({"pair_id": f"{job['id']}-{rid}", "job_id": job["id"], "resume_id": rid, "resume_dir": "tailored",
                      "role": f"tailored-{target}",
                      "damage": rng.choice(DAMAGE_KINDS) if rng.random() < DAMAGE_SHARE else None,
                      "visa": rng.random() < VISA_SHARE})
    (PROMPTS.parent / "plan.json").write_text(json.dumps(plan, indent=1))
    (PAIRS / "tailored_pairs.jsonl").write_text("".join(json.dumps(p) + "\n" for p in pairs))
    print(f"{len(plan)} tailored prompts: targets {dict(Counter(p['target'] for p in plan))}, "
          f"quality {dict(Counter(p['quality'] for p in plan))}, {len({p['function'] for p in plan})} functions")


def cross_pairs(force=False):
    """Each tailored resume against one other job in its function, which it wasn't written for.

    Without these, every resume written for a job is only ever seen next to that job. The
    student could then learn "written for this posting" as a sign of fit. These pairs show it the
    same strong resume scoring lower on a different posting. A separate seed leaves every
    prompt, name and pair from build() unchanged.
    """
    out = PAIRS / "tailored_cross_pairs.jsonl"
    # The teacher's labels are keyed by pair id. New pairs would leave hours of labels behind.
    if not force and out.exists() and any((LABELS / f"{json.loads(line)['pair_id']}.json").exists()
                                          for line in out.read_text().splitlines()):
        raise SystemExit("The cross pairs already have labels. Pass --force to rewrite them anyway.")
    rng = random.Random(SEED + 1)
    plan = json.loads((PROMPTS.parent / "plan.json").read_text())
    jobs = [json.loads(line) for line in (PAIRS / "jobs.jsonl").read_text().splitlines()]
    by_function = {}
    for job in sorted(jobs, key=lambda j: j["id"]):
        by_function.setdefault(job["function"], []).append(job)
    pairs = []
    for p in plan:
        job = rng.choice([j for j in by_function[p["function"]] if j["id"] != p["job_id"]])
        pairs.append({"pair_id": f"{job['id']}-{p['id']}", "job_id": job["id"], "resume_id": p["id"], "resume_dir": "tailored",
                      "role": "tailored-cross",
                      "damage": rng.choice(DAMAGE_KINDS) if rng.random() < DAMAGE_SHARE else None,
                      "visa": rng.random() < VISA_SHARE})
    out.write_text("".join(json.dumps(p) + "\n" for p in pairs))
    print(f"{len(pairs)} cross pairs: each tailored resume against another job in its function")


def check(ids=None):
    plan = json.loads((PROMPTS.parent / "plan.json").read_text())
    if ids:
        unknown = ids - {p["id"] for p in plan}
        if unknown:
            raise SystemExit(f"No tailored resume is planned for --ids {', '.join(sorted(unknown))}")
        plan = [p for p in plan if p["id"] in ids]
    bad, unwritten = 0, []
    for p in plan:
        path = RESUMES / "tailored" / f"{p['id']}.txt"
        if not path.exists():
            unwritten.append(p["id"])
            continue
        text = path.read_text()
        words, target = len(text.split()), WORDS[p["length"]]
        issues = []
        if not within_band(words, target):
            issues.append(f"{words} words, aimed for about {target}")
        if name_line(text) != p["name"].title():
            issues.append(f"name line is {name_line(text)!r}, expected {p['name']!r}")
        issues += contact_issues(text)
        bullets = [line for line in text.splitlines() if BULLET.match(line)]
        bad += bool(issues)
        print(f"{'FIX ' if issues else 'ok  '} {p['id']}  target {p['target']}  {p['quality']:<7} {words:>4} words  {len(bullets):>2} bullets"
              f"{'  <- ' + '; '.join(issues) if issues else ''}")
    print(f"checked {len(plan) - len(unwritten)} of {len(plan)}"
          f"{'; not written yet: ' + ', '.join(unwritten) if unwritten else ''}")
    if len(unwritten) == len(plan):
        bad += 1
    return bad


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="check the tailored resumes already written")
    ap.add_argument("--ids", help="with --check, only these ids, comma-separated")
    ap.add_argument("--cross", action="store_true", help="write pairs of each tailored resume with another job")
    ap.add_argument("--force", action="store_true", help="rebuild even though resumes or labels already depend on the output")
    args = ap.parse_args()
    if args.check:
        raise SystemExit(1 if check(set(args.ids.split(",")) if args.ids else None) else 0)
    if args.cross:
        cross_pairs(args.force)
        return
    build(args.force)


if __name__ == "__main__":
    main()
