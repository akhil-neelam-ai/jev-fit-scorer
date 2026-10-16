import { DIMENSIONS, displayScore, estimateCost, recommendationFor, scoreBand, visaBand } from "./scoring.js";
import { extractOpenJobPage } from "./extract.js";

const $ = (id) => document.getElementById(id);

// Shows one state of the job card. A title is a job title and gets the
// "This job" eyebrow. A name is a state title, like "Description not found".
// The state also goes on <body data-state>, which tests and the screenshot
// script wait on: setup, loading, unscorable, board, embedded, not-found,
// not-job, error, result.
function setJobState({ state, title = "", name = "", status = "", result = null, retry = false }) {
  $("jobEyebrow").hidden = !title;
  $("jobName").textContent = title || name;
  $("jobStatus").textContent = status;
  $("jobStatus").hidden = !status;
  $("jobResult").hidden = !result;
  if (result) renderResult(result);
  $("rescore").hidden = !retry;
  $("setupGuide").hidden = state !== "setup";
  $("scoreAnyway").hidden = state !== "not-job";
  $("openEmbedded").hidden = state !== "embedded";
  document.body.dataset.state = state;
}

function renderResult(result) {
  const score = displayScore(result);
  $("jobRecommendation").textContent = recommendationFor(score);
  $("jobScore").textContent = `Fit ${score}/10`;
  $("jobScore").className = `score-chip ${scoreBand(score)}`;
  renderScorecard(result.scorecard);
  $("jobFactor").textContent = strongestFactor(result.why);
  renderVisa(result.visa);
  $("jobDetails").textContent = [
    formatConfidence(result.fitConfidence),
    result.cached ? "cached" : formatDuration(result.elapsedMs),
    formatCost(result.inputTokens)
  ].filter(Boolean).join(" · ");
}

function strongestFactor(choice) {
  const dimension = DIMENSIONS[choice];
  return dimension ? `Main factor: ${dimension.label.toLowerCase()}` : "Based on the visible job description.";
}

// Jev's six-dimension scorecard, in Lenny's order of importance.
function renderScorecard(scorecard) {
  const el = $("jobScorecard");
  el.replaceChildren();
  const rows = Object.entries(DIMENSIONS).filter(([key]) => scorecard?.[key]);
  el.hidden = rows.length === 0;
  for (const [key, dimension] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = dimension.label;
    const dd = document.createElement("dd");
    dd.textContent = scorecard[key].label;
    dd.className = scorecard[key].label.toLowerCase();
    el.append(dt, dd);
  }
}

// visaBand returns null when the user turned the estimate off.
function renderVisa(visa) {
  const band = visaBand(visa);
  $("jobVisa").hidden = !band;
  if (!band) return;
  $("jobVisaValue").textContent = `${band.label} · ${band.percent}%`;
  $("jobVisaValue").className = band.tone;
}

function formatConfidence(confidence) {
  return Number.isFinite(confidence) ? `${Math.round(confidence * 100)}% confidence` : "";
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "";
  return `${(milliseconds / 1000).toFixed(milliseconds < 10000 ? 1 : 0)}s`;
}

function formatCost(inputTokens) {
  return Number.isFinite(inputTokens) ? "$" + estimateCost(inputTokens).toFixed(5) : "";
}

const NO_RESPONSE = "The extension didn't respond. Try again.";

// Lenny's Jobs lists many roles on one page, so a role has to be opened first.
const isLennysJobs = (hostname) => hostname === "lennysjobs.com" || hostname.endsWith(".lennysjobs.com");

// What the not-job and embedded states' buttons act on.
let pageToScore = null;
let embeddedSrc = "";

async function scoreOpenJobPage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id || !tab.url || !/^https?:/.test(tab.url)) {
      setJobState({ state: "unscorable", name: "Open a job posting", status: "This tab can't be scored." });
      return;
    }

    if (isLennysJobs(new URL(tab.url).hostname)) {
      setJobState({
        state: "board",
        name: "Open a role first",
        status: "Click a job title to open its full description, then click the extension again."
      });
      return;
    }

    const [{ result: job }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractOpenJobPage
    });

    // The page's own text isn't the posting, so scoring it would be wrong.
    if (job?.embeddedSrc) {
      embeddedSrc = job.embeddedSrc;
      setJobState({
        state: "embedded",
        name: "This posting is embedded from another site",
        status: "Open it on its own page, then click the extension again."
      });
      return;
    }

    if (!job?.title || !job.description || job.description.length < 250) {
      setJobState({
        state: "not-found",
        name: "Description not found",
        status: "Open the role's full job description, then try again.",
        retry: true
      });
      return;
    }

    // Scoring sends the page to TypeSafe, so a page with no sign of a job
    // posting waits for a click.
    if (!job.looksLikeJob) {
      pageToScore = job;
      setJobState({
        state: "not-job",
        name: "This doesn't look like a job posting",
        status: "Score anyway sends this page's text to TypeSafe."
      });
      return;
    }

    await scoreJob(job);
  } catch {
    // Chrome refuses to run scripts on some pages, such as the Chrome Web Store.
    setJobState({
      state: "error",
      name: "Couldn't score this page",
      status: "Chrome can't read this page. Open the job on its own page, then try again.",
      retry: true
    });
  }
}

async function scoreJob(job) {
  setJobState({ state: "loading", title: job.title, status: "Scoring…" });
  const response = await chrome.runtime.sendMessage({ type: "score_job", job }).catch(() => null);

  // The worker writes its errors for people, so show them as they arrive.
  if (!response?.ok) {
    setJobState({ state: "error", title: job.title, status: response?.error || NO_RESPONSE, retry: true });
    return;
  }

  setJobState({ state: "result", title: job.title, result: response.result, retry: true });
}

// Returns the worker's status, or null after showing an error in the card.
async function loadStatus() {
  const status = await chrome.runtime.sendMessage({ type: "get_status" }).catch(() => null);
  if (status?.ok) return status;
  setJobState({ state: "error", name: "Couldn't score this page", status: NO_RESPONSE, retry: true });
  return null;
}

async function start() {
  // Show the loading state before any await, so Score again hides on the
  // click itself.
  setJobState({ state: "loading", name: "Reading this page…", status: "Finding the job description." });
  const status = await loadStatus();
  if (!status) return;
  if (status.hasKey && status.hasResume) {
    await scoreOpenJobPage();
  } else {
    setJobState({ state: "setup", name: "Set up Worth Applying?", status: "Add your TypeSafe API key and resume to start scoring." });
  }
}

// True while a run is going, so a double click on Score again or Score anyway
// can't start a second, overlapping run.
let running = false;
async function runOnce(task) {
  if (running) return;
  running = true;
  try {
    await task();
  } finally {
    running = false;
  }
}

$("openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("setupGuide").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") }));
// Score again checks the settings first, so it also recovers from a status error.
$("rescore").addEventListener("click", () => runOnce(start));
$("scoreAnyway").addEventListener("click", () => runOnce(() => scoreJob(pageToScore)));
$("openEmbedded").addEventListener("click", () => chrome.tabs.create({ url: embeddedSrc }));
document.addEventListener("DOMContentLoaded", () => runOnce(start));
// Counts the click on the icon, unless usage counts are off in Settings.
chrome.runtime.sendMessage({ type: "count", event: "popup_open" }).catch(() => {});
