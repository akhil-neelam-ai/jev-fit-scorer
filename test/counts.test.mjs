// Loads the real background.js with a fake chrome API and a fake network, and
// checks the usage counts it sends: what, when, how often, and that the off
// switch stops them. Each scenario loads a fresh copy of the worker.
// Run: node test/counts.test.mjs
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!cond) failures++;
};

// What the fake network does with each request. A count lands on
// worker.counts. Anything else is a Jev call, answered with a good score
// unless jevFails is set.
let worker = null;
let countsFail = false;
let jevFails = false;
const GOOD = {
  answers: {
    fit: { score: 3, confidence: 0.8 }, why: { choice: "function" }, visa: { noul: 0.3 },
    ...Object.fromEntries(["required_qualifications", "function", "role_level", "customer_type", "company_stage", "domain"]
      .map((d) => [`dim_${d}`, { score: 1, confidence: 0.7 }]))
  },
  usage: { input_tokens: 100 }
};
globalThis.fetch = async (url, init) => {
  if (url === worker.COUNT_URL) {
    worker.requests.push({ url, method: init.method, type: init.headers["Content-Type"], body: init.body });
    if (countsFail) throw new TypeError("Failed to fetch");
    worker.counts.push(JSON.parse(init.body));
    return { ok: true, status: 204 };
  }
  if (jevFails) return { ok: false, status: 500, json: async () => ({}), text: async () => "down" };
  return { ok: true, json: async () => structuredClone(GOOD), text: async () => "" };
};
console.warn = () => {};

// Loads a fresh worker over `stored`, as if Chrome had just started it.
let loads = 0;
async function loadWorker(stored = {}) {
  const store = structuredClone(stored);
  const w = { store, messageListeners: [], installListeners: [], counts: [], requests: [] };
  globalThis.chrome = {
    storage: { local: {
      get: async (keys) => Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, structuredClone(store[k])])),
      set: async (values) => { Object.assign(store, structuredClone(values)); }
    } },
    runtime: {
      onMessage: { addListener: (fn) => w.messageListeners.push(fn) },
      onInstalled: { addListener: (fn) => w.installListeners.push(fn) },
      getURL: (path) => `chrome-extension://test-id/${path}`,
      getManifest: () => ({ version })
    },
    tabs: { create: async () => ({ id: 1 }) }
  };
  const module = await import(`../background.js?load=${++loads}`);
  w.COUNT_URL = module.COUNT_URL;
  w.send = (message) => new Promise((resolve) => w.messageListeners[0](message, {}, resolve));
  w.install = (details) => w.installListeners[0](details);
  w.events = () => w.counts.map((c) => c.e);
  worker = w;
  return w;
}

// Counts go out in the background. Wait until no more arrive.
async function settle() {
  let seen = -1;
  while (seen !== worker.requests.length) {
    seen = worker.requests.length;
    await new Promise((r) => setTimeout(r, 30));
  }
}
const job = (n) => ({ title: `PM ${n}`, company: "Acme", description: `${n} `.repeat(200), pageUrl: `https://jobs.example.com/${n}` });

// ---- a fresh install, from install to regular use ----
let w = await loadWorker();
check("counts go to the site's count endpoint", w.COUNT_URL === "https://worth-applying.vercel.app/api/count", w.COUNT_URL);
w.install({ reason: "install" });
await settle();
check("a new install sends install", JSON.stringify(w.events()) === JSON.stringify(["install"]), JSON.stringify(w.events()));
const first = w.requests[0];
check("a count is a plain-text POST, so Chrome sends no preflight", first?.method === "POST" && first.type === "text/plain", JSON.stringify(first));
check("a count holds only the event, the version and an install ID",
  JSON.stringify(Object.keys(w.counts[0] || {})) === JSON.stringify(["e", "v", "id"]) && w.counts[0].v === version && UUID.test(w.counts[0].id),
  first?.body);
const installId = w.counts[0]?.id;
check("the install ID is stored on the device", w.store.installId === installId, w.store.installId);

for (const screen of ["intro", "pin", "key", "pin", "key", "resume"]) await w.send({ type: "count", event: `guide_${screen}` });
await settle();
check("each guide screen is counted once, however often it shows",
  JSON.stringify(w.events().slice(1)) === JSON.stringify(["guide_intro", "guide_pin", "guide_key", "guide_resume"]), JSON.stringify(w.events()));

const ignored = await w.send({ type: "count", event: "resume_text" });
await w.send({ type: "count", event: "first_score" });
await settle();
check("pages can't send events outside their list", ignored.ok && w.events().length === 5, JSON.stringify(w.events()));

await w.send({ type: "save_settings", settings: { apiKey: "sk-test" } });
await settle();
check("a key alone isn't setup_done", !w.events().includes("setup_done"), JSON.stringify(w.events()));
await w.send({ type: "save_settings", settings: { resume: "MBA, 4y analytics" } });
await w.send({ type: "save_settings", settings: { needsSponsorship: false } });
await settle();
check("setup_done is sent once, when the key and resume are both saved",
  w.events().filter((e) => e === "setup_done").length === 1, JSON.stringify(w.events()));

