# Privacy policy: Worth Applying?

Last updated October 16, 2026

This covers the Worth Applying? Chrome extension. The short version: your data stays in your browser, except what goes to TypeSafe to score a job. We don't run a server, and the extension sends us nothing.

## What the extension stores

Everything below lives in your browser's local extension storage, on your device:

- Your TypeSafe API key
- Your resume text
- Your settings, such as whether you want the visa estimate
- Scores for jobs you've already checked, so the same job isn't scored twice

## What it sends, and when

It reads a page only when you click the extension icon. If the page looks like a job posting, it sends the following to TypeSafe's API at api.typesafe.ai. On any other page, it sends nothing unless you click Score anyway.

- Your resume text
- The job's title, company, and description from the page
- The page's web address, minus anything after a ? or #

When you test your API key in Settings, it sends one short test request with that key. TypeSafe's own privacy policy covers what it does with what it receives.

## What it never does

- It doesn't send anything to us. We don't run a server.
- It has no analytics, tracking, or ads.
- It doesn't read pages unless you click its icon.
- It doesn't sell your data or send it anywhere except TypeSafe.

## Why it asks for these permissions

| Permission | Why |
| --- | --- |
| activeTab, scripting | To read the page you're on, only after you click the icon |
| storage | To keep your key, resume, settings, and past scores on your device |
| api.typesafe.ai | To send the scoring request |

## Deleting your data

Remove the extension from chrome://extensions. That deletes everything it stored. To change your resume or key, edit them in Settings and click Save.

## This website

This website counts visits with [Vercel Web Analytics](https://vercel.com/docs/analytics/privacy-policy). The extension doesn't. It records the page you open, the site that sent you, and your country, browser and device type. It uses no cookies. Vercel says the counts aren't tied to you or your IP address.

## Questions

Open an issue on [GitHub](https://github.com/akhil-neelam-ai/worth-applying/issues). The code is open source, so you can check everything above for yourself.
