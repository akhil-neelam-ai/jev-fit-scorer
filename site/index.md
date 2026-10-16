# Worth Applying? Know if a job fits before you apply.

Worth Applying? is a free, open-source Chrome extension. It scores any job posting against your resume in about a second.

- Install: [Chrome Web Store](https://chromewebstore.google.com/detail/worth-applying/ppcfjfgonfggaaeoomjakdjkjpjbokbc)
- Works in: Chrome, Edge, Brave, and Comet
- Price: free. Scoring uses your own TypeSafe API key and costs about 2 cents per 100 jobs.
- Decision model: Jev, from TypeSafe
- Source code: [GitHub](https://github.com/akhil-neelam-ai/worth-applying), MIT license
- Privacy policy: [worth-applying.vercel.app/privacy](https://worth-applying.vercel.app/privacy)

## What you get for each job

Open a job posting and click the extension icon. The popup shows:

- A fit score from 1 to 10
- A recommendation: Strongly apply (8 to 10), Apply and tailor (6 to 7), Apply if interested (4 to 5), or Deprioritize (1 to 3)
- A six-part scorecard: required qualifications, core work, role level, customer type, company stage, and domain. Each part is rated weak, moderate, or strong.
- The main factor behind the score, good or bad
- How likely the employer is to sponsor a US visa, if you need one. This estimate never lowers your fit score.
- The model's confidence, plus the time and cost of the call

## The same resume can score a 7 or a 2

Three postings from our test run, scored against one MBA candidate's resume:

| Job | Fit score | Recommendation | Main factor |
| --- | --- | --- | --- |
| Associate Product Manager | 7/10 | Apply and tailor | Role level |
| Product Manager, Growth Strategy | 4/10 | Apply if interested | Required qualifications |
| Lead, Software Engineer | 2/10 | Deprioritize | Required qualifications |

## How the score works

Jev rates the overall fit and six parts of the match. The extension blends them into one score from 1 to 10. We tuned the blend against full fit reviews from [Lenny's Jobs](https://www.lennysjobs.com/).

On 101 postings the scorer wasn't tuned on, 93 scores came out the same as Lenny's Jobs, or 1 point off. The average difference was 0.6 points. All 101 were scored against one MBA candidate's resume, mostly product roles, so your results may differ. The full method is in the [README](https://github.com/akhil-neelam-ai/worth-applying#readme).

## Install

1. Add it from the [Chrome Web Store](https://chromewebstore.google.com/detail/worth-applying/ppcfjfgonfggaaeoomjakdjkjpjbokbc).
2. Sign in to [TypeSafe](https://console.typesafe.ai) and create an API key.
3. In the setup guide that opens, add your key and your resume as plain text.
4. Open a job posting and click the icon.

## Privacy

Your resume and API key live in your browser. The extension reads a page only when you click its icon. When you score a job, only your resume and that posting go to TypeSafe's API at api.typesafe.ai. The extension sends anonymous usage counts, such as setup steps and icon clicks, under a random install ID. They never include your resume, your key or the jobs you view, and you can turn them off in Settings. This website counts visits with Vercel Web Analytics, which uses no cookies.

Not affiliated with Lenny's Jobs, TrueUp, or TypeSafe.
