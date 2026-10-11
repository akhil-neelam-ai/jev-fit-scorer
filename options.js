// Options page logic: load/save settings, test the API key.
const $ = (id) => document.getElementById(id);
const extensionContextAvailable =
  typeof chrome !== "undefined" && typeof chrome.runtime?.sendMessage === "function";

// Like the popup, a failed or missing worker reply counts as no reply.
const NO_REPLY = "The extension didn't respond. Try again.";
const ask = (m) => chrome.runtime.sendMessage(m).catch(() => null);

// Shows why the form can't be used and turns its buttons off.
function lockForm(message) {
  $("testResult").textContent = `✕ ${message}`;
  $("saveResult").textContent = `✕ ${message}`;
  $("testKey").disabled = true;
  $("save").disabled = true;
}

function requireExtensionContext() {
  if (extensionContextAvailable) return true;
  lockForm("Open Settings from the installed Worth Applying? extension, not options.html directly.");
  return false;
}

// One timer for the Save result, so an old "Saved ✓" timer can't blank a
// newer message.
let saveResultTimer;
function showSaveResult(text, clearAfterMs = 0) {
  clearTimeout(saveResultTimer);
  $("saveResult").textContent = text;
  if (clearAfterMs) saveResultTimer = setTimeout(() => ($("saveResult").textContent = ""), clearAfterMs);
}

async function load() {
  if (!requireExtensionContext()) return;
  const resp = await ask({ type: "get_settings" });
  // Without the stored settings the form is blank, and saving it would erase
  // them. So lock it instead.
  if (!resp?.ok) {
    lockForm(NO_REPLY);
    return;
  }
  const s = resp.settings || {};
  $("apiKey").value = s.apiKey || "";
  $("resume").value = s.resume || "";
  $("needsSponsorship").checked = s.needsSponsorship !== false;
}

async function save() {
  if (!requireExtensionContext()) return;
  const response = await ask({
    type: "save_settings",
    settings: {
      apiKey: $("apiKey").value.trim(),
      resume: $("resume").value,
      needsSponsorship: $("needsSponsorship").checked
    }
  });
  if (!response?.ok) throw new Error(response?.error || NO_REPLY);
  showSaveResult("Saved ✓", 2000);
  announceSaved();
}

// The setup guide runs this form too, and checks off a step on this event.
const announceSaved = () => document.dispatchEvent(new Event("settings-saved"));

async function testKey() {
  if (!requireExtensionContext()) return;
  const key = $("apiKey").value.trim();
  if (!key) {
    $("testResult").textContent = "Paste a key first.";
    return;
  }
  // One test at a time, so a double click doesn't pay for two calls.
  $("testKey").disabled = true;
  $("testResult").textContent = "Testing…";
  try {
    const resp = await ask({ type: "test_api_key", apiKey: key });
    if (!resp?.ok) throw new Error(resp?.error || NO_REPLY);

    // The field can change while the test runs. Saving the tested key then
    // would overwrite the newer one.
    if ($("apiKey").value.trim() !== key) {
      $("testResult").textContent = "The key changed while testing. Test it again.";
      return;
    }

    // A successful test also persists the key, so users do not have to
    // remember a second Save click after verifying their credentials.
    const saved = await ask({
      type: "save_settings",
      settings: { apiKey: key }
    });
    if (!saved?.ok) throw new Error(saved?.error || NO_REPLY);
    $("testResult").textContent = `✓ Key works and was saved (${resp.usage?.input_tokens ?? "?"} input tokens used)`;
    announceSaved();
  } catch (error) {
    $("testResult").textContent = `✕ ${error.message || "Could not test the key."}`;
  } finally {
    $("testKey").disabled = false;
  }
}

$("save").addEventListener("click", async () => {
  try {
    await save();
  } catch (error) {
    showSaveResult(`✕ ${error.message || "Could not save settings."}`);
  }
});
$("testKey").addEventListener("click", testKey);
document.addEventListener("DOMContentLoaded", load);
