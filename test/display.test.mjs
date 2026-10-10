// Checks the 1-10 display: calibration, scorecard blend, fallbacks, tiers.
// Run: node test/display.test.mjs
import { displayScore, comparableScore, recommendationFor, calibratedFit, scorecardEstimate, DIMENSIONS } from "../scoring.js";

const sc = (level) => Object.fromEntries(Object.keys(DIMENSIONS).map((k) => [k, { score: level }]));
let failures = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${got !== undefined ? "  (" + got + ")" : ""}`);
  if (!ok) failures++;
};

let prev = -1, monotone = true;
for (let f = 0; f <= 4.0001; f += 0.01) { const v = calibratedFit(f); if (v < prev - 1e-9) monotone = false; prev = v; }
check("calibration is monotone over 0..4", monotone);
check("calibration endpoints", calibratedFit(0) === 2 && calibratedFit(4) === 10, `${calibratedFit(0)}, ${calibratedFit(4)}`);
check("out-of-range fit is clamped", calibratedFit(-1) === 2 && calibratedFit(9) === 10);
check("scorecard estimate rises with every level", scorecardEstimate(sc(0)) < scorecardEstimate(sc(1)) && scorecardEstimate(sc(1)) < scorecardEstimate(sc(2)),
  [0, 1, 2].map((l) => scorecardEstimate(sc(l)).toFixed(2)).join(" / "));
check("partial scorecard falls back to calibration only",
  scorecardEstimate({ function: { score: 2 } }) === null && displayScore({ fit: 2, scorecard: { function: { score: 2 } } }) === Math.round(calibratedFit(2)));
check("results without a scorecard still display", displayScore({ fit: 1.5 }) === Math.round(calibratedFit(1.5)), displayScore({ fit: 1.5 }));
check("blend is the average of both parts", Math.abs(comparableScore({ fit: 2, scorecard: sc(1) }) - (calibratedFit(2) + scorecardEstimate(sc(1))) / 2) < 1e-12);
check("display stays within 1..10", [0, 4].every((f) => [0, 2].every((l) => { const d = displayScore({ fit: f, scorecard: sc(l) }); return d >= 1 && d <= 10; })));
check("recommendation tiers", [1, 3, 4, 5, 6, 7, 8, 10].map(recommendationFor).join(" | ") ===
  "Deprioritize | Deprioritize | Apply if interested | Apply if interested | Apply and tailor | Apply and tailor | Strongly apply | Strongly apply");

console.log(failures ? `\n${failures} FAILED` : "\nALL DISPLAY CHECKS PASSED");
process.exit(failures ? 1 : 0);