const before = w.counts.length;
await w.send({ type: "count", event: "popup_open" });
await w.send({ type: "count", event: "popup_open" });
await settle();
const opened = w.events().slice(before);
check("each icon click is counted, and the day's first adds active_day",
  opened.filter((e) => e === "popup_open").length === 2 && opened.filter((e) => e === "active_day").length === 1, JSON.stringify(opened));

let r = await w.send({ type: "score_job", job: job(1) });
await w.send({ type: "score_job", job: job(1) });
await w.send({ type: "score_job", job: job(2) });
await settle();
const scored = w.events();
check("each fresh score is counted, and the first adds first_score",
  r.ok && scored.filter((e) => e === "score").length === 2 && scored.filter((e) => e === "first_score").length === 1, JSON.stringify(scored));
check("a cached score isn't counted again", scored.filter((e) => e === "score").length === 2, JSON.stringify(scored));
jevFails = true;
r = await w.send({ type: "score_job", job: job(3) });
jevFails = false;
await settle();
check("a failed score sends score_error", !r.ok && w.events().at(-1) === "score_error", JSON.stringify(w.events().slice(-2)));
check("every count carries the same install ID", w.counts.every((c) => c.id === installId), JSON.stringify([...new Set(w.counts.map((c) => c.id))]));
check("no count holds the resume, the key or a job", !w.requests.some((q) => /MBA|sk-test|Acme|jobs\.example/.test(q.body)),
  w.requests.map((q) => q.body).join(" "));

// ---- the off switch ----
const settings = await w.send({ type: "get_settings" });
check("Settings sees the usage switch, on by default", settings.settings?.shareUsage === true, JSON.stringify(settings.settings));
await w.send({ type: "save_settings", settings: { shareUsage: false } });
let sentBefore = w.requests.length;
await w.send({ type: "count", event: "popup_open" });
await w.send({ type: "score_job", job: job(4) });
await w.send({ type: "count", event: "guide_done" });
await settle();
check("with counts off, nothing is sent", w.requests.length === sentBefore, `${w.requests.length - sentBefore} sent`);
check("turning counts off forgets the install ID", w.store.installId === "" && w.store.shareUsage === false, JSON.stringify(w.store.installId));
await w.send({ type: "save_settings", settings: { shareUsage: true } });
await w.send({ type: "count", event: "popup_open" });
await settle();
check("turning them back on starts a new install ID", UUID.test(w.counts.at(-1)?.id) && w.counts.at(-1).id !== installId, w.counts.at(-1)?.id);

// ---- a count that doesn't get through ----
countsFail = true;
await w.send({ type: "count", event: "guide_try" });
await settle();
countsFail = false;
check("a once-only count that didn't get through isn't marked as sent", !w.store.countsSent.guide_try, JSON.stringify(w.store.countsSent));
await w.send({ type: "count", event: "guide_try" });
await settle();
check("so it goes out the next time", w.events().at(-1) === "guide_try", JSON.stringify(w.events().slice(-2)));

// ---- a restart keeps the bookkeeping ----
const kept = structuredClone(w.store);
w = await loadWorker(kept);
await w.send({ type: "count", event: "guide_pin" });
await w.send({ type: "count", event: "popup_open" });
await settle();
check("after a restart, once-only counts stay sent and the ID stays the same",
  JSON.stringify(w.events()) === JSON.stringify(["popup_open"]) && w.counts[0].id === kept.installId, JSON.stringify(w.counts));

// ---- an install from before counts existed ----
w = await loadWorker({ apiKey: "sk-old", resume: "MBA", needsSponsorship: true, cache: { someJob: { fit: 2, ts: 1 } } });
w.install({ reason: "update", previousVersion: "1.4.1" });
await settle();
check("an update sends nothing by itself", w.requests.length === 0, JSON.stringify(w.events()));
await w.send({ type: "count", event: "guide_intro" });
await w.send({ type: "save_settings", settings: { needsSponsorship: false } });
await w.send({ type: "score_job", job: job(5) });
await w.send({ type: "count", event: "popup_open" });
await settle();
check("an older install isn't counted as new: no guide, setup_done or first_score",
  JSON.stringify(w.events()) === JSON.stringify(["score", "popup_open", "active_day"]), JSON.stringify(w.events()));

w = await loadWorker({ needsSponsorship: true });
w.install({ reason: "update", previousVersion: "1.4.1" });
await w.send({ type: "save_settings", settings: { apiKey: "sk-new", resume: "MBA" } });
await settle();
check("an older install that finishes setup now still sends setup_done", w.events().includes("setup_done"), JSON.stringify(w.events()));

console.log(`\n${failures === 0 ? "ALL USAGE COUNT CHECKS PASSED" : failures + " FAILURE(S)"}`);
process.exit(failures ? 1 : 0);
