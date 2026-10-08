#!/usr/bin/env node
// Compare ways of turning Jev's answers into a 1-10 score that matches Lenny's,
// using 5-fold cross-validation so no job is scored by a model fit on it.
//   node eval/compare-versions.mjs
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";

const LENNY = "eval/private/lenny", V4 = "eval/private/jev", V5 = "eval/private/jev-v5", OUT = "eval/private/analysis";
await mkdir(OUT, { recursive: true });
const DIMS = ["role_level", "function", "domain", "company_stage", "customer_type", "required_qualifications"];
const RATING = { weak: 0, moderate: 1, strong: 2, unclear: 0.5 };
const GENERIC = new Set("product products manager management senior sr staff principal lead associate intern internship the and of for with ii iii iv 2026 2027 summer mba group director head technical tech".split(" "));
const distinct = (t) => (t || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !GENERIC.has(w));
function clean(l) {
  const d = (l.job?.description || "").toLowerCase();
  if (d.length < 1000 || /\d[\d,]* jobs? matched|jobs search results/.test(d.slice(0, 800))) return false;
  const t = distinct(l.card.title);
  if (t.length) return t.some((w) => d.includes(w));
  const all = (l.card.title || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  return !all.length || all.filter((w) => d.includes(w)).length / all.length >= 0.6;
}
const read = async (dir, f) => JSON.parse(await readFile(`${dir}/${f}`, "utf8"));
const jobs = [];
for (const f of (await readdir(LENNY)).filter((f) => f.endsWith(".json"))) {
  const l = await read(LENNY, f);
  if (l.lenny?.result?.fit_score == null || !clean(l)) continue;
  let v4, v5; try { v4 = await read(V4, f); v5 = await read(V5, f); } catch { continue; }
  const r = l.lenny.result, sc = Object.fromEntries(r.scorecard.map((d) => [d.dimension, d.rating]));
  const text = `${r.summary_opinion} ${(r.gaps || []).join(" ")}`;
  jobs.push({
    key: l.key, stratum: l.stratum || "default-pm", L: r.fit_score,
    v4: v4.result.fit, v5: v5.result.fit,
    lennyDims: DIMS.map((d) => RATING[sc[d]] ?? 0.5), lennyLabels: sc,
    jevDims: DIMS.map((d) => v5.result.scorecard?.[d]?.score ?? 1),
    jevLabels: Object.fromEntries(DIMS.map((d) => [d, v5.result.scorecard?.[d]?.label?.toLowerCase()])),
    eligibility: /work[- ]authoriz|visa|sponsor|export[- ]control|citizen|clearance|right to work/i.test(text),
    tokens4: v4.result.inputTokens, tokens5: v5.result.inputTokens, ms4: v4.result.elapsedMs, ms5: v5.result.elapsedMs
  });
}
const n = jobs.length;

// ---------- models ----------
function isotonic(points) {
  const s = [...points].sort((a, b) => a.x - b.x);
  const B = s.map((p) => ({ sx: p.x, sy: p.y, w: 1 }));
  for (let i = 0; i < B.length - 1;) {
    if (B[i].sy / B[i].w > B[i + 1].sy / B[i + 1].w) { B[i] = { sx: B[i].sx + B[i + 1].sx, sy: B[i].sy + B[i + 1].sy, w: B[i].w + B[i + 1].w }; B.splice(i + 1, 1); if (i > 0) i--; } else i++;
  }
  const knots = B.map((b) => ({ x: b.sx / b.w, y: b.sy / b.w }));
  const f = (x) => {
    if (x <= knots[0].x) return knots[0].y;
    for (let i = 1; i < knots.length; i++) if (x <= knots[i].x) { const a = knots[i - 1], b = knots[i]; return a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x || 1); }
    return knots.at(-1).y;
  };
  f.knots = knots; return f;
}
function ridge(X, y, lambda = 0) {
  const k = X[0].length + 1, A = Array.from({ length: k }, () => new Array(k + 1).fill(0));
  for (let i = 0; i < X.length; i++) { const xi = [1, ...X[i]]; for (let a = 0; a < k; a++) { for (let b = 0; b < k; b++) A[a][b] += xi[a] * xi[b]; A[a][k] += xi[a] * y[i]; } }
  for (let a = 1; a < k; a++) A[a][a] += lambda;
  for (let c = 0; c < k; c++) { let p = c; for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r; [A[c], A[p]] = [A[p], A[c]]; for (let r = 0; r < k; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let j = c; j <= k; j++) A[r][j] -= f * A[c][j]; } }
  const beta = A.map((row, i) => row[k] / row[i]);
  const f = (x) => beta[0] + x.reduce((s, v, j) => s + v * beta[j + 1], 0); f.beta = beta; return f;
}
// Non-negative weights: drop any feature whose weight comes out negative and
// refit, so a better match on a dimension can never lower the score.
function ridgeNonNeg(X, y, lambda = 1) {
  let keep = X[0].map((_, j) => j);
  for (;;) {
    const f = ridge(X.map((x) => keep.map((j) => x[j])), y, lambda);
    const neg = keep.filter((_, i) => f.beta[i + 1] < 0);
    if (!neg.length) {
      const beta = [f.beta[0], ...X[0].map((_, j) => (keep.includes(j) ? f.beta[keep.indexOf(j) + 1] : 0))];
      const g = (x) => beta[0] + x.reduce((s, v, j) => s + v * beta[j + 1], 0); g.beta = beta; return g;
    }
    keep = keep.filter((j) => !neg.includes(j));
  }
}
const show = (v) => Math.max(1, Math.min(10, Math.round(v)));
const METHODS = {
  "A  v4 x2.5 (today)": { fit: () => (j) => j.v4 * 2.5 },
  "B  v4 + calibration": { fit: (tr) => { const f = isotonic(tr.map((j) => ({ x: j.v4, y: j.L }))); return (j) => f(j.v4); } },
  "C  v5 x2.5": { fit: () => (j) => j.v5 * 2.5 },
  "D  v5 + calibration": { fit: (tr) => { const f = isotonic(tr.map((j) => ({ x: j.v5, y: j.L }))); return (j) => f(j.v5); } },
  "E  v5 scorecard, Lenny's weights": { fit: (tr) => { const f = ridge(tr.map((j) => j.lennyDims), tr.map((j) => j.L)); return (j) => f(j.jevDims); } },
  "F  v5 scorecard, fitted weights": { fit: (tr) => { const f = ridge(tr.map((j) => j.jevDims), tr.map((j) => j.L), 1); return (j) => f(j.jevDims); } },
  "G  blend of D and F": { fit: (tr) => { const d = isotonic(tr.map((j) => ({ x: j.v5, y: j.L }))), f = ridge(tr.map((j) => j.jevDims), tr.map((j) => j.L), 1); return (j) => (d(j.v5) + f(j.jevDims)) / 2; } },
  "F2 v5 scorecard, non-negative weights": { fit: (tr) => { const f = ridgeNonNeg(tr.map((j) => j.jevDims), tr.map((j) => j.L)); return (j) => f(j.jevDims); } },
  "G2 blend of D and F2": { fit: (tr) => { const d = isotonic(tr.map((j) => ({ x: j.v5, y: j.L }))), f = ridgeNonNeg(tr.map((j) => j.jevDims), tr.map((j) => j.L)); return (j) => (d(j.v5) + f(j.jevDims)) / 2; } }
};

