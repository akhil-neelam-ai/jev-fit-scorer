// Worth Applying? background service worker.
//
// This file owns everything browser-specific: stored settings, the score cache,
// the request queue, and the message interface. The scoring itself (prompt,
// rubric, API call, response parsing) lives in scoring.js so the CLI and the
// eval harness score through exactly the same code.
//
// API calls happen here rather than in a content script because the service
// worker is not subject to the page's CORS restrictions.

import {
  cacheKeyFor,
  callJev,
  scoreJob as runJevScore
} from "./scoring.js";

const MAX_CONCURRENCY = 3;

// Cache + stats live in chrome.storage.local so they survive restarts.
const DEFAULT_SETTINGS = {
  apiKey: "",
  resume: "",
  needsSponsorship: true,
  autoScore: true,
  cache: {}, // hash -> {fit, fitConfidence, why, visa, inputTokens, elapsedMs, ts}
  totalInputTokens: 0,
  totalJobsScored: 0,
  sessionJobsScored: 0
};

let settings = { ...DEFAULT_SETTINGS };
let queue = [];
let inFlight = 0;
let settingsLoaded = false;
const pendingScores = new Map();

async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
    settings = { ...DEFAULT_SETTINGS, ...stored };
  } catch (e) {
    console.warn("[worth-applying] failed to load settings", e);
  }
  settingsLoaded = true;
}

async function saveSettings() {
  await chrome.storage.local.set({
    apiKey: settings.apiKey,
    resume: settings.resume,
    needsSponsorship: settings.needsSponsorship,
    autoScore: settings.autoScore,
    cache: settings.cache,
    totalInputTokens: settings.totalInputTokens,
    totalJobsScored: settings.totalJobsScored,
    sessionJobsScored: settings.sessionJobsScored
  });
}

// The cache key covers the candidate and the scoring options as well as the
// job, so changing either naturally produces a fresh score.
function keyFor(job) {
  return cacheKeyFor({
    resume: settings.resume,
    needsSponsorship: settings.needsSponsorship,
    job
  });
}

async function scoreJob(job) {
  const key = keyFor(job);
  const cached = settings.cache[key];
  if (cached) return { ...cached, cached: true };

  const pending = pendingScores.get(key);
  if (pending) return pending;

  const scoring = scoreAndCacheJob(job, key);
  pendingScores.set(key, scoring);
  try {
    return await scoring;
  } finally {
    pendingScores.delete(key);
  }
}

async function scoreAndCacheJob(job, key) {
  let scored;
  try {
    scored = await runJevScore({
      apiKey: settings.apiKey,
      resume: settings.resume,
      needsSponsorship: settings.needsSponsorship,
      job
    });
  } catch (e) {
    // A malformed response still consumed tokens, so persist the counter even
    // though there is no score to cache.
    if (e.usage) {
      settings.totalInputTokens += Number(e.usage.input_tokens) || 0;
      await saveSettings();
    }
    throw e;
  }

  settings.totalInputTokens += Number(scored.usage.input_tokens) || 0;
  settings.cache[key] = scored.result;
  settings.totalJobsScored += 1;
  settings.sessionJobsScored += 1;
  await saveSettings();
  return { ...scored.result, cached: false };
}

// ---- queue: max MAX_CONCURRENCY Jev calls in flight ----
function pumpQueue() {
  while (inFlight < MAX_CONCURRENCY && queue.length > 0) {
    const { job, manual, resolve, reject } = queue.shift();
    if (!settings.autoScore && !manual) {
      reject(new Error("Auto-score was turned off before this job was scored."));
      continue;
    }
    inFlight++;
    scoreJob(job)
      .then(resolve)
      .catch(reject)
      .finally(() => {
        inFlight--;
        pumpQueue();
      });
  }
}

function enqueueScore(job, manual = false) {
  return new Promise((resolve, reject) => {
    queue.push({ job, manual, resolve, reject });
    pumpQueue();
  });
}

// ---- message interface ----
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (!settingsLoaded) await loadSettings();

    if (msg.type === "score_job") {
      const manual = msg.manual === true;
      if (!settings.autoScore && !manual) {
        return sendResponse({ ok: true, manualRequired: true });
      }
      try {
        const result = await enqueueScore(msg.job, manual);
        sendResponse({ ok: true, result });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    } else if (msg.type === "test_api_key") {
      // Tiny smoke-test call: score a trivial state so we spend ~100 tokens.
      // The key under test is passed explicitly so it never touches settings
      // until it is known to work.
      try {
        const data = await callJev({
          state: "TEST: the sky is blue.",
          questions: {
            check: {
              type: "noul",
              instructions: "The state is a true statement."
            }
          },
          apiKey: msg.apiKey
        });
        sendResponse({ ok: true, usage: data.usage || null });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    } else if (msg.type === "get_status") {
      sendResponse({
        ok: true,
        hasKey: !!settings.apiKey,
        hasResume: !!settings.resume.trim(),
        autoScore: settings.autoScore,
        needsSponsorship: settings.needsSponsorship,
        totalInputTokens: settings.totalInputTokens,
        totalJobsScored: settings.totalJobsScored,
        sessionJobsScored: settings.sessionJobsScored,
        queueDepth: queue.length
      });
    } else if (msg.type === "get_settings") {
      sendResponse({ ok: true, settings });
    } else if (msg.type === "save_settings") {
      settings = { ...settings, ...msg.settings };
      await saveSettings();
      sendResponse({ ok: true });
    }
  })();
  return true; // async response
});

chrome.runtime.onStartup.addListener(async () => {
  await loadSettings();
  settings.sessionJobsScored = 0;
  await saveSettings();
});
chrome.runtime.onInstalled.addListener(async () => {
  await loadSettings();
  settings.sessionJobsScored = 0; // reset the per-session counter
  await saveSettings();
});

loadSettings();
