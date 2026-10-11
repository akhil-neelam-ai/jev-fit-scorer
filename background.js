// Worth Applying? background service worker.
//
// This file owns everything browser-specific: stored settings, the score cache,
// and the message interface. The scoring itself (prompt, rubric, API call,
// response parsing) lives in scoring.js so the CLI and the eval harness score
// through exactly the same code.
//
// API calls happen here because the service worker is not subject to the
// page's CORS restrictions.

import {
  cacheKeyFor,
  callJev,
  scoreJob as runJevScore
} from "./scoring.js";

// Settings and the score cache live in chrome.storage.local so they survive
// restarts. These are the stored keys and their defaults.
const DEFAULT_SETTINGS = {
  apiKey: "",
  resume: "",
  needsSponsorship: true,
  cache: {} // cache key -> the result scoring.js's parseJevResponse returns
};

// The settings the Settings page shows and saves.
const USER_SETTINGS = ["apiKey", "resume", "needsSponsorship"];

// The cache keeps this many scores, the newest by the ts each one stores.
// Exported for the tests.
export const MAX_CACHE_ENTRIES = 500;

let settings = { ...DEFAULT_SETTINGS };
const pendingScores = new Map();

// The listed keys of an object, skipping any it doesn't have.
const pick = (object, keys) =>
  Object.fromEntries(keys.filter((key) => key in (object || {})).map((key) => [key, object[key]]));

// ---- errors people see ----
//
// The popup and the Settings page show a reply's `error` word for word. So
// every failed message answers with friendlyError's wording, and the raw error
// goes to the worker console. The CLI calls scoring.js directly and keeps the
// detailed messages.

const SCORE_FAILED = "Couldn't score this page. Try again.";
const KEY_REFUSED = "TypeSafe didn't accept your API key. Check it in Settings.";
const TOO_SLOW = "TypeSafe took too long to answer. Try again.";

// Wording by message type. `fallback` is what to say when friendlyError can't
// name the problem. `keyRefused` replaces the refused-key wording, because the
// Settings page tests keys and shouldn't send people to Settings.
const ERRORS_BY_TYPE = {
  score_job: { fallback: SCORE_FAILED },
  test_api_key: {
    fallback: "Couldn't test your API key. Try again.",
    keyRefused: "That key didn't work. Check it and try again."
  },
  save_settings: { fallback: "Couldn't save your settings. Try again." }
};

// For a message that is already written for people. friendlyError shows it
// as it is.
function userError(message) {
  return Object.assign(new Error(message), { forUser: true });
}

// Exported for the tests. `type` is the message type that failed.
export function friendlyError(error, type) {
  const { fallback = SCORE_FAILED, keyRefused = KEY_REFUSED } = ERRORS_BY_TYPE[type] || {};
  if (error?.forUser) return error.message;
  const message = String(error?.message ?? "");
  // scoring.js reports any non-2xx response as "Jev API <status>: <body>".
  const status = Number(/^Jev API (\d{3}):/.exec(message)?.[1]);
  if (status === 401 || status === 403) return keyRefused;
  if (status === 402) return "TypeSafe couldn't charge this request. Check your account at console.typesafe.ai.";
  if (status === 408) return TOO_SLOW;
  if (status === 429) return "Too many requests right now. Wait a minute, then try again.";
  if (status >= 500 && status <= 599) return "TypeSafe is having trouble. Try again in a minute.";
  // scoring.js drops a call that runs past JEV_TIMEOUT_MS. Depending on the
  // browser, fetch then rejects with a TimeoutError or an AbortError.
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return TOO_SLOW;
  // fetch rejects with a TypeError when no response came back at all:
  // "Failed to fetch" in Chromium, "fetch failed" in Node.
  if (error?.name === "TypeError" && /failed to fetch|fetch failed/i.test(message)) {
    return "Couldn't reach TypeSafe. Check your connection, then try again.";
  }
  return fallback;
}

