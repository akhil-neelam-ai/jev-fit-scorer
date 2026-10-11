// Checks that every error the worker sends back is written for people, that
// the raw error still reaches the worker console, and that a storage fault
// can't cost a paid score or erase saved settings. Loads the real
// background.js with a fake chrome API and a fake Jev endpoint, the same way
// worker.test.mjs does.
// Run: node test/errors.test.mjs
const store = {};
const listeners = [];
let failNextGet = false;
let failNextSave = false;
globalThis.chrome = {
  storage: { local: {
    get: async (keys) => {
      if (failNextGet) {
        failNextGet = false;
        throw new Error("storage read failed");
      }
      return Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
    },
    set: async (obj) => {
      if (failNextSave) {
        failNextSave = false;
        throw new Error("QUOTA_BYTES quota exceeded");
      }
      Object.assign(store, structuredClone(obj));
    }
  } },
  runtime: {
    onMessage: { addListener: (fn) => listeners.push(fn) },
    onInstalled: { addListener: () => {} }
  }
};

// The worker logs raw errors with console.warn. Keep them for checks.
const warnings = [];
console.warn = (...args) => warnings.push(args.map(String).join(" "));

// Each fetch plays `outcome`: an Error to throw, or a status and a body.
let outcome = null;
let fetchCalls = 0;
globalThis.fetch = async () => {
  fetchCalls++;
  await new Promise((r) => setTimeout(r, 10));
  if (outcome instanceof Error) throw outcome;
  const { status, body } = outcome;
  return { ok: status >= 200 && status < 300, status, text: async () => body, json: async () => JSON.parse(body) };
};

const { friendlyError } = await import(new URL("../background.js", import.meta.url));

// Record every reply the worker sends, so the last checks can scan them all.
const replies = [];
const sendTo = (listener) => (msg) => new Promise((resolve) => listener(msg, {}, (reply) => {
  replies.push(reply);
  resolve(reply);
}));
const send = sendTo(listeners[0]);

let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!cond) failures++;
};

const BAD_KEY = "TypeSafe didn't accept your API key. Check it in Settings.";
const KEY_DIDNT_WORK = "That key didn't work. Check it and try again.";
const NO_CHARGE = "TypeSafe couldn't charge this request. Check your account at console.typesafe.ai.";
const TOO_SLOW = "TypeSafe took too long to answer. Try again.";
const TOO_MANY = "Too many requests right now. Wait a minute, then try again.";
const SERVER = "TypeSafe is having trouble. Try again in a minute.";
const OFFLINE = "Couldn't reach TypeSafe. Check your connection, then try again.";
const SCORE_FAILED = "Couldn't score this page. Try again.";
const TEST_FAILED = "Couldn't test your API key. Try again.";
const RAW_401 = 'Jev API 401: {"error":"invalid api key"}';
// What fetch rejects with when scoring.js's AbortSignal.timeout fires. Some
// browsers report an AbortError instead.
const timedOut = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");
const aborted = () => new DOMException("This operation was aborted", "AbortError");