// Deterministic folds by key hash.
const h = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
const folds = jobs.map((j) => h(j.key) % 5);
const pred = {};
for (const [name, m] of Object.entries(METHODS)) {
  pred[name] = new Array(n);
  for (let k = 0; k < 5; k++) {
    const tr = jobs.filter((_, i) => folds[i] !== k), model = m.fit(tr);
    jobs.forEach((j, i) => { if (folds[i] === k) pred[name][i] = show(model(j)); });
  }
}

// ---------- metrics ----------
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function ranks(a) { const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(a.length); for (let i = 0; i < idx.length;) { let k = i; while (k + 1 < idx.length && idx[k + 1][0] === idx[i][0]) k++; for (let m = i; m <= k; m++) r[idx[m][1]] = (i + k) / 2 + 1; i = k + 1; } return r; }
function pearson(x, y) { const mx = mean(x), my = mean(y); let a = 0, b = 0, c = 0; for (let i = 0; i < x.length; i++) { a += (x[i] - mx) * (y[i] - my); b += (x[i] - mx) ** 2; c += (y[i] - my) ** 2; } return b && c ? a / Math.sqrt(b * c) : NaN; }
const bucket = (x) => (x <= 3 ? 0 : x <= 6 ? 1 : 2);
function kappa(p, l) { const m = [[0,0,0],[0,0,0],[0,0,0]]; p.forEach((v, i) => m[bucket(l[i])][bucket(v)]++); const N = p.length, po = (m[0][0] + m[1][1] + m[2][2]) / N; let pe = 0; for (let a = 0; a < 3; a++) pe += ((m[a][0] + m[a][1] + m[a][2]) / N) * ((m[0][a] + m[1][a] + m[2][a]) / N); return (po - pe) / (1 - pe); }
const L = jobs.map((j) => j.L);
let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
function bootMae(p) { const v = []; for (let b = 0; b < 2000; b++) { let s = 0; for (let i = 0; i < n; i++) { const k = Math.floor(rnd() * n); s += Math.abs(p[k] - L[k]); } v.push(s / n); } v.sort((a, b) => a - b); return [v[50], v[1949]]; }
function bootDiff(p, q) { const v = []; for (let b = 0; b < 2000; b++) { let s = 0; for (let i = 0; i < n; i++) { const k = Math.floor(rnd() * n); s += Math.abs(p[k] - L[k]) - Math.abs(q[k] - L[k]); } v.push(s / n); } v.sort((a, b) => a - b); return [v[50], v[1949]]; }
const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "n/a");
const stats = Object.fromEntries(Object.entries(pred).map(([name, p]) => {
  const err = p.map((v, i) => v - L[i]);
  return [name, { mae: mean(err.map(Math.abs)), bias: mean(err), rho: pearson(ranks(p), ranks(L)), within1: err.filter((e) => Math.abs(e) <= 1).length, exact: err.filter((e) => e === 0).length, kappa: kappa(p, L), ci: bootMae(p) }];
}));

