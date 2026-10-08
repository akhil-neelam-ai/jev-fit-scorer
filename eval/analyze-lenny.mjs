#!/usr/bin/env node
// Reverse-engineer how Lenny's "Am I a fit?" turns its scorecard into a score.
//   node eval/analyze-lenny.mjs --lenny eval/private/lenny --out eval/private/analysis
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({ options: {
  lenny: { type: "string", default: "eval/private/lenny" },
  out: { type: "string", default: "eval/private/analysis" }
} });
await mkdir(args.out, { recursive: true });

// Same data-quality gate as the report, so both analyses use the same jobs.
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

const recs = [];
for (const f of (await readdir(args.lenny)).filter((f) => f.endsWith(".json"))) {
  const l = JSON.parse(await readFile(`${args.lenny}/${f}`, "utf8"));
  if (l.lenny?.result?.fit_score != null && clean(l)) recs.push(l);
}
const DIMS = ["role_level", "function", "domain", "company_stage", "customer_type", "required_qualifications"];
const RATING = { weak: 0, moderate: 1, strong: 2, unclear: 0.5 };
const rows = recs.map((l) => {
  const r = l.lenny.result;
  const sc = Object.fromEntries((r.scorecard || []).map((d) => [d.dimension, d.rating]));
  const text = `${r.summary_opinion} ${(r.gaps || []).join(" ")}`;
  return {
    key: l.key, score: r.fit_score, rec: r.recommendation, conf: r.confidence, ctx: r.context_limitation, sc,
    x: DIMS.map((d) => RATING[sc[d]] ?? 0.5),
    eligibility: /work[- ]authoriz|visa|sponsor|export[- ]control|citizen|clearance|right to work|eligib/i.test(text),
    location: /relocat|on-?site|in-?office|located in|based in|time ?zone/i.test(text) && !/remote/i.test(text.slice(0, 0)),
    experience: /\d\+? years|years of|tenure/i.test(text),
    notShown: /not shown|isn.t shown|aren.t shown|doesn.t show|not evident|not demonstrated|not clear/i.test(text)
  };
});
const n = rows.length;
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "n/a");

// Least squares: score ~ b0 + sum(w_d * rating_d), via normal equations.
function ols(X, y) {
  const k = X[0].length + 1, A = Array.from({ length: k }, () => new Array(k + 1).fill(0));
  for (let i = 0; i < X.length; i++) {
    const xi = [1, ...X[i]];
    for (let a = 0; a < k; a++) { for (let b = 0; b < k; b++) A[a][b] += xi[a] * xi[b]; A[a][k] += xi[a] * y[i]; }
  }
  for (let c = 0; c < k; c++) {
    let p = c; for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < k; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let j = c; j <= k; j++) A[r][j] -= f * A[c][j]; }
  }
  const beta = A.map((row, i) => row[k] / row[i]);
  const pred = X.map((x) => beta[0] + x.reduce((s, v, j) => s + v * beta[j + 1], 0));
  const ybar = mean(y), ssr = y.reduce((s, v, i) => s + (v - pred[i]) ** 2, 0), sst = y.reduce((s, v) => s + (v - ybar) ** 2, 0);
  return { beta, r2: 1 - ssr / sst, mae: mean(y.map((v, i) => Math.abs(v - pred[i]))) };
}
const y = rows.map((r) => r.score);
const full = ols(rows.map((r) => r.x), y);
const sumOnly = ols(rows.map((r) => [r.x.reduce((s, v) => s + v, 0)]), y);

