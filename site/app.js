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
