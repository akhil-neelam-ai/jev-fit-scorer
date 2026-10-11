# Worth Applying?

Most job postings aren't a ready fit. We ran one MBA candidate's resume against 100+ job postings from a job board, mostly product roles. The extension rated 29 a poor fit, 59 a medium fit, and only 13 a strong fit.

Finding that out the usual way means reading each posting closely, and sometimes tailoring a resume before you learn it was a long shot. This extension scores the posting you have open in about a second. You can skip the poor fits and spend your time on the jobs worth applying to.

It works on any job posting page.

## How it scores fit

Click the extension icon on a job posting. It reads the description and sends it to Jev, TypeSafe's decision model, along with your resume. Jev returns typed answers with probabilities instead of writing text, so each score costs a fraction of a cent.

One request asks Jev nine questions about the same resume and job. Jev answers each question on its own.

| Question | Type | What comes back |
| --- | --- | --- |
| `fit` | Score from 0 to 4 | How well the resume matches the job, with a confidence |
| Six scorecard questions | Weak, moderate, or strong | One rating per dimension |
| `why` | Choice | The scorecard dimension that is the strongest match or gap |
| `visa` | Probability | How likely the job sponsors US visas (only if you ask) |

The popup turns those answers into:

- A fit score out of 10, green at 7 and up, amber from 4 to 6, gray below 4
- A recommendation that follows the score
- A six-part scorecard rating required qualifications, core work, role level, customer type, company stage, and domain
- The single strongest factor in the fit, good or bad
- How likely the employer sponsors US visas. This is on by default. Turn it off in Options if you don't need sponsorship.
- Jev's confidence, plus the time and cost of the call, or "Cached" if you already scored this job

| Score | Recommendation |
| --- | --- |
| 8 to 10 | Strongly apply |
| 6 to 7 | Apply and tailor |
| 4 to 5 | Apply if interested |
| 1 to 3 | Deprioritize |

## How we built the score

A fit score needs a reference point. We used the "Am I a fit?" analysis on [Lenny's Jobs](https://www.lennysjobs.com/), which writes a full fit review for one job at a time. We ran it and our scorer on the same 101 postings, against the same resume.

Lenny's review comes with a six-part scorecard, and its ratings explained 81% of its score. Required qualifications and core work carried the most weight. Industry domain barely counted. Work authorization, visa, and location showed up as caveats, not as reasons to score lower.

We built our rubric to weigh the same six things in the same order. It lowers the score for required experience the resume doesn't show. It doesn't lower it for questions you can resolve, such as sponsorship or relocation. The number you see blends Jev's overall fit score with its six scorecard ratings, both mapped onto Lenny's scale.

Here's how closely our score tracks Lenny's on those 101 jobs:

| | |
| --- | --- |
| Same score as Lenny | 50 of 101 |
| Within 1 point of Lenny | 93 of 101 |
| Average difference | 0.6 points |

We measured these on jobs the scorer wasn't tuned on. All 101 jobs were scored against one resume, so your results may differ. Lenny never went above 8 for that resume, so scores above 8 rest on less evidence. Lenny's Jobs is a reference point here, not the truth.

## Install

Works in Chrome and other Chromium browsers, including Comet, Edge, and Brave.

1. On this repo's GitHub page, click **Code**, then **Download ZIP**, and unzip it. You can also clone the repo.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the folder that holds `manifest.json`.
3. Click the extension icon, then **Options**. Paste your API key and click **Test & save API key**.
4. Paste your resume as plain text and click **Save**. Uncheck the visa box if you don't need sponsorship.
5. Open a job posting and click the extension icon.

## Get a Jev key

You need a TypeSafe API key. Create one at [console.typesafe.ai](https://console.typesafe.ai) on the API Keys page.

Jev charges $0.042 per million input tokens and nothing for output. A resume plus a full job description usually runs a few thousand tokens.

## Score from the terminal

The same scoring runs from the command line. You need Node 18 or newer. There is nothing to install.

```bash
export TYPESAFE_API_KEY=your-key   # or save the key in ~/.typesafe_api_key
node cli.js --resume resume.txt --job job.txt --company Stripe
```

Copied a job description? Pipe it in:

```bash
pbpaste | node cli.js --resume resume.txt --job -
```

Add `--json` for machine-readable output. Add `--no-sponsorship` to skip the visa question. Run `node cli.js --help` for every option.

## Change the scoring

All of the scoring lives in [`scoring.js`](scoring.js). That covers the questions Jev answers, the calibration map, the scorecard weights, and the recommendation tiers. It has no dependencies and runs in the browser and in Node. Edit it and both the extension and the CLI pick up the change.

Bump `SCORING_CACHE_VERSION` when you change a question. Cached scores are keyed on that version, so old scores won't stick around.

Run `npm test` before you send a change. It checks the score math and the extension's background worker against a fake Jev API. `npm run test:browser` loads the extension in Chromium. Set `CHROME_BIN` to a Chromium or Chrome for Testing binary first, since regular Chrome won't load test extensions.

The `eval/` folder holds the scripts behind the numbers above. `score-jev.mjs` scores a set of saved jobs. `report.mjs` compares the results with a reference score. `analyze-lenny.mjs` measures how a reference scorer weighs its scorecard. `compare-versions.mjs` cross-validates ways of turning Jev's answers into a 1 to 10 score. The job data itself isn't in this repo, because it includes a personal resume and job search.

## Privacy

Your resume and API key stay in your browser's local extension storage. When you score a job, the extension sends your resume and the visible job description to api.typesafe.ai. Nothing else leaves your browser.

The extension only reads a page after you click its icon. It doesn't ask for access to every site you visit.

## Limitations

The extension reads the page's visible text. Some career sites load the description in a way that hides it from normal page text, and those need a site-specific extractor.

On some career sites it picks up the wrong job title, such as a site banner. Google's careers site hands it the search results instead of the job. Fixes for both are next on the list.

A score is a triage signal. Read the posting before you apply.

This project isn't affiliated with Lenny's Jobs, TrueUp, or TypeSafe.

## What's next

- The Chrome Web Store, so you can install it without Developer mode.
- A small open decision model, trained with Unsloth for this one job, that you can run yourself.

## License

MIT. See [LICENSE](LICENSE).
