// Checks the 1-10 display: calibration, scorecard blend, fallbacks, tiers,
// and the score and visa bands.
// Run: node test/display.test.mjs
import {
  displayScore, comparableScore, recommendationFor, calibratedFit, scorecardEstimate, scoreBand, visaBand,
  DIMENSIONS, SCORECARD_WEIGHTS
} from "../scoring.js";

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
check("scorecard weights are non-negative", Object.values(SCORECARD_WEIGHTS).every((w) => w >= 0));
// Raise one dimension a level while the others stay put. The score must not fall.
const lowered = Object.keys(DIMENSIONS).flatMap((k) => [0, 1]
  .filter((l) => comparableScore({ fit: 2, scorecard: { ...sc(l), [k]: { score: l + 1 } } }) < comparableScore({ fit: 2, scorecard: sc(l) }))
  .map((l) => `${k} ${l} to ${l + 1}`));
check("raising one dimension never lowers the score", lowered.length === 0, lowered.join(", ") || undefined);
check("partial scorecard falls back to calibration only",
  scorecardEstimate({ function: { score: 2 } }) === null && displayScore({ fit: 2, scorecard: { function: { score: 2 } } }) === Math.round(calibratedFit(2)));
check("results without a scorecard still display", displayScore({ fit: 1.5 }) === Math.round(calibratedFit(1.5)), displayScore({ fit: 1.5 }));
check("blend is the average of both parts", Math.abs(comparableScore({ fit: 2, scorecard: sc(1) }) - (calibratedFit(2) + scorecardEstimate(sc(1))) / 2) < 1e-12);
check("display stays within 1..10", [0, 4].every((f) => [0, 2].every((l) => { const d = displayScore({ fit: f, scorecard: sc(l) }); return d >= 1 && d <= 10; })));
check("display clamps an extreme blend to 10", displayScore({ fit: 4, scorecard: sc(50) }) === 10, displayScore({ fit: 4, scorecard: sc(50) }));
check("recommendation tiers", [1, 3, 4, 5, 6, 7, 8, 10].map(recommendationFor).join(" | ") ===
  "Deprioritize | Deprioritize | Apply if interested | Apply if interested | Apply and tailor | Apply and tailor | Strongly apply | Strongly apply");
check("score bands change at 4 and 7", [1, 3, 4, 6, 7, 10].map(scoreBand).join(" | ") === "low | low | mid | mid | high | high",
  [1, 3, 4, 6, 7, 10].map(scoreBand).join(" | "));

const showVisa = (visa) => { const band = visaBand(visa); return band ? `${band.label} ${band.percent}% ${band.tone}` : "none"; };
check("visa bands change at 30 and 60 percent", [0.29, 0.3, 0.59, 0.6].map(showVisa).join(" | ") ===
  "Unlikely 29% weak | Unclear 30% moderate | Unclear 59% moderate | Likely 60% strong", [0.29, 0.3, 0.59, 0.6].map(showVisa).join(" | "));
// The band follows the rounded percent, so the word always matches the number shown.
check("visa bands use the rounded percent", [0.2949, 0.295, 0.5949, 0.595].map(showVisa).join(" | ") ===
  "Unlikely 29% weak | Unclear 30% moderate | Unclear 59% moderate | Likely 60% strong", [0.2949, 0.295, 0.5949, 0.595].map(showVisa).join(" | "));
check("visa ends of the scale", [0, 1].map(showVisa).join(" | ") === "Unlikely 0% weak | Likely 100% strong");
check("no visa estimate has no band", [null, undefined, NaN].every((visa) => visaBand(visa) === null));

console.log(failures ? `\n${failures} FAILED` : "\nALL DISPLAY CHECKS PASSED");
process.exit(failures ? 1 : 0);
