# 🔥 Jev Fit Scorer

Lenny's Jobs has an "Am I a fit?" button on every posting, but you have to click it one job at a time.

Jev Fit Scorer scores the job posting you have open with Jev, TypeSafe's decision model. Jev returns typed answers with calibrated probabilities instead of generated text. Each score costs a fraction of a cent, and the popup shows the exact time and cost.

It works on any job posting page, not only Lenny's Jobs. On Lenny's Jobs, click a role to open the company's posting, then click the extension.

## What you get

Click the extension icon on a job posting and the popup shows:

- A fit score out of 10, calibrated to read like Lenny's own score
- Lenny's colors: green at 7 and up, amber from 4 to 6, gray below 4
- A recommendation: deprioritize, apply if interested, apply and tailor, or strongly apply
- A six-part scorecard rating required qualifications, core work, role level, customer type, company stage, and domain
- The single strongest factor in the fit, good or bad
- How likely the employer sponsors US visas, if you ask for that
- Jev's confidence, plus the time and cost of the call, or "Cached" if you already scored this job

## Install

Works in Chrome and other Chromium browsers, including Comet, Edge, and Brave.

1. Download `jev-fit-scorer.zip` from the [latest release](https://github.com/akhil-neelam-ai/jev-fit-scorer/releases/latest) and unzip it. You can also clone this repo.
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

## How the score works

One request asks Jev nine questions about the same resume and job. Jev answers each question on its own.

| Question | Type | What comes back |
| --- | --- | --- |
| `fit` | Score from 0 to 4 | How well the resume matches the job, with a confidence |
| Six scorecard questions | Weak, moderate, or strong | One rating per dimension |
| `why` | Choice | The scorecard dimension that is the strongest match or gap |
| `visa` | Probability | How likely the job sponsors US visas (only if you ask) |

The rubric copies how Lenny's Jobs scores fit. We ran its "Am I a fit?" on 101 jobs and measured what drives its score. Its six-part scorecard explained 81% of the number. Required qualifications and core work carried the most weight. Industry domain barely counted. Work authorization, visa, and location showed up as caveats, not as reasons to score lower.

Jev's rubric now weighs the same six things in the same order. It lowers the score for required experience the resume doesn't show. It doesn't lower it for eligibility questions the candidate can resolve, such as sponsorship or relocation.

The number you see blends two estimates. One maps Jev's overall fit score onto Lenny's scale. The other adds up the six scorecard ratings with weights fit to Lenny's scores. The recommendation follows the number:

| Score | Recommendation |
| --- | --- |
| 8 to 10 | Strongly apply |
| 6 to 7 | Apply and tailor |
| 4 to 5 | Apply if interested |
| 1 to 3 | Deprioritize |

## How close it gets to Lenny

We scored 101 jobs with both. Each job's number below comes from a model fit on the other jobs, so no job graded its own answer.

| | Before (×2.5) | Now |
| --- | --- | --- |
| Average gap to Lenny's score | 1.60 points | 0.59 points |
| Within 1 point of Lenny | 46 of 101 | 93 of 101 |
| Same low, mid, or high band (Cohen's kappa) | 0.20 | 0.73 |
| Rank agreement (Spearman) | 0.81 | 0.83 |

All 101 jobs were scored against one MBA candidate's resume, so your gap may differ. Lenny never went above 8 for that resume, so scores above 8 are extrapolated. Lenny's Jobs is a reference point here, not the truth.

## Change the scoring

All of the scoring lives in [`scoring.js`](scoring.js). That covers the questions Jev answers, the calibration map, the scorecard weights, and the recommendation tiers. It has no dependencies and runs in the browser and in Node. Edit it and both the extension and the CLI pick up the change.

Bump `SCORING_CACHE_VERSION` when you change a question. Cached scores are keyed on that version, so old scores won't stick around.

The `eval/` folder holds the scripts behind the numbers above. `score-jev.mjs` scores a set of saved jobs. `report.mjs` compares the results with a reference score. `analyze-lenny.mjs` measures how a reference scorer weighs its scorecard. `compare-versions.mjs` cross-validates ways of turning Jev's answers into a 1 to 10 score. The job data itself isn't in this repo, because it includes a personal resume and job search.

## Privacy

Your resume and API key stay in your browser's local extension storage. When you score a job, the extension sends your resume and the visible job description to api.typesafe.ai. Nothing else leaves your browser.

The extension only reads a page after you click its icon. It doesn't ask for access to every site you visit.

## Limitations

The extension reads the page's visible text. Some career sites load the description in a way that hides it from normal page text, and those need a site-specific extractor.

A score is a triage signal. Read the posting before you apply.

This project isn't affiliated with Lenny's Jobs, TrueUp, or TypeSafe.

## License

MIT. See [LICENSE](LICENSE).
