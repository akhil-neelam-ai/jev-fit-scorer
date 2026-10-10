// Loads the real background.js (and through it, scoring.js) with a fake chrome
// API and a fake Jev endpoint, then drives it through its message interface.
// Run: node test/worker.test.mjs
const store = {};
const listeners = [];
globalThis.chrome = {
  storage: { local: {
    get: async (keys) => Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, structuredClone(store[k])])),
    set: async (obj) => { Object.assign(store, structuredClone(obj)); }
  } },
  runtime: {
    onMessage: { addListener: (fn) => listeners.push(fn) },
    onStartup: { addListener() {} },
    onInstalled: { addListener() {} }
  }
};

const calls = [];
let nextResponse = null;
globalThis.fetch = async (url, init) => {
  calls.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) });
  await new Promise((r) => setTimeout(r, 20)); // let concurrent requests overlap
  const payload = nextResponse;
  return { ok: true, json: async () => structuredClone(payload), text: async () => "" };
};

await import(new URL("../background.js", import.meta.url));
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

await send({ type: "save_settings", settings: { apiKey: "key-real", resume: "MBA, 4y analytics", needsSponsorship: true } });

nextResponse = good(3.2, 1000);
let r = await send({ type: "score_job", job: jobA, manual: true });
check("fresh score returns ok", r.ok && r.result.fit === 3.2 && r.result.cached === false, JSON.stringify(r.result?.fit));
check("request carries v5's nine questions",
  calls[0]?.url === "https://api.typesafe.ai/v1/systemone" && calls[0]?.body.model === "jev-latest" &&
  Object.keys(calls[0]?.body.questions || {}).join(",") === ["fit", "why", ...DIMS.map((d) => "dim_" + d), "visa"].join(","),
  Object.keys(calls[0]?.body.questions || {}).length + " questions");
check("scorecard parses with labels", r.result.scorecard && DIMS.every((d) => r.result.scorecard[d]) && r.result.scorecard.function.label === "Moderate" && r.result.scorecard.required_qualifications.label === "Weak",
  JSON.stringify(Object.fromEntries(Object.entries(r.result.scorecard || {}).map(([k, v]) => [k, v.label]))));
check("state carries resume and job", calls[0]?.body.state.startsWith("CANDIDATE RESUME:\nMBA, 4y analytics") && calls[0]?.body.state.includes("Senior PM at Stripe"));

r = await send({ type: "score_job", job: jobA, manual: true });
check("second score of same job is served from cache", r.ok && r.result.cached === true && calls.length === 1, `fetch calls=${calls.length}`);

nextResponse = good(2.0, 500);
const [b1, b2] = await Promise.all([
  send({ type: "score_job", job: jobB, manual: true }),
  send({ type: "score_job", job: jobB, manual: true })
]);
check("concurrent identical jobs share one paid call", b1.ok && b2.ok && calls.length === 2, `fetch calls=${calls.length}`);

nextResponse = { answers: { fit: { score: 9 } }, usage: { input_tokens: 777 } };
r = await send({ type: "score_job", job: jobC, manual: true });
check("invalid fit score is rejected", !r.ok && /invalid fit score/.test(r.error), r.error);
check("invalid score is not cached", !Object.values(store.cache).some((v) => v.fit === 9));

let s = await send({ type: "get_status" });
check("tokens from the rejected call are still counted", s.totalInputTokens === 1000 + 500 + 777, `total=${s.totalInputTokens}`);
check("job counters count only usable scores", s.totalJobsScored === 2 && s.sessionJobsScored === 2, `total=${s.totalJobsScored}`);

nextResponse = { answers: { check: { noul: 0.99 } }, usage: { input_tokens: 12 } };
r = await send({ type: "test_api_key", apiKey: "key-candidate" });
check("test_api_key uses the key under test", r.ok && calls.at(-1).auth === "Bearer key-candidate");
check("test_api_key does not touch saved settings", store.apiKey === "key-real");

await send({ type: "save_settings", settings: { needsSponsorship: false } });
nextResponse = good(1.0, 400);
r = await send({ type: "score_job", job: jobA, manual: true });
check("changing sponsorship invalidates the cached score", r.ok && r.result.cached === false && r.result.fit === 1.0);
check("sponsorship off drops only the visa question", !("visa" in calls.at(-1).body.questions) && Object.keys(calls.at(-1).body.questions).length === 8);

await send({ type: "save_settings", settings: { autoScore: false } });
r = await send({ type: "score_job", job: jobB, manual: false });
check("auto-score off asks for a manual click", r.ok && r.manualRequired === true);

console.log(`\n${failures === 0 ? "ALL WORKER CHECKS PASSED" : failures + " FAILURE(S)"}`);
process.exit(failures ? 1 : 0);