// ---- the mapping on its own ----
for (const [name, error, expected] of [
  ["401 means the key was refused", new Error(RAW_401), BAD_KEY],
  ["403 means the key was refused", new Error('Jev API 403: {"error":"forbidden"}'), BAD_KEY],
  ["402 points to the account", new Error('Jev API 402: {"error":"insufficient credits"}'), NO_CHARGE],
  ["408 says it took too long", new Error("Jev API 408: "), TOO_SLOW],
  ["a timed-out call says it took too long", timedOut(), TOO_SLOW],
  ["an aborted call says it took too long", aborted(), TOO_SLOW],
  ["429 asks for a short wait", new Error('Jev API 429: {"error":"rate limited"}'), TOO_MANY],
  ["500 is trouble at TypeSafe", new Error("Jev API 500: Internal Server Error"), SERVER],
  ["503 is trouble at TypeSafe", new Error("Jev API 503: <html>Service Unavailable</html>"), SERVER],
  ["504 is trouble at TypeSafe", new Error("Jev API 504: "), SERVER],
  ["Chromium network failure", new TypeError("Failed to fetch"), OFFLINE],
  ["Node network failure", new TypeError("fetch failed"), OFFLINE],
  ["a TypeError from a bug is not a network failure", new TypeError("Cannot read properties of undefined (reading 'title')"), SCORE_FAILED],
  ["other statuses fall back", new Error('Jev API 400: {"error":"bad request"}'), SCORE_FAILED],
  ["a body that isn't JSON falls back", new SyntaxError("Unexpected token '<', \"<html>\" is not valid JSON"), SCORE_FAILED],
  ["an unusable score falls back", new Error("Jev returned an invalid fit score."), SCORE_FAILED],
  ["a thrown string falls back", "boom", SCORE_FAILED],
  ["a missing error falls back", undefined, SCORE_FAILED]
]) {
  const got = friendlyError(error);
  check(`friendlyError: ${name}`, got === expected, got);
}
check("friendlyError: the message type names the fallback", friendlyError(new Error("odd"), "test_api_key") === TEST_FAILED);
check("friendlyError: a known status wins over the fallback",
  friendlyError(new Error('Jev API 429: {"error":"rate limited"}'), "test_api_key") === TOO_MANY);
check("friendlyError: a key test has its own refused-key wording",
  friendlyError(new Error(RAW_401), "test_api_key") === KEY_DIDNT_WORK && friendlyError(new Error(RAW_401), "score_job") === BAD_KEY);

// ---- through the message interface ----
const job = (n) => ({ title: "Senior PM", company: "Stripe", description: "x".repeat(300), pageUrl: `https://jobs.example/${n}` });
const reply = (status, body) => ({ status, body });
const fit = (score) => JSON.stringify({ answers: { fit: { score } }, usage: { input_tokens: 10 } });

let r = await send({ type: "score_job", job: job(1) });
check("no key: points to Settings before any paid call",
  !r.ok && r.error === "Add your TypeSafe API key in Settings." && fetchCalls === 0, r.error);

await send({ type: "save_settings", settings: { apiKey: "key-real" } });
r = await send({ type: "score_job", job: job(1) });
check("no resume: points to Settings before any paid call",
  !r.ok && r.error === "Add your resume in Settings." && fetchCalls === 0, r.error);

await send({ type: "save_settings", settings: { resume: "MBA, 4y analytics" } });

// Failed scores are never cached, so the same job makes a fresh call each time.
for (const [name, planned, expected] of [
  ["401 with a raw body", reply(401, '{"error":"invalid api key"}'), BAD_KEY],
  ["402", reply(402, '{"error":"insufficient credits"}'), NO_CHARGE],
  ["429", reply(429, '{"error":"rate limited"}'), TOO_MANY],
  ["503", reply(503, "<html>Service Unavailable</html>"), SERVER],
  ["offline", new TypeError("Failed to fetch"), OFFLINE],
  ["a call that times out", timedOut(), TOO_SLOW],
  ["a 200 that isn't JSON", reply(200, "<html>Sign in to Wi-Fi</html>"), SCORE_FAILED],
  ["an unusable score", reply(200, fit(9)), SCORE_FAILED]
]) {
  outcome = planned;
  r = await send({ type: "score_job", job: job(1) });
  check(`score_job, ${name}`, !r.ok && r.error === expected, r.error);
}

// The Settings page sends test_api_key, so a refused key there doesn't point
// to Settings.
for (const [name, planned, expected] of [
  ["401 with a raw body", reply(401, '{"error":"invalid api key"}'), KEY_DIDNT_WORK],
  ["403", reply(403, '{"error":"forbidden"}'), KEY_DIDNT_WORK],
  ["offline", new TypeError("Failed to fetch"), OFFLINE],
  ["a call that times out", timedOut(), TOO_SLOW],
  ["a 200 that isn't JSON", reply(200, "<html>Sign in to Wi-Fi</html>"), TEST_FAILED]
]) {
  outcome = planned;
  r = await send({ type: "test_api_key", apiKey: "key-candidate" });
  check(`test_api_key, ${name}`, !r.ok && r.error === expected, r.error);
}