const out = [];
out.push(`# Scoring versions compared`, ``, `${n} jobs. Every number below is cross-validated (5 folds): each job's score comes from a model fit on the other four fifths. Errors are measured on the 1 to 10 score a user would see.`, ``);
out.push(`| Method | Mean abs gap (95% CI) | Avg gap | Rank agreement | Within 1 | Exact | Bucket kappa |`, `| --- | --- | --- | --- | --- | --- | --- |`);
for (const [name, s] of Object.entries(stats)) out.push(`| ${name} | ${fmt(s.mae)} (${fmt(s.ci[0])} to ${fmt(s.ci[1])}) | ${fmt(s.bias)} | ${fmt(s.rho)} | ${s.within1}/${n} | ${s.exact}/${n} | ${fmt(s.kappa)} |`);
const names = Object.keys(stats), best = names.reduce((a, b) => (stats[b].mae < stats[a].mae ? b : a));
const today = names[0], d = bootDiff(pred[best], pred[today]);
out.push(``, `Best: ${best}. Versus today's method, it changes the mean absolute gap by ${fmt(stats[best].mae - stats[today].mae)} (95% CI ${fmt(d[0])} to ${fmt(d[1])}).`, ``);
const dD = bootDiff(pred[names[3]], pred[names[1]]);
out.push(`New rubric alone, both calibrated (D vs B): ${fmt(stats[names[3]].mae - stats[names[1]].mae)} (95% CI ${fmt(dD[0])} to ${fmt(dD[1])}).`, ``);

