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

Generated resumes tend to sound alike, and they tend to be too polished. If every resume reads well, the student never learns what a weak one looks like. So each persona has a writing quality, drawn as strong (30%), average (45%) or weak (25%). The draw gave 44 strong, 70 average and 42 weak. A weak resume has vague bullets, filler and uneven formatting, like many real ones.

Claude Opus 5.5 writes the resumes, one per prompt in `prompts.jsonl`. The teacher labels them later. Our usual writing rules weren't meant to apply to these resumes, though the writers followed them anyway (lesson 8). A weak resume needs the clichés real weak resumes have, like "team player" and "other duties as assigned".

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
- Fixing the title lists changed other people's industries and twists. A seeded random generator hands out numbers in a fixed order. When one step takes a different number of draws, every later draw shifts. That's harmless before any resume exists. After that, anything new draws from its own generator with a separate seed, so nothing already written changes.

Then Opus wrote the five pilot resumes, and `make_resumes.py --check` read them. It flags length, contact details and markdown. It also counts the bullets that include a number. Strong resumes averaged 94% and weak ones 6%, so the quality setting does its job. The check also caught two resumes about 20% under their target length, which we fixed.

Two rules came out of the pilot. Every email and link uses example.com, so no resume points to a real person. Schools and large employers can be real. Startups and small firms get invented names, so no real small company gains a fake employee.

## 7. Training on a Mac

The Unsloth Studio app (a beta for macOS) installs its own Python setup with Unsloth and Apple's MLX library. That setup includes Unsloth's decision-model trainer for Apple Silicon. So the student can train on a 64 GB M5 Pro, with no cloud GPU.

There are two ways to get a small decision model. One is to start from a model already trained for decisions, such as Laya, with 0.4 billion parameters. But Laya reads at most 1,024 tokens. Our teacher prompts ran from 2,031 to 4,796 tokens, with a median of 3,167. Laya would never see a whole resume and job posting. Lesson 19 shows that limit was only a default.

The other way is to take a plain small language model and add a fresh decision head. Unsloth calls this design Clef. The head reads one prompt holding every question and scores all their options together. We'll start with Qwen3.5 2B, which is Apache 2.0. The trainer's default limit is 4,096 tokens, so we'll raise it to cover the longest prompts.

The trainer can learn from the teacher's full probabilities, not just its top answer. If the teacher says "1: 58%, 0: 40%", the student learns that the case is close. This is called soft-label distillation. It matters here because the extension's scores are probability-weighted. The student needs the teacher's doubt as well as its pick.

The app also serves decision models on a local endpoint that takes the same kind of request Jev does. Once the student is trained, we can point the extension at the Mac and try it in the real popup. Lesson 18 corrects that, since the app can't serve a Clef model on a Mac.

We'll train from a script in our own environment, with every version pinned, rather than inside the app's setup. The app updates itself. A pinned setup means a run next month repeats a run today.

## 8. Checking the whole set

All 156 resumes passed the check. Short ones averaged 204 words against a target of 200, medium ones 345 against 350, and long ones 533 against 550. The quality setting held at scale too. Strong resumes put a number in 85% of their bullets, average ones in 42% and weak ones in 4%.

Eight Opus writers worked in parallel, about 19 resumes each, and each confirmed it ran as Claude Opus 5.5. Together they used about 1.5 million tokens in 21 minutes.

Checking each file wasn't enough. The problems only showed up across the whole set. Three writers, working separately, each named their person Marisol Quintanilla. Two picked Devin Marchetti. Five resumes used the first name Kristine, and five used the surname Marchetti. Told to avoid stock names, eight copies of one model all reached for the same "unusual" ones. Copies of one model share its favorite choices, so they aren't independent samples.

The fix taught the same lesson twice. Some of my replacement names collided with names already in the set, and one matched exactly. Names now pass a rule checked by script: every full name is unique, and no first or last name appears more than twice.

