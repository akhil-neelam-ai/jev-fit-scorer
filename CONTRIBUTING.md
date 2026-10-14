# Contributing to Worth Applying?

Thanks for helping. This page covers how the code is laid out, how to change the score, and how to check your change.

## Where things live

| Path | What it does |
| --- | --- |
| `scoring.js` | The whole score: the questions the model answers, the calibration map, the scorecard weights, and the recommendation tiers |
| `background.js` | The extension's worker: settings and the score cache |
| `popup.html`, `popup.js` | The popup that reads the open job page and shows the score |
| `extract.js` | Reads the job's title, company, and description from the open page |
| `options.html`, `options.js` | The settings page for the API key, resume, and visa option |
| `welcome.html`, `welcome.js`, `welcome.css` | The setup guide that opens after install, one screen at a time. Its form runs on `options.js`, so it keeps the settings page's field ids |
| `fonts/` | Bricolage Grotesque, the landing page's display font, bundled for the setup guide. Its license is in `bricolage-grotesque.css` |
| `cli.js` | The same scoring from the command line |
| `test/` | Tests for the score math, the worker, the CLI, the page reader, the popup, and the setup guide |
| `eval/` | The scripts behind the numbers in the README |
| `site/` | The landing page at worth-applying.vercel.app |
| `scripts/popup-shots.mjs` | Renders the real popup into the landing page's screenshots. Rerun it after changing the popup: `CHROME_BIN=... node scripts/popup-shots.mjs` |
| `scripts/package.mjs` | Builds the Chrome Web Store upload from an allowlist of files |

## Change the scoring

All of the scoring lives in [`scoring.js`](scoring.js). It has no dependencies and runs in the browser and in Node. Edit it and both the extension and the CLI pick up the change.

Bump `SCORING_CACHE_VERSION` when you change a question. Cached scores are keyed on that version, so old scores won't stick around.

## Run the tests

Run `npm test` before you send a change. It checks the score math, the extension's worker, and the CLI against a fake API. It also pins the extension's permissions and checks the store package.

`npm run test:browser` loads the extension in Chromium and checks that installing it opens the setup guide, and that the popup and options pages work. It also runs the page reader on sample pages, walks the popup through every state, and walks the setup guide through its four steps. Set `CHROME_BIN` to a Chromium or Chrome for Testing binary first, since regular Chrome won't load test extensions. These tests need Node 22 or newer.

## Package for the Chrome Web Store

Run `npm run package`. It writes `dist/worth-applying-<version>.zip` with only the files listed in `scripts/package.mjs`, then reads the zip back to check nothing else got in. It stops if the extension loads a file that isn't on the list, or if a listed file looks like it holds an email address or phone number.

Never zip this folder by hand for an upload. Your local copy may hold `eval/private/`, which has a personal resume and job search. When the extension starts loading a new file, add it to the list in `scripts/package.mjs`.

For a store update, raise `version` in `manifest.json` and `package.json` first. The store only takes a version higher than the one it has.

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
