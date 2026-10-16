// Runs the setup guide: an intro, four steps (pin, key, resume, try) and a
// done screen, one at a time. options.js runs the key and resume form and
// fires "settings-saved" after each save. This file moves between the
// screens, shows each step's live state, and moves on once a step is done.
const $ = (id) => document.getElementById(id);
const STEPS = ["pin", "key", "resume", "try"];
const ORDER = ["intro", ...STEPS, "done"];

let screen = "";
let status = { hasKey: false, hasResume: false, hasScore: false };
let pinned = null; // true or false, or null when the browser can't say
let latest = 0;
let arrivedDone = false; // the guide opened with setup already finished

async function isPinned() {
  try {
    return (await chrome.action.getUserSettings()).isOnToolbar;
  } catch {
    return null;
  }
}

// Reads the worker's status and the toolbar. Returns false when a newer read
// started meanwhile, so an old answer can't win.
async function read() {
  const run = ++latest;
  const [reply, pin] = await Promise.all([
    chrome.runtime.sendMessage({ type: "get_status" }).catch(() => null),
    isPinned()
  ]);
  if (run !== latest) return false;
  if (reply?.ok) status = { hasKey: !!reply.hasKey, hasResume: !!reply.hasResume, hasScore: !!reply.hasScore };
  pinned = pin;
  return true;
}

// Where to start: the intro on a fresh install, otherwise the first step
// that isn't done. Pinning is optional, so it never holds someone back.
function firstScreen() {
  const { hasKey, hasResume, hasScore } = status;
  if (!hasKey && !hasResume && !hasScore) return "intro";
  if (!hasKey) return "key";
  if (!hasResume) return "resume";
  return hasScore ? "done" : "try";
}

function show(next) {
  screen = next;
  // The worker counts each screen once per install, unless counts are off.
  chrome.runtime.sendMessage({ type: "count", event: `guide_${next}` }).catch(() => {});
  for (const section of document.querySelectorAll(".screen")) {
    const on = section.dataset.screen === next;
    section.hidden = !on;
    section.classList.toggle("enter", on);
  }
  $("bar").hidden = !STEPS.includes(next);
  document.body.dataset.screen = next;
  render();
  scrollTo(0, 0);
  document.querySelector(`.screen[data-screen="${next}"] [tabindex="-1"]`)?.focus({ preventScroll: true });
}

function render() {
  const at = STEPS.indexOf(screen);
  document.querySelectorAll(".segments li").forEach((segment, i) => {
    segment.classList.toggle("done", i < at);
    segment.classList.toggle("now", i === at);
    if (i === at) segment.setAttribute("aria-current", "step");
    else segment.removeAttribute("aria-current");
  });

  // Pin: the demo stops on its last frame once the real icon is pinned.
  $("pinDemo").classList.toggle("is-pinned", pinned === true);
  $("pinTitle").textContent = pinned === true ? "Pinned. Nice." : "Pin it to your toolbar.";
  setStatus($("pinStatus"), pinned === true ? "ok" : pinned === false ? "waiting" : "",
    pinned === true ? "Pinned" : "Waiting for you to pin it");
  $("pinContinue").disabled = pinned === false;
  $("pinSkip").hidden = pinned !== false;

  // Key and resume: once saved, Continue leads and saving again steps back.
  $("keyTitle").textContent = status.hasKey ? "That key works." : "Connect TypeSafe.";
  $("keyContinue").hidden = !status.hasKey;
  $("testKey").className = status.hasKey ? "ghost" : "cta";
  $("testKey").textContent = status.hasKey ? "Test and save a different key" : "Test and save key";
  $("resumeTitle").textContent = status.hasResume ? "Got it." : "Add your resume.";
  $("resumeContinue").hidden = !status.hasResume;
  $("save").className = status.hasResume ? "ghost" : "cta";
  $("save").textContent = status.hasResume ? "Save changes" : "Save resume";
  syncButtons();

  $("restart").hidden = screen !== "done" || !arrivedDone;

  // For the tests: which steps are done, and what the toolbar said.
  document.body.dataset.pinned = pinned === null ? "unknown" : String(pinned);
  document.body.dataset.done = String([pinned !== false, status.hasKey, status.hasResume, status.hasScore].filter(Boolean).length);
}

function setStatus(element, tone, text) {
  element.className = `status ${tone}`;
  element.hidden = !tone;
  element.textContent = tone ? text : "";
}

// Saving waits for some resume text. The key button stays options.js's: it
// turns the button off during a test so a double click can't pay twice.
function syncButtons() {
  $("save").disabled = !$("resume").value.trim();
}

// After a step gets done on its own screen, show that for a beat, then move on.
let advance;
function moveOnFrom(from, next) {
  clearTimeout(advance);
  advance = setTimeout(() => {
    if (screen === from) show(next);
  }, 900);
}

async function update() {
  const before = { ...status };
  if (!(await read())) return;
  if (!screen) return show(firstScreen());
  render();
  if (screen === "key" && !before.hasKey && status.hasKey) moveOnFrom("key", "resume");
  if (screen === "resume" && !before.hasResume && status.hasResume) moveOnFrom("resume", "try");
  // The first score happens in another tab. Coming back here finishes the guide.
  if (screen === "try" && status.hasScore) show("done");
}

async function start() {
  await read();
  const first = firstScreen();
  arrivedDone = first === "done";
  show(first);
}

document.addEventListener("click", (event) => {
  const next = event.target.closest("[data-go]")?.dataset.go;
  if (next) show(next);
});
$("back").addEventListener("click", () => show(ORDER[Math.max(0, ORDER.indexOf(screen) - 1)]));
$("closeTab").addEventListener("click", async () => {
  const tab = await chrome.tabs.getCurrent().catch(() => null);
  if (tab?.id) chrome.tabs.remove(tab.id);
  else window.close();
});
$("openSettings").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("resume").addEventListener("input", syncButtons);
// options.js marks its results with ✓ or ✕. Color them to match.
for (const id of ["testResult", "saveResult"]) {
  new MutationObserver(() => {
    const text = $(id).textContent;
    $(id).dataset.tone = text.includes("✓") ? "ok" : text.includes("✕") ? "error" : "";
  }).observe($(id), { childList: true, characterData: true, subtree: true });
}
document.addEventListener("settings-saved", update);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") update();
});
window.addEventListener("focus", update);
// Pinning happens in the toolbar while this tab stays open, so check for it
// every second while the pin step is showing.
setInterval(async () => {
  if (screen !== "pin" || pinned !== false || document.visibilityState !== "visible") return;
  if (await isPinned()) update();
}, 1000);
start();
