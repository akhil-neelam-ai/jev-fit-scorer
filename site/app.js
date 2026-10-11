// Worth Applying? landing page: switches the sample popup in the hero, and draws the
// fit bar when it scrolls into view. The page reads fine without this file.
document.documentElement.classList.add("reveal");

// Lowest score in each recommendation tier, and that tier's label on the scale.
const TIERS = [[8, 3], [6, 2], [4, 1], [1, 0]];

const scale = document.querySelector(".scale");
const labels = [...document.querySelectorAll(".scale-labels span")];
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
  const score = Number(button.dataset.score);
  for (const other of buttons) other.setAttribute("aria-pressed", String(other === button));
  for (const shot of shots) {
    const on = shot.dataset.shot === button.dataset.sample;
    shot.classList.toggle("is-on", on);
    if (on) shot.removeAttribute("aria-hidden");
    else shot.setAttribute("aria-hidden", "true");
  }
  scale.style.setProperty("--s", score);
  const tier = TIERS.find(([min]) => score >= min)[1];
  labels.forEach((label, index) => label.classList.toggle("on", index === tier));
  live.textContent = button.dataset.summary;
}

for (const button of buttons) button.addEventListener("click", () => select(button));

// Watch the legend under the bar, not the bar: the bar starts clipped to nothing,
// and a fully clipped element never counts as visible.
const split = document.querySelector(".split");
if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    split.classList.add("in");
    observer.disconnect();
  }, { rootMargin: "0px 0px -15% 0px" });
  observer.observe(document.querySelector(".split-legend"));
} else {
  split.classList.add("in");
}
