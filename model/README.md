# Worth Applying? model

Work toward a small decision model of our own. It answers the nine questions the extension asks Jev, each with probabilities. They cover an overall fit from 0 to 4, six scorecard ratings, the main factor and a visa estimate. If it scores close to Jev on the 101-job test, the extension could offer it without a TypeSafe key.

[LEARNING.md](LEARNING.md) explains each step as we go, with the decisions and the reasons.

## Plan

1. **Teacher check.** Run a local open model on the 101 test jobs with Jev's exact questions. Grade it with the same cross-validated method used for Jev. If the teacher can't get near Jev, a student trained on its answers won't either. Done: the teacher tied Jev.
2. **Training data.** Job postings from Trackly, and 156 generated resumes plus a few hundred from ResumeAtlas. Labels come from the teacher, checked against a small gold set rated by hand.
3. **Fine-tune.** A 1 to 3 billion parameter model with LoRA through Unsloth, or mlx-tune on Apple Silicon.
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
python3 model/make_resumes.py --check           # length, contact details, markdown, and numbers per bullet
```

`--check` prints one line per resume and a summary by writing quality. Strong resumes should have far more bullets with numbers than weak ones.
