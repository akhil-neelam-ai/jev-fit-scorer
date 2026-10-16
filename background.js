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
  shareUsage: true,
  cache: {}, // cache key -> the result scoring.js's parseJevResponse returns
  // Usage-count bookkeeping: the random install ID, the once-only counts
  // already sent, and the last day active_day was sent.
  installId: "",
  countsSent: {},
  activeDay: ""
};

// The settings the Settings page shows and saves.
const USER_SETTINGS = ["apiKey", "resume", "needsSponsorship", "shareUsage"];

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

  let result;
  try {
    ({ result } = await runJevScore({
      apiKey: settings.apiKey,
      resume: settings.resume,
      needsSponsorship: settings.needsSponsorship,
      job
    }));
  } catch (e) {
    count("score_error");
    throw e;
  }
  count("score");
  count("first_score");

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

// ---- usage counts ----
//
// Anonymous counts of a few actions, so we can see how many installs finish
// setup and keep using the extension. Each count is an event name, the
// extension's version and a random install ID made here. Never the resume,
// the key, anything about a job, page addresses or scores. The privacy policy
// lists the events, and Settings turns counts off.

export const COUNT_URL = "https://worth-applying.vercel.app/api/count";

// Sent the first time each happens on an install.
const ONCE = new Set(["install", "guide_intro", "guide_pin", "guide_key", "guide_resume", "guide_try", "guide_done", "setup_done", "first_score"]);
// Sent at most once a day.
const DAILY = new Set(["active_day"]);
// Sent every time.
const EVERY = new Set(["popup_open", "score", "score_error"]);
// What the popup and the setup guide may ask to count.
const PAGE_EVENTS = new Set(["popup_open", "guide_intro", "guide_pin", "guide_key", "guide_resume", "guide_try", "guide_done"]);

// The bookkeeping runs one count at a time, so two counts can't both send a
// once-only event or make two install IDs. Sending doesn't wait in line.
let counting = Promise.resolve();
function inTurn(task) {
  const run = counting.then(task);
  counting = run.catch(() => null);
  return run;
}

// Counts `event` unless counts are off or it was already counted. It never
// throws. A count that doesn't get through is dropped, but a once-only or
// daily one can go again next time.
function count(event) {
  return inTurn(() => claim(event))
    .then((claimed) => claimed && deliver(claimed))
    .catch(() => {});
}

// Marks `event` as counted and returns what to send, or null to send nothing.
async function claim(event) {
  await whenSettingsReady();
  if (!settings.shareUsage) return null;
  if (ONCE.has(event)) {
    if (settings.countsSent[event]) return null;
    settings.countsSent = { ...settings.countsSent, [event]: true };
    await saveSettings({ countsSent: settings.countsSent });
  } else if (DAILY.has(event)) {
    const today = new Date().toISOString().slice(0, 10);
    if (settings.activeDay === today) return null;
    settings.activeDay = today;
    await saveSettings({ activeDay: today });
  } else if (!EVERY.has(event)) {
    return null;
  }
  // Counts may have been turned off while that saved.
  if (!settings.shareUsage) return null;
  if (!settings.installId) {
    settings.installId = crypto.randomUUID();
    await saveSettings({ installId: settings.installId });
  }
  return { event, installId: settings.installId };
}

async function deliver({ event, installId }) {
  if (!settings.shareUsage) return;
  let delivered = false;
  try {
    const response = await fetch(COUNT_URL, {
      method: "POST",
      // Plain text keeps this a simple request, so there's no CORS preflight.
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ e: event, v: chrome.runtime.getManifest().version, id: installId }),
      signal: AbortSignal.timeout(10_000)
    });
    delivered = response.ok;
  } catch {}
  if (delivered) return;
  // A once-only or daily count that didn't get through can go again next time.
  await inTurn(async () => {
    if (ONCE.has(event)) {
      const { [event]: _, ...rest } = settings.countsSent;
      settings.countsSent = rest;
      await saveSettings({ countsSent: rest });
    } else if (DAILY.has(event)) {
      settings.activeDay = "";
      await saveSettings({ activeDay: "" });
    }
  });
}

// An install from before counts existed has been through setup already, or
// chose not to. Marking what it did keeps setup_done and first_score meaning
// the first time, and keeps old installs out of the setup funnel.
function markEarlierSetup() {
  return inTurn(async () => {
    await whenSettingsReady();
    if (settings.countsSent.install) return;
    const done = ["install", "guide_intro", "guide_pin", "guide_key", "guide_resume", "guide_try", "guide_done"];
    if (settings.apiKey && settings.resume.trim()) done.push("setup_done");
    if (Object.keys(settings.cache).length > 0) done.push("first_score");
    settings.countsSent = { ...Object.fromEntries(done.map((event) => [event, true])), ...settings.countsSent };
    await saveSettings({ countsSent: settings.countsSent });
  }).catch((e) => console.warn("[worth-applying] couldn't mark earlier setup", e));
}

// ---- install ----

// A new install opens the setup guide. Updates and reloads don't.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "update") markEarlierSetup();
  if (reason !== "install") return;
  count("install");
  chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") })
    .catch((e) => console.warn("[worth-applying] couldn't open the setup guide", e));
});

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
      // hasScore tells the setup guide that a first job has been scored.
      sendResponse({
        ok: true,
        hasKey: !!settings.apiKey,
        hasResume: !!settings.resume.trim(),
        hasScore: Object.keys(settings.cache).length > 0
      });
    } else if (msg.type === "get_settings") {
      // Only what the Settings page shows. The score cache stays here.
      sendResponse({ ok: true, settings: pick(settings, USER_SETTINGS) });
    } else if (msg.type === "save_settings") {
      // Write only the fields this message sets, and change the live settings
      // once storage has them. So a failed save changes nothing, and two saves
      // at once can't undo each other.
      const changes = pick(msg.settings, USER_SETTINGS);
      // Turning counts off forgets the install ID. Turning them back on
      // starts a new one.
      if (changes.shareUsage === false) changes.installId = "";
      await saveSettings(changes);
      settings = { ...settings, ...changes };
      sendResponse({ ok: true });
      if (settings.apiKey && settings.resume.trim()) count("setup_done");
    } else if (msg.type === "count") {
      // The popup and the setup guide count their own events through here.
      if (PAGE_EVENTS.has(msg.event)) {
        count(msg.event);
        if (msg.event === "popup_open") count("active_day");
      }
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