Shared text was rare. Only 11 lines of six or more words appear in more than one resume, and most are school names with their city.

The writers also followed rules nobody gave them for this task. They read this workspace's writing guide, which bans words like "leveraged" and "spearheaded". Not one of the 156 resumes uses either word, though real resumes use both all the time. Other clichés got through: 36 of the 42 weak resumes say things like "team player" or "hardworking". The student's base model already knows the banned words, so the effect should be small. The 143 tailored resumes have the same gap, since their writers read the same guide.

Contradictions in the personas got handled in the open. One MBA student's level allowed "only internships", so the writer kept the pre-MBA career and said so. People living in the US who need sponsorship got plausible stories, such as an L-1 visa tied to their current employer. Each writer listed every persona it had to bend.

The writers also found a gap in the check. It accepted lengths up to 20% off target, while their brief said 15%. They kept their files within 15% anyway, and the check now enforces 15%.

## 9. Open a dataset before you use it

ResumeAtlas looked fine from its card: 13,389 resumes in 43 categories, under an MIT license. The file itself told a different story. Every row is lowercase, with no punctuation and no line breaks. Small words like "the", "and" and "with" are gone. Across 6.4 million words there isn't a single one. In our generated resumes, those words make up 18% of the text.

That's the standard cleanup for keyword classifiers, which count words and ignore their order. Our student is a language model that reads sentences, and the extension will hand it normal text. Training on keyword soup would teach it a kind of resume no user ever pastes.

The rows also come from resume template sites. The placeholder name "jessica claire" appears in 7,613 rows, often with the same San Francisco street address. Another 781 rows say "robert smith", and 1,304 rows are exact copies of another row.

So we dropped ResumeAtlas. The real-world mess it was meant to add can come from our own resumes instead. Some of them will get the damage that copying from a PDF causes, such as lost line breaks, merged columns and stray page numbers. That's called augmentation, and it lets us choose exactly which kinds of mess the student sees.

## 10. Pairing jobs with resumes

`build_pairs.py` picks 1,000 of the 2,265 Trackly postings: 25 entry, 25 mid and 25 senior jobs in each function, plus 25 Deployment Strategist roles. Each job gets three resumes: a likely fit from the same function and level, a partial fit, and a mismatch from an unrelated function. That's 3,000 pairs, and each resume appears 16 to 27 times. The roles only steer the mix. The teacher decides every real answer.

Keeping the exam out took three checks. 14 postings had the same URL as a test job, and 3 had the same company and title. Another 153 shared more than a fifth of their text with a test job. Those turned out to be other roles at the same companies, sharing long "about us" and benefits sections. We dropped them anyway, which keeps most of those companies' postings out of training. Jobs are never dropped by company name alone, though. A test company can still appear through a posting that shares little text with its test job.

The teacher always reads the clean resume. About 1 in 5 pairs will reach the student with copy-paste damage, under the clean resume's label. Half the pairs also ask the visa question, the way the extension does for people who need sponsorship.

`label_pairs.py` works through the pairs in a fixed shuffled order. If the run stops partway, the finished labels are still a fair sample of every function and level. Each label keeps the teacher's full probabilities for all nine questions. In the first test, a clear mismatch got "0" at 97%.

The same test showed something to watch. A "likely fit" pair scored only 1.15 out of 4. These resumes weren't written for these jobs, so strong matches may be rare. If 3s and 4s barely appear after the first few hundred labels, we'll add resumes written for specific jobs.

## 11. A second opinion on the teacher

The plan was for a person to score about 60 pairs by hand. We used Claude Opus 5.5 at maximum effort instead, judging 120 pairs blind. It saw only the resume, the job and the nine questions, never the teacher's answers or the persona notes. Its scores only measure the teacher, and they never become training labels.

