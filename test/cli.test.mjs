// Runs cli.js the way a user would, with a fake Jev (test/stub-fetch.mjs) and
// an empty home folder, so it never reads a real key or reaches the network.
// Run: node test/cli.test.mjs
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DIMENSIONS, JEV_ENDPOINT, displayScore, parseJevResponse, recommendationFor } from "../scoring.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const STUB = pathToFileURL(join(ROOT, "test/stub-fetch.mjs")).href;
const home = mkdtempSync(join(tmpdir(), "jev-cli-test-"));
const log = join(home, "requests.jsonl");

let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!cond) failures++;
};

// The fake Jev's answer: the Associate Product Manager sample from the
// landing page.
const DIMS = Object.keys(DIMENSIONS);
const REPLY = {
  answers: {
    fit: { score: 2.6, confidence: 0.51 },
    why: { choice: "role_level" },
    visa: { noul: 0.72 },
    ...Object.fromEntries(DIMS.map((d, i) => [`dim_${d}`, { score: [1.66, 1.84, 1.94, 1.22, 1.51, 1.07][i], confidence: 0.7 }]))
  },
  usage: { input_tokens: 3220 }
};
const display = displayScore(parseJevResponse(REPLY));

const file = (name, text) => {
  const path = join(home, name);
  writeFileSync(path, text);
  return path;
};
const resume = file("resume.txt", "MBA, 4 years of product analytics, SQL and Python.\n");
const blankResume = file("blank.txt", "  \n\n  ");
const jobText = "Associate Product Manager\n" + "Own the roadmap for our analytics product with engineering and design. ".repeat(4);
const job = file("job.txt", jobText);
const shortJob = file("short.txt", "Product Manager\nA short note.");

// Runs cli.js with TYPESAFE_API_KEY set to `key`, or unset when key is "".
function cli(args, { key = "test-key", input } = {}) {
  const env = { ...process.env, HOME: home, STUB_FETCH_LOG: log, STUB_JEV_REPLY: JSON.stringify(REPLY) };
  delete env.TYPESAFE_API_KEY;
  if (key) env.TYPESAFE_API_KEY = key;
  writeFileSync(log, "");
  const run = spawnSync(process.execPath, ["--import", STUB, "cli.js", ...args], { cwd: ROOT, env, input, encoding: "utf8" });
  const requests = readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { code: run.status, out: run.stdout, err: run.stderr, requests };
}

try {
  let r = cli(["--help"]);
  check("--help prints the usage and exits 0", r.code === 0 && r.out.startsWith("Usage: node cli.js") && r.err === "", `exit ${r.code}`);

  r = cli([]);
  check("no --resume or --job exits 1 with the usage",
    r.code === 1 && r.err.startsWith("error: --resume and --job are required.") && r.err.includes("Usage:"), r.err.split("\n")[0]);
  r = cli(["--resume", resume]);
  check("no --job exits 1", r.code === 1 && r.err.startsWith("error: --resume and --job are required."), r.err.split("\n")[0]);

  r = cli(["--resume", resume, "--job", job, "--bogus"]);
  check("an unknown flag exits 1 and names it", r.code === 1 && r.err.startsWith("error: Unknown option '--bogus'"), r.err.split("\n")[0]);

  r = cli(["--resume", resume, "--job", job], { key: "" });
  check("no key exits 1 and says where to put one",
    r.code === 1 && r.err.startsWith("error: set TYPESAFE_API_KEY or create ~/.typesafe_api_key") && r.requests.length === 0, r.err.trim());

  const missing = join(home, "missing.txt");
  r = cli(["--resume", missing, "--job", job]);
  check("an unreadable resume exits 1", r.code === 1 && r.err.trim() === `error: cannot read resume file: ${missing}`, r.err.trim());

  r = cli(["--resume", blankResume, "--job", job]);
  check("an empty resume exits 1 and says the file is empty",
    r.code === 1 && r.err.trim() === `error: the resume file is empty: ${blankResume}` && r.requests.length === 0, r.err.trim());

  r = cli(["--resume", resume, "--job", shortJob]);
  check("a job under 100 characters exits 1",
    r.code === 1 && r.err.trim() === "error: the job description is too short to score (under 100 characters)." && r.requests.length === 0,
    r.err.trim());

  // The text report, with the job piped in on stdin.
  r = cli(["--resume", resume, "--job", "-", "--company", "Acme"], { input: jobText });
  const lines = r.out.split("\n");
  check("the text report makes one call with the key", r.code === 0 && r.err === "" && r.requests.length === 1 &&
    r.requests[0].url === JEV_ENDPOINT && r.requests[0].auth === "Bearer test-key", r.err.trim() || `${r.requests.length} calls`);
  check("the text report names the job from its first line", lines[0] === "Associate Product Manager at Acme", lines[0]);
  check("the text report shows the score and recommendation",
    lines[1] === `  Fit          ${display}/10  ${recommendationFor(display)}`, lines[1]);
  check("the text report shows the main factor and all six rows",
    r.out.includes("  Main factor  role level") && DIMS.every((d) => r.out.includes(DIMENSIONS[d].label)));
  check("the text report shows the visa band", r.out.includes("  Sponsorship  Likely · 72%"), lines.find((l) => l.includes("Sponsorship")));
  check("the text report shows the cost", r.out.includes("  Cost         3,220 input tokens, $0.00014"), lines.find((l) => l.includes("Cost")));

  r = cli(["--resume", resume, "--job", job, "--json"]);
  let json = null;
  try { json = JSON.parse(r.out); } catch {}
  check("--json prints JSON", r.code === 0 && json !== null, r.err.trim());
  check("--json has the score, recommendation, scorecard and cost",
    json?.display === display && json.recommendation === recommendationFor(display) &&
    DIMS.every((d) => json.scorecard?.[d]?.label) && json.estimatedCostUsd > 0,
    JSON.stringify({ display: json?.display, recommendation: json?.recommendation, estimatedCostUsd: json?.estimatedCostUsd }));
  check("--json has the visa band", json?.visaLabel === "Likely" && json.visaPercent === 72 && json.visa === 0.72,
    JSON.stringify({ visaLabel: json?.visaLabel, visaPercent: json?.visaPercent }));
  check("the visa question is asked by default", "visa" in (r.requests[0]?.body.questions || {}));

  r = cli(["--resume", resume, "--job", job, "--json", "--no-sponsorship"]);
  json = JSON.parse(r.out || "null");
  const questions = Object.keys(r.requests[0]?.body.questions || {});
  check("--no-sponsorship sends no visa question", r.code === 0 && !questions.includes("visa") && questions.length === 8, questions.join(","));
  check("--no-sponsorship leaves the visa fields empty",
    json?.visa === null && json.visaLabel === null && json.visaPercent === null, JSON.stringify({ visa: json?.visa, visaLabel: json?.visaLabel }));
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL CLI CHECKS PASSED" : failures + " FAILURE(S)"}`);
process.exit(failures ? 1 : 0);