check("the raw 401 still reaches the worker console", warnings.some((w) => w.includes(RAW_401)), `${warnings.length} warnings`);
check("setup messages are not logged as faults", !warnings.some((w) => w.includes("in Settings")));

// ---- storage faults ----
outcome = reply(200, fit(2));
r = await send({ type: "score_job", job: job(2) });
check("a working score is stored", r.ok && Object.keys(store.cache || {}).length === 1, `${Object.keys(store.cache || {}).length} stored`);

// The score is paid for by the time the cache write fails, so it still
// comes back.
failNextSave = true;
r = await send({ type: "score_job", job: job(3) });
check("a failed cache write still returns the paid score", r.ok && r.result?.fit === 2 && r.result.cached === false, r.error);
check("the failed cache write is logged", warnings.some((w) => w.includes("couldn't save the score") && w.includes("QUOTA_BYTES")));
let callsBefore = fetchCalls;
r = await send({ type: "score_job", job: job(3) });
check("the worker still has that score in memory", r.ok && r.result.cached === true && fetchCalls === callsBefore, `new fetch calls=${fetchCalls - callsBefore}`);

// A failed save changes nothing, in storage or in the worker.
const settingsBefore = (await send({ type: "get_settings" })).settings;
failNextSave = true;
r = await send({ type: "save_settings", settings: { apiKey: "", resume: "", needsSponsorship: false } });
check("a failed save still answers, in plain words", !r.ok && r.error === "Couldn't save your settings. Try again.", r.error);
const settingsAfter = (await send({ type: "get_settings" })).settings;
check("get_settings keeps the old values after a failed save",
  settingsAfter?.apiKey === "key-real" && JSON.stringify(settingsAfter) === JSON.stringify(settingsBefore), JSON.stringify(settingsAfter));
const status = await send({ type: "get_status" });
check("get_status keeps the old values after a failed save", status.ok && status.hasKey && status.hasResume, JSON.stringify(status));

// Chrome stops an idle worker and starts a new one later. Start a second copy
// of background.js while storage reads fail. Until a read works, it must not
// report missing setup or write over what's stored.
const storedBefore = JSON.stringify(store);
failNextGet = true;
await import(new URL("../background.js?restarted", import.meta.url));
await new Promise((resolve) => setTimeout(resolve, 0)); // let its first read fail
const sendNew = sendTo(listeners.at(-1));
check("the failed first read is logged", warnings.some((w) => w.includes("failed to load settings") && w.includes("storage read failed")));

failNextGet = true;
r = await sendNew({ type: "get_status" });
check("get_status after a failed read doesn't report a missing key", !r.ok && !("hasKey" in r), JSON.stringify(r));
failNextGet = true;
r = await sendNew({ type: "save_settings", settings: { needsSponsorship: false } });
check("save_settings after a failed read writes nothing", !r.ok && JSON.stringify(store) === storedBefore, r.error);

r = await sendNew({ type: "get_status" });
check("the next message reads storage again", r.ok && r.hasKey && r.hasResume, JSON.stringify(r));
callsBefore = fetchCalls;
r = await sendNew({ type: "score_job", job: job(2) });
check("the stored key, resume and cache all survive",
  r.ok && r.result.cached === true && fetchCalls === callsBefore && JSON.stringify(store) === storedBefore, `new fetch calls=${fetchCalls - callsBefore}`);

// Whatever failed, no reply carries raw API text or breaks the copy rules.
const errors = replies.filter((x) => x?.ok === false).map((x) => x.error);
const raw = errors.find((e) => /Jev API|invalid api key|[{}<>]/.test(e));
check("no error reply carries raw API text", errors.length > 0 && raw === undefined, raw || `${errors.length} error replies`);
const offStyle = errors.find((e) => /[—;]|options/i.test(e));
check("no error reply has an em dash, a semicolon, or \"Options\"", offStyle === undefined, offStyle);

console.log(`\n${failures === 0 ? "ALL ERROR CHECKS PASSED" : failures + " FAILURE(S)"}`);
process.exit(failures ? 1 : 0);