| | Teacher (Qwen) vs judge (Opus) |
|---|---|
| Within 1 point | 106 of 120 (88%) |
| Same whole score | 83 of 120 (69%) |
| Rank agreement (1.0 is the same order) | 0.84 |
| Average fit, 0 to 4 | teacher 0.44, judge 0.72 |

They put the pairs in nearly the same order. A rank agreement of 0.84 is about as close as Jev and Lenny were (0.83).

The teacher is harsher by about 0.3 points, mostly on likely and partial fits in business roles. Finance showed the largest gap, 0.49 against 1.40. On clear mismatches, all 40 landed within a point of each other.

A steady bias is the easy kind of error. The student copies the teacher, then gets its own calibration curve onto Lenny's scale. A model that runs 0.3 low just gets a curve that lifts it. Calibration can't fix a wrong order, and the order agrees.

The biggest disagreement was role level, the same on only 42 of 120 pairs. Our rubric says "same or higher level" counts as strong. Opus followed that literally, so a VP applying to an internship scored strong. Qwen didn't. Several judges flagged the wording on their own. When two careful readers disagree, the question itself is often ambiguous.

The main factor matched on only 44 pairs. Qwen almost always names required qualifications, and the judges noted that several factors often tie. Visa answers landed on the same side of 50% for 95 pairs.

The most useful finding was about the data, not the teacher. Opus gave a 3 or a 4 to only 5 of the 120 pairs. A student trained on that would rarely see a strong match. So Opus also wrote 143 resumes for specific postings, aimed at fits of 4, 3 and 2.

## 12. What the labels show

The teacher labeled all 3,286 pairs overnight with no failures. A pair took about 8.7 seconds.

The tailored resumes worked. Of the training rows aimed at a 4, the teacher's top answer was a 4 for 46 of 48. Resumes aimed at a 3 came back as 3 or 4, and those aimed at a 2 split between 2 and 3. The teacher is harsh on the generated resumes, but a resume written to fit gets credit.

The cross pairs worked too. Next to a different job in their function, the same tailored resumes mostly scored 0 or 1. So the student can't learn "written for this posting" as a sign of fit.

Before looking, we set a bar for the training rows. At least 80 needed a top answer of 3 or 4, and at least 240 a 2. The first passed at 132. The second missed at 130.

| Teacher's top answer | 0 | 1 | 2 | 3 | 4 |
|---|---|---|---|---|---|
| Training rows | 1,611 | 630 | 130 | 70 | 62 |

Counting the teacher's doubt doesn't rescue the 2s. Its probability on a 2, summed across every training row, is worth about 158 rows. A 2 means several required qualifications are missing. The generated resumes usually miss by more than that, and the tailored ones land higher. If the first grade shows a weak middle, the fix is more resumes aimed at a 2.

## 13. Copy the real input field by field

The rows already matched the extension in two ways: one-line job descriptions and URLs without query strings. A code reviewer asked about a field we had skipped, the company name.

The extension finds a company on only a few sites, and on the rest it sends nothing. We counted. 104 of the 109 test jobs reached Jev with no company. Every training row had one, so the student would have met "Senior PM at" with nothing after only at test time.

Now 19 of every 20 rows leave the company out. A hash of the pair picks which ones, so the choice is the same on every run. Counting the real input took one short script.

The same review found a quieter leak path. A tailored resume is written from one posting's full text. If that posting is held out for validation, its resume could still train through its cross pair. The rows script now follows each tailored resume back to its posting, and 14 more of them moved to validation. A posting flagged as a copy of a test job now takes its tailored resume out of every row. None of the 7 flagged postings had one this time.

## 14. Train in the precision you ship

The first smoke run trained its adapters over a 4-bit copy of the base model, which saves memory. Unsloth always saves the merged model in 16-bit. It merges the adapters into the full-precision weights. The reload check then failed. The merged model's answers moved by up to 0.13 against the model that had just trained.

