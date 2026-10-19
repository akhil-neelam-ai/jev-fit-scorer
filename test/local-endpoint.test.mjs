// Runs cli.js through eval/local-endpoint.mjs against a fake Unsloth app on
// 127.0.0.1. Sentinel keys sit in TYPESAFE_API_KEY and in ~/.typesafe_api_key,
// and neither may ever reach the app.
// Run: node test/local-endpoint.test.mjs
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DIMENSIONS, JEV_ENDPOINT } from "../scoring.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "local-endpoint-test-"));
const home = join(dir, "home");
const emptyHome = join(dir, "empty-home");
mkdirSync(home);
mkdirSync(emptyHome);
const ENV_KEY = "sentinel-env-key-4471";
const FILE_KEY = "sentinel-file-key-9032";
writeFileSync(join(home, ".typesafe_api_key"), FILE_KEY);
const RESUME_TEXT = "Made-up resume: 4 years of product analytics, SQL and Python.";
const resume = join(dir, "resume.txt");
writeFileSync(resume, RESUME_TEXT + "\n");
const job = join(dir, "job.txt");
writeFileSync(job, "Associate Product Manager\n" + "Own the roadmap for our analytics product with engineering and design. ".repeat(4));

let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!cond) failures++;
};

const REPLY = {
  answers: {
    fit: { type: "score", score: 2.6, confidence: 0.51, probabilities: { 0: 0.05, 1: 0.1, 2: 0.2, 3: 0.4, 4: 0.25 } },
    why: { type: "choice", choice: "role_level", confidence: 0.6 },
    visa: { type: "noul", noul: 0.72 },
    ...Object.fromEntries(Object.keys(DIMENSIONS).map((d) => [`dim_${d}`, { type: "score", score: 1.5, confidence: 0.7 }]))
  },
  usage: { input_tokens: 3220 }
};

// A fake app. Each request gets the next reply in `replies`: a status, the local-backend
// header or not, and an optional redirect target.
async function app(replies) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const { status = 200, local = true, location } = replies[Math.min(seen.length - 1, replies.length - 1)];
      res.writeHead(status, {
        "content-type": "application/json",
        ...(local ? { "x-unsloth-decision-backend": "mlx" } : {}),
        ...(location ? { location } : {})
      });
      res.end(status === 200 ? JSON.stringify(REPLY) : '{"error": "model loading"}');
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return { port, url: `http://127.0.0.1:${port}/v1/systemone`, seen, close: () => server.close() };
}

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

// Runs the CLI through the preload. `key` is TYPESAFE_API_KEY, or none when it is null.
function cli(url, { key = ENV_KEY, homeDir = home, extra = {} } = {}) {
  const env = { ...process.env };
  delete env.TYPESAFE_API_KEY;
  delete env.NODE_USE_ENV_PROXY;
  Object.assign(env, { HOME: homeDir, LOCAL_DECISION_URL: url, LOCAL_DECISION_RETRY_MS: "20", LOCAL_DECISION_WAIT_MS: "300", ...extra });
  if (key !== null) env.TYPESAFE_API_KEY = key;
  return run(["--import", "./eval/local-endpoint.mjs", "cli.js", "--resume", resume, "--job", job, "--json"], env);
}

