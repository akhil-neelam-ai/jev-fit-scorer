// Drives the site's usage-count endpoint (site/api/count.js) with a fake
// PostHog, and checks what it accepts, what it turns away, and what it passes on.
// Run: node test/count-api.test.mjs
const forwarded = [];
let posthogStatus = 200;
let posthogDown = false;
globalThis.fetch = async (url, init) => {
  forwarded.push({ url, body: JSON.parse(init.body) });
  if (posthogDown) throw new TypeError("fetch failed");
  return { ok: posthogStatus >= 200 && posthogStatus < 300, status: posthogStatus };
};
const errors = [];
console.error = (...args) => errors.push(args.map(String).join(" "));

const { POST, OPTIONS, EVENTS } = await import(new URL("../site/api/count.js", import.meta.url));

let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!cond) failures++;
};

const STORE = "chrome-extension://ppcfjfgonfggaaeoomjakdjkjpjbokbc";
const UNPACKED = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const ID = "3b241101-e2bb-4255-8caf-4136c566a962";
const post = (body, origin = STORE) => POST(new Request("https://worth-applying.vercel.app/api/count", {
  method: "POST",
  headers: { "Content-Type": "text/plain", ...(origin ? { Origin: origin } : {}) },
  body: typeof body === "string" ? body : JSON.stringify(body)
}));

process.env.POSTHOG_PROJECT_KEY = "phc_test";
delete process.env.POSTHOG_HOST;

const preflight = OPTIONS();
check("a preflight is answered with CORS headers", preflight.status === 204 &&
  preflight.headers.get("access-control-allow-origin") === "*", String(preflight.status));

let r = await post({ e: "install", v: "1.5.0", id: ID });
const sent = forwarded.at(-1);
check("a store count is accepted", r.status === 204 && r.headers.get("access-control-allow-origin") === "*", String(r.status));
check("it goes to PostHog's US capture endpoint by default", sent?.url === "https://us.i.posthog.com/i/v0/e/", sent?.url);
check("PostHog gets the event, the install ID and the version, marked as from the store",
  sent?.body.api_key === "phc_test" && sent.body.event === "install" && sent.body.distinct_id === ID &&
  sent.body.properties.version === "1.5.0" && sent.body.properties.source === "store", JSON.stringify(sent?.body));
check("PostHog is told to skip person profiles and IP location",
  sent?.body.properties.$process_person_profile === false && sent.body.properties.$geoip_disable === true,
  JSON.stringify(sent?.body.properties));
check("nothing else is passed on", JSON.stringify(Object.keys(sent?.body || {})) === JSON.stringify(["api_key", "event", "distinct_id", "properties"]) &&
  JSON.stringify(Object.keys(sent?.body.properties || {}).sort()) === JSON.stringify(["$geoip_disable", "$process_person_profile", "source", "version"]),
  JSON.stringify(sent?.body));

r = await post({ e: "popup_open", v: "1.5.0", id: ID, resume: "MBA, 4y analytics", url: "https://jobs.example.com" }, UNPACKED);
check("a copy loaded from a folder is marked unpacked", r.status === 204 && forwarded.at(-1).body.properties.source === "unpacked",
  forwarded.at(-1).body.properties.source);
check("extra fields in a count are dropped", !JSON.stringify(forwarded.at(-1).body).includes("MBA") && !JSON.stringify(forwarded.at(-1).body).includes("jobs.example"),
  JSON.stringify(forwarded.at(-1).body));

let before = forwarded.length;
r = await post({ e: "install", v: "1.5.0", id: ID }, null);
check("a count with no origin is turned away", r.status === 403 && forwarded.length === before, String(r.status));
r = await post({ e: "install", v: "1.5.0", id: ID }, "https://example.com");
check("a count from a website is turned away", r.status === 403 && forwarded.length === before, String(r.status));

const bad = [
  ["an unknown event", { e: "resume_text", v: "1.5.0", id: ID }],
  ["a missing event", { v: "1.5.0", id: ID }],
  ["an install ID that isn't a UUID", { e: "install", v: "1.5.0", id: "me@example.com" }],
  ["a missing install ID", { e: "install", v: "1.5.0" }],
  ["a version that isn't a version", { e: "install", v: "<script>", id: ID }],
  ["a body that isn't JSON", "install"],
  ["a body over 300 characters", { e: "install", v: "1.5.0", id: ID, pad: "x".repeat(300) }]
];
for (const [name, body] of bad) {
  r = await post(body);
  check(`${name} is refused`, r.status === 400 && forwarded.length === before, String(r.status));
}
check("the list of events matches what the extension sends", EVENTS.size === 13, `${EVENTS.size} events`);

process.env.POSTHOG_HOST = "https://eu.i.posthog.com";
r = await post({ e: "score", v: "1.5.0", id: ID });
check("POSTHOG_HOST switches to PostHog's EU endpoint", r.status === 204 && forwarded.at(-1).url === "https://eu.i.posthog.com/i/v0/e/", forwarded.at(-1).url);

posthogStatus = 401;
r = await post({ e: "score", v: "1.5.0", id: ID });
check("a refusal from PostHog is reported as 502 and logged", r.status === 502 && errors.at(-1)?.includes("401"), `${r.status} ${errors.at(-1)}`);
posthogStatus = 200;
posthogDown = true;
r = await post({ e: "score", v: "1.5.0", id: ID });
check("PostHog being unreachable is reported as 502", r.status === 502, String(r.status));
posthogDown = false;

delete process.env.POSTHOG_PROJECT_KEY;
before = forwarded.length;
r = await post({ e: "score", v: "1.5.0", id: ID });
check("without a PostHog key the count is dropped with 503", r.status === 503 && forwarded.length === before && errors.at(-1)?.includes("POSTHOG_PROJECT_KEY"),
  `${r.status} ${errors.at(-1)}`);

console.log(`\n${failures === 0 ? "ALL COUNT ENDPOINT CHECKS PASSED" : failures + " FAILURE(S)"}`);
process.exit(failures ? 1 : 0);
