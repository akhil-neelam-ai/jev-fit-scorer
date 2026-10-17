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

Real resumes are personal data, whatever the tag says. ResumeAtlas is tagged MIT but doesn't say where its 13,389 resumes came from. We planned to use a few hundred for their messy formatting and older careers, with contact details stripped. Lesson 9 reverses that.

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

## 8. Checking the whole set

All 156 resumes passed the check. Short ones averaged 204 words against a target of 200, medium ones 345 against 350, and long ones 533 against 550. The quality setting held at scale too. Strong resumes put a number in 85% of their bullets, average ones in 42% and weak ones in 4%.

Eight Opus writers worked in parallel, about 19 resumes each, and each confirmed it ran as Claude Opus 5.5. Together they used about 1.5 million tokens in 21 minutes.

Checking each file wasn't enough. The problems only showed up across the whole set. Three writers, working separately, each named their person Marisol Quintanilla. Two picked Devin Marchetti. Five resumes used the first name Kristine, and five used the surname Marchetti. Told to avoid stock names, eight copies of one model all reached for the same "unusual" ones. Copies of one model share its favorite choices, so they aren't independent samples.

The fix taught the same lesson twice. Some of my replacement names collided with names already in the set, and one matched exactly. Names now pass a rule checked by script: every full name is unique, and no first or last name appears more than twice.

Shared text was rare. Only 11 lines of six or more words appear in more than one resume, and most are school names with their city.

The writers also followed rules nobody gave them for this task. They read this workspace's writing guide, which bans words like "leveraged" and "spearheaded". Not one of the 156 resumes uses either word, though real resumes use both all the time. Other clichés got through: 36 of the 42 weak resumes say things like "team player" or "hardworking". The student's base model already knows the banned words, and ResumeAtlas will bring real phrasing back.

Contradictions in the personas got handled in the open. One MBA student's level allowed "only internships", so the writer kept the pre-MBA career and said so. People living in the US who need sponsorship got plausible stories, such as an L-1 visa tied to their current employer. Each writer listed every persona it had to bend.

The writers also found a gap in the check. It accepted lengths up to 20% off target, while their brief said 15%. They kept their files within 15% anyway, and the check now enforces 15%.

## 9. Open a dataset before you use it

ResumeAtlas looked fine from its card: 13,389 resumes in 43 categories, under an MIT license. The file itself told a different story. Every row is lowercase, with no punctuation and no line breaks. Small words like "the", "and" and "with" are gone. Across 6.4 million words there isn't a single one. In our generated resumes, those words make up 18% of the text.

That's the standard cleanup for keyword classifiers, which count words and ignore their order. Our student is a language model that reads sentences, and the extension will hand it normal text. Training on keyword soup would teach it a kind of resume no user ever pastes.

The rows also come from resume template sites. The placeholder name "jessica claire" appears in 7,613 rows, often with the same San Francisco street address. Another 781 rows say "robert smith", and 1,304 rows are exact copies of another row.

So we dropped ResumeAtlas. The real-world mess it was meant to add can come from our own resumes instead. Some of them will get the damage that copying from a PDF causes, such as lost line breaks, merged columns and stray page numbers. That's called augmentation, and it lets us choose exactly which kinds of mess the student sees.

## 10. Pairing jobs with resumes

`build_pairs.py` picks 1,000 of the 2,265 Trackly postings: 25 entry, 25 mid and 25 senior jobs in each function, plus 25 Deployment Strategist roles. Each job gets three resumes: a likely fit from the same function and level, a partial fit, and a mismatch from an unrelated function. That's 3,000 pairs, and each resume appears 16 to 27 times. The roles only steer the mix. The teacher decides every real answer.

Keeping the exam out took three checks. 14 postings had the same URL as a test job, and 3 had the same company and title. Another 153 shared more than a fifth of their text with a test job. Those turned out to be other roles at the same companies, sharing long "about us" and benefits sections. We dropped them anyway. The test now measures the student on companies it never saw in training.

The teacher always reads the clean resume. About 1 in 5 pairs will reach the student with copy-paste damage, under the clean resume's label. Half the pairs also ask the visa question, the way the extension does for people who need sponsorship.

`label_pairs.py` works through the pairs in a fixed shuffled order. If the run stops partway, the finished labels are still a fair sample of every function and level. Each label keeps the teacher's full probabilities for all nine questions. In the first test, a clear mismatch got "0" at 97%.

The same test showed something to watch. A "likely fit" pair scored only 1.15 out of 4. These resumes weren't written for these jobs, so strong matches may be rare. If 3s and 4s barely appear after the first few hundred labels, we'll add resumes written for specific jobs.

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
| Check generated data as a set, not only file by file | Eight writers reused the same names, which no single file revealed. |
| Drop ResumeAtlas. Add copy-paste damage to some generated resumes instead | Its rows have no punctuation, capitals or small words, so they aren't text a user would paste. |
| Leave out any job that shares a fifth of its text with a test job | It also drops the test companies' other roles, so the test checks companies the student never saw. |
| Label in a shuffled order | A run that stops early still leaves a balanced sample. |

## Words we've used

| Word | Meaning |
|---|---|
| Bootstrap | Resampling the test set many times to see how much a number moves by luck. |
| Calibration curve | A mapping from a model's raw scores onto the scale you care about. |
| Cross-validation | Fitting on part of the data, scoring on the rest, then rotating. |
| Distillation | Training a small student to copy a large teacher's answers. |
| Leakage | Test data reaching the training set, which inflates the score. |
| Mode collapse | A model's habit of giving the same few answers when you asked for variety. |
| Augmentation | Changing copies of your training data on purpose, such as adding copy-paste damage, so the model learns to handle it. |
| Stop words | Small, common words like "the" and "and". Keyword tools often delete them, which ruins text for a language model. |
| LoRA | Training a small set of added weights instead of the whole model, so fine-tuning fits on one GPU. |
| 4-bit quantization | Storing each weight in 4 bits instead of 16. A 27B model then fits in about 16 GB, with a small loss in quality. |
| Seed | The starting number for a random generator. The same seed gives the same "random" list every run. |
| Soft labels | Training targets that are full probabilities, such as 58% and 40%, instead of one right answer. |
| Token | The unit a model reads, about three quarters of an English word. |

## Next

The 156 resumes are done, and Trackly has supplied 150 job postings for each of the 13 functions.

1. Label the 3,000 pairs with the teacher, about 6 hours on the Mac. Then check how the answers spread from 0 to 4.
2. Turn the labels into Unsloth's training rows, with the copy-paste damage added.
3. Rate 50 to 100 pairs by hand for the gold set.
4. Train the student on the Mac with Unsloth's MLX trainer, then grade it on the 101 jobs.
