// Loads the unpacked extension into Chrome for Testing and checks, over the
// DevTools protocol, that (1) the module service worker registers, which means
// its import of scoring.js resolved, and (2) the popup and options pages load
// as modules and round-trip messages to the worker without errors.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";

// Run: CHROME_BIN=/path/to/chromium node test/browser.test.mjs
// Needs Chromium or Chrome for Testing (branded Chrome ignores --load-extension).
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const bin = process.env.CHROME_BIN || process.argv[2];
const ext = process.argv[3] || fileURLToPath(new URL("..", import.meta.url));
if (!bin) { console.error("set CHROME_BIN to a Chromium or Chrome for Testing binary"); process.exit(2); }
const profile = mkdtempSync(tmpdir() + "/jev-test-profile-");
const port = 9333;
const proc = spawn(bin, [
  `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
  `--load-extension=${ext}`, `--disable-extensions-except=${ext}`,
  "--headless=new", "--no-first-run", "--no-default-browser-check", "about:blank"
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = async (path, method = "GET") => (await fetch(`http://127.0.0.1:${port}${path}`, { method })).json();
let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); if (!ok) failures++; };

async function cdpSession(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let nextId = 1; const pending = new Map(); const errors = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") errors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
    if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") errors.push(msg.params.entry.text);
  };
  const send = (method, params = {}) => new Promise((r) => { const id = nextId++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  return { send, errors, close: () => ws.close() };
}

try {
  // Chromium ships its own component extensions with background.js workers,
  // so identify ours by manifest name, never by file name.
  let sw = null;
  for (let i = 0; i < 40 && !sw; i++) {
    await sleep(250);
    let targets = [];
    try { targets = await json("/json/list"); } catch {}
    for (const t of targets.filter((t) => t.type === "service_worker")) {
      const probe = await cdpSession(t.webSocketDebuggerUrl);
      const r = await probe.send("Runtime.evaluate", { expression: "chrome.runtime.getManifest().name", returnByValue: true });
      probe.close();
      if (r.result?.result?.value === "Worth Applying?") { sw = t; break; }
    }
  }
  check("module service worker registered (import of scoring.js resolved)", !!sw, sw?.url);
  if (!sw) throw new Error("no service worker target; extension failed to load");
  const extId = new URL(sw.url).host;

  // Ask the worker itself what it is running as.
  const swSession = await cdpSession(sw.webSocketDebuggerUrl);
  await swSession.send("Runtime.enable");
  const mf = await swSession.send("Runtime.evaluate", { expression: "JSON.stringify(chrome.runtime.getManifest().background)", returnByValue: true });
  check("worker runs with type: module", mf.result?.result?.value?.includes('"module"'), mf.result?.result?.value);

  // Opens an extension page in a new tab, the same path Chrome uses for
  // Settings, and polls the probe until it matches. Returns the page's
  // session and the probe's last value, or null if no tab opened.
  const seenTargets = new Set();
  async function openPage(page, probe, expect) {
    const created = await swSession.send("Runtime.evaluate", {
      expression: `chrome.tabs.create({ url: chrome.runtime.getURL("${page}") }).then((t) => t.id)`,
      awaitPromise: true, returnByValue: true
    });
    if (created.result?.exceptionDetails) console.log("  tabs.create failed:", created.result.exceptionDetails.exception?.description);
    let target = null;
    for (let i = 0; i < 20 && !target; i++) {
      await sleep(250);
      target = (await json("/json/list")).find((t) => t.type === "page" && t.url.endsWith("/" + page) && !seenTargets.has(t.id));
    }
    if (!target) { check(`${page} opened`, false, "no page target"); return null; }
    seenTargets.add(target.id);
    const s = await cdpSession(target.webSocketDebuggerUrl);
    await s.send("Runtime.enable"); await s.send("Log.enable");
    let value = "";
    for (let i = 0; i < 20; i++) {
      await sleep(250);
      const out = await s.send("Runtime.evaluate", { expression: probe, returnByValue: true });
      value = out.result?.result?.value || String(out.result?.exceptionDetails?.exception?.description || "");
      if (expect.test(value)) break;
    }
    return { s, value };
  }

  const STATE = "(document.body.dataset.state || 'no state') + ' | ' + document.getElementById('jobName').textContent";
  const FORM = "['apiKey', 'resume'].map((id) => document.getElementById(id).value).join(' | ') + ' | ' + document.getElementById('needsSponsorship').checked";
  for (const [page, probe, expect] of [
    // Only popup.js sets data-state, and "setup" means the worker answered get_status (a fresh profile has no key).
    ["popup.html", STATE, /^setup \| Set up Worth Applying\?$/],
    ["options.html", "document.getElementById('apiKey') ? 'form ok, testKey disabled=' + document.getElementById('testKey').disabled : 'missing form'", /form ok, testKey disabled=false/]
  ]) {
    const tab = await openPage(page, probe, expect);
    if (!tab) continue;
    check(`${page} loads as a module and talks to the worker`, expect.test(tab.value), tab.value);
    check(`${page} has no console errors`, tab.s.errors.length === 0, tab.s.errors.join(" ; ").slice(0, 300));
    if (page !== "options.html") { tab.s.close(); continue; }

    // Save settings from this Settings page through the real worker. A fresh
    // Settings page then fills its form from get_settings.
    const saved = await tab.s.send("Runtime.evaluate", {
      expression: `chrome.runtime.sendMessage({ type: "save_settings", settings: { apiKey: "sk-test", resume: "MBA, 4y analytics", needsSponsorship: false } })`,
      awaitPromise: true, returnByValue: true
    });
    check("save_settings from Settings is stored", saved.result?.result?.value?.ok === true, JSON.stringify(saved.result?.result?.value));
    tab.s.close();
  }

  const settings = await openPage("options.html", FORM, /^sk-test \| MBA, 4y analytics \| false$/);
  check("a fresh Settings page fills its form from get_settings", /^sk-test \| MBA, 4y analytics \| false$/.test(settings?.value), settings?.value);
  settings?.s.close();
  // With setup done, the popup asks Chrome for the active tab. Opened as a
  // tab of its own, it finds no web page there to score.
  const popup = await openPage("popup.html", STATE, /^unscorable \| Open a job posting$/);
  check("with setup done, the popup gets the active tab without the tabs permission", /^unscorable/.test(popup?.value), popup?.value);
  check("the set-up popup has no console errors", popup?.s.errors.length === 0, popup?.s.errors.join(" ; ").slice(0, 300));
  popup?.s.close();
  swSession.close();
} catch (e) {
  console.log("ERROR", e.message); failures++;
} finally {
  proc.kill("SIGKILL");
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
console.log(`\n${failures === 0 ? "EXTENSION LOADS CLEANLY IN CHROMIUM" : failures + " FAILURE(S)"}`);
process.exit(failures ? 1 : 0);
