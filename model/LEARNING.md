# Learning log: our own decision model

On October 16, 2026, a free model running on a MacBook scored our 101 test jobs about as well as Jev, TypeSafe's decision model. That was step one of this project. The goal is a small model of our own that answers the extension's nine questions, so scoring could work without a TypeSafe key.

This log keeps each lesson in the order we learned it, with the decisions and the reasons. It holds no private data. No resumes, no Lenny's Jobs reviews and no job-by-job results appear here.

## 1. The big picture

A decision model is a language model trained to pick from fixed options and say how sure it is. It doesn't write prose. Ask how well a resume fits a job on a 0 to 4 scale, and it answers something like "1: 58%, 0: 40%, 2: 2%". Jev works this way.

We don't train on Jev's answers, and Lenny's reviews are kept for testing. So a large open model, the teacher, answers our nine questions for thousands of resume and job pairs. A small model, the student, learns to copy those answers. Think of a senior recruiter grading thousands of applications so a junior can learn the pattern. The student ends up much smaller, so it runs cheaper and faster.

The 101 test jobs never go into training. They're the exam. If the student studied them, a high score would only prove it memorized the answers.

The teacher never types its answers. The script feeds it the resume, the job and the questions, then stops at `fit=`. It reads the probability the model gives each digit, and the weighted average becomes the score. Jev reports its scores the same way. Thinking mode is off, because we want the probability on the very first answer token.

## 2. Reading the scoreboard

| | Jev | Qwen 3.8 teacher |
|---|---|---|
| Average gap from Lenny's score (1 to 10) | 0.59 | 0.63 |
| Within 1 point | 93 of 101 | 89 of 101 |
| Exact match | 50 | 49 |
| Rank agreement (1.0 is perfect) | 0.83 | 0.82 |
| Time per job | 0.1 s, on TypeSafe's servers | 11 s, on a Mac |

The average gap is the main number. It's how far each score lands from Lenny's, averaged over all 101 jobs. Lower is better.

A gap of 0.04 can be luck. With only 101 jobs, the numbers move around. So the script resamples the jobs 2,000 times, which is called a bootstrap. The teacher's gap minus Jev's lands between -0.09 and +0.17. That range includes zero, so the two are tied on this test.

Each model needs its own calibration curve. For the same fit, one model might say 3.4 where another says 2.8. The curve converts each model's raw answers onto Lenny's scale, like converting currencies.

The curve is cross-validated. If it were fitted on all 101 jobs and graded on the same jobs, it would partly memorize them. So the script fits it on four fifths of the jobs and scores the last fifth, five times over. Every job gets scored by a curve that never saw it.

The teacher is weaker on entry-level APM roles, with a gap of 0.68 against Jev's 0.47. It's slightly better on clear mismatches. It's also 100 times slower than Jev, and that's the reason to train a student.

## 3. Variety and balance

The student only learns what it sees. If every training job were a product role, it would never meet a product manager's resume next to a legal posting. That pair should score 0, and a user will hit it in the first week. So the set covers 13 job functions, from interns to VPs and from startups to large companies.

The answers need balance too. If most pairs were good fits, a model that always said 3 would look accurate. Each job will get a likely fit, a partial fit and a mismatch, so every answer from 0 to 4 shows up often.

One niche shouldn't flood the set. We have 315 Deployment Strategist postings. Used whole, they'd be about 15% of the jobs for one rare title. We'll use about 100.

Test jobs must stay out, even by accident. That mistake is called leakage, and it quietly inflates the final score. The pairing step will drop any job that appears in the test set.

## 4. Synthetic resumes

Real resumes belong to real people, and training on them would need their consent. Generated resumes avoid that. They also let us choose the mix, which a pile of collected resumes never would.

We write the people first, then the resumes. `make_resumes.py` builds 156 personas from a fixed seed, 12 for each of the 13 functions. Each function gets 2 students, 2 new graduates, 2 early-career people, 3 mid-level, 2 senior and 1 leader. A persona also sets the industry, the type of employer, the country (1 in 5 outside the US) and the length. About half get a twist, such as a career switch, a caregiving gap or a need for visa sponsorship.

Generated resumes tend to sound alike, and they tend to be too polished. If every resume reads well, the student never learns what a weak one looks like. So each persona has a writing quality: weak (30%), average (45%) or strong (25%). A weak resume has vague bullets, filler and uneven formatting, like many real ones.

Claude Opus 5.5 writes the resumes, one per prompt in `prompts.jsonl`. The teacher labels them later. Our usual writing rules don't apply to these resumes. A weak resume needs the clichés real weak resumes have, like "team player" and "other duties as assigned".

## 5. Where training data comes from

A license tag on Hugging Face is the uploader's claim. If they scraped resumes from a website, they may not have had the right to relicense them. Check where the data came from, not just the tag.

No license means you can't use it. The default is all rights reserved. That ruled out the one public dataset with ready-made fit labels.

Real resumes are personal data, whatever the tag says. ResumeAtlas is tagged MIT but doesn't say where its 13,389 resumes came from. We'll use a few hundred for their messy formatting and older careers, with contact details stripped.

Fit for purpose matters most. Our test jobs are mostly 2026 product and tech roles. Older resumes from template sites reflect a different job market, so ResumeAtlas stays a small share.

