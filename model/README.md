# Worth Applying? model

Work toward a small decision model of our own. It answers the nine questions the extension asks Jev, each with probabilities. They cover an overall fit from 0 to 4, six scorecard ratings, the main factor and a visa estimate. If it scores close to Jev on the 101-job test, the extension could offer it without a TypeSafe key.

[LEARNING.md](LEARNING.md) explains each step as we go, with the decisions and the reasons.

## Plan

1. **Teacher check.** Run a local open model on the 101 test jobs with Jev's exact questions. Grade it with the same cross-validated method used for Jev. If the teacher can't get near Jev, a student trained on its answers won't either. Done: the teacher tied Jev.
2. **Training data.** About 2,000 job postings from Trackly, 156 generated resumes and 143 resumes written for specific postings, some with copy-paste damage added. Labels come from the teacher, checked by a blind Opus 5.5 judge on 120 pairs (LEARNING.md, lesson 11).
3. **Fine-tune.** Qwen3.5 2B with a Clef decision head, trained through LoRA on the teacher's probabilities. Unsloth's MLX trainer runs it on Apple Silicon (LEARNING.md, lesson 7).
4. **Test.** The same 101 jobs, the same grading.
5. **Decide how to ship,** only if the student gets close to Jev.

## Data rules

- Training labels come only from models whose licenses allow training on their outputs, and from our own ratings. The teacher is Qwen 3.8 27B, released under Apache 2.0.
- Jev's answers and Lenny's Jobs reviews are never training labels. Lenny's reviews are the test benchmark and nothing else.
- Claude Opus 5.5 writes the generated resumes. They are only inputs, never the answers the student learns. Anthropic allows this for models that don't compete with its own (see LEARNING.md, lesson 5).
- Every generated resume has an invented name, an example.com email and a 555 phone number.
- Everything in `model/private/` and `eval/private/` stays on the machine that made it. Both folders are git-ignored.

## Run the teacher check

```bash
uv venv model/.venv --python 3.12
uv pip install --python model/.venv/bin/python mlx-lm
model/.venv/bin/python model/teacher_eval.py --out eval/private/teacher-qwen38
node eval/compare-versions.mjs --extra eval/private/teacher-qwen38 --extra-name qwen38
```

`teacher_eval.py` reads the questions from `scoring.js` and reads the model's probability for every allowed answer, so its scores are probability-weighted like Jev's. It writes results in the shape `eval/score-jev.mjs` writes. It needs the test records and resume in `eval/private/`, and the model in LM Studio's MLX format.

## Write the resumes

```bash
python3 model/make_resumes.py --personas-only   # 156 personas and one prompt each, from a fixed seed
# Claude Opus 5.5 writes model/private/resumes/generated/<id>.txt for each line of prompts.jsonl
python3 model/make_resumes.py --check           # length, contact details, markdown, numbers per bullet, and repeated names across the set
```

`--check` prints one line per resume and a summary by writing quality. Strong resumes should have far more bullets with numbers than weak ones. The name rule always covers every resume, even with `--ids`.

Resumes written for specific postings, so the training set has strong matches:

```bash
python3 model/make_tailored.py            # one prompt per chosen job, with an assigned name (refuses to rebuild once resumes exist)
python3 model/make_tailored.py --cross    # pairs each tailored resume with another job in its function
python3 model/make_tailored.py --check    # length, contact details, markdown, and the assigned name
```

## Pair and label

```bash
python3 model/build_pairs.py                                    # 1,000 jobs, 3 resumes each, test jobs left out
caffeinate -is model/.venv/bin/python model/label_pairs.py      # the teacher labels all 3,286 pairs (about 8 hours)
```

`build_pairs.py` reads the job postings from `~/coding-projects/job-descriptions/<function>/jds/`. It refuses to run without the test jobs to check against, and refuses to rewrite pairs that already have labels (`--force` overrides). `label_pairs.py` labels the tailored pairs, then the cross pairs, then the rest. Every label records a stamp of the prompt it answered and the teacher that made it. `python3 model/label_pairs.py --stamp-existing` stamps labels written before stamps existed, and `--from <stamp>` moves labels from an old stamp definition. It can stop and restart at any point, and it skips pairs that already have a label in `model/private/labels/`. While it runs, it holds a lock that stops the training and grading scripts from loading a model beside it.

## Train and grade the student

The training environment is a pinned copy of the Unsloth app's own setup (Python 3.13):

```bash
uv venv model/.venv-train --python 3.13
uv pip install --python model/.venv-train/bin/python --no-deps -r model/requirements-train.txt
python3 model/make_rows.py                                     # train and valid rows, after labeling
model/.venv-train/bin/python model/train_student.py --smoke    # 20 steps, saving and evaluating every 10
model/.venv-train/bin/python model/train_student.py --smoke --resume --steps 24   # resumes from step 20
model/.venv-train/bin/python model/student_eval.py --model model/private/student/smoke/merged --check-reload
caffeinate -is model/.venv-train/bin/python model/train_student.py --name run1
model/.venv-train/bin/python model/student_eval.py --model model/private/student/run1/merged
node eval/compare-versions.mjs --extra eval/private/student-run1 --extra-name student-run1
```

Training runs over the 16-bit base, since the merged model is 16-bit (`--four-bit` trains over a 4-bit copy instead). `make_rows.py` stops if a pair file is missing or under 95% labeled. It also stops if no test jobs are there to audit against, or if a training resume shares text with the real test resume. So do labels that don't carry today's prompt stamp, or that come from more than one teacher. Training refuses rows that don't match the manifest `make_rows.py` wrote with them. `--check-reload` fails if the saved model answers differ from the trained one by more than 0.02 in any probability. `student_eval.py` writes only under `eval/private`, and refuses to mix results from two models in one folder (`--fresh` sets the old folder aside). Training and grading refuse to start while the teacher is labeling, because both need most of the Mac's memory.

## Try the student from the CLI

The Unsloth app serves Clef models only on NVIDIA or AMD GPUs, so on a Mac the student gets its own small server. It answers at `/v1/systemone` on `127.0.0.1`, the same path as Jev's API. Start it, wait for its "serving" line, then check it answers like the trained student, using only generated resumes, before scoring a real one:

```bash
model/.venv-train/bin/python model/serve_student.py --model model/private/student/run1/merged
python3 model/serve_check.py --run model/private/student/run1
node --import ./eval/local-endpoint.mjs cli.js --resume resume.txt --job job.txt
```

The preload sends the CLI's request to the server instead of TypeSafe, with a placeholder key, so the real key is never read. It names the student exactly, and the server answers only to that name. It also refuses redirects, proxies, any address but `127.0.0.1`, and any answer that didn't come from a local checkpoint. On an NVIDIA or AMD machine, the Unsloth app can serve the student instead. Clone the merged folder into `~/.unsloth/studio/outputs/`, pick it under Settings > API, and point `LOCAL_DECISION_URL` and `--url` at the app.

