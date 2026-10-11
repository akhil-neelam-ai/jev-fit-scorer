// Loads the real background.js (and through it, scoring.js) with a fake chrome
// API and a fake Jev endpoint, then drives it through its message interface.
// Run: node test/worker.test.mjs
const store = {};
const listeners = [];
// A read sees the store as it was when the read started and answers 20 ms
// later, so the worker's first read is still in flight when the first
// messages arrive, as on a cold start.
let storageReads = 0;
globalThis.chrome = {
  storage: { local: {
    get: async (keys) => {
      storageReads++;
      const stored = Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
      await new Promise((r) => setTimeout(r, 20));
      return stored;
    },
    set: async (obj) => { Object.assign(store, structuredClone(obj)); }
  } },
  runtime: {
    onMessage: { addListener: (fn) => listeners.push(fn) }
  }
};

// The worker logs raw errors with console.warn. Keep them for checks.
const warnings = [];
console.warn = (...args) => warnings.push(args.map(String).join(" "));

// scoring.js gives every call AbortSignal.timeout(JEV_TIMEOUT_MS). Record what
// it asks for, and cut the wait to 50 ms so the timeout check runs fast.
const timeoutsAsked = [];
const realTimeout = AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout = (ms) => {
  timeoutsAsked.push(ms);
  return realTimeout(50);
};

const calls = [];
let nextResponse = null;
let stallNext = false; // the next call is accepted and never answered
let fetchDelayMs = 20; // lets concurrent requests overlap
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  calls.push({ url, auth: init.headers.Authorization, body, signal: init.signal });
  if (stallNext) {
    stallNext = false;
    // Like real fetch, it gives up only when its signal aborts. A real fetch
    // holds a socket open meanwhile, which keeps Node running. This timer
    // stands in for it, since AbortSignal.timeout's own timer doesn't.
    const socket = setInterval(() => {}, 1000);
    return new Promise((_, reject) => init.signal.addEventListener("abort", () => {
      clearInterval(socket);
      reject(init.signal.reason);
    }));
  }
  if (fetchDelayMs) await new Promise((r) => setTimeout(r, fetchDelayMs));
  // Like the real API, answer only the questions that were asked.
  const payload = structuredClone(nextResponse);
  if (payload?.answers) {
    payload.answers = Object.fromEntries(Object.entries(payload.answers).filter(([q]) => q in body.questions));
  }
  return { ok: true, json: async () => structuredClone(payload), text: async () => "" };
};

const { MAX_CACHE_ENTRIES } = await import(new URL("../background.js", import.meta.url));
// Read the endpoint and model from scoring.js, so swapping in another
// decision model doesn't break this test.
const { JEV_ENDPOINT, JEV_MODEL, JEV_TIMEOUT_MS, MAX_DESCRIPTION_CHARS } = await import(new URL("../scoring.js", import.meta.url));
const send = (msg) => new Promise((resolve) => listeners[0](msg, {}, resolve));

let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!cond) failures++;
};

const DIMS = ["required_qualifications", "function", "role_level", "customer_type", "company_stage", "domain"];
const good = (score, tokens) => ({
  answers: {
    fit: { score, confidence: 0.8, legend: ["a", "b", "c", "Strong", "e"] }, why: { choice: "function" }, visa: { noul: 0.3 },
    ...Object.fromEntries(DIMS.map((d, i) => [`dim_${d}`, { score: (i % 3), confidence: 0.7 }]))
  },
  usage: { input_tokens: tokens }
});
const jobA = { title: "Senior PM", company: "Stripe", description: "x".repeat(300), pageUrl: "https://a" };
const jobB = { title: "Growth PM", company: "Notion", description: "y".repeat(300), pageUrl: "https://b" };
const jobC = { title: "Data PM", company: "Ramp", description: "z".repeat(300), pageUrl: "https://c" };
const jobD = { title: "Ops PM", company: "Brex", description: "v".repeat(300), pageUrl: "https://d" };

// Cold start: both messages arrive while the worker's first read is in
// flight. They must wait on that read, not start their own, or a late read
// could undo the first save.
await Promise.all([
  send({ type: "save_settings", settings: { apiKey: "key-real" } }),
  send({ type: "save_settings", settings: { resume: "MBA, 4y analytics", needsSponsorship: true } })
]);
check("cold start reads storage once", storageReads === 1, `reads=${storageReads}`);
check("both cold-start saves persist", store.apiKey === "key-real" && store.resume === "MBA, 4y analytics",
  JSON.stringify({ apiKey: store.apiKey, resume: store.resume }));