The save itself was fine. The adapters, reloaded over a 4-bit base, matched to 0.0003. Adapters learn to correct the base they train on. Moved onto the 16-bit weights, they correct for rounding that isn't there.

So the student now trains over the 16-bit base, the same one that gets merged and served. It ran no slower, at about 25 seconds a step, and the reload check passed at 0.007. That's why the check exists. It compares the model you grade with the model you trained. A mismatch then shows up in a ten-minute smoke run, not after a six-hour one.

## 15. Run a new rule on the real data before trusting it

The resume check had a loose phone rule. It passed a resume if "555" appeared anywhere. It also passed a real LinkedIn link if the same line held an example.com email. So we wrote a stricter rule that checks each phone number and each link on its own.

The first version flagged 8 of the 299 resumes for having no phone at all. All 8 had one, in the styles of India, France, the UK, Australia, the Netherlands and Germany. The pattern only knew American numbers. A test written from my own examples would have passed, because I'd have picked American examples.

The second version flagged one more, "P.O. Box 40512-00100, Nairobi". That's a Kenyan postal box, and the real phone sat on the next line. The rule now skips numbers after "Box", and all 299 resumes pass. The tests now hold every format the real resumes taught us.

## 16. Stamp each label with the question it answered

A label only means something next to the question it answers. If the rubric in `scoring.js` changes, old labels answer a different question than new ones. Mixing them would teach the student two versions at once.

So every label now carries a stamp. It's a short hash of everything that decides a label besides the pair itself. That means the questions from `scoring.js`, plus the parts of `teacher_eval.py` that build the prompt and read the answers. The labeler won't add labels under a new stamp, or from another teacher, while older ones sit in the folder. The rows script goes further. It works out today's stamp and refuses labels that don't carry it, so a rubric edit after labeling can't slip into the rows.

The first version only hashed the system prompt, the questions and the prompt template. The code review pointed out what it missed, such as the state template and the code that reads the answers. So the 3,286 labels were stamped twice, once under each definition. Both times git showed nothing they cover had changed since the first label. Each backfilled label says so in a `stampedBy` field.

## 17. The first grade

The student trained for 4.6 hours: 626 steps over 2 epochs, never above 9 GB of memory. Its training loss fell from 1.12 to about 0.54 within the first epoch, then flattened near 0.5. Most of what it learned, it learned early.

Then came the scoreboard on the 101 test jobs, using the same method we ship for Jev.

| | Mean gap from Lenny | Rank agreement | Within 1 point |
|---|---|---|---|
| Jev | 0.59 | 0.83 | 93 of 101 |
| Student, Qwen3.5 2B | 0.62 | 0.82 | 92 of 101 |

The teacher it learned from scored 0.63. The student's gap is 0.03 above Jev's, but the 95% interval runs from -0.10 to +0.16. That's inside the noise of a 101-job test. The plan set its bar before training: a gap of 0.74 or less, with an interval that includes zero, counts as close enough. This lands there.

It's weaker on internships and entry APM roles (0.91 and 0.74, against Jev's 0.73 and 0.47). It's better on most PM roles (0.47 against 0.58). It answers in about half a second on the Mac, with no API key.

Two worries didn't show up in the grade. Calibration made no difference, since the calibrated and uncalibrated students both scored 0.62. The grade fits its own score mapping for each model, which absorbs the change in temperature. And the thin supply of 2s didn't sink the result, so the extra resumes aimed at a 2 can wait.

One good run can be luck, though. The plan's next step for this row is a second training run with a different seed. If it agrees, that's a result.

## 18. Keep the resume on the Mac

The Unsloth app wouldn't serve the student. Its error said Clef models need an NVIDIA or AMD GPU, and this Mac has neither. So the student got its own server, about 120 lines of Python. `serve_student.py` loads the merged model with the same code the grade uses. It answers at `/v1/systemone`, the same path as Jev's API, on 127.0.0.1. That address always means this computer.

