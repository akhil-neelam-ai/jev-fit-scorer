// Drives the real popup (popup.html, popup.js, scoring.js) in Chrome for
// Testing through every state it can show, with a stand-in for the chrome API.
// Run: CHROME_BIN=/path/to/chrome node test/popup.test.mjs
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { displayScore, recommendationFor, scoreBand } from "../scoring.js";
import { openChrome, serve } from "./chrome.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };
const NO_RESPONSE = "The extension didn't respond. Try again.";

let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!cond) failures++;
};

// What extract.js returns on a job page, and a real result from the
// 101-posting test run.
const JOB = {
  title: "Associate Product Manager", company: "", description: "Sample job description. ".repeat(20),
  pageUrl: "https://jobs.example.com/roles/42", looksLikeJob: true, embeddedSrc: ""
};
const RESULT = {
  fit: 2.6, fitConfidence: 0.51, why: "role_level", visa: 0.79, inputTokens: 3220, elapsedMs: 125, cached: false, scorecard: {
    required_qualifications: { score: 1.66, label: "Strong" }, function: { score: 1.84, label: "Strong" },
    role_level: { score: 1.94, label: "Strong" }, customer_type: { score: 1.22, label: "Moderate" },
    company_stage: { score: 1.51, label: "Strong" }, domain: { score: 1.07, label: "Moderate" }
  }
};
const READY = { ok: true, hasKey: true, hasResume: true };

// Stands in for the chrome.* APIs the popup calls, and records each call on
// window.calls. A planned reply of "reject" rejects, and "never" never settles.
const stub = ({ url = JOB.pageUrl, page = JOB, extractFails = false, replies = {} }) => `(() => {
  const calls = window.calls = [];
  const plan = ${JSON.stringify({ get_status: READY, score_job: { ok: true, result: RESULT }, ...replies })};
  const answer = (planned) => planned === "reject" ? Promise.reject(new Error("Could not establish connection."))
    : planned === "never" ? new Promise(() => {}) : Promise.resolve(planned);
  Object.defineProperty(window, "chrome", { configurable: true, value: {
    tabs: {
      query: async () => [{ id: 7, url: ${JSON.stringify(url)} }],
      create: async (properties) => { calls.push({ api: "tabs.create", ...properties }); return { id: 8 }; }
    },
    scripting: {
      executeScript: async ({ func }) => {
        calls.push({ api: "executeScript", func: func.name });
        ${extractFails ? 'throw new Error("Cannot access contents of the page.");' : `return [{ result: ${JSON.stringify(page)} }];`}
      }
    },
    runtime: {
      getURL: (path) => "chrome-extension://test-id/" + path,
      openOptionsPage() { calls.push({ api: "openOptionsPage" }); },
      sendMessage: (message) => { calls.push({ api: "sendMessage", ...message }); return answer(plan[message.type]); }
    }
  } });
})();`;

const server = await serve((path) => {
  const file = join(ROOT, path);
  if (!file.startsWith(ROOT) || !TYPES[extname(file)]) return null;
  try {
    return { type: TYPES[extname(file)], body: readFileSync(file) };
  } catch {
    return null;
  }
});
const chrome = await openChrome(process.env.CHROME_BIN);

// Opens the popup with the given stand-in.
async function open(setup = {}) {
  const { result } = await chrome.send("Page.addScriptToEvaluateOnNewDocument", { source: stub(setup) });
  await chrome.goto(`${server.base}/popup.html`);
  await chrome.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: result.identifier });
}

