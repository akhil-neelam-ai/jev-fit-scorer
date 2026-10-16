// Worth Applying? landing page: plays the demo video, draws the accuracy dots,
// and offers tools to AI agents. The page reads fine without this file.

// The demo video loops like a GIF. It plays, muted, while most of it is on
// screen, and pauses when it scrolls away. It has no controls, so a tap, a
// click, Enter or Space pauses or resumes it. With reduced motion it starts paused.
const demo = document.querySelector("video[data-autoplay]");
if (demo) {
  let pausedByViewer = false;
  const toggle = () => {
    pausedByViewer = !demo.paused;
    if (demo.paused) demo.play().catch(() => {});
    else demo.pause();
  };
  demo.addEventListener("click", toggle);
  demo.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggle();
  });
  if ("IntersectionObserver" in window && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) demo.pause();
      else if (!pausedByViewer) demo.play().catch(() => {});
    }, { threshold: 0.5 }).observe(demo);
  }
}

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
  // Three results from the test run. index.md lists the same ones.
  const samples = [
    { job: "Associate Product Manager", score: 7, recommendation: "Apply and tailor", mainFactor: "Role level" },
    { job: "Product Manager, Growth Strategy", score: 4, recommendation: "Apply if interested", mainFactor: "Required qualifications" },
    { job: "Lead, Software Engineer", score: 2, recommendation: "Deprioritize", mainFactor: "Required qualifications" }
  ];
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
      description: "Returns three sample results from the test run: the same resume scored against three job postings, with each fit score out of 10, its recommendation, and the main factor.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
      execute: async () => reply(samples)
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