nextResponse = good(3.2, 1000);
let r = await send({ type: "score_job", job: jobA });
check("fresh score returns ok", r.ok && r.result.fit === 3.2 && r.result.cached === false, JSON.stringify(r.result?.fit));
const { why, visa, fitConfidence, inputTokens, elapsedMs } = r.result || {};
check("result carries the fields the popup shows",
  why === "function" && visa === 0.3 && fitConfidence === 0.8 && inputTokens === 1000 && Number.isFinite(elapsedMs),
  JSON.stringify({ why, visa, fitConfidence, inputTokens, elapsedMs }));
check("request carries v5's nine questions",
  calls[0]?.url === JEV_ENDPOINT && calls[0]?.body.model === JEV_MODEL &&
  Object.keys(calls[0]?.body.questions || {}).join(",") === ["fit", "why", ...DIMS.map((d) => "dim_" + d), "visa"].join(","),
  Object.keys(calls[0]?.body.questions || {}).length + " questions");
check("scorecard parses with labels", r.result.scorecard && DIMS.every((d) => r.result.scorecard[d]) && r.result.scorecard.function.label === "Moderate" && r.result.scorecard.required_qualifications.label === "Weak",
  JSON.stringify(Object.fromEntries(Object.entries(r.result.scorecard || {}).map(([k, v]) => [k, v.label]))));
check("state carries resume and job", calls[0]?.body.state.startsWith("CANDIDATE RESUME:\nMBA, 4y analytics") && calls[0]?.body.state.includes("Senior PM at Stripe"));

r = await send({ type: "score_job", job: jobA });
check("second score of same job is served from cache", r.ok && r.result.cached === true && calls.length === 1, `fetch calls=${calls.length}`);

nextResponse = good(2.0, 500);
const [b1, b2] = await Promise.all([
  send({ type: "score_job", job: jobB }),
  send({ type: "score_job", job: jobB })
]);
check("concurrent identical jobs share one paid call", b1.ok && b2.ok && calls.length === 2, `fetch calls=${calls.length}`);

// A call that's accepted and never answered is dropped after JEV_TIMEOUT_MS,
// cut to 50 ms here, and the job can be scored again.
stallNext = true;
let before = calls.length;
r = await send({ type: "score_job", job: jobD });
check("a call that never answers times out in plain words",
  !r.ok && r.error === "TypeSafe took too long to answer. Try again.", r.error);
check("each call asks for a JEV_TIMEOUT_MS timeout on its fetch",
  timeoutsAsked.length === calls.length && timeoutsAsked.every((ms) => ms === JEV_TIMEOUT_MS) && calls.at(-1).signal instanceof AbortSignal,
  `asked ${[...new Set(timeoutsAsked)].join(", ")} ms`);
nextResponse = good(1.5, 300);
r = await send({ type: "score_job", job: jobD });
check("a job still scores after a timeout", r.ok && r.result.fit === 1.5 && r.result.cached === false && calls.length === before + 2,
  `new fetch calls=${calls.length - before}`);

// Each of these replies has no usable fit score, so it is refused and never
// cached. Failed scores aren't cached, so jobC makes a fresh call each time.
const invalidReplies = [
  ["a reply with no answers", {}],
  ["a reply with no fit answer", { answers: { why: { choice: "function" } } }],
  ["a null fit score", { answers: { fit: { score: null } } }],
  ["a fit score of -1", { answers: { fit: { score: -1 } } }],
  ["a fit score of 4.5", { answers: { fit: { score: 4.5 } } }]
];
for (const [name, reply] of invalidReplies) {
  nextResponse = { ...reply, usage: { input_tokens: 777 } };
  const cachedBefore = Object.keys(store.cache).length;
  r = await send({ type: "score_job", job: jobC });
  check(`${name} is rejected in plain words`, !r.ok && r.error === "Couldn't score this page. Try again.", r.error);
  check(`${name} is not cached`, Object.keys(store.cache).length === cachedBefore, `${Object.keys(store.cache).length} cached`);
}
check("the raw reason is logged for debugging", warnings.some((w) => w.includes("Jev returned an invalid fit score.")), warnings.at(-1));

const s = await send({ type: "get_status" });
check("get_status says only whether setup is done",
  JSON.stringify(s) === JSON.stringify({ ok: true, hasKey: true, hasResume: true }), JSON.stringify(s));
const g = await send({ type: "get_settings" });
check("get_settings sends the three Settings fields and no cache",
  g.ok && JSON.stringify(g.settings) === JSON.stringify({ apiKey: "key-real", resume: "MBA, 4y analytics", needsSponsorship: true }),
  JSON.stringify(Object.keys(g.settings || {})));

