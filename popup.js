import { DIMENSIONS, displayScore, estimateCost, recommendationFor } from "./scoring.js";

let currentJob = null;

function formatCost(inputTokens) {
  if (!Number.isFinite(inputTokens)) return "–";
  return "$" + estimateCost(inputTokens).toFixed(5);
}

function formatConfidence(confidence) {
  return Number.isFinite(confidence) ? `${Math.round(confidence * 100)}%` : "–";
}

function setJobState({ name, status, result, retry = false }) {
  document.getElementById("jobName").textContent = name;
  document.getElementById("jobStatus").textContent = status;
  document.getElementById("rescore").hidden = !retry;

  const resultEl = document.getElementById("jobResult");
  if (!result) {
    resultEl.hidden = true;
    return;
  }

  resultEl.hidden = false;
  const score = displayScore(result);
  document.getElementById("jobScore").textContent = `Fit score ${score}/10`;
  document.getElementById("jobScore").style.color = scoreColor(score);
  document.getElementById("jobScoreLabel").textContent = recommendationFor(score);
  renderScorecard(result.scorecard);
  document.getElementById("jobConfidence").textContent = formatConfidence(result.fitConfidence);
  document.getElementById("jobSpeed").textContent = result.cached ? "Cached" : formatDuration(result.elapsedMs).replace("Scored in ", "");
  document.getElementById("jobCost").textContent = formatCost(result.inputTokens);
}

// Same color bands as Lenny's display: 7 and up, 4 to 6, below 4.
function scoreColor(score) {
  if (score >= 7) return "#16a34a";
  if (score >= 4) return "#d97706";
  return "#6b7280";
}

function strongestFactor(choice) {
  const dimension = DIMENSIONS[choice];
  return dimension ? `Main factor: ${dimension.label.toLowerCase()}` : "Based on the visible job description.";
}

// Jev's six-dimension scorecard, in Lenny's order of importance.
function renderScorecard(scorecard) {
  const el = document.getElementById("jobScorecard");
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

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "Scored now";
  return `Scored in ${(milliseconds / 1000).toFixed(milliseconds < 10000 ? 1 : 0)}s`;
}

// This runs only in the active tab after the user opens the extension. activeTab
// grants temporary access for that interaction; the extension does not request
// blanket access to career sites.
function extractOpenJobPage() {
  const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
  const pageText = (element) => element?.innerText || element?.textContent || "";
  const textLength = (element) => clean(pageText(element)).length;
  const roots = [
    "[data-qa='job-description']",
    "[data-testid='job-description']",
    "#job-description",
    ".job-description",
    "[class*='job-description']",
    "article",
    "main",
    "[role='main']"
  ]
    .map((selector) => document.querySelector(selector))
    .filter((element) => element && textLength(element) >= 250);

  const root = roots[0] || document.body;
  const copy = root.cloneNode(true);
  copy.querySelectorAll("script, style, noscript, nav, header, footer, aside, form, button, svg").forEach((element) => element.remove());

  let description = clean(pageText(copy));
  if (description.length < 250 && root !== document.body) {
    description = clean(document.body.innerText);
  }

  const titleElement = document.querySelector("h1, [data-qa='job-title'], [data-testid='job-title']");
  const title = clean(
    titleElement?.textContent ||
      document.querySelector("meta[property='og:title']")?.content ||
      document.title
  );
  const explicitCompany = clean(
    document.querySelector("[data-qa='company-name'], [data-testid='company-name'], .company-name")?.textContent
  );
  // Amazon Jobs presents the legal employer in the paragraph immediately after
  // the H1: "Job ID: ... | Amazon Kuiper Commercial Services LLC".
  const titleSubheading = clean(titleElement?.nextElementSibling?.textContent);
  const company = explicitCompany || (titleSubheading.includes("|")
    ? clean(titleSubheading.slice(titleSubheading.lastIndexOf("|") + 1))
    : "");

  return {
    title,
    company,
    location: "",
    tagline: "",
    tags: "",
    salary: "",
    posted: "",
    meta: "",
    description: description.slice(0, 60000),
    pageUrl: location.href
  };
}

async function scoreOpenJobPage() {
  setJobState({
    name: "Reading the open job page…",
    status: "Extracting the visible description."
  });

  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id || !tab.url || !/^https?:/.test(tab.url)) {
      setJobState({ name: "Open a job description", status: "This tab cannot be scored." });
      return;
    }

    if (new URL(tab.url).hostname.endsWith("lennysjobs.com")) {
      setJobState({
        name: "Open a role first",
        status: "Click a job title to open its full description, then reopen Jev Fit Scorer."
      });
      return;
    }

    const [{ result: job }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractOpenJobPage
    });

    if (!job?.title || !job.description || job.description.length < 250) {
      setJobState({
        name: "Description not found",
        status: "Open the role's full job description, then try again.",
        retry: true
      });
      return;
    }

    currentJob = job;
    setJobState({ name: job.title, status: "Scoring with Jev…" });
    const response = await chrome.runtime.sendMessage({ type: "score_job", job, manual: true });

    if (!response?.ok) {
      throw new Error(response?.error || "Scoring failed.");
    }

    setJobState({
      name: job.title,
      status: `${strongestFactor(response.result.why)} · ${response.result.cached ? "From cache" : "Fresh result"}`,
      result: response.result,
      retry: true
    });
    await loadStatus();
  } catch (error) {
    setJobState({
      name: currentJob?.title || "Could not score this page",
      status: error.message || "Chrome could not read this job page.",
      retry: true
    });
  }
}

async function loadStatus() {
  const resp = await chrome.runtime.sendMessage({ type: "get_status" });
  if (!resp || !resp.ok) {
    document.getElementById("statusLine").textContent = "extension error";
    return null;
  }
  const ok = resp.hasKey && resp.hasResume;
  document.getElementById("statusLine").textContent = ok
    ? "ready — score an open job page"
    : "setup needed (open Options)";
  return resp;
}

document.getElementById("openOptions").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});
document.getElementById("rescore").addEventListener("click", scoreOpenJobPage);
document.addEventListener("DOMContentLoaded", async () => {
  const status = await loadStatus();
  if (status?.hasKey && status?.hasResume) await scoreOpenJobPage();
  else setJobState({ name: "Set up Jev Fit Scorer", status: "Add your API key and resume in Options." });
});
