# Worth Applying? model

Work toward a small decision model of our own that answers the same nine questions the extension asks Jev: an overall fit from 0 to 4, six scorecard ratings, the main factor, and a visa estimate, each with probabilities. If it scores close to Jev on the 101-job test, the extension could offer it without a TypeSafe key.

## Plan

1. **Teacher check.** Run a local open model on the 101 test jobs with Jev's exact questions, and grade it with the same cross-validated method used for Jev. If the teacher can't get near Jev, a student trained on its answers won't either.
2. **Training data.** Public job postings, generated resumes, labels from the teacher, and a small gold set rated by hand to check the teacher.
3. **Fine-tune.** A 1 to 3 billion parameter model with LoRA through Unsloth, or mlx-tune on Apple Silicon.
4. **Test.** The same 101 jobs, the same grading.
5. **Decide how to ship,** only if the student gets close to Jev.

## Data rules

- Training labels come only from models whose licenses allow training on their outputs, and from our own ratings. The teacher is Qwen 3.8 27B, released under Apache 2.0.
- Jev's answers and Lenny's Jobs reviews are never training labels. Lenny's reviews are the test benchmark and nothing else.
- Everything in `model/private/` and `eval/private/` stays on the machine that made it. Both folders are git-ignored.

## Run the teacher check

```bash
uv venv model/.venv --python 3.12
uv pip install --python model/.venv/bin/python mlx-lm
model/.venv/bin/python model/teacher_eval.py --out eval/private/teacher-qwen38
node eval/compare-versions.mjs --extra eval/private/teacher-qwen38 --extra-name qwen38
```

`teacher_eval.py` reads the questions from `scoring.js` and reads the model's probability for every allowed answer, so its scores are probability-weighted like Jev's. It writes results in the shape `eval/score-jev.mjs` writes. It needs the test records and resume in `eval/private/`, and the model in LM Studio's MLX format.
