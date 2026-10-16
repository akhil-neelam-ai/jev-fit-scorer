// Drives the real setup guide (welcome.html, with options.js running its form)
// in Chrome for Testing, screen by screen, with a stand-in for the chrome API.
// Run: CHROME_BIN=/path/to/chrome node test/welcome.test.mjs
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openChrome, serve } from "./chrome.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2" };
const BAD_KEY = "That key didn't work. Check it and try again.";

let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!cond) failures++;
};

// Stands in for the worker, the toolbar and the tab. window.__state is what
// the worker has stored and whether the icon is pinned. Tests change it to act
// out what happens outside the page. Every call lands on window.calls.
const stub = ({ state = {}, pinApi = true, keyWorks = true } = {}) => `(() => {
  const calls = window.calls = [];
  const s = window.__state = Object.assign({ hasScore: false, pinned: false,
    settings: { apiKey: "", resume: "", needsSponsorship: true } }, ${JSON.stringify(state)});
  const replies = {
    get_status: () => ({ ok: true, hasKey: !!s.settings.apiKey, hasResume: !!s.settings.resume.trim(), hasScore: s.hasScore }),
    get_settings: () => ({ ok: true, settings: { ...s.settings } }),
    test_api_key: () => ${keyWorks} ? { ok: true, usage: { input_tokens: 97 } } : { ok: false, error: ${JSON.stringify(BAD_KEY)} },
    save_settings: (message) => { Object.assign(s.settings, message.settings); return { ok: true }; },
    count: () => ({ ok: true })
  };
  Object.defineProperty(window, "chrome", { configurable: true, value: {
    runtime: {
      sendMessage: async (message) => { calls.push(message); return replies[message.type](message); },
      openOptionsPage: () => calls.push({ api: "openOptionsPage" })
    },
    action: ${pinApi ? "{ getUserSettings: async () => ({ isOnToolbar: s.pinned }) }" : "{}"},
    tabs: {
      getCurrent: async () => ({ id: 41 }),
      remove: async (id) => calls.push({ api: "tabs.remove", id })
    }
  } });
})();`;

const server = await serve((path) => {
  const file = join(ROOT, path);
  if (!file.startsWith(ROOT) || !TYPES[extname(file)]) return null;
  try {
    return { type: TYPES[extname(file)], body: readFileSync(file) };
  } catch {
    return null;
  }
});
const chrome = await openChrome(process.env.CHROME_BIN);

async function open(setup = {}) {
  const { result } = await chrome.send("Page.addScriptToEvaluateOnNewDocument", { source: stub(setup) });
  await chrome.goto(`${server.base}/welcome.html`);
  await chrome.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: result.identifier });
}

// Waits until the expression holds, then reads the screen that's showing.
async function guide(until) {
  await chrome.waitFor(until);
  return chrome.evaluate(`(() => {
    const $ = (id) => document.getElementById(id);
    const shown = document.querySelector(".screen:not([hidden])");
    return {
      screen: document.body.dataset.screen,
      screens: document.querySelectorAll(".screen:not([hidden])").length,
      heading: shown?.querySelector("[tabindex='-1']")?.textContent || "",
      buttons: [...(shown?.querySelectorAll("button") || [])].filter((b) => !b.hidden)
        .map((b) => b.textContent.trim() + (b.disabled ? " (off)" : "")).join(", "),
      status: shown?.querySelector(".status:not([hidden])")?.textContent || "",
      bar: !$("bar").hidden,
      segments: [...document.querySelectorAll(".segments li")].map((s) => s.classList.contains("now") ? "now" : s.classList.contains("done") ? "done" : "-").join(" "),
      testResult: $("testResult").textContent + " " + ($("testResult").dataset.tone || ""),
      calls: window.calls
    };
  })()`);
}
const on = (screen) => `document.body.dataset.screen === ${JSON.stringify(screen)}`;
const click = (selector) => chrome.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const show = (g) => `${g.screen} | ${g.heading} | ${g.buttons} | ${g.status}`;
const sent = (g, type) => g.calls.filter((c) => c.type === type);

