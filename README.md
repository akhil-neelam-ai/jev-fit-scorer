# 🔥 Jev Fit Scorer

Lenny's Jobs has an "Am I a fit?" button on every posting, but you have to click it one job at a time.

Jev Fit Scorer scores the job posting you have open with Jev, TypeSafe's decision model. Jev returns typed answers with calibrated probabilities instead of generated text. Each score costs a fraction of a cent, and the popup shows the exact time and cost.

It works on any job posting page, not only Lenny's Jobs. On Lenny's Jobs, click a role to open the company's posting, then click the extension.

## What you get

Click the extension icon on a job posting and the popup shows:

- A fit score out of 10, colored green (strong), amber (worth a look), or gray (weak)
- Jev's confidence in that score
- The single strongest factor in the fit, good or bad
- How likely the employer sponsors US visas, if you ask for that
- The time and cost of the call, or "Cached" if you already scored this job

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
export TYPESAFE_API_KEY=your-key
node cli.js --resume resume.txt --job job.txt --company Stripe
```

Copied a job description? Pipe it in:

```bash
pbpaste | node cli.js --resume resume.txt --job -
```

Add `--json` for machine-readable output. Add `--no-sponsorship` to skip the visa question. Run `node cli.js --help` for every option.

## How the score works

One request asks Jev three questions about the same resume and job. Jev answers each question on its own.

| Question | Type | What comes back |
| --- | --- | --- |
| `fit` | Score from 0 to 4 | How well the resume matches the job, with a confidence |
| `why` | Choice | The strongest factor in the fit, good or bad |
| `visa` | Probability | How likely the job sponsors US visas (only if you ask) |

For `fit`, Jev looks at five things. Does the role's level and scope match? Does the resume show the functional experience? Does it show the technical or industry background? Does it meet the stated requirements? Has the candidate worked with comparable users or scale?

Stated requirements count more than adjacent experience. Jev is told not to infer anything the resume doesn't show.

Lenny's Jobs shows fit out of 10, so the extension multiplies Jev's score by 2.5 and rounds. Jev's scores are probability-weighted and often fractional, so a 3.2 shows as 8/10.

| Jev score | Shows as | Meaning |
| --- | --- | --- |
| 0 | 0/10 | No meaningful match. Skip it. |
| 1 | 3/10 | Weak match |
| 2 | 5/10 | Moderate match. Worth a look. |
| 3 | 8/10 | Strong match. Apply soon. |
| 4 | 10/10 | Exceptional match. Apply now. |

## Change the scoring

All of the scoring lives in [`scoring.js`](scoring.js). It has no dependencies and runs in the browser and in Node. Edit the rubric or the questions there and both the extension and the CLI pick up the change.

Bump `SCORING_CACHE_VERSION` in the same file when you do. Cached scores are keyed on that version, so old scores won't stick around.

## Privacy

Your resume and API key stay in your browser's local extension storage. When you score a job, the extension sends your resume and the visible job description to api.typesafe.ai. Nothing else leaves your browser.

The extension only reads a page after you click its icon. It doesn't ask for access to every site you visit.

## Limitations

The extension reads the page's visible text. Some career sites load the description in a way that hides it from normal page text, and those need a site-specific extractor.

A score is a triage signal. Read the posting before you apply.

This project isn't affiliated with Lenny's Jobs, TrueUp, or TypeSafe.

## License

MIT. See [LICENSE](LICENSE).
