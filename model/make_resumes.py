"""Generate synthetic resumes for the training set, one per persona.

A persona fixes the function, seniority, industry, writing quality and an
optional twist (career switch, visa need, gap...). Writing the list first,
with a fixed seed, is what guarantees the mix: every function, every level,
weak resumes as well as polished ones. Then a model writes one plain-text
resume per persona from the prompt saved next to it. Names and contact details
are invented (example.com emails, 555 phone numbers), so no real person appears.

  python3 model/make_resumes.py --personas-only               # personas.json and prompts.jsonl
  python3 model/make_resumes.py --check                       # check the written resumes against their personas
  model/.venv/bin/python model/make_resumes.py --pilot 5     # or let the local Qwen write them

The resumes in model/private/resumes/generated/ were written by Claude Opus 5.5
from prompts.jsonl, inside Claude Code (see model/LEARNING.md). Anthropic's help
center allows Claude's outputs in training data for models that don't compete
with its own, such as categorization tools, but not as training targets. Here
the resumes are inputs only. The answers the student learns come from Qwen.
"""

import argparse
import json
import random
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "model/private/resumes"
DEFAULT_MODEL = Path.home() / ".lmstudio/models/lmstudio-community/Qwen3.8-27B-MLX-4bit"
SEED = 20261016

# Titles a person in each Trackly job function might hold.
FUNCTIONS = {
    "product": ["Product Manager", "Associate Product Manager", "Senior Product Manager", "Group Product Manager", "Product Operations Manager", "Technical Product Manager"],
    "engineering": ["Software Engineer", "Backend Engineer", "Frontend Engineer", "Mobile Engineer", "Site Reliability Engineer", "Machine Learning Engineer", "Engineering Manager"],
    "design": ["Product Designer", "UX Researcher", "Visual Designer", "Content Designer", "Design Manager"],
    "data": ["Data Analyst", "Data Scientist", "Analytics Engineer", "Data Engineer", "Business Intelligence Analyst"],
    "marketing": ["Marketing Manager", "Growth Marketer", "Product Marketing Manager", "Content Marketer", "Brand Manager", "Performance Marketing Specialist"],
    "sales": ["Account Executive", "Sales Development Representative", "Enterprise Account Executive", "Sales Manager", "Solutions Engineer"],
    "partnerships": ["Partnerships Manager", "Business Development Manager", "Channel Partner Manager", "Alliances Lead"],
    "finance": ["Financial Analyst", "FP&A Manager", "Accountant", "Investment Banking Analyst", "Controller"],
    "strategy": ["Strategy Analyst", "Management Consultant", "Corporate Development Associate", "Chief of Staff", "Deployment Strategist"],
    "operations": ["Operations Manager", "Business Operations Analyst", "Supply Chain Analyst", "Program Manager", "Revenue Operations Manager"],
    "people": ["Recruiter", "HR Business Partner", "People Operations Specialist", "Talent Acquisition Manager", "Learning and Development Lead"],
    "legal": ["Corporate Counsel", "Paralegal", "Compliance Analyst", "Privacy Counsel", "Contracts Manager"],
    "support": ["Customer Support Specialist", "Customer Success Manager", "Technical Support Engineer", "Support Team Lead", "Implementation Specialist"],
}
# Titles that fit someone early in their career, and titles for leaders. The pilot
# caught a student aiming for "Group Product Manager", so titles follow the level.
JUNIOR = {
    "product": ["Associate Product Manager", "Product Analyst", "Product Manager"],
    "engineering": ["Software Engineer", "Frontend Engineer", "Backend Engineer", "Data Platform Engineer"],
    "design": ["Product Designer", "UX Designer", "Visual Designer", "UX Researcher"],
    "data": ["Data Analyst", "Business Intelligence Analyst", "Junior Data Scientist"],
    "marketing": ["Marketing Coordinator", "Growth Marketing Associate", "Content Marketer", "Marketing Analyst"],
    "sales": ["Sales Development Representative", "Account Executive", "Solutions Engineer"],
    "partnerships": ["Partnerships Associate", "Business Development Representative", "Partnerships Manager"],
    "finance": ["Financial Analyst", "Staff Accountant", "Investment Banking Analyst"],
    "strategy": ["Strategy Analyst", "Business Analyst", "Associate Consultant", "Deployment Strategist"],
    "operations": ["Operations Analyst", "Business Operations Associate", "Supply Chain Analyst", "Program Coordinator"],
    "people": ["Recruiting Coordinator", "Recruiter", "People Operations Specialist", "HR Generalist"],
    "legal": ["Paralegal", "Legal Assistant", "Compliance Analyst", "Associate Attorney"],
    "support": ["Customer Support Specialist", "Customer Success Associate", "Technical Support Engineer"],
}
LEADER = {
    "product": ["Director of Product", "VP of Product"], "engineering": ["Director of Engineering", "VP of Engineering"],
    "design": ["Head of Design", "Design Director"], "data": ["Director of Data Science", "Head of Analytics"],
    "marketing": ["VP of Marketing", "Head of Growth"], "sales": ["VP of Sales", "Head of Sales"],
    "partnerships": ["Head of Partnerships", "VP of Business Development"], "finance": ["Finance Director", "VP of Finance"],
    "strategy": ["Head of Strategy", "Chief of Staff"], "operations": ["VP of Operations", "Director of Operations"],
    "people": ["Head of People", "VP of Human Resources"], "legal": ["General Counsel", "Head of Legal"],
    "support": ["Director of Customer Support", "VP of Customer Success"],
}
# (name, the person in a phrase, titles to draw from, how many per function): 12 in all.
LEVELS = [
    ("student", "a student looking for an internship, with only internships, projects and campus roles", "junior", 2),
    ("new grad", "a recent graduate with up to 1 year of full-time experience", "junior", 2),
    ("early career", "an early-career professional with 2 to 4 years of full-time experience", "junior", 2),
    ("mid level", "a mid-level professional with 5 to 7 years of experience", "all", 3),
    ("senior", "a senior professional with 8 to 12 years of experience", "all", 2),
    ("leader", "a leader with 13 or more years of experience, managing teams or a department", "leader", 1),
]
INDUSTRIES = ["fintech", "healthcare", "e-commerce", "enterprise software", "developer tools", "consumer social apps", "gaming",
              "education", "government", "manufacturing", "media", "climate tech", "AI and machine learning", "consulting",
              "banking", "retail", "logistics", "biotech", "nonprofits", "real estate"]