A code review caught a quieter problem in the first script. It asked the app for "jev-latest", the model name the CLI sends to TypeSafe. In the app, that name is an alias for whatever model is set as the default. The default can be a hosted model, TypeSafe's Jev included. The script did check every answer for a header that only a local model sets. But that check reads the answer, and by then the resume has already gone.

So every request now names the student exactly, as `clef-ft:worth-applying-run1`. Our server answers only to that name. The app would look it up only among folders on this Mac. The script also never sends to "localhost". On a Mac, that name can mean the IPv6 address, where a different program could be listening. The script refuses redirects and proxies. It swaps the TypeSafe key for a placeholder, so the real key is never read.

Next, the server had to show it answers like the model we trained. `serve_check.py` sends three validation rows, all with generated resumes. It compares the answers with the ones the model gave right after training. The largest change in any probability was 0.011, inside the 0.02 the reload check allows (lesson 14). The visa answer arrives as one number, the chance of yes, so the check splits it into yes and no first.

A made-up resume went through the CLI next. Then the real resume did, against one of the 101 test jobs. Its fit, on the 0 to 4 scale, landed within 0.1 of the graded answer for that job. The main factor matched too. The CLI sends no page link, so its prompt differs a little from the graded one. The answer took about half a second, and the resume never left the Mac.

## 19. Read a model's limits from its own files

Lesson 7 ruled out Laya because it "reads at most 1,024 tokens". That was wrong. Once Laya was downloaded, we could check its files. Laya is a small decision head on mmBERT-base, an encoder that reads up to 8,192 tokens. Laya was trained on 1,024-token inputs, which makes 1,024 its default. Unsloth's trainer raises it with `max_seq_length`, up to the encoder's 8,192.

Our training rows fit easily once the limit is raised. Counted with Laya's own tokenizer, the resume and posting run from 476 to 3,490 tokens, with a median of 1,685. Only 108 of the 2,503 training rows fit in 1,024 tokens. All of them fit in 4,096.

Laya reads questions differently from Clef. It reads each question in its own pass, with its own copy of the resume and posting. Our nine questions mean nine passes, where Clef needs one. Each question also gets 256 tokens, options included. The fit question's instructions run 263, so the end of that rubric gets cut.

Size is Laya's real draw. It holds about 0.3 billion parameters, and two thirds of them are a vocabulary table for many languages. The layers that do the work hold about 0.1 billion, a twentieth of the 2B student. Nine passes eat into that, so it should need roughly half the 2B's compute per job, not a twentieth. A model this size is far easier to ship with the extension.

## Decisions so far

