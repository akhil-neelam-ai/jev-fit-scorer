// Options page logic: load/save settings, test the API key.
const $ = (id) => document.getElementById(id);
const extensionContextAvailable =
  typeof chrome !== "undefined" && typeof chrome.runtime?.sendMessage === "function";

function requireExtensionContext() {
  if (extensionContextAvailable) return true;
  const message = "Open Options from the installed Worth Applying? extension, not options.html directly.";
  $("testResult").textContent = `✕ ${message}`;
  $("saveResult").textContent = `✕ ${message}`;
  $("testKey").disabled = true;
  $("save").disabled = true;
  return false;
}

async function load() {
  if (!requireExtensionContext()) return;
  const resp = await chrome.runtime.sendMessage({ type: "get_settings" });
  const s = resp.settings || {};
  $("apiKey").value = s.apiKey || "";
  $("resume").value = s.resume || "";
  $("needsSponsorship").checked = s.needsSponsorship !== false;
}

async function save() {
  if (!requireExtensionContext()) return;
  const response = await chrome.runtime.sendMessage({
    type: "save_settings",
    settings: {
      apiKey: $("apiKey").value.trim(),
      resume: $("resume").value,
      needsSponsorship: $("needsSponsorship").checked
    }
  });
  if (!response?.ok) throw new Error(response?.error || "Could not save settings.");
  $("saveResult").textContent = "Saved ✓";
  setTimeout(() => ($("saveResult").textContent = ""), 2000);
}

async function testKey() {
  if (!requireExtensionContext()) return;
  const key = $("apiKey").value.trim();
  if (!key) {
    $("testResult").textContent = "Paste a key first.";
    return;
  }
  $("testResult").textContent = "Testing…";
  try {
    const resp = await chrome.runtime.sendMessage({ type: "test_api_key", apiKey: key });
    if (!resp?.ok) {
      $("testResult").textContent = `✕ ${resp?.error || "The key did not work."}`;
      return;
    }

    // A successful test also persists the key, so users do not have to
    // remember a second Save click after verifying their credentials.
    const saved = await chrome.runtime.sendMessage({
      type: "save_settings",
      settings: { apiKey: key }
    });
    if (!saved?.ok) throw new Error(saved?.error || "The key worked but could not be saved.");
    $("testResult").textContent = `✓ Key works and was saved (${resp.usage?.input_tokens ?? "?"} input tokens used)`;
  } catch (error) {
    $("testResult").textContent = `✕ ${error.message || "Could not test the key."}`;
  }
}

$("save").addEventListener("click", async () => {
  try {
    await save();
  } catch (error) {
    $("saveResult").textContent = `✕ ${error.message || "Could not save settings."}`;
  }
});
$("testKey").addEventListener("click", testKey);
document.addEventListener("DOMContentLoaded", load);