STAGES = ["an early-stage startup", "a growth-stage startup", "a large tech company", "a large non-tech enterprise",
          "a consulting firm", "an agency", "a government agency", "a nonprofit", "a university or research lab"]
INTL = ["India", "the United Kingdom", "Germany", "Brazil", "Canada", "Nigeria", "Singapore", "Mexico", "China", "Kenya", "France", "the Philippines"]
# Each twist, and who it can apply to. The pilot turned up a bootcamp FP&A
# manager and a "consulting firm" person who worked in government, so twists
# only go where they make sense.
EARLY = {"student", "new grad", "early career"}
TWISTS = [
    ("is switching careers from {other} into this function, so most experience is in {other}", lambda f, lv: lv != "student"),
    ("is an MBA student switching into this function from a pre-MBA career in {other}", lambda f, lv: lv == "student"),
    ("studied in {country} and will need US visa sponsorship to work in the US", lambda f, lv: True),
    ("has a two-year career gap for caregiving, shown honestly on the resume", lambda f, lv: lv not in ("student", "new grad")),
    ("came through a coding or design bootcamp without a related degree", lambda f, lv: f in ("engineering", "design", "data") and lv in EARLY | {"mid level"}),
    ("has worked mostly in government or nonprofits", lambda f, lv: True),
    ("is finishing a PhD and moving into industry", lambda f, lv: lv in ("student", "new grad")),
    ("worked as a freelancer or consultant on many short projects", lambda f, lv: lv not in ("student", "new grad")),
]
QUALITY = {
    "strong": "Write it well: specific bullets with measurable results, a clear story and tidy formatting.",
    "average": "Write it like a typical resume: some results, some generic bullets, normal formatting.",
    "weak": "Write it like a weak resume: vague bullets with few or no numbers, some filler, uneven formatting.",
}
LENGTHS = {"short": "about 200 words", "medium": "about 350 words", "long": "about 550 words"}
WORDS = {"short": 200, "medium": 350, "long": 550}


def personas():
    """The full persona list. A fixed seed means the same list every run."""
    rng = random.Random(SEED)
    out = []
    for function, titles in FUNCTIONS.items():
        others = [f for f in FUNCTIONS if f != function]
        pools = {"junior": JUNIOR[function], "all": titles, "leader": LEADER[function]}
        for level, level_text, pool, count in LEVELS:
            for _ in range(count):
                twist = None
                if rng.random() < 0.45:
                    options = [t for t, fits in TWISTS if fits(function, level)]
                    twist = rng.choice(options).format(other=rng.choice(others), country=rng.choice(INTL))
                person = {
                    "id": f"p{len(out) + 1:03d}",
                    "function": function,
                    "title": rng.choice(pools[pool]),
                    "level": level,
                    "levelText": level_text,
                    "industry": rng.choice(INDUSTRIES),
                    "stage": rng.choice(STAGES),
                    "location": "the United States" if rng.random() < 0.8 else rng.choice(INTL),
                    "twist": twist,
                    "quality": rng.choices(list(QUALITY), weights=[0.3, 0.45, 0.25])[0],
                    "length": rng.choice(list(LENGTHS)),
                }
                # A government or nonprofit career sets the employer type, so the prompt can't contradict itself.
                if twist and "government or nonprofits" in twist:
                    person["stage"] = rng.choice(["a government agency", "a nonprofit"])
                out.append(person)
    return out


