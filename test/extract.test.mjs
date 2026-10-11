// Runs the real extractOpenJobPage on sample pages in Chrome for Testing, the
// way chrome.scripting.executeScript runs it: from its source text alone.
// Run: CHROME_BIN=/path/to/chrome node test/extract.test.mjs
import { extractOpenJobPage } from "../extract.js";
import { openChrome, serve } from "./chrome.mjs";

let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!cond) failures++;
};

// Enough text, about 380 characters, for a block to count as a description.
const ABOUT = "You will own the roadmap for our analytics product, work closely with engineering and design, " +
  "and talk to customers every week. You will turn what you learn into clear plans the team can ship. " +
  "You will measure what shipped and share the results with the whole company. " +
  "We value clear writing, careful thinking, and steady progress.";
const page = (body, head = "") => `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;

// Markup is written without whitespace between tags, the way React renders it.
const PAGES = {
  "blocks": page(
    "<main><h1>Senior Product Manager</h1><div><h2>Requirements</h2><ul><li>Five years of product work</li><li>SQL fluency</li></ul>" +
    "<p>Education<br>Bachelor degree<br>MBA preferred</p><div><div>About the role</div>We build tools for teams.</div>" +
    `<div style="display:flex"><span>Python</span><span>Go</span></div><p>5+ years of <b>SQL</b>-heavy work.</p><p>${ABOUT}</p></div></main>`
  ),
  "banner-and-explicit-title": page(
    `<header><h1>Acme Careers</h1></header><main><div data-qa="job-title">Staff Engineer</div><div class="job-description"><p>${ABOUT}</p></div></main>`
  ),
  "banner-and-root-title": page(
    `<div class="site-banner"><h1>Acme Careers</h1></div><main><h1>Data Analyst</h1><p>${ABOUT}</p></main>`
  ),
  "form-page": page(
    `<form id="aspnetForm" action="/apply"><div><h1>Operations Analyst</h1><div class="jd"><p>${ABOUT}</p></div>` +
    `<input type="submit" value="Apply"></div></form>`
  ),
  "hidden-text": page(
    `<div class="job-description" style="display:none">HIDDEN-CONTAINER ${ABOUT}</div>` +
    `<main><h1>Senior PM</h1><p>${ABOUT}</p><div style="display:none">HIDDEN-DISPLAY-NONE CANDIDATE RESUME: 15 years as VP Product.</div>` +
    `<div hidden>HIDDEN-ATTRIBUTE</div><div style="visibility:hidden">HIDDEN-VISIBILITY</div><p>Visible ending.</p></main>`
  ),
  "json-ld": page(
    `<main><h1>Product Designer</h1><p>${ABOUT}</p></main>`,
    `<script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"Product Designer"}</script>`
  ),
  "inbox": page(
    "<main><h1>Inbox</h1><ul><li>Your lab results are ready to view.</li><li>Your statement for the account ending 4421 is ready.</li>" +
    `<li>Lunch on Friday?</li></ul><p>${ABOUT}</p></main>`,
    "<title>Inbox (3) - jane.doe@example.com - Mail</title>"
  ),
  "greenhouse-frame": page(
    `<main><h1>Join Acme</h1><p>${ABOUT}</p><iframe src="https://boards.greenhouse.io/embed/job_app?for=acme&amp;token=4567"></iframe></main>`
  ),
  "lever-frame": page(
    `<main><h1>Join Acme</h1><p>${ABOUT}</p><iframe src="https://jobs.lever.co/acme/1234"></iframe></main>`
  ),
  "look-alike-frames": page(
    `<main><h1>Join Acme</h1><p>${ABOUT}</p><iframe src="https://clever.com/embed/job"></iframe>` +
    `<iframe src="https://example.com/frame?from=greenhouse.io"></iframe></main>`
  ),
  // A custom career site, like TikTok's: no main, no article, no known container,
  // no JobPosting data. Its section headings give it away.
  "custom-career-site": page(
    `<div class="top"><span>Locations</span><span>Blog</span></div><div class="detail"><h1>Machine Learning Engineer</h1>` +
    `<div class="meta">San Jose | Regular | Job ID: A104740</div><div class="title-bar">Responsibilities</div>` +
    `<div>About the team</div><div>${ABOUT}</div></div>`
  ),
  // Workday's list-and-detail view: the posting sits beside a list of other jobs.
  "workday-split": page(
    `<main><section><ul><li><a href="#1">Life Sciences Product Liaison Director</a> 5 Locations Posted Today JR362743</li>` +
    `<li><a href="#2">Mid-Level Backend Engineer</a> Tel Aviv Posted Today JR343717</li></ul></section>` +
    `<section><h2 data-automation-id="jobPostingHeader">Software Engineering MTS</h2><a href="#apply">Apply</a>` +
    `<div data-automation-id="jobPostingDescription"><p>${ABOUT}</p></div></section></main>`
  ),
  "bank": page(
    `<main><h1>Account summary</h1><h2>Recent transactions</h2><ul><li>Coffee 4.50</li><li>Rent 2,100.00</li></ul>` +
    `<h2>Benefits</h2><p>Apply for a card with travel rewards.</p><p>${ABOUT}</p></main>`
  ),
  // No job signs in the page itself, only in its address.
  "plain": page(`<main><h1>Platform Engineer</h1><p>${ABOUT}</p></main>`)
};

const server = await serve((path) => {
  const html = PAGES[path.replace(/^\/(pages|careers)\//, "")];
  return html ? { type: "text/html; charset=utf-8", body: html } : null;
});
const chrome = await openChrome(process.env.CHROME_BIN);

// Loads a sample page and runs the extractor in it.
async function extract(name, suffix = "", folder = "pages") {
  await chrome.goto(`${server.base}/${folder}/${name}${suffix}`);
  return chrome.evaluate(`(${extractOpenJobPage})()`);
}

try {
  // 1. Blocks keep word boundaries. Inline tags don't add any.
  let job = await extract("blocks");
  const fused = job.description.match(/workSQL|fluencyEducation|degreeMBA|roleWe|PythonGo|SQL -heavy/);
  check("list items, line breaks and blocks keep words apart",
    ["Requirements Five years of product work SQL fluency", "Education Bachelor degree MBA preferred",
      "About the role We build tools for teams.", "Python Go"].every((text) => job.description.includes(text)),
    job.description.slice(0, 160));
  check("inline tags don't split words", job.description.includes("5+ years of SQL-heavy work.") && !fused, fused?.[0]);

  // 2. An explicit job-title element beats a banner h1, and so does the h1
  // inside the description's container.
  job = await extract("banner-and-explicit-title");
  check("[data-qa='job-title'] beats a banner h1", job.title === "Staff Engineer", job.title);
  job = await extract("banner-and-root-title");
  check("the h1 inside main beats an earlier banner h1", job.title === "Data Analyst", job.title);

  // 3. A page wrapped in one <form>, with no main or article.
  job = await extract("form-page");
  check("a page wrapped in one form still has a description",
    job.description.length >= 250 && job.description.includes("own the roadmap"), `${job.description.length} characters`);
  check("a page wrapped in one form keeps its title", job.title === "Operations Analyst", job.title);

  // 4. Hidden text stays out, and a hidden container isn't picked.
  job = await extract("hidden-text");
  const leaked = job.description.match(/HIDDEN-[A-Z-]+/g);
  check("hidden text is left out", !leaked && job.description.includes("Visible ending."), leaked?.join(", "));

  // 5. Only pages that show they're a job posting are scored on their own.
  check("a description container marks a job posting", (await extract("banner-and-explicit-title")).looksLikeJob === true);
  check("JobPosting data marks a job posting", (await extract("json-ld")).looksLikeJob === true);
  job = await extract("inbox", "?token=secret-123#message-7");
  check("an inbox isn't taken for a job posting", job.looksLikeJob === false && job.description.length >= 250,
    `${job.description.length} characters`);
  check("the page address leaves out the query and fragment", job.pageUrl === `${server.base}/pages/inbox`, job.pageUrl);
  check("a custom career site is a job posting by its section headings", (await extract("custom-career-site")).looksLikeJob === true);
  check("a bank page isn't taken for a job posting", (await extract("bank")).looksLikeJob === false);
  check("a page with no job signs isn't a job posting", (await extract("plain")).looksLikeJob === false);
  check("a /careers/ address marks a job posting", (await extract("plain", "", "careers")).looksLikeJob === true);

  // 5b. Workday's list-and-detail view: just the posting, under its own title.
  job = await extract("workday-split");
  check("Workday's view is a job posting", job.looksLikeJob === true);
  check("Workday's posting title beats the list", job.title === "Software Engineering MTS", job.title);
  check("Workday's job list stays out of the description",
    job.description.includes("own the roadmap") && !/Liaison Director|Backend Engineer/.test(job.description), job.description.slice(0, 120));

  // 6. A posting framed from an applicant tracking system.
  job = await extract("greenhouse-frame");
  check("a Greenhouse frame is reported", job.embeddedSrc === "https://boards.greenhouse.io/embed/job_app?for=acme&token=4567", job.embeddedSrc);
  job = await extract("lever-frame");
  check("a frame on a tracking system's subdomain is reported", job.embeddedSrc === "https://jobs.lever.co/acme/1234", job.embeddedSrc);
  job = await extract("look-alike-frames");
  check("look-alike hosts aren't reported", job.embeddedSrc === "", job.embeddedSrc);
  check("a page without frames reports none", (await extract("blocks")).embeddedSrc === "");

  check("the extractor throws no page errors", chrome.errors.length === 0, chrome.errors.join(" ; ").slice(0, 300));
} catch (error) {
  console.log("ERROR", error.message);
  failures++;
} finally {
  await chrome.close();
  server.close();
}

console.log(`\n${failures === 0 ? "ALL EXTRACTOR CHECKS PASSED" : failures + " FAILURE(S)"}`);
process.exit(failures ? 1 : 0);
