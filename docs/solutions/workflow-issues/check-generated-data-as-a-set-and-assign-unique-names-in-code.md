---
title: Parallel LLM writers share favorites, so check the set and assign names in code
date: 2026-10-16
last_updated: 2026-10-18
category: workflow-issues
module: synthetic-resume-generation
problem_type: workflow_issue
component: development_workflow
related_components: ["tooling"]
severity: medium
applies_when:
  - Several parallel subagents, or several runs of one model, each write part of one dataset that must stay varied
  - A field has to be unique or rare across the set, such as a name, id or email, and the writers pick it freely
  - Every per-file check passes but nobody has measured the set as a whole for repeats or missing vocabulary
  - The writers inherit a workspace CLAUDE.md or style guide that the generated data should not follow
  - A seeded generator already produced prompts that writers used, and more items must be added without changing the old ones
  - A new check, such as a phone or link pattern, is about to judge data written in many countries' styles
tags: ["synthetic-data", "parallel-agents", "mode-collapse", "set-level-validation", "name-collisions", "style-leak", "claude-md", "seeded-generation", "regex-checks", "real-data-testing"]
---

# Parallel LLM writers share favorites, so check the set and assign names in code

## Context

Eight Claude Opus 5.5 subagents wrote 156 synthetic resumes in parallel, about 19 each, as inputs for training a job-fit model. A seeded persona list in `model/make_resumes.py` fixed each resume's function, level, industry, writing quality and length. Every resume passed the per-file check: length, an example.com email, a 555 phone number, no markdown, and a share of bullets with numbers.

Counted as a set, the resumes had problems no single file showed. Three writers each named their person "Marisol Quintanilla". Two chose "Devin Marchetti". The first name "Kristine" appeared on 5 resumes, and so did the surname "Marchetti". The brief had told the writers to avoid stock names, so all of them reached for the same "unusual" ones.

A second batch of 143 resumes, written for specific job postings, needed the same fix before any writer started. Four more traps turned up in the same pipeline. A style rule leaked in from the workspace. A seeded generator would have shifted if anyone added a draw. A float comparison failed at a tolerance edge. And a stricter contact check was wrong until it ran on the real resumes.

## Guidance

Parallel copies of one model share its favorite choices, so they are not independent samples. Settings fixed in code held across the eight writers. Strong resumes put a number in 85% of their bullets and weak ones in 4%. The name was left to the writers, and it collided. Anything left to the writers will converge, so fix it in code or measure it across the set.

### Check the set as well as each file

A per-file check judges one document. Add a rule that reads all of them together. Here every full name must be unique, and no first or last name may appear on more than two resumes. A cap of two allows ordinary overlap and still flags a cluster like five resumes named Kristine.

Run the rule over every document, even when the per-file checks are narrowed to a few ids. Otherwise a fix to one file can reuse a name held by another, and nothing complains. From `model/make_resumes.py`:

```python
def check(people, everyone=None):
    """Checks each written resume in `people` against its persona. Then it checks the names across
    `everyone` (all personas by default), so a check of a few ids still catches a reused name.
    Returns the number of problems."""
    by_quality, bad, names = {}, 0, {}
    for p in everyone or people:
        path = OUT / "generated" / f"{p['id']}.txt"
        if path.exists():
            names[p["id"]] = name_line(path.read_text())
    ...  # per-file checks on `people`
    full = Counter(names.values())
    firsts = Counter(n.split()[0] for n in names.values() if n)
    lasts = Counter(n.replace(".", "").split()[-1] for n in names.values() if n)
    repeats = [f"{n} x{k}" for n, k in full.items() if k > 1]
    repeats += [f"first name {n} x{k}" for n, k in firsts.items() if k > 2]
    repeats += [f"last name {n} x{k}" for n, k in lasts.items() if k > 2]
```

Any repeat counts as a problem, and the script exits 1.

### Take favorite fields out of the writers' hands

If the model has favorites for a field, assign the value in code and put it in the prompt. Telling writers to avoid values only moves the collision. Asking the same model to repair the collisions repeats the failure. The first repair here did exactly that: the orchestrating agent, the same model, picked replacement names by hand. One matched an existing full name exactly, and three more names ended up on three resumes each.

The 143 job-posting resumes get their names from `assign_names` in `model/make_tailored.py`:

```python
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
```

- Draws mix five regional pools, so no single culture dominates.
- Any first or last name already on an earlier resume is skipped, so batch two can't clash with batch one. `used_names()` reads only the first batch's folder today, so a third batch needs it extended.
- Each name is used at most twice, the same cap as the set rule.
- A pool that is too small ends in an error, not a quiet shortfall. It fired once, at 138 names for 143 resumes, before any prompt was written.

Size the pools from the cap. A batch of n at a cap of c needs at least n/c unused first names and as many unused last names. For 143 at a cap of 2, that is 72 of each.

### Put the value in the prompt, then check the writer used it

The tailored check compares the assigned name with the name line on the page, using the same `name_line()` the set rule uses:

```python
if name_line(text) != p["name"].title():
    issues.append(f"name line is {name_line(text)!r}, expected {p['name']!r}")
```

### Count words across the set

Subagents inherit the workspace instructions. Here those included a personal writing guide that bans words like "leveraged" and "spearheaded". The writers followed a rule nobody gave them for this task. Not one of the 156 resumes used either word, though real resumes use both often. Other stock phrases got through: 36 of the 42 weak resumes say things like "team player".