const L = [];
L.push(`# How Lenny scores fit`, ``, `Measured from ${n} jobs scored for one resume. Lenny is TrueUp's "Am I a fit?" on Lenny's Jobs.`, ``);
L.push(`## Recommendation tiers`, ``, `| Recommendation | Jobs | Score range | Average |`, `| --- | --- | --- | --- |`);
for (const rec of ["strongly_apply", "apply_tailor", "apply_if_interested", "deprioritize"]) {
  const s = rows.filter((r) => r.rec === rec).map((r) => r.score);
  if (s.length) L.push(`| ${rec} | ${s.length} | ${Math.min(...s)} to ${Math.max(...s)} | ${fmt(mean(s), 1)} |`);
}
L.push(``, `## Scorecard ratings and the score`, ``, `Ratings coded weak 0, moderate 1, strong 2, unclear 0.5.`, ``);
L.push(`| Dimension | Weight (points per step) | Avg score when weak | moderate | strong |`, `| --- | --- | --- | --- | --- |`);
DIMS.forEach((d, j) => {
  const by = (rt) => { const s = rows.filter((r) => r.sc[d] === rt).map((r) => r.score); return s.length ? `${fmt(mean(s), 1)} (n=${s.length})` : "n/a"; };
  L.push(`| ${d} | ${fmt(full.beta[j + 1])} | ${by("weak")} | ${by("moderate")} | ${by("strong")} |`);
});
L.push(``, `Intercept ${fmt(full.beta[0])}. The six ratings explain ${Math.round(full.r2 * 100)}% of the variance in Lenny's score (mean absolute error ${fmt(full.mae)}). Just summing the ratings explains ${Math.round(sumOnly.r2 * 100)}%: each step up on any dimension adds about ${fmt(sumOnly.beta[1])} points.`, ``);

L.push(`## Caps`, ``, `The highest score Lenny gave when a dimension was rated weak:`, ``, `| Dimension rated weak | Jobs | Max score | Avg score |`, `| --- | --- | --- | --- |`);
for (const d of DIMS) {
  const s = rows.filter((r) => r.sc[d] === "weak").map((r) => r.score);
  if (s.length) L.push(`| ${d} | ${s.length} | ${Math.max(...s)} | ${fmt(mean(s), 1)} |`);
}
const weakCount = (r) => DIMS.filter((d) => r.sc[d] === "weak").length;
L.push(``, `| Number of weak dimensions | Jobs | Score range | Average |`, `| --- | --- | --- | --- |`);
for (let k = 0; k <= 6; k++) { const s = rows.filter((r) => weakCount(r) === k).map((r) => r.score); if (s.length) L.push(`| ${k} | ${s.length} | ${Math.min(...s)} to ${Math.max(...s)} | ${fmt(mean(s), 1)} |`); }

L.push(``, `## Eligibility, location, and experience gaps`, ``, `Jobs where Lenny's own summary or gaps mention the issue:`, ``, `| Issue mentioned | Jobs | Avg score | Required-qualifications rated weak |`, `| --- | --- | --- | --- |`);
for (const [label, f] of [["work authorization, visa, export control, clearance", (r) => r.eligibility], ["location or relocation", (r) => r.location], ["years of experience", (r) => r.experience], ["something \"not shown\" in the resume", (r) => r.notShown], ["none of these", (r) => !r.eligibility && !r.location && !r.experience]]) {
  const s = rows.filter(f);
  if (s.length) L.push(`| ${label} | ${s.length} | ${fmt(mean(s.map((r) => r.score)), 1)} | ${s.filter((r) => r.sc.required_qualifications === "weak").length} |`);
}
L.push(``, `## Confidence and context`, ``, `| Lenny confidence | Jobs | Avg score |`, `| --- | --- | --- |`);
for (const c of ["high", "medium", "low"]) { const s = rows.filter((r) => r.conf === c).map((r) => r.score); if (s.length) L.push(`| ${c} | ${s.length} | ${fmt(mean(s), 1)} |`); }
L.push(``, `| Context limitation | Jobs | Avg score |`, `| --- | --- | --- |`);
for (const c of ["none", "profile", "job", "both"]) { const s = rows.filter((r) => r.ctx === c).map((r) => r.score); if (s.length) L.push(`| ${c} | ${s.length} | ${fmt(mean(s), 1)} |`); }

await writeFile(`${args.out}/lenny-patterns.md`, L.join("\n") + "\n");
await writeFile(`${args.out}/lenny-patterns.json`, JSON.stringify({ n, weights: Object.fromEntries(DIMS.map((d, j) => [d, full.beta[j + 1]])), intercept: full.beta[0], r2: full.r2, sumModel: { intercept: sumOnly.beta[0], perStep: sumOnly.beta[1], r2: sumOnly.r2 } }, null, 2));
console.log(L.join("\n"));
