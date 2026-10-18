---
title: Stamp each teacher label with a hash of its prompt, and refuse to mix stamps
date: 2026-10-18
category: architecture-patterns
module: teacher-label-pipeline
problem_type: architecture_pattern
component: development_workflow
related_components: ["tooling", "testing_framework"]
severity: high
applies_when:
  - A slow or paid step writes labels or other outputs, and relabeling would cost hours
  - A later step rebuilds part of the context live, such as buildQuestions in scoring.js, and pairs it with stored answers
  - Scripts hand data down a chain (labels, then rows, then training) and each one trusts the file before it
  - The producer's code imports something heavy, like MLX, so a checker can't import it
  - Labels already exist from before any stamp, or a second teacher model could write into the same folder
tags: ["prompt-stamp", "label-provenance", "teacher-student", "stale-labels", "ast", "golden-test", "fail-closed", "backfill"]
---

# Stamp each teacher label with a hash of its prompt, and refuse to mix stamps

## Context

The teacher labeled 3,286 resume-job pairs overnight. It was Qwen 3.8 27B, run through mlx-lm on a Mac. Each label is one JSON file with the teacher's full probabilities for nine questions. A small student model trains on those probabilities.

A label means something only next to the prompt that drew it. The questions come from `scoring.js`, the extension's rubric. The rest lives in `model/teacher_eval.py`. It builds the prompt (`SYSTEM`, `build_state`, `build_prompt`) and reads the answers (`Reader`, `score_job`).

`make_rows.py` runs later and calls `buildQuestions` live. If the rubric or any of those parts changed after labeling, the rows would pair new questions with old answers. Nothing would fail, and the student would train on them anyway. A second teacher model could mix in the same way. Before commit `5911c1c`, a label recorded its teacher and time but not its prompt.

## Guidance

### Hash the source text of every part that decides an answer

Each label now carries a 12-character stamp. It hashes the rubric plus the source of five named parts:

```python
# model/teacher_prompt.py
STAMPED = ("SYSTEM", "build_state", "build_prompt", "Reader", "score_job")

def prompt_stamp(r=None, source=None):
    """A short hash of everything that decides a label besides the pair itself.
    Labels with one stamp answered one prompt, read the same way."""
    parts = stamped_parts(TEACHER.read_text() if source is None else source)
    return hashlib.sha1(json.dumps([parts, rubric() if r is None else r], sort_keys=True).encode()).hexdigest()[:12]
```

`stamped_parts()` uses `ast.get_source_segment` to pull each part out of `teacher_eval.py` as text. `teacher_eval.py` imports MLX at the top, so this module never imports it, and any script on any Python can compute the stamp. A part that is renamed or deleted stops the run with a message.

It hashes raw source text, not `ast.dump`. The dump varies across Python versions, and the labeler runs 3.12 while `make_rows.py` runs 3.14. The price is a false alarm: a comment edit inside a stamped part changes the stamp. That fails safe.

### Scope the stamp by walking the labeler's call path

The first stamp hashed only the system prompt, the rubric and the prompt template. A six-reviewer code review found what it missed. The state template and the answer-reading code could change a label while the stamp stayed put.

To scope it, list what the labeler imports and follow each call to the saved answer. Every name `label()` imports from `teacher_eval.py`, except `DEFAULT_MODEL`, is now in `STAMPED`. The teacher's folder name is checked on its own.

The stamp still doesn't cover a few things:
- The flags on the `apply_chat_template` call, and the model's own tokenizer template.
- The teacher's weights. The check compares folder names.
- Module constants the stamped parts read, such as `CHUNK`. It sets how many prompt tokens are fed per step, so it shouldn't change an answer.
- `buildState` in `scoring.js`. The `ParityWithScoringJs` test guards the Python copy instead.

### Check where old answers meet live code, before the slow step

Two places join old answers to current code, and both check first. `label()` adds new labels beside old ones, and refuses before the 27B model loads:

```python
# model/label_pairs.py, in label()
r = rubric()
stamp, teacher = prompt_stamp(r), Path(model_path).name
existing = read_labels()
if existing and (problem := label_problems(existing, stamp, teacher)):
    raise SystemExit(problem)
model, tok = load(model_path)
```

`make_rows.py` pairs labels with questions built live, so it computes today's stamp itself:

```python
# model/make_rows.py, in main()
# The labels must answer the questions these rows will ask, so they must carry today's stamp.
prompt = prompt_stamp()
if problem := label_problems(labels.values(), prompt):
    raise SystemExit(problem)
```

### Make each refusal name the next command

```python
# model/label_pairs.py, in label_problems()
return (f"{sum(others.values())} labels answered another prompt ({dict(others)}), not the current {stamp}. "
        f"Move them aside with mv model/private/labels model/private/labels-{old}. "
        f"If only the stamp's definition changed, run python3 model/label_pairs.py --stamp-existing --from {old}.")
```

An agent running unattended can act on `mv model/private/labels model/private/labels-<old>`. It can't act on "label into a fresh folder". The unstamped case prints a `git log` command dated from the earliest label. Tests assert each message holds its hint.

### Treat a backfill as an attestation

`--stamp-existing` writes today's stamp onto labels that have none. With `--from`, it also moves labels that carry an old stamp. Each one is marked:

```python
# model/label_pairs.py, in stamp_existing()
if not label.get("prompt") or (old and label["prompt"] == old):
    write_label(path, {**label, "prompt": stamp, "stampedBy": "backfill"})
```

