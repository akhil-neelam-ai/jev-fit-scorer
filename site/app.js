// Worth Applying? landing page: switches the sample popup in the product panel.
// The page reads fine without this file.
const shots = [...document.querySelectorAll("[data-shot]")];
const buttons = [...document.querySelectorAll("[data-sample]")];
const live = document.querySelector("[data-live]");

// The other two screenshots load once the page settles, so they don't slow the first paint.
function loadShots() {
  for (const shot of shots) {
    if (!shot.dataset.src) continue;
    shot.src = shot.dataset.src;
    delete shot.dataset.src;
  }
}
addEventListener("load", () => ("requestIdleCallback" in window ? requestIdleCallback(loadShots) : setTimeout(loadShots, 200)));

function select(button) {
  loadShots();
  for (const other of buttons) other.setAttribute("aria-pressed", String(other === button));
  for (const shot of shots) {
    const on = shot.dataset.shot === button.dataset.sample;
    shot.classList.toggle("is-on", on);
    if (on) shot.removeAttribute("aria-hidden");
    else shot.setAttribute("aria-hidden", "true");
  }
  live.textContent = button.dataset.summary;
}

for (const button of buttons) button.addEventListener("click", () => select(button));

// The dot chart on the accuracy card: data-dots="93/101" draws 101 dots with the first 93 filled.
for (const chart of document.querySelectorAll("[data-dots]")) {
  const [filled, total] = chart.dataset.dots.split("/").map(Number);
  for (let i = 0; i < total; i++) {
    const dot = document.createElement("i");
    if (i >= filled) dot.className = "off";
    chart.append(dot);
  }
}

// Tools for AI agents in the browser (WebMCP). Browsers without the API skip this.
const modelContext = document.modelContext || navigator.modelContext;
if (modelContext?.registerTool) {
  const STORE = "https://chromewebstore.google.com/detail/worth-applying/ppcfjfgonfggaaeoomjakdjkjpjbokbc";
  const samples = buttons.map((button) => ({
    id: button.dataset.sample,
    job: button.querySelector(".sample-role").textContent,
    recommendation: button.querySelector(".sample-rec").textContent,
    score: Number.parseInt(button.querySelector(".sample-score").textContent, 10)
  }));
  const reply = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
  const tools = [
    {
      name: "get_install_info",
      description: "Returns how to install the Worth Applying? Chrome extension: the Chrome Web Store link, supported browsers, price, what you need, and the privacy policy.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
      execute: async () => reply({
        chromeWebStore: STORE,
        price: "Free. Scoring uses your own TypeSafe API key and costs about 2 cents per 100 jobs.",
        browsers: ["Chrome", "Edge", "Brave", "Comet"],
        youNeed: ["A TypeSafe API key from https://console.typesafe.ai", "Your resume as plain text"],
        privacyPolicy: new URL("/privacy", location.href).href,
        sourceCode: "https://github.com/akhil-neelam-ai/worth-applying"
      })
    },
    {
      name: "get_sample_scores",
      description: "Returns the three sample results on this page: the same resume scored against three job postings, with each fit score out of 10 and its recommendation.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
      execute: async () => reply(samples)
    },
    {
      name: "show_sample",
      description: "Shows the extension's popup for one sample job in the page's product panel.",
      inputSchema: {
        type: "object",
        properties: { sample: { type: "string", enum: samples.map((s) => s.id), description: "apm (7/10), growth (4/10), or engineer (2/10)" } },
        required: ["sample"]
      },
      execute: async ({ sample }) => {
        const button = buttons.find((b) => b.dataset.sample === sample);
        if (!button) return reply({ error: `Unknown sample: ${sample}` });
        select(button);
        button.scrollIntoView({ block: "center", behavior: "smooth" });
        return reply(samples.find((s) => s.id === sample));
      }
    }
  ];
  for (const tool of tools) {
    try {
      Promise.resolve(modelContext.registerTool(tool)).catch(() => {});
    } catch {
      // An older or different version of the API. The page works without it.
    }
  }
}