| Decision | Why |
|---|---|
| Build a prototype, then decide after the 101-job test | We learn whether a small model can get close before spending more. |
| Teacher: Qwen 3.8 27B, 4-bit, run locally | Apache 2.0 allows training on its answers, and it tied Jev on the test. |
| Never train on Jev's answers or Lenny's reviews | Lenny's reviews are the test, and Jev is the bar we measure against. |
| Labels from the teacher, checked by a hand-rated gold set | The gold set tests the teacher on jobs Lenny never reviewed. |
| Jobs from Trackly, about 150 for each function | Each job comes with clean tags for function, level and company stage. |
| Resumes: 156 written by Claude Opus 5.5, plus a few hundred from ResumeAtlas (ResumeAtlas later dropped, lesson 9) | We control the mix and the rights are clean. ResumeAtlas adds real-world mess. |
| Train on the Mac with Unsloth's MLX trainer | The Studio app ships it, and 64 GB is enough for a 2B student. |
| First student: Qwen3.5 2B with a Clef head, trained on soft labels | It reads a whole resume and posting, and the license allows it. Laya can't fit them (wrong, lesson 19). |
| Check generated data as a set, not only file by file | Eight writers reused the same names, which no single file revealed. |
| Drop ResumeAtlas. Add copy-paste damage to some generated resumes instead | Its rows have no punctuation, capitals or small words, so they aren't text a user would paste. |
| Leave out any job that shares a fifth of its text with a test job | It also drops most of the test companies' other roles, which share their boilerplate. |
| Label in a shuffled order | A run that stops early still leaves a balanced sample. |
| A blind Opus 5.5 judge checks the teacher on 120 pairs, instead of a hand-rated gold set | It saves hours of rating. Opus comes from a different lab than Qwen, so its mistakes differ. Its scores never become labels. |
| Add 143 resumes written for specific postings, aimed at fits of 4, 3 and 2 | Only 5 of 120 judged pairs were strong matches. |
| Leave the company out of 19 in 20 training rows | 104 of the 109 test jobs reached Jev without one. |
| A tailored resume goes wherever its posting goes: validation, or out of every row | Text written from a held-out or flagged posting must never train. |
| Keep Unsloth's calibration, and save the adapters from before it too | The grade refits a score mapping for each model, which absorbs most of a temperature change. The saved adapters keep an uncalibrated grade possible. |
| Train over the 16-bit base, not a 4-bit copy | The merged model is 16-bit. Adapters trained over 4-bit answered up to 0.13 differently once merged, and 16-bit ran no slower. |
| Check each phone number and link in a resume on its own | A rule per line let a real LinkedIn link pass next to an example.com email. |
| Stamp every label with a hash of the prompt it answered | Labels from two prompt versions would teach two questions at once. |
| Serve the student from our own small server on the Mac | The Unsloth app serves Clef models only on NVIDIA or AMD GPUs. |
| Name the student exactly in every request | In the app, "jev-latest" means the default model, which can be hosted. A check on the answer comes after the resume has gone. |
| Check the server on generated resumes before the real one | A wrong or drifted model shows up before any private text is sent. |

## Words we've used

| Word | Meaning |
|---|---|
| Alias | A short name that stands for whatever model is set as the default, such as "jev-latest" in the Unsloth app. |
| Bootstrap | Resampling the test set many times to see how much a number moves by luck. |
| Calibration curve | A mapping from a model's raw scores onto the scale you care about. |
| Cross-validation | Fitting on part of the data, scoring on the rest, then rotating. |
| Distillation | Training a small student to copy a large teacher's answers. |
| Encoder | A model that reads a whole text in both directions at once. It can't write text, but it suits picking from fixed options. |
| Endpoint | The web address a program sends its requests to, such as Jev's `/v1/systemone`. |
| Hash | A short fingerprint of some text. Change one character and the fingerprint changes. |
| Leakage | Test data reaching the training set, which inflates the score. |
| Mode collapse | A model's habit of giving the same few answers when you asked for variety. |
| Augmentation | Changing copies of your training data on purpose, such as adding copy-paste damage, so the model learns to handle it. |
| Anchoring | Drifting toward a number you saw first. Blind judging, where you never see the other answer, prevents it. |
| Stop words | Small, common words like "the" and "and". Keyword tools often delete them, which ruins text for a language model. |
| LoRA | Training a small set of added weights instead of the whole model, so fine-tuning fits on one GPU. |
| 4-bit quantization | Storing each weight in 4 bits instead of 16. A 27B model then fits in about 16 GB, with a small loss in quality. |
| Seed | The starting number for a random generator. The same seed gives the same "random" list every run. |
| Soft labels | Training targets that are full probabilities, such as 58% and 40%, instead of one right answer. |
| Token | The unit a model reads, about three quarters of an English word. |
| Validation set | Rows held back from training, to check the model on work it hasn't seen. |

## Next

The first student is trained and graded: 0.62 against Jev's 0.59, within the test's noise (lesson 17). It has also scored a real resume from the CLI, and the resume never left the Mac (lesson 18).

1. Train a second student with a different seed, about 4.6 hours, to confirm the first wasn't luck.
2. If it agrees, plan how a local option could ship.