nextResponse = { answers: { check: { noul: 0.99 } }, usage: { input_tokens: 12 } };
r = await send({ type: "test_api_key", apiKey: "key-candidate" });
check("test_api_key uses the key under test", r.ok && calls.at(-1).auth === "Bearer key-candidate");
check("test_api_key does not touch saved settings", store.apiKey === "key-real");

await send({ type: "save_settings", settings: { needsSponsorship: false } });
nextResponse = good(1.0, 400);
r = await send({ type: "score_job", job: jobA });
check("changing sponsorship invalidates the cached score", r.ok && r.result.cached === false && r.result.fit === 1.0);
check("sponsorship off drops only the visa question and its estimate",
  !("visa" in calls.at(-1).body.questions) && Object.keys(calls.at(-1).body.questions).length === 8 && r.result.visa === null,
  `visa=${r.result?.visa}`);

// The cache key covers the resume and the job's details, not just the
// description. Whitespace around the resume doesn't count.
await send({ type: "save_settings", settings: { resume: "MBA, 6y analytics, SQL" } });
nextResponse = good(2.5, 300);
before = calls.length;
r = await send({ type: "score_job", job: jobA });
check("a new resume invalidates the cached score", r.ok && r.result.cached === false && r.result.fit === 2.5 && calls.length === before + 1,
  `new fetch calls=${calls.length - before}`);

await send({ type: "save_settings", settings: { resume: "  MBA, 6y analytics, SQL\n" } });
before = calls.length;
r = await send({ type: "score_job", job: jobA });
check("whitespace around the resume keeps the cached score", r.ok && r.result.cached === true && calls.length === before,
  `new fetch calls=${calls.length - before}`);

before = calls.length;
r = await send({ type: "score_job", job: { ...jobA, title: "Staff PM" } });
check("a new title with the same description is scored fresh", r.ok && r.result.cached === false && calls.length === before + 1,
  `new fetch calls=${calls.length - before}`);

// A job is four fields, and the description is cut at MAX_DESCRIPTION_CHARS
// before both the request and the cache key.
const longJob = {
  title: "Long PM", company: "Figma", description: "q".repeat(MAX_DESCRIPTION_CHARS + 500), pageUrl: "https://long",
  location: "Mars Base", salary: "$1"
};
before = calls.length;
r = await send({ type: "score_job", job: longJob });
const sentState = calls.at(-1).body.state;
check("the request cuts the description at MAX_DESCRIPTION_CHARS",
  r.ok && sentState.endsWith("FULL JOB DESCRIPTION:\n" + "q".repeat(MAX_DESCRIPTION_CHARS)), `${sentState.length} characters of state`);
check("only title, company, description and address reach Jev", !/Mars Base|\$1/.test(sentState) && sentState.includes("Source: https://long"));
r = await send({ type: "score_job", job: { ...longJob, description: longJob.description + " text past the cut" } });
check("text past the cut keeps the cached score", r.ok && r.result.cached === true && calls.length === before + 1,
  `new fetch calls=${calls.length - before}`);

// The cache keeps only the newest MAX_CACHE_ENTRIES scores, by their ts.
// Score the cap plus five more, each with a later ts than the one before.
const realNow = Date.now;
let clock = realNow();
Date.now = () => ++clock;
fetchDelayMs = 0;
nextResponse = good(2.0, 100);
const capJobs = Array.from({ length: MAX_CACHE_ENTRIES + 5 }, (_, i) => (
  { title: `PM ${i}`, company: "Acme", description: "w".repeat(300), pageUrl: `https://cap/${i}` }
));
const scoredTs = [];
for (const job of capJobs) scoredTs.push((await send({ type: "score_job", job })).result?.ts);
Date.now = realNow;
fetchDelayMs = 20;
const storedTs = Object.values(store.cache).map((entry) => entry.ts).sort((a, b) => a - b);
check("the stored cache stays at the cap", storedTs.length === MAX_CACHE_ENTRIES, `${storedTs.length} entries`);
check("the stored cache keeps the newest scores",
  JSON.stringify(storedTs) === JSON.stringify(scoredTs.slice(-MAX_CACHE_ENTRIES)),
  `oldest kept ts is score #${scoredTs.indexOf(storedTs[0]) + 1} of ${scoredTs.length}`);
before = calls.length;
r = await send({ type: "score_job", job: capJobs[0] });
check("a dropped score is scored fresh", r.ok && r.result.cached === false && calls.length === before + 1,
  `new fetch calls=${calls.length - before}`);

console.log(`\n${failures === 0 ? "ALL WORKER CHECKS PASSED" : failures + " FAILURE(S)"}`);
process.exit(failures ? 1 : 0);