Claude's output needs its own check. [Anthropic's help center](https://support.claude.com/en/articles/12326764-can-i-use-my-outputs-to-train-an-ai-model) allows Claude's outputs in training data for models that don't compete with Anthropic's. Its examples include content categorization. It rules out general chatbots, open-ended text generators and using Claude's outputs as training targets. Our student picks from fixed options, like a categorizer. The resumes are only its inputs, and the answers it learns come from Qwen under Apache 2.0. The article opens by saying training AI models with Anthropic's services needs written permission, then carves out models that don't compete. We read it that way. Before selling or licensing the model, we'd ask Anthropic in writing.

## 6. A pilot catches what the plan missed

Before writing 156 resumes, we printed the prompts for 5 and read them. Four problems turned up.

- A student was aiming for "Group Product Manager". Titles now come from a pool that fits each level.
- One sentence read "a person who is 5 to 7 years". Each level is now a full phrase.
- A bootcamp graduate was aiming for FP&A manager, and a "consulting firm" employee had a twist saying they worked in government. Each twist now lists who it can apply to. A government or nonprofit twist also sets the employer type.
- Fixing the title lists changed other people's industries and twists. A seeded random generator hands out numbers in a fixed order. When one step takes a different number of draws, every later draw shifts. That's harmless before any resume exists. After that, new fields go at the end of the draw order.

Then Opus wrote the five pilot resumes, and `make_resumes.py --check` read them. It flags length, contact details and markdown. It also counts the bullets that include a number. Strong resumes averaged 94% and weak ones 6%, so the quality setting does its job. The check also caught two resumes about 20% under their target length, which we fixed.

Two rules came out of the pilot. Every email and link uses example.com, so no resume points to a real person. Schools and large employers can be real. Startups and small firms get invented names, so no real small company gains a fake employee.

## 7. Training on a Mac

The Unsloth Studio app (a beta for macOS) installs its own Python setup with Unsloth and Apple's MLX library. That setup includes Unsloth's decision-model trainer for Apple Silicon. So the student can train on a 64 GB M5 Pro, with no cloud GPU.

There are two ways to get a small decision model. One is to start from a model already trained for decisions, such as Laya, with 0.4 billion parameters. But Laya reads at most 1,024 tokens. Our teacher prompts ran from 2,031 to 4,796 tokens, with a median of 3,167. Laya would never see a whole resume and job posting.

The other way is to take a plain small language model and add a fresh decision head. Unsloth calls this design Clef. The head reads one prompt holding every question and scores all their options together. We'll start with Qwen3.5 2B, which is Apache 2.0. The trainer's default limit is 4,096 tokens, so we'll raise it to cover the longest prompts.

The trainer can learn from the teacher's full probabilities, not just its top answer. If the teacher says "1: 58%, 0: 40%", the student learns that the case is close. This is called soft-label distillation. It matters here because the extension's scores are probability-weighted. The student needs the teacher's doubt as well as its pick.

The app also serves decision models on a local endpoint that takes the same kind of request Jev does. Once the student is trained, we can point the extension at the Mac and try it in the real popup.

We'll train from a script in our own environment, with every version pinned, rather than inside the app's setup. The app updates itself. A pinned setup means a run next month repeats a run today.

## Decisions so far

| Decision | Why |
|---|---|
| Build a prototype, then decide after the 101-job test | We learn whether a small model can get close before spending more. |
| Teacher: Qwen 3.8 27B, 4-bit, run locally | Apache 2.0 allows training on its answers, and it tied Jev on the test. |
| Never train on Jev's answers or Lenny's reviews | Lenny's reviews are the test, and Jev is the bar we measure against. |
| Labels from the teacher, checked by a hand-rated gold set | The gold set tests the teacher on jobs Lenny never reviewed. |
| Jobs from Trackly, about 150 for each function | Each job comes with clean tags for function, level and company stage. |
| Resumes: 156 written by Claude Opus 5.5, plus a few hundred from ResumeAtlas | We control the mix and the rights are clean. ResumeAtlas adds real-world mess. |
| Train on the Mac with Unsloth's MLX trainer | The Studio app ships it, and 64 GB is enough for a 2B student. |
| First student: Qwen3.5 2B with a Clef head, trained on soft labels | It reads a whole resume and posting, and the license allows it. Laya can't fit them. |

## Words we've used

| Word | Meaning |
|---|---|
| Bootstrap | Resampling the test set many times to see how much a number moves by luck. |
| Calibration curve | A mapping from a model's raw scores onto the scale you care about. |
| Cross-validation | Fitting on part of the data, scoring on the rest, then rotating. |
| Distillation | Training a small student to copy a large teacher's answers. |
| Leakage | Test data reaching the training set, which inflates the score. |
| LoRA | Training a small set of added weights instead of the whole model, so fine-tuning fits on one GPU. |
| 4-bit quantization | Storing each weight in 4 bits instead of 16. A 27B model then fits in about 16 GB, with a small loss in quality. |
| Seed | The starting number for a random generator. The same seed gives the same "random" list every run. |
| Soft labels | Training targets that are full probabilities, such as 58% and 40%, instead of one right answer. |
| Token | The unit a model reads, about three quarters of an English word. |

## Next

1. Review the five pilot resumes, then have Opus write the other 151.
2. Sample a few hundred ResumeAtlas resumes and strip their contact details.
3. Pair and label about 3,000 resume and job pairs with the teacher, in Unsloth's training format. Test jobs stay out.
4. Rate 50 to 100 pairs by hand for the gold set.
5. Train the student on the Mac with Unsloth's MLX trainer, then grade it on the 101 jobs.