No per-file check can see this, because one resume without "leveraged" is normal. Count the words you expect in real data, and the words your own instructions ban. The check scripts have no vocabulary rule yet, so this gap stays a recorded limit of the data. A second set-wide count came back clean: only 11 lines of six or more words appear in more than one resume, mostly school names. Counts that find nothing are still worth running.

### Freeze the plan once writers start

A seeded loop is a sequence. One extra draw inside it shifts every later draw, which silently changes the personas, and so the prompts, for resumes already written. Give new draws their own generator, and read the saved plan instead of rebuilding it:

```python
def cross_pairs(force=False):
    ...  # refuses to rewrite the cross pairs once any of them has a teacher label
    rng = random.Random(SEED + 1)
    plan = json.loads((PROMPTS.parent / "plan.json").read_text())
    ...
```

`build_pairs.py` got the same guard. It refuses to rewrite the pairs or jobs that existing labels depend on.

Then refuse to rebuild prompts once outputs exist:

```python
def build(force=False):
    # The resumes are written from these prompts. Rebuilding after that would orphan them.
    if not force and any((RESUMES / "tailored").glob("*.txt")):
        raise SystemExit("Tailored resumes already exist. Pass --force to rebuild the prompts anyway.")
```

### Compare tolerances in whole numbers

The length check was written as `0.85 * target <= words <= 1.15 * target`. In floating point, `1.15 * 200` is `229.99999999999997`, so a 230-word resume on a 200-word target failed a check it should pass. Compare integers instead:

```python
def within_band(words, target):
    """Within 15% of the target, in whole numbers so 230 words on a 200 target isn't lost to float error."""
    return 85 * target <= 100 * words <= 115 * target
```

A unit test in `model/tests/test_pipeline.py` pins both edges: 230 and 170 pass, 231 and 169 fail. The check must also match the brief. An earlier version allowed 20% while the writers were told 15%.

### Run a new check on the real set before trusting it

The first contact check was loose. It passed a resume if "555" appeared anywhere, and passed a real LinkedIn link if the same line held an example.com email. The stricter version checks each phone number and each link on its own.

Its first draft flagged 8 of the 299 resumes for having no phone. All 8 had one, in the styles of India, France, the UK, Australia, the Netherlands and Germany. The pattern only knew American numbers. The second draft accepted those but counted "P.O. Box 40512-00100, Nairobi" as a phone without 555. Now the rule skips numbers after a standalone "Box", and all 299 pass.

A test written from the author's own examples would have passed both broken drafts. So run any new check over the full real set before writing its tests, then turn every surprise into a test case. `test_phone_formats_from_other_countries` and `test_years_and_postal_boxes_are_not_phones` hold them now.

## Why This Matters

- The per-file checks gave a false all-clear. All 156 resumes passed while names repeated across the set. Writers can't see each other's output, so the set holds less variety than its count suggests. Names are the visible sign, and other shared habits are harder to spot.
- A repair by the same model repeats the failure, as the hand-picked replacements did.
- Assigning in code makes uniqueness checkable. The second batch has 143 unique names and no clash with the first, and a short pool fails loudly.
- A shifting plan breaks the link between a resume and its spec. The check compares each resume with its persona, so if the persona list moves, the verdicts are wrong and nothing reports an error.
- In this user's projects, real bugs have come from live runs and from reading real output, not from mocks or fixtures (auto memory [claude]). That fits here: the name clusters and the vocabulary gap appeared only when the real set was counted. No unit test covers `assign_names` or the set-wide name rule. They depend on running `--check` against the real resumes after every batch.

## When to Apply

- Several parallel subagents write items for one dataset, such as resumes, job posts, reviews, support tickets or test fixtures.
- The model invents a field it tends to favor, such as names, employers, cities or usernames.
- A later batch joins a set that already exists. Skip the values earlier batches used.
- A seeded generator has produced outputs you want to keep, and you are adding a field, a pair type or a batch.
- Subagents run in a workspace whose instruction file carries style rules.
- A length or count tolerance is written as a percentage.
- A new pattern check, for phones, links or dates, is about to judge data from many countries.

## Examples

Names, before. The prompt said "Invent the name." Every file passed, but "Marisol Quintanilla" appeared on 3 resumes, "Kristine" on 5 and "Marchetti" on 5. Replacements picked by the same model collided again.

Names, after. The first batch passes the set rule, with 156 distinct names and no first or last name on three or more resumes. The second batch's prompt says "Use the name {name}." It has 143 unique names and 0 clashes with the first.

Float edge, before: `0.85 * target <= words <= 1.15 * target` rejects 230 words on a 200 target. After: `85 * target <= 100 * words <= 115 * target` accepts 230 and rejects 231.

Seeded generation, a trap avoided by design: an extra `rng.random()` inside the persona loop would change every later persona. `cross_pairs()` uses `SEED + 1` and reads `plan.json`, and `build()` exits unless `--force` is passed.

Result: `make_resumes.py --check` and `make_tailored.py --check` exit 0 on all 299 resumes, and `npm run test:model` passes.

## Related

- `model/LEARNING.md`, lesson 8, is the project-log account of the same incident, and lesson 6 covers draw-order shifts in seeded generators. Lesson 15 covers the contact check.
- `docs/solutions/architecture-patterns/stamp-teacher-labels-with-a-prompt-hash-and-refuse-to-mix-stamps.md` guards the same pipeline one stage later, on the teacher's labels.
- `docs/solutions/conventions/package-chrome-extension-from-allowlist-never-zip-repo-root.md` shares the principle of enforcing a rule with a script that fails closed.
- `docs/plans/2026-10-16-001-feat-train-student-decision-model-plan.md` is the plan this data feeds.