try {
  let fake = await app([{}]);
  let r = await cli(fake.url);
  fake.close();
  const sent = fake.seen[0];
  check("the CLI's request goes to the local app", r.code === 0 && fake.seen.length === 1 && sent.method === "POST" &&
    sent.url === "/v1/systemone", r.err.trim() || `${fake.seen.length} requests`);
  check("it sends the placeholder key", sent?.headers.authorization === "Bearer no-key-required", sent?.headers.authorization);
  check("neither real key ever reaches the app", !JSON.stringify(sent).includes(ENV_KEY) && !JSON.stringify(sent).includes(FILE_KEY));
  const body = JSON.parse(sent?.body || "{}");
  check("it names the student exactly, so a default alias can't reach a hosted model",
    body.model === "clef-ft:worth-applying-run1" && typeof body.state === "string" && "fit" in (body.questions || {}), body.model);
  check("the answer comes back as the usual report", JSON.parse(r.out || "{}").display > 0, r.out.slice(0, 60));

  for (const [label, homeDir] of [["the key file", home], ["no key at all", emptyHome]]) {
    fake = await app([{}]);
    r = await cli(fake.url, { key: null, homeDir });
    fake.close();
    check(`with ${label} and no key in the environment, the placeholder still goes`,
      r.code === 0 && fake.seen[0]?.headers.authorization === "Bearer no-key-required" &&
      !JSON.stringify(fake.seen[0] || {}).includes(FILE_KEY), r.err.trim());
  }

  fake = await app([{ local: false }]);
  r = await cli(fake.url);
  fake.close();
  check("an answer without the local-backend header is refused", r.code === 1 && r.err.includes("refused"), r.err.trim());

  fake = await app([{ status: 503 }, { status: 503 }, {}]);
  r = await cli(fake.url);
  fake.close();
  check("a 503 while the model loads is retried", r.code === 0 && fake.seen.length === 3, `${fake.seen.length} requests`);

  fake = await app([{ status: 503 }]);
  r = await cli(fake.url);
  fake.close();
  check("a model that never finishes loading ends in an error", r.code === 1 && r.err.includes("503") &&
    fake.seen.length > 1 && fake.seen.length < 30, `${fake.seen.length} requests`);

  const other = await app([{}]);
  fake = await app([{ status: 307, location: other.url }]);
  r = await cli(fake.url);
  fake.close();
  other.close();
  check("a redirect is refused, so nothing reaches another address", r.code === 1 && other.seen.length === 0, r.err.trim().slice(0, 80));

  fake = await app([{}]);
  for (const url of ["http://example.invalid/v1/systemone", "http://localhost.evil.invalid/v1/systemone",
    "http://127.0.0.1.evil.invalid/v1/systemone", "http://127.0.0.1@evil.invalid/v1/systemone",
    "https://127.0.0.1/v1/systemone", `http://localhost:${fake.port}/v1/systemone`, `http://127.1:${fake.port}/v1/systemone`]) {
    r = await cli(url);
    check(`${url} is refused before anything is sent`, r.code !== 0 && r.err.includes("isn't 127.0.0.1 on this Mac"),
      r.err.trim().split("\n")[0]);
  }
  check("none of those reached the fake app, though the last two could have", fake.seen.length === 0, `${fake.seen.length} requests`);

  const gone = await app([{}]);
  gone.close(); // a port nothing listens on any more
  r = await cli(gone.url);
  check("with no server running, it says to start one", r.code !== 0 && r.err.includes("Start model/serve_student.py"),
    r.err.trim().split("\n")[0]);

  r = await cli(fake.url, { extra: { LOCAL_DECISION_MODEL: "jev-latest" } });
  check("a default alias as the model name is refused", r.code !== 0 && r.err.includes("isn't a local model name") &&
    fake.seen.length === 0, r.err.trim().split("\n")[0]);

  r = await cli(fake.url, { extra: { NODE_USE_ENV_PROXY: "1" } });
  check("a proxy setting for fetch is refused", r.code !== 0 && r.err.includes("proxy") && fake.seen.length === 0,
    r.err.trim().split("\n")[0]);
  fake.close();

  r = await run(["--import", "./eval/local-endpoint.mjs", "--input-type=module", "-e",
    "fetch('https://example.invalid/').then(() => process.exit(0), (e) => { console.error(e.message); process.exit(3); })"],
  { ...process.env, LOCAL_DECISION_URL: "http://127.0.0.1:9/v1/systemone" });
  check("any other request is refused", r.code === 3 && r.err.includes("Only the scoring call is allowed"), r.err.trim());

  check("without the preload, the CLI still calls TypeSafe", JEV_ENDPOINT === "https://api.typesafe.ai/v1/systemone");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL LOCAL ENDPOINT CHECKS PASSED" : failures + " FAILURE(S)"}`);
process.exit(failures ? 1 : 0);
