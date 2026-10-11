# Contributing to Worth Applying?

Thanks for helping. This page covers how the code is laid out, how to change the score, and how to check your change.

## Where things live

| Path | What it does |
| --- | --- |
| `scoring.js` | The whole score: the questions the model answers, the calibration map, the scorecard weights, and the recommendation tiers |
| `background.js` | The extension's worker: settings, the score cache, and the request queue |
| `popup.html`, `popup.js` | The popup that reads the open job page and shows the score |
| `options.html`, `options.js` | The settings page for the API key, resume, and visa option |
| `cli.js` | The same scoring from the command line |
| `test/` | Tests for the score math, the worker, and loading the extension |
| `eval/` | The scripts behind the numbers in the README |
| `site/` | The landing page at worth-applying.vercel.app |
| `scripts/popup-shots.mjs` | Renders the real popup into the landing page's screenshots. Rerun it after changing the popup: `CHROME_BIN=... node scripts/popup-shots.mjs` |

## Change the scoring

All of the scoring lives in [`scoring.js`](scoring.js). It has no dependencies and runs in the browser and in Node. Edit it and both the extension and the CLI pick up the change.

Bump `SCORING_CACHE_VERSION` when you change a question. Cached scores are keyed on that version, so old scores won't stick around.

## Run the tests

Run `npm test` before you send a change. It checks the score math and the extension's worker against a fake API.

`npm run test:browser` loads the extension in Chromium and checks the popup and options pages. Set `CHROME_BIN` to a Chromium or Chrome for Testing binary first, since regular Chrome won't load test extensions.

## Score from the terminal

The CLI uses the same `scoring.js` as the extension. You need Node 18 or newer. There is nothing to install.

```bash
export TYPESAFE_API_KEY=your-key   # or save the key in ~/.typesafe_api_key
node cli.js --resume resume.txt --job job.txt --company Stripe
```

Copied a job description? Pipe it in:

```bash
pbpaste | node cli.js --resume resume.txt --job -
```

Add `--json` for machine-readable output. Add `--no-sponsorship` to skip the visa question. Run `node cli.js --help` for every option.

## The evaluation scripts

The `eval/` folder holds the scripts behind the README's numbers.

| Script | What it does |
| --- | --- |
| `score-jev.mjs` | Scores a set of saved jobs through `scoring.js` |
| `report.mjs` | Compares those scores with a reference score |
| `analyze-lenny.mjs` | Measures how a reference scorer weighs its scorecard |
| `compare-versions.mjs` | Cross-validates ways of turning the model's answers into a 1 to 10 score |
| `build-dataset.mjs` | Bundles every job, both scores, and the analysis into one local archive |

The job data itself isn't in this repo, because it includes a personal resume and job search. The scripts expect it under `eval/private/`, which git ignores.