// Raw rubric shift and eligibility jobs.
const big = jobs.filter((j) => j.L - Math.round(j.v4 * 2.5) >= 3);
out.push(`## What the new rubric changed`, ``);
out.push(`| Jobs | n | Lenny avg | v4 raw avg (x2.5) | v5 raw avg (x2.5) |`, `| --- | --- | --- | --- | --- |`);
for (const [label, s] of [["All", jobs], ["Lenny mentions work authorization, visa, export control", jobs.filter((j) => j.eligibility)], ["Gap of 3+ points under v4", big]]) {
  out.push(`| ${label} | ${s.length} | ${fmt(mean(s.map((j) => j.L)), 1)} | ${fmt(mean(s.map((j) => j.v4 * 2.5)), 1)} | ${fmt(mean(s.map((j) => j.v5 * 2.5)), 1)} |`);
}
out.push(``, `## Jev's scorecard vs Lenny's`, ``, `| Dimension | Same rating | Jev avg when Lenny says weak | moderate | strong |`, `| --- | --- | --- | --- | --- |`);
DIMS.forEach((dim, di) => {
  const same = jobs.filter((j) => j.jevLabels[dim] === j.lennyLabels[dim]).length;
  const by = (rt) => { const s = jobs.filter((j) => j.lennyLabels[dim] === rt).map((j) => j.jevDims[di]); return s.length ? `${fmt(mean(s))} (n=${s.length})` : "n/a"; };
  out.push(`| ${dim} | ${same}/${n} | ${by("weak")} | ${by("moderate")} | ${by("strong")} |`);
});
out.push(``, `## By job group (cross-validated mean abs gap)`, ``, `| Group | n | ${names.map((x) => x.split(" ")[0]).join(" | ")} |`, `| --- | --- | ${names.map(() => "---").join(" | ")} |`);
for (const g of [...new Set(jobs.map((j) => j.stratum))]) {
  const idx = jobs.map((j, i) => (j.stratum === g ? i : -1)).filter((i) => i >= 0);
  out.push(`| ${g} | ${idx.length} | ${names.map((nm) => fmt(mean(idx.map((i) => Math.abs(pred[nm][i] - L[i]))))).join(" | ")} |`);
}
out.push(``, `## Cost`, ``, `v4 median ${Math.round(mean(jobs.map((j) => j.tokens4)))} input tokens per job, v5 ${Math.round(mean(jobs.map((j) => j.tokens5)))} (the scorecard questions). Median call time v4 ${[...jobs.map((j) => j.ms4)].sort((a, b) => a - b)[n >> 1]} ms, v5 ${[...jobs.map((j) => j.ms5)].sort((a, b) => a - b)[n >> 1]} ms.`);

// Final parameters, fit on all jobs, for shipping.
const finalIso = isotonic(jobs.map((j) => ({ x: j.v5, y: j.L })));
const finalLin = ridgeNonNeg(jobs.map((j) => j.jevDims), jobs.map((j) => j.L));
await writeFile(`${OUT}/version-comparison.md`, out.join("\n") + "\n");
await writeFile(`${OUT}/version-comparison.json`, JSON.stringify({ n, stats, best, calibrationKnots: finalIso.knots, scorecardWeights: { intercept: finalLin.beta[0], ...Object.fromEntries(DIMS.map((d, i) => [d, finalLin.beta[i + 1]])) } }, null, 2));
await writeFile(`${OUT}/predictions.json`, JSON.stringify(jobs.map((j, i) => ({ key: j.key, stratum: j.stratum, lenny: j.L, v4: j.v4, v5: j.v5, ...Object.fromEntries(names.map((nm) => [nm.split(" ")[0], pred[nm][i]])) })), null, 2));
console.log(out.join("\n"));