// Waits until the expression holds, then reads what the job card shows.
async function card(until) {
  await chrome.waitFor(until);
  return chrome.evaluate(`(() => {
    const $ = (id) => document.getElementById(id);
    return {
      state: document.body.dataset.state,
      name: $("jobName").textContent,
      status: $("jobStatus").hidden ? "" : $("jobStatus").textContent,
      eyebrow: !$("jobEyebrow").hidden,
      buttons: [...document.querySelectorAll(".job-score button")].filter((b) => !b.hidden).map((b) => b.textContent).join(", "),
      visa: $("jobVisa").hidden ? null : $("jobVisaValue").textContent + " " + $("jobVisaValue").className,
      result: $("jobResult").hidden ? null : {
        recommendation: $("jobRecommendation").textContent, chip: $("jobScore").textContent, band: $("jobScore").className,
        rows: $("jobScorecard").children.length / 2, factor: $("jobFactor").textContent, details: $("jobDetails").textContent
      },
      calls: window.calls
    };
  })()`);
}
const inState = (state) => `document.body.dataset.state === ${JSON.stringify(state)}`;
const scoreCalls = (shown) => shown.calls.filter((c) => c.type === "score_job");
const show = (shown) => `${shown.state} | ${shown.name} | ${shown.status}`;

try {
  await open({ replies: { get_status: { ok: true, hasKey: false, hasResume: false } } });
  let shown = await card(inState("setup"));
  check("setup: no key or resume offers the setup guide",
    shown.name === "Set up Worth Applying?" && shown.status === "Add your TypeSafe API key and resume to start scoring." &&
    shown.buttons === "Start setup", show(shown));
  await chrome.evaluate(`document.getElementById("setupGuide").click()`);
  shown = await card(`window.calls.some((c) => c.api === "tabs.create")`);
  check("setup: Start setup opens the guide in a tab",
    shown.calls.filter((c) => c.api === "tabs.create").map((c) => c.url).join() === "chrome-extension://test-id/welcome.html",
    JSON.stringify(shown.calls.at(-1)));

  await open({ replies: { score_job: "never" } });
  shown = await card(`${inState("loading")} && document.getElementById("jobName").textContent === ${JSON.stringify(JOB.title)}`);
  check("loading: the job title over Scoring…", shown.eyebrow && shown.status === "Scoring…" && shown.buttons === "", show(shown));

  await open({ url: "chrome://newtab/" });
  shown = await card(inState("unscorable"));
  check("unscorable: a chrome:// tab", shown.name === "Open a job posting" && shown.status === "This tab can't be scored." &&
    !shown.calls.some((c) => c.api === "executeScript"), show(shown));

  for (const url of ["https://www.lennysjobs.com/jobs?role=pm", "https://lennysjobs.com/"]) {
    await open({ url });
    shown = await card(inState("board"));
    check(`board: ${new URL(url).hostname}`, shown.name === "Open a role first" &&
      shown.status === "Click a job title to open its full description, then click the extension again.", show(shown));
  }
  await open({ url: "https://notlennysjobs.com/jobs/1" });
  shown = await card(inState("result"));
  check("a host that only ends in lennysjobs.com isn't the board", shown.state === "result", show(shown));

  await open({ page: { ...JOB, title: "Careers", description: "Join our team." } });
  shown = await card(inState("not-found"));
  check("not-found: a short description", shown.name === "Description not found" &&
    shown.status === "Open the role's full job description, then try again." && shown.buttons === "Score again", show(shown));

  await open({ extractFails: true });
  shown = await card(inState("error"));
  check("error: Chrome won't run the extractor", shown.name === "Couldn't score this page" &&
    shown.status === "Chrome can't read this page. Open the job on its own page, then try again." && shown.buttons === "Score again",
    show(shown));

  const workerError = "Too many requests right now. Wait a minute, then try again.";
  await open({ replies: { score_job: { ok: false, error: workerError } } });
  shown = await card(inState("error"));
  check("error: the worker's words, verbatim, under the job title",
    shown.eyebrow && shown.name === JOB.title && shown.status === workerError && shown.buttons === "Score again", show(shown));

  await open({ replies: { score_job: "reject" } });
  shown = await card(inState("error"));
  check("error: score_job gets no reply", shown.name === JOB.title && shown.status === NO_RESPONSE, show(shown));
  await open({ replies: { get_status: "reject" } });
  shown = await card(inState("error"));
  check("error: get_status gets no reply", shown.name === "Couldn't score this page" && shown.status === NO_RESPONSE, show(shown));

  // A page with no sign of a job posting waits for a click before anything
  // is sent. A double click still sends one score.
  await open({ page: { ...JOB, looksLikeJob: false } });
  shown = await card(inState("not-job"));
  check("not-job: asks before sending the page", shown.name === "This doesn't look like a job posting" &&
    shown.status === "Score anyway sends this page's text to TypeSafe." && shown.buttons === "Score anyway" &&
    scoreCalls(shown).length === 0, show(shown));
  await chrome.evaluate(`(() => { const button = document.getElementById("scoreAnyway"); button.click(); button.click(); })()`);
  shown = await card(inState("result"));
  check("not-job: Score anyway sends one score and shows it",
    shown.state === "result" && scoreCalls(shown).length === 1 && scoreCalls(shown)[0].job.title === JOB.title,
    `${scoreCalls(shown).length} score_job messages`);

  const frame = "https://boards.greenhouse.io/embed/job_app?for=acme&token=4567";
  await open({ page: { ...JOB, embeddedSrc: frame } });
  shown = await card(inState("embedded"));
  check("embedded: points to the framed posting", shown.name === "This posting is embedded from another site" &&
    shown.status === "Open it on its own page, then click the extension again." && shown.buttons === "Open the posting" &&
    scoreCalls(shown).length === 0, show(shown));
  await chrome.evaluate(`document.getElementById("openEmbedded").click()`);
  shown = await card(`window.calls.some((c) => c.api === "tabs.create")`);
  check("embedded: Open the posting opens the frame's page in a tab",
    shown.calls.filter((c) => c.api === "tabs.create").map((c) => c.url).join() === frame, JSON.stringify(shown.calls.at(-1)));

  // A result, then the visa row at its band edges.
  await open();
  shown = await card(inState("result"));
  const score = displayScore(RESULT);
  check("result: recommendation, score chip and scorecard",
    shown.eyebrow && shown.name === JOB.title && shown.result?.recommendation === recommendationFor(score) &&
    shown.result.chip === `Fit ${score}/10` && shown.result.band === `score-chip ${scoreBand(score)}` && shown.result.rows === 6 &&
    shown.result.factor === "Main factor: role level" && shown.buttons === "Score again", JSON.stringify(shown.result));
  check("result: confidence, time and cost", shown.result?.details === "51% confidence · 0.1s · $0.00014", shown.result?.details);
  const sent = scoreCalls(shown)[0];
  check("result: the popup ran extract.js and sent only the job",
    shown.calls.some((c) => c.api === "executeScript" && c.func === "extractOpenJobPage") &&
    JSON.stringify(Object.keys(sent || {})) === JSON.stringify(["api", "type", "job"]), JSON.stringify(Object.keys(sent || {})));
  for (const [visa, expected] of [[0.595, "Likely · 60% strong"], [0.299, "Unclear · 30% moderate"], [0.29, "Unlikely · 29% weak"], [null, null]]) {
    await open({ replies: { score_job: { ok: true, result: { ...RESULT, visa, cached: true } } } });
    shown = await card(inState("result"));
    check(`result: visa ${visa} shows ${expected ?? "no visa row"}`, shown.state === "result" && shown.visa === expected, shown.visa);
  }
  check("result: a cached score says so", shown.result?.details === "51% confidence · cached · $0.00014", shown.result?.details);

  check("the popup throws no page errors", chrome.errors.length === 0, chrome.errors.join(" ; ").slice(0, 300));
} catch (error) {
  console.log("ERROR", error.message);
  failures++;
} finally {
  await chrome.close();
  server.close();
}

console.log(`\n${failures === 0 ? "ALL POPUP CHECKS PASSED" : failures + " FAILURE(S)"}`);
process.exit(failures ? 1 : 0);
