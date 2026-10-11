// Renders the extension's real popup with three test-run results and saves the
// screenshots the landing page shows (site/popup-*.webp). Rerun it after changing
// popup.html, popup.js, styles.css, or scoring.js so the site keeps matching the extension.
//
// Usage: CHROME_BIN="/path/to/Google Chrome for Testing" node scripts/popup-shots.mjs
//
// OUT_DIR sets where the screenshots go. It defaults to the repo's site folder.
// Point it somewhere else to try a change without touching the site:
//   OUT_DIR=/tmp/popup-test CHROME_BIN="/path/to/Google Chrome for Testing" node scripts/popup-shots.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_DIR = process.env.OUT_DIR || join(ROOT, "site");

// Real results from the 101-posting test run (scoring version 5), with company names removed.
const SAMPLES = {
  apm: {
    title: "Associate Product Manager",
    result: { fit: 2.6, fitConfidence: 0.51, why: "role_level", visa: 0.79, inputTokens: 3220, elapsedMs: 125, scorecard: {
      required_qualifications: { score: 1.66, label: "Strong" }, function: { score: 1.84, label: "Strong" },
      role_level: { score: 1.94, label: "Strong" }, customer_type: { score: 1.22, label: "Moderate" },
      company_stage: { score: 1.51, label: "Strong" }, domain: { score: 1.07, label: "Moderate" } } }
  },
  growth: {
    title: "Product Manager, Growth Strategy",
    result: { fit: 0.99, fitConfidence: 0.82, why: "required_qualifications", visa: 0.17, inputTokens: 3673, elapsedMs: 94, scorecard: {
      required_qualifications: { score: 0.45, label: "Weak" }, function: { score: 0.73, label: "Moderate" },
      role_level: { score: 0.88, label: "Moderate" }, customer_type: { score: 0.68, label: "Moderate" },
      company_stage: { score: 1.03, label: "Moderate" }, domain: { score: 0.72, label: "Moderate" } } }
  },
  engineer: {
    title: "Lead, Software Engineer",
    result: { fit: 0.03, fitConfidence: 0.98, why: "required_qualifications", visa: 0.13, inputTokens: 4228, elapsedMs: 122, scorecard: {
      required_qualifications: { score: 0, label: "Weak" }, function: { score: 0.01, label: "Weak" },
      role_level: { score: 0, label: "Weak" }, customer_type: { score: 0.98, label: "Moderate" },
      company_stage: { score: 0.58, label: "Moderate" }, domain: { score: 0.08, label: "Weak" } } }
  }
};

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!process.env.CHROME_BIN) {
  console.error("Set CHROME_BIN to a Chrome for Testing binary.");
  process.exit(1);
}
mkdirSync(OUT_DIR, { recursive: true });

// Serve the repo so popup.html loads its real script and stylesheet.
const server = createServer((request, response) => {
  const path = join(ROOT, decodeURIComponent(new URL(request.url, "http://localhost").pathname));
  let body;
  try {
    if (!path.startsWith(ROOT)) throw new Error("outside the repo");
    body = readFileSync(path);
  } catch {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream" }).end(body);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const port = 9700 + Math.floor(Math.random() * 200);
const profile = mkdtempSync(join(tmpdir(), "popup-shots-"));
const chrome = spawn(process.env.CHROME_BIN, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "--headless=new", "--no-first-run", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });

// Stand-ins for the chrome.* APIs the popup calls, answering with one sample result.
const stub = (job, result) => `Object.defineProperty(window, "chrome", { configurable: true, value: {
  tabs: { query: async () => [{ id: 1, url: "https://example.com/job" }] },
  scripting: { executeScript: async () => [{ result: ${JSON.stringify(job)} }] },
  runtime: {
    openOptionsPage() {},
    sendMessage: async (message) =>
      message.type === "get_status" ? { ok: true, hasKey: true, hasResume: true }
      : message.type === "score_job" ? { ok: true, result: ${JSON.stringify(result)} }
      : { ok: false }
  }
} });`;

// True once the popup shows a result. The redesigned popup sets body[data-state="result"].
// The older one unhides the scorecard and says "Fresh result". Both need a filled scorecard.
const RESULT_READY = `(() => {
  const scorecard = document.getElementById("jobScorecard");
  if (!scorecard || (scorecard.childElementCount === 0 && scorecard.textContent.trim() === "")) return false;
  if (document.body.dataset.state === "result") return true;
  return !scorecard.hidden && Boolean(document.getElementById("jobStatus")?.textContent.includes("Fresh result"));
})()`;

try {
  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(250);
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page"); } catch {}
  }
  if (!target) throw new Error("Chrome did not start.");

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => (socket.onopen = resolve));
  let nextId = 1;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true })).result?.result?.value;

  await send("Page.enable");
  // The popup's body is 300px wide plus 14px padding on each side. Capture at 2x for sharp text.
  await send("Emulation.setDeviceMetricsOverride", { width: 328, height: 800, deviceScaleFactor: 2, mobile: false });

  // Opens the popup with one sample's result and returns the popup's height.
  async function render(key) {
    const { title, result } = SAMPLES[key];
    const job = { title, company: "", description: "Sample job description. ".repeat(20), pageUrl: "https://example.com/job", looksLikeJob: true, embeddedSrc: "" };
    const { result: { identifier } } = await send("Page.addScriptToEvaluateOnNewDocument", { source: stub(job, { ...result, cached: false }) });
    await send("Page.navigate", { url: `${base}/popup.html` });
    let ready = false;
    for (let i = 0; i < 50 && !ready; i++) {
      await sleep(100);
      ready = await evaluate(RESULT_READY);
    }
    await send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
    if (!ready) throw new Error(`The popup did not render a result for ${key}.`);
    return evaluate("Math.ceil(document.body.getBoundingClientRect().height)");
  }

  // Every shot gets the tallest popup's height, so the page's frame never changes size between samples.
  const heights = [];
  for (const key of Object.keys(SAMPLES)) heights.push(await render(key));
  const height = Math.max(...heights);

  for (const key of Object.keys(SAMPLES)) {
    await render(key);
    const shot = await send("Page.captureScreenshot", { format: "webp", quality: 92, clip: { x: 0, y: 0, width: 328, height, scale: 1 } });
    const file = join(OUT_DIR, `popup-${key}.webp`);
    writeFileSync(file, Buffer.from(shot.result.data, "base64"));
    console.log(`${file}: 328x${height} at 2x, ${Math.round(Buffer.byteLength(shot.result.data, "base64") / 1024)} KB`);
  }
  socket.close();
} finally {
  chrome.kill("SIGKILL");
  server.close();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