try {
  // A fresh install starts on the intro, with no step bar.
  await open();
  let g = await guide(on("intro"));
  check("fresh: the intro shows first, alone", g.heading === "Know if a job fits before you apply." &&
    g.buttons === "Get started" && !g.bar && g.screens === 1, show(g));
  const note = await chrome.evaluate(`document.querySelector("[data-screen='intro'] .fine")?.textContent || ""`);
  check("fresh: the intro says what's counted and where to turn it off", /random ID/.test(note) && /Settings/.test(note), note);

  // Pin: the guide watches the toolbar and checks the pin off by itself.
  await click("[data-screen='intro'] [data-go='pin']");
  g = await guide(on("pin"));
  check("pin: waits for the pin, with Skip for now", g.heading === "Pin it to your toolbar." &&
    g.status === "Waiting for you to pin it" && g.buttons === "Continue (off), Skip for now" && g.bar && g.segments === "now - - -", show(g));
  await chrome.evaluate("window.__state.pinned = true");
  g = await guide(`document.body.dataset.pinned === "true"`);
  check("pin: pinning in the toolbar is noticed without a click", g.heading === "Pinned. Nice." &&
    g.status === "Pinned" && g.buttons === "Continue", show(g));

  // Key: Test and save checks the key, saves it, says so, and moves on.
  await click("#pinContinue");
  g = await guide(on("key"));
  check("key: asks for a key", g.heading === "Connect TypeSafe." && g.buttons === "Test and save key" && g.segments === "done now - -", show(g));
  await chrome.evaluate(`(() => { document.getElementById("apiKey").value = "sk-test"; document.getElementById("testKey").click(); })()`);
  g = await guide(`document.getElementById("keyTitle").textContent === "That key works."`);
  check("key: a working key is saved and celebrated",
    sent(g, "test_api_key").map((c) => c.apiKey).join() === "sk-test" &&
    JSON.stringify(sent(g, "save_settings").map((c) => c.settings)) === JSON.stringify([{ apiKey: "sk-test" }]) &&
    g.testResult.startsWith("✓ Key works and was saved") && g.testResult.endsWith(" ok"), `${show(g)} | ${g.testResult}`);
  g = await guide(on("resume"));
  check("key: then the guide moves on to the resume", g.heading === "Add your resume." && g.segments === "done done now -", show(g));

  // Resume: Save waits for text, saves the whole form, and moves on.
  check("resume: Save is off until there's text", g.buttons === "Save resume (off)", g.buttons);
  await chrome.evaluate(`(() => { const r = document.getElementById("resume"); r.value = "MBA, 4y analytics"; r.dispatchEvent(new Event("input")); document.getElementById("save").click(); })()`);
  g = await guide(on("try"));
  check("resume: the resume and sponsorship are saved",
    JSON.stringify(sent(g, "save_settings").at(-1)?.settings) === JSON.stringify({ apiKey: "sk-test", resume: "MBA, 4y analytics", needsSponsorship: true }),
    JSON.stringify(sent(g, "save_settings").at(-1)));
  check("try: waits for a first score", g.heading === "Now score a real job." && g.status === "Waiting for your first score" &&
    g.buttons === "I'll do this later" && g.segments === "done done done now", show(g));

  // Back goes one screen back. Saved steps offer Continue first.
  await click("#back");
  g = await guide(on("resume"));
  check("back: from try to the saved resume", g.heading === "Got it." && g.buttons === "Continue, Save changes", show(g));
  await click("#back");
  g = await guide(on("key"));
  check("back: to the saved key", g.heading === "That key works." && g.buttons === "Continue, Test and save a different key", show(g));
  await click("#keyContinue");
  await click("#resumeContinue");

  // The first score happens in another tab. Coming back to the guide finishes it.
  await chrome.evaluate(`(() => { window.__state.hasScore = true; window.dispatchEvent(new Event("focus")); })()`);
  g = await guide(on("done"));
  check("done: a first score finishes the guide", g.heading === "You're set." && g.buttons === "Close this tab, Open Settings" && !g.bar, show(g));
  check("every screen asks the worker to count it, in order",
    [...new Set(sent(g, "count").map((c) => c.event))].join() === "guide_intro,guide_pin,guide_key,guide_resume,guide_try,guide_done",
    sent(g, "count").map((c) => c.event).join());
  await click("#closeTab");
  g = await guide(`window.calls.some((c) => c.api === "tabs.remove")`);
  check("done: Close this tab closes this tab", JSON.stringify(g.calls.filter((c) => c.api === "tabs.remove")) === JSON.stringify([{ api: "tabs.remove", id: 41 }]),
    JSON.stringify(g.calls.at(-1)));

  // A key TypeSafe refuses stays on the key screen, in red.
  await open({ keyWorks: false, state: { pinned: true, settings: { apiKey: "", resume: "MBA", needsSponsorship: true } } });
  g = await guide(on("key"));
  await chrome.evaluate(`(() => { document.getElementById("apiKey").value = "sk-bad"; document.getElementById("testKey").click(); })()`);
  g = await guide(`document.getElementById("testResult").textContent.includes("✕")`);
  check("bad key: says why in red and stays put", g.screen === "key" && g.testResult === `✕ ${BAD_KEY} error` &&
    sent(g, "save_settings").length === 0, `${show(g)} | ${g.testResult}`);

  // A browser that can't say whether the icon is pinned doesn't hold anyone up.
  await open({ pinApi: false });
  g = await guide(on("intro"));
  await click("[data-screen='intro'] [data-go='pin']");
  g = await guide(on("pin"));
  check("no pin API: Continue is on, with no waiting", g.buttons === "Continue" && g.status === "", show(g));

  // Someone who finished setup opens the guide again, from Settings.
  await open({ state: { hasScore: true, pinned: true, settings: { apiKey: "sk-real", resume: "MBA", needsSponsorship: false } } });
  g = await guide(on("done"));
  check("returning: opens on done, with a way back to the steps", g.buttons === "Close this tab, Open Settings, See the steps again", show(g));
  await click("#restart");
  g = await guide(on("pin"));
  check("returning: See the steps again starts at the pin", g.heading === "Pinned. Nice.", show(g));

  // Halfway through setup, the guide opens on the first step left.
  await open({ state: { settings: { apiKey: "sk-real", resume: "", needsSponsorship: true } } });
  g = await guide(on("resume"));
  check("halfway: a saved key opens on the resume step", g.heading === "Add your resume.", show(g));

  check("the guide throws no page errors", chrome.errors.length === 0, chrome.errors.join(" ; ").slice(0, 300));
} catch (error) {
  console.log("ERROR", error.message);
  failures++;
} finally {
  await chrome.close();
  server.close();
}

console.log(`\n${failures === 0 ? "ALL SETUP GUIDE CHECKS PASSED" : failures + " FAILURE(S)"}`);
process.exit(failures ? 1 : 0);