// ---- settings ----

// True once a storage read has worked. Until then settings holds only the
// defaults, and saving them would erase what's stored.
let settingsLoaded = false;

async function loadSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  settings = { ...DEFAULT_SETTINGS, ...stored };
  settingsLoaded = true;
}

// Every handler waits on one shared read, so a cold start reads storage once,
// and a late read can't undo an early save. A failed read fails the messages
// that waited on it and clears the promise, so the next message reads again.
let settingsReady = null;
function whenSettingsReady() {
  settingsReady ??= loadSettings().catch((e) => {
    settingsReady = null;
    throw e;
  });
  return settingsReady;
}
whenSettingsReady().catch((e) => console.warn("[worth-applying] failed to load settings", e));

// Writes `values` to storage. It refuses until a read has worked, so the
// defaults can never overwrite stored settings.
async function saveSettings(values) {
  if (!settingsLoaded) throw new Error("Settings never loaded, so saving could erase them.");
  await chrome.storage.local.set(values);
}

// ---- the score cache ----

// The cache key covers the candidate and the scoring options as well as the
// job, so changing either naturally produces a fresh score.
function keyFor(job) {
  return cacheKeyFor({
    resume: settings.resume,
    needsSponsorship: settings.needsSponsorship,
    job
  });
}

// Drops all but the newest MAX_CACHE_ENTRIES scores, so the cache can't fill
// storage.
function pruneCache(cache) {
  const keys = Object.keys(cache);
  if (keys.length <= MAX_CACHE_ENTRIES) return;
  keys.sort((a, b) => (cache[b].ts || 0) - (cache[a].ts || 0));
  for (const key of keys.slice(MAX_CACHE_ENTRIES)) delete cache[key];
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
  // Check setup before scoring.js does, so the message names Settings.
  if (!settings.apiKey) throw userError("Add your TypeSafe API key in Settings.");
  if (!(settings.resume || "").trim()) throw userError("Add your resume in Settings.");

  const { result } = await runJevScore({
    apiKey: settings.apiKey,
    resume: settings.resume,
    needsSponsorship: settings.needsSponsorship,
    job
  });

  settings.cache[key] = result;
  pruneCache(settings.cache);
  // The score is paid for and in hand. A failed write only loses the stored
  // copy, so log it and still return the score.
  try {
    await saveSettings({ cache: settings.cache });
  } catch (e) {
    console.warn("[worth-applying] couldn't save the score to the cache", e);
  }
  return { ...result, cached: false };
}

// ---- message interface ----
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    await whenSettingsReady();

    if (msg.type === "score_job") {
      sendResponse({ ok: true, result: await scoreJob(msg.job) });
    } else if (msg.type === "test_api_key") {
      // Tiny smoke-test call: score a trivial state so we spend ~100 tokens.
      // The key under test is passed explicitly so it never touches settings
      // until it is known to work.
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
    } else if (msg.type === "get_status") {
      sendResponse({
        ok: true,
        hasKey: !!settings.apiKey,
        hasResume: !!settings.resume.trim()
      });
    } else if (msg.type === "get_settings") {
      // Only what the Settings page shows. The score cache stays here.
      sendResponse({ ok: true, settings: pick(settings, USER_SETTINGS) });
    } else if (msg.type === "save_settings") {
      // Write only the fields this message sets, and change the live settings
      // once storage has them. So a failed save changes nothing, and two saves
      // at once can't undo each other.
      const changes = pick(msg.settings, USER_SETTINGS);
      await saveSettings(changes);
      settings = { ...settings, ...changes };
      sendResponse({ ok: true });
    }
  })().catch((e) => {
    // Every failed message answers here. Setup messages are already written
    // for people, so only real faults are logged.
    if (!e?.forUser) console.warn(`[worth-applying] ${msg?.type} failed`, e);
    sendResponse({ ok: false, error: friendlyError(e, msg?.type) });
  });
  return true; // async response
});
