# Worth Applying? Job fit scores from a decision model

Most job postings aren't a ready fit. We ran one MBA candidate's resume against 100+ job postings from a job board, mostly product roles. The extension rated 29 a poor fit, 59 a medium fit, and only 13 a strong fit.

Finding that out the usual way means reading each posting closely, and sometimes tailoring a resume before you learn it was a long shot. This extension scores the posting you have open in about a second. You can skip the poor fits and spend your time on the jobs worth applying to.

It works on any job posting page.

## How it scores fit

Click the extension icon on a job posting. It reads the description and sends it, with your resume, to a decision model. A decision model answers typed questions with probabilities instead of writing text, so each score costs a fraction of a cent. Today the extension uses TypeSafe's Jev, with your own API key.

One request asks the model nine questions about the same resume and job. It answers each question on its own.

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
- How likely the employer sponsors US visas. This is on by default. Turn it off in Settings if you don't need sponsorship. The fit score is the same either way.
- The model's confidence, plus the time and cost of the call, or "Cached" if you already scored this job

| Score | Recommendation |
| --- | --- |
| 8 to 10 | Strongly apply |
| 6 to 7 | Apply and tailor |
| 4 to 5 | Apply if interested |
| 1 to 3 | Deprioritize |

## How we built the score

A fit score needed a reference point. We used the "Am I a fit?" analysis on [Lenny's Jobs](https://www.lennysjobs.com/), which writes a full fit review for one job at a time. We ran it and our scorer on the same 101 postings, against the same resume.

Lenny's review comes with a six-part scorecard, and its ratings explained 81% of its score. Required qualifications and core work carried the most weight. Industry domain barely counted. Work authorization, visa, and location showed up as caveats, not as reasons to score lower.

We built our rubric to weigh the same six things in the same order. It lowers the score for required experience the resume doesn't show. It doesn't lower it for questions you can resolve, such as sponsorship or relocation. The number you see blends Jev's overall fit score with its six scorecard ratings, both mapped onto Lenny's scale.

Here's how closely our score tracks Lenny's on those 101 jobs. Both score jobs from 1 to 10.

| | |
| --- | --- |
| Same score as Lenny | 50 of 101 |
| Same score or 1 point off | 93 of 101 |
| Average difference | 0.6 points |

We measured these on jobs the scorer wasn't tuned on. All 101 jobs were scored against one resume, so your results may differ. Lenny never went above 8 for that resume, so scores above 8 rest on less evidence. Lenny's Jobs is a reference point here, not the truth.

## Install

Works in Chrome and other Chromium browsers, including Comet, Edge, and Brave.

1. On this repo's GitHub page, click **Code**, then **Download ZIP**, and unzip it. You can also clone the repo.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the folder that holds `manifest.json`.
3. Click the extension icon, then **Settings**. Paste your API key and click **Test & save API key**.
4. Paste your resume as plain text and click **Save**. Uncheck the visa box if you don't need sponsorship.
5. Open a job posting and click the extension icon.

## Get an API key

Today the extension works with TypeSafe's Jev. Create an API key at [console.typesafe.ai](https://console.typesafe.ai) on the API Keys page.

Jev charges $0.042 per million input tokens and nothing for output. A resume plus a full job description usually runs a few thousand tokens.

## Use a different decision model

The extension uses TypeSafe's Jev today. Other decision models accept the same kind of request, including models on Vercel AI Gateway and models you train and serve yourself with Unsloth. Switching takes three changes:

1. In [`scoring.js`](scoring.js), set `JEV_ENDPOINT` to the new model's address and `JEV_MODEL` to its name. For example, Vercel AI Gateway serves Jev at `https://ai-gateway.vercel.sh/typesafe/v1/systemone` as `typesafe-ai/jev`.
2. In `manifest.json`, add the new address to `host_permissions`. Chrome blocks calls to any host that isn't listed there.
3. If the provider expects a different login header, request, or response, update `callJev()` and `parseJevResponse()` in `scoring.js` to match its docs.

The 1 to 10 score is calibrated to Jev. Another model rates fit on its own curve, so the same job can score differently. Until you recalibrate, treat its scores as a ranking rather than numbers on Lenny's scale. The scripts in `eval/` show how we calibrated Jev. Your resume will also go to the new provider instead of TypeSafe.

Or give this prompt to your coding agent:

```text
Switch this Chrome extension from TypeSafe's Jev to the decision model [MODEL NAME],
served at [ENDPOINT URL]. Its API docs are at [DOCS URL].

1. In scoring.js, set JEV_ENDPOINT and JEV_MODEL for the new model.
2. Add the endpoint's host to host_permissions in manifest.json.
3. Read the provider's docs. If its auth header, request body, or response shape
   differs from TypeSafe's, update callJev() and parseJevResponse() to match.
   Keep the result object the same shape so the popup keeps working.
4. Don't change buildQuestions(). Those questions are the scoring rubric.
5. Leave CALIBRATION_KNOTS and SCORECARD_WEIGHTS alone. They were fit to Jev,
   so remind me that the 1 to 10 scores aren't calibrated for this model yet.
6. Run npm test and fix anything that breaks.
```

## Privacy

Your resume and API key stay in your browser's local extension storage. When you click the extension icon, it sends your resume and the open page's title, company, text, and web address to api.typesafe.ai for scoring. Nothing else leaves your browser.

The extension only reads a page after you click its icon. It doesn't ask for access to every site you visit.

## Limitations

The extension reads the page's visible text. Some career sites load the description in a way that hides it from normal page text, and those need a site-specific extractor.

On some career sites it picks up the wrong job title, such as a site banner. Google's careers site hands it the search results instead of the job. Fixes for both are next on the list.

A score is a triage signal. Read the posting before you apply.

This project isn't affiliated with Lenny's Jobs, TrueUp, or TypeSafe.

## What's next

- The Chrome Web Store, so you can install it without Developer mode.
- Support for other decision models, with your own API key.
- A small open decision model, trained with Unsloth for this one job, that you can run yourself.

## For developers

The scoring logic, tests, command-line tool, and evaluation scripts are covered in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