The tool can't know whether anything changed since those labels were written. A person or an agent checks:
- Run the `git log -p --since=<first label date> -- scoring.js model/teacher_eval.py` command the refusal prints, and read the diff.
- `git log` sees commits only, so also check `git status` and `git diff` on the same files.
- When the stamp's definition widens, check the newly covered code the same way, then restamp with `--from <old stamp>`.

The command takes the labeler's lock, so it can't touch files a running labeler is writing.

### Carry the stamp forward in a manifest, and hash the bytes you parse

`make_rows.py` writes a manifest beside the rows. It holds the stamp, the teacher, pair coverage, row counts and the sha1 of each file. The old manifest goes first, so a crash leaves no manifest next to new rows:

```python
# model/make_rows.py, in write_rows()
(OUT / "manifest.json").unlink(missing_ok=True)
for split, rows in files.items():
    (OUT / f"{split}.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
(OUT / "manifest.json").write_text(json.dumps({..., **{f"{split}_sha1": ... for split in files}}, indent=2))
```

`train_student.py` reads each rows file once and hashes the same bytes it parses. A second read could change between the hash and the parse:

```python
# model/train_student.py, in read_rows()
data = (rows_dir / f"{name}.jsonl").read_bytes()
sha1[name] = hashlib.sha1(data).hexdigest()
if sha1[name] != manifest.get(f"{name}_sha1"):
    raise SystemExit(f"{name}.jsonl doesn't match its manifest. Rebuild the rows with python3 model/make_rows.py.")
```

The run folder keeps those hashes in `rows.json`, and `--resume` refuses if the rows changed since the run began.

### Pin the real stamp in a test

The repo is public and the labels are private, so no public test can read them. A test can still pin the stamp they carry:

```python
# model/tests/test_pipeline.py
CURRENT_STAMP = "330f0dbe678c"

def test_the_real_stamp_is_pinned(self):
    self.assertEqual(teacher_prompt.prompt_stamp(), CURRENT_STAMP,
                     "The teacher's prompt changed, so the current labels answer a different one.")
```

It works like `test_order_is_pinned`, which fixes the order a labeling run depends on. Anyone who edits a stamped part or the rubric sees the failure and the reason.

## Why This Matters

- Nothing fails when labels and prompt drift apart. The rows build and the student trains. Finding it later costs a night of labeling plus a 4.6-hour training run.
- Rows from two prompts teach the student two different questions at once.
- A false alarm costs one command. A silent mismatch costs the run.
- A stamp is only as complete as its list. The tests prove each listed part moves the stamp, but not that the list is complete. Code review found the first gap by reading the call path. In this user's projects, real bugs have come from live runs and from reading real output, not from mocks or fixtures (auto memory [claude]).
- The rows these checks guard trained a student that matched Jev on the 101-job test: a mean gap of 0.62 against 0.59, within noise. That run started before the manifest existed. From the next run on, `summary.json` names the prompt stamp, the teacher and the hash of each rows file.

## When to Apply

- A slow or paid step writes files, and a later step reads them with code that can change. LLM labels, cached embeddings, generated fixtures and cached API responses all fit.
- The later step rebuilds part of the context live, as `make_rows.py` does with `buildQuestions`. That join is where drift hides.
- More than one producer could write into one folder: a second teacher, a second prompt version, a second embedding model.
- An agent runs the pipeline unattended, so every refusal has to name a command.

Skip it when regenerating is cheap. Delete the output and rebuild.

## Examples

**The backfill.** The 3,286 labels predated stamps. The last commit to the prompt files was `04da94f`, at 22:16 on 2026-10-16, one minute after the first label. Its diff only moved the system prompt into a `SYSTEM` constant, with the same words. It also made `score_job` return the probabilities the labeler needed to run at all. `scoring.js` last changed eight hours earlier. So every label got the current stamp. After review widened the definition, git showed the newly covered code unchanged too, and the labels were restamped with `--from`.

**What the tests pin.** Each stamped part moves the stamp, and `main()` doesn't:

```python
for old, new in (('fit."', 'fit!"'), ("return resume", "return resume.strip()"), ("return state", "return state + ''"),
                 ("pass", "x = 1"), ("return 1", "return 2")):
    self.assertNotEqual(base, self.stamp(self.SOURCE.replace(old, new)), new)
self.assertEqual(base, self.stamp(self.SOURCE.replace("print('hi')", "print('bye')")), "main() doesn't decide labels")
```

The refusals fire before the model loads, which a fake `load` that raises proves. A rows file edited after the build is refused too.

**Porting it.** These are sketches, not code in this repo:

| Pipeline | Stamp | Store it | Check it |
|---|---|---|---|
| LLM labels | prompt text, answer-reading code, rubric | in each label file | before the model loads and before rows are built |
| Cached embeddings | model id and revision, cleaning and chunking code | in the index header | when the index opens, before a query or a merge |
| Generated fixtures | generator source, seed, schema | in a manifest with a hash per file | in test setup, before any test reads them |

## Related

- `docs/solutions/workflow-issues/check-generated-data-as-a-set-and-assign-unique-names-in-code.md` guards the same pipeline one stage earlier. Its "freeze the plan once writers start" rule is the input-side version of this one.
- `docs/solutions/conventions/package-chrome-extension-from-allowlist-never-zip-repo-root.md` shares the fail-closed rules: keep the list complete, read back what was built, and name the fix in the error.
- `model/LEARNING.md`, lesson 16, is the project-log account. Lesson 17 has the grade.
- `model/teacher_prompt.py`, `model/label_pairs.py`, `model/make_rows.py`, `model/train_student.py` and `model/tests/test_pipeline.py` hold the code.