def prompt_for(p):
    lines = [
        f"Write a realistic plain-text resume for {p['levelText']}, aiming for {'internships in ' if p['level'] == 'student' else ''}roles like {p['title']}.",
        f"Their background is mostly in {p['industry']}, at {p['stage']}. They live in {p['location']}.",
    ]
    if p["twist"]:
        lines.append(f"This person {p['twist']}.")
    lines += [
        QUALITY[p["quality"]],
        f"Length: {LENGTHS[p['length']]}.",
        "Invent the name. Use an example.com email, a 555 phone number, and example.com for any links.",
        "Schools and large, well-known employers can be real. Invent the names of startups and small firms.",
        "Use simple text with section headings and bullet points. No markdown symbols such as # or **.",
        "Output only the resume text.",
    ]
    return "\n".join(lines)


BULLET = re.compile(r"^\s*[-•▪◦‣o]\s+")
YEAR = re.compile(r"\b(19|20)\d\d\b")
LINK_HOSTS = re.compile(r"(https?://|www\.|linkedin\.com|github\.com|behance\.net|dribbble\.com|medium\.com|substack\.com)", re.I)


def check(people):
    """Checks each written resume against its persona. Returns the number with problems."""
    by_quality, bad = {}, 0
    for p in people:
        path = OUT / "generated" / f"{p['id']}.txt"
        if not path.exists():
            continue
        text = path.read_text()
        words, target = len(text.split()), WORDS[p["length"]]
        issues = []
        if not 0.8 * target <= words <= 1.25 * target:
            issues.append(f"{words} words, aimed for about {target}")
        emails = re.findall(r"[\w.+-]+@([\w-]+(?:\.[\w-]+)+)", text)
        if not emails or any(d.lower() != "example.com" for d in emails):
            issues.append("email must be on example.com")
        if "555" not in text:
            issues.append("no 555 phone number")
        hosts = [m.group(0) for m in LINK_HOSTS.finditer(text)]
        if any("example.com" not in line for line in text.splitlines() if LINK_HOSTS.search(line)):
            issues.append(f"links off example.com: {', '.join(sorted(set(hosts)))}")
        if re.search(r"^\s*#|\*\*|^\s*\*\s", text, re.M):
            issues.append("markdown symbols")
        # Share of bullets with a number in them, years left out. Strong resumes should
        # be well above weak ones, or the quality setting isn't doing its job.
        bullets = [line for line in text.splitlines() if BULLET.match(line)]
        with_numbers = sum(1 for line in bullets if re.search(r"\d", YEAR.sub("", line)))
        share = with_numbers / len(bullets) if bullets else 0
        by_quality.setdefault(p["quality"], []).append(share)
        if issues:
            bad += 1
        print(f"{'FIX ' if issues else 'ok  '} {p['id']}  {p['function']:<12} {p['level']:<12} {p['quality']:<7} "
              f"{words:>4} words  {len(bullets):>2} bullets, {share:.0%} with numbers"
              f"{'  <- ' + '; '.join(issues) if issues else ''}")
    for quality in QUALITY:
        shares = by_quality.get(quality)
        if shares:
            print(f"{quality:<8} {len(shares):>3} resumes, {sum(shares) / len(shares):.0%} of bullets with numbers on average")
    return bad


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=str(DEFAULT_MODEL))
    ap.add_argument("--pilot", type=int, help="write only this many, spread across functions")
    ap.add_argument("--personas-only", action="store_true")
    ap.add_argument("--check", action="store_true", help="check the resumes already written, and change nothing")
    args = ap.parse_args()

    people = personas()
    if args.check:
        raise SystemExit(1 if check(people) else 0)
    (OUT / "generated").mkdir(parents=True, exist_ok=True)
    (OUT / "personas.json").write_text(json.dumps(people, indent=2))
    # The exact prompt for each persona, so any model can write the same set.
    (OUT / "prompts.jsonl").write_text("".join(json.dumps({"id": p["id"], "prompt": prompt_for(p)}) + "\n" for p in people))
    if args.personas_only:
        print(f"{len(people)} personas and prompts written to {OUT}")
        return
    # A pilot takes one persona from each of several functions, at different levels.
    todo = people[:: max(1, len(people) // args.pilot)][: args.pilot] if args.pilot else people
    todo = [p for p in todo if not (OUT / "generated" / f"{p['id']}.txt").exists()]
    print(f"to write: {len(todo)}", flush=True)

    from mlx_lm import generate, load
    from mlx_lm.sample_utils import make_sampler

    model, tok = load(args.model)
    sampler = make_sampler(temp=0.8, top_p=0.95)
    for p in todo:
        messages = [{"role": "user", "content": prompt_for(p)}]
        chat = tok.apply_chat_template(messages, add_generation_prompt=True, tokenize=False, enable_thinking=False)
        text = generate(model, tok, prompt=chat, max_tokens=1200, sampler=sampler, verbose=False).strip()
        (OUT / "generated" / f"{p['id']}.txt").write_text(text + "\n")
        print(f"ok   {p['id']}  {p['function']:<12} {p['level']:<12} {p['quality']:<7} {len(text.split())} words"
              f"{'  twist: ' + p['twist'][:50] if p['twist'] else ''}", flush=True)
    print("done", flush=True)


if __name__ == "__main__":
    main()
