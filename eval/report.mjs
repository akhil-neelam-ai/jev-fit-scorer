#!/usr/bin/env node
// Compare Jev against a reference scorer (Lenny's "Am I a fit?") on paired jobs.
//   node eval/report.mjs --lenny eval/private/lenny --jev eval/private/jev --out eval/private
// Writes report.md and pairs.csv. Numbers come with bootstrap 95% intervals,
// because a small sample can make any agreement look good.

import { readFile, readdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { toTenPointScale, estimateCost, displayScore, comparableScore } from "../scoring.js";

const { values: args } = parseArgs({ options: {
  lenny: { type: "string", default: "eval/private/lenny" },
  jev: { type: "string", default: "eval/private/jev" },
  out: { type: "string", default: "eval/private" },
  name: { type: "string", default: "report" }
} });

const readDir = async (dir) => {
  const out = new Map();
  for (const f of (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".json"))) {
    try {
      out.set(f.slice(0, -5), JSON.parse(await readFile(`${dir}/${f}`, "utf8")));
    } catch {
      console.warn(`skipping unreadable ${dir}/${f} (probably still being written)`);
    }
  }
  return out;
};
const lenny = await readDir(args.lenny);
const jev = await readDir(args.jev);

// Data-quality gate. Some posting links land on a talent-network or careers
// page instead of the job. Lenny then scored its own stored copy while Jev
// would score the wrong text, so those pairs are excluded and listed.
const GENERIC = new Set("product products manager management senior sr staff principal lead associate intern internship the and of for with ii iii iv 2026 2027 summer mba group director head technical tech".split(" "));
const distinctTokens = (t) => (t || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !GENERIC.has(w));
function descriptionProblem(l) {
  const d = (l.job?.description || "").toLowerCase();
  if (d.length < 1000) return `description only ${d.length} characters`;
  if (/\d[\d,]* jobs? matched|jobs search results/.test(d.slice(0, 800))) return "description is a job-search listing page";
  const t = distinctTokens(l.card.title);
  if (t.length) {
    if (!t.some((w) => d.includes(w))) return "description never mentions the role";
  } else {
    // Titles made only of common words ("Associate Product Manager Intern")
    // need most of those words present, or a listing page slips through.
    const all = (l.card.title || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    if (all.length && all.filter((w) => d.includes(w)).length / all.length < 0.6) return "description doesn't match the role's title";
  }
  return null;
}
const excluded = [];
const pairs = [];
for (const [key, l] of lenny) {
  const j = jev.get(key);
  if (!j || l.lenny?.result?.fit_score == null) continue;
  const problem = descriptionProblem(l);
  if (problem) { excluded.push({ key, title: l.card.title, company: l.card.company, problem }); continue; }
  const r = l.lenny.result;
  pairs.push({
    key, title: l.card.title, company: l.card.company, jdSource: l.job.jdSource, stratum: l.stratum || "default-pm",
    L: Number(r.fit_score), lConf: r.confidence, lRec: r.recommendation, lSummary: r.summary_opinion || "",
    scorecard: Object.fromEntries((r.scorecard || []).map((d) => [d.dimension, d.rating])),
    // Version-5 results carry a scorecard and use the calibrated display the
    // extension ships. Version-4 results are shown the way v4 showed them.
    J: j.result.fit,
    D: j.result.scorecard && Object.keys(j.result.scorecard).length ? displayScore(j.result) : toTenPointScale(j.result.fit),
    C: j.result.scorecard && Object.keys(j.result.scorecard).length ? comparableScore(j.result) : j.result.fit * 2.5,
    calibrated: Boolean(j.result.scorecard && Object.keys(j.result.scorecard).length),
    jConf: j.result.fitConfidence, jWhy: j.result.why, jTokens: j.result.inputTokens, jMs: j.result.elapsedMs, lMs: l.runMs
  });
}
const n = pairs.length;
if (n === 0) { console.log(`no pairs yet (lenny=${lenny.size}, jev=${jev.size})`); process.exit(0); }

// ---------- stats helpers ----------
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
function ranks(a) {
  const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
  const r = new Array(a.length);
  for (let i = 0; i < idx.length;) {
    let k = i; while (k + 1 < idx.length && idx[k + 1][0] === idx[i][0]) k++;
    for (let m = i; m <= k; m++) r[idx[m][1]] = (i + k) / 2 + 1;
    i = k + 1;
  }
  return r;
}
function pearson(x, y) {
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < x.length; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN;
}
const spearman = (x, y) => pearson(ranks(x), ranks(y));
let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
function bootstrap(fn, B = 2000) {
  if (n < 5) return null;
  const vals = [];
  for (let b = 0; b < B; b++) {
    const s = Array.from({ length: n }, () => pairs[Math.floor(rand() * n)]);
    const v = fn(s); if (Number.isFinite(v)) vals.push(v);
  }
  vals.sort((a, b) => a - b);
  return [vals[Math.floor(0.025 * vals.length)], vals[Math.floor(0.975 * vals.length)]];
}
const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "n/a");
const ci = (c, d = 2) => (c ? ` (95% CI ${fmt(c[0], d)} to ${fmt(c[1], d)})` : "");
const pct = (k, of = n) => `${k}/${of} (${Math.round((100 * k) / of)}%)`;

const biasOf = (s) => mean(s.map((p) => p.D - p.L));
const maeOf = (s) => mean(s.map((p) => Math.abs(p.D - p.L)));
const rhoOf = (s) => spearman(s.map((p) => p.J), s.map((p) => p.L));
const bucket = (x) => (x <= 3 ? "low" : x <= 6 ? "mid" : "high");
const B3 = ["low", "mid", "high"];

// ---------- isotonic calibration (pool adjacent violators) ----------
function fitIsotonic(points) {
  const s = [...points].sort((a, b) => a.x - b.x);
  const blocks = s.map((p) => ({ lo: p.x, hi: p.x, sum: p.y, w: 1 }));
  for (let i = 0; i < blocks.length - 1;) {
    if (blocks[i].sum / blocks[i].w > blocks[i + 1].sum / blocks[i + 1].w) {
      blocks[i] = { lo: blocks[i].lo, hi: blocks[i + 1].hi, sum: blocks[i].sum + blocks[i + 1].sum, w: blocks[i].w + blocks[i + 1].w };
      blocks.splice(i + 1, 1); if (i > 0) i--;
    } else i++;
  }
  return (x) => { let b = blocks[0]; for (const blk of blocks) if (x >= blk.lo) b = blk; return b.sum / b.w; };
}
function cvIsotonicMae(k = 5) {
  if (n < 10) return null;
  const order = pairs.map((p, i) => i).sort((a, b) => pairs[a].key.localeCompare(pairs[b].key));
  let err = 0;
  for (let f = 0; f < k; f++) {
    const test = order.filter((_, i) => i % k === f), train = order.filter((_, i) => i % k !== f);
    const map = fitIsotonic(train.map((i) => ({ x: pairs[i].J, y: pairs[i].L })));
    for (const i of test) err += Math.abs(Math.round(map(pairs[i].J)) - pairs[i].L);
  }
  return err / n;
}

// ---------- compute ----------
const bias = biasOf(pairs), mae = maeOf(pairs), rho = rhoOf(pairs);
const r = pearson(pairs.map((p) => p.C), pairs.map((p) => p.L));
const exact = pairs.filter((p) => p.D === p.L).length;
const within1 = pairs.filter((p) => Math.abs(p.D - p.L) <= 1).length;
const within2 = pairs.filter((p) => Math.abs(p.D - p.L) <= 2).length;
const jevHigher = pairs.filter((p) => p.D > p.L).length, jevLower = pairs.filter((p) => p.D < p.L).length;

const confusion = Object.fromEntries(B3.map((a) => [a, Object.fromEntries(B3.map((b) => [b, 0]))]));
for (const p of pairs) confusion[bucket(p.L)][bucket(p.D)]++;
const po = B3.reduce((s, b) => s + confusion[b][b], 0) / n;
const pe = B3.reduce((s, b) => s + (B3.reduce((t, c) => t + confusion[b][c], 0) / n) * (B3.reduce((t, c) => t + confusion[c][b], 0) / n), 0);
const kappa = pe < 1 ? (po - pe) / (1 - pe) : NaN;

const iso = n >= 10 ? fitIsotonic(pairs.map((p) => ({ x: p.J, y: p.L }))) : null;
const cvMae = cvIsotonicMae();

const groupBy = (f) => { const g = new Map(); for (const p of pairs) { const k = f(p); if (!g.has(k)) g.set(k, []); g.get(k).push(p); } return g; };
const tokens = pairs.reduce((s, p) => s + (p.jTokens || 0), 0);

// ---------- write ----------
const lines = [];
lines.push(`# Jev vs Lenny: fit score comparison`, ``);
const calibratedRun = pairs.some((p) => p.calibrated);
lines.push(`${n} jobs scored by both${excluded.length ? `, after excluding ${excluded.length} with a bad description extract (listed at the end)` : ""}. Lenny's score is TrueUp's "Am I a fit?" result (1 to 10). ${calibratedRun
  ? "Jev's score is shown the way the version-5 extension shows it: a calibrated blend of its fit score and scorecard. That calibration was fit on these same jobs, so agreement here is optimistic. The honest, cross-validated numbers are in analysis/version-comparison.md."
  : "Jev's 0 to 4 score is shown the way the version-4 extension showed it: multiplied by 2.5 and rounded."}`, ``);
lines.push(`## Agreement`, ``);
lines.push(`| Measure | Value |`, `| --- | --- |`);
lines.push(`| Average gap (Jev minus Lenny) | ${fmt(bias)}${ci(bootstrap(biasOf))} |`);
lines.push(`| Mean absolute gap | ${fmt(mae)}${ci(bootstrap(maeOf))} |`);
lines.push(`| Rank agreement (Spearman) | ${fmt(rho)}${ci(bootstrap(rhoOf))} |`);
lines.push(`| Linear correlation (Pearson, unrounded) | ${fmt(r)} |`);
lines.push(`| Exact match | ${pct(exact)} |`);
lines.push(`| Within 1 point | ${pct(within1)} |`);
lines.push(`| Within 2 points | ${pct(within2)} |`);
lines.push(`| Jev higher / lower / same | ${jevHigher} / ${jevLower} / ${exact} |`);
lines.push(`| Low/mid/high bucket agreement (Cohen's kappa) | ${fmt(kappa)} |`, ``);
lines.push(`## Buckets (rows: Lenny, columns: Jev)`, ``, `Low is 1 to 3, mid is 4 to 6, high is 7 to 10.`, ``);
lines.push(`| Lenny \\ Jev | low | mid | high |`, `| --- | --- | --- | --- |`);
for (const a of B3) lines.push(`| ${a} | ${B3.map((b) => confusion[a][b]).join(" | ")} |`);
lines.push(``);
if (iso && !calibratedRun) {
  lines.push(`## Calibration`, ``);
  lines.push(`A monotone map from Jev's raw score to Lenny's scale. Cross-validated mean absolute gap after mapping: ${fmt(cvMae)} (vs ${fmt(mae)} with today's ×2.5).`, ``);
  lines.push(`| Jev raw | Today shows | Calibrated |`, `| --- | --- | --- |`);
  for (const x of [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4]) lines.push(`| ${x.toFixed(1)} | ${toTenPointScale(x)} | ${fmt(iso(x), 1)} |`);
  lines.push(``);
}
lines.push(`## By slice`, ``, `| Slice | n | Avg gap | Mean abs gap |`, `| --- | --- | --- | --- |`);
for (const [label, f] of [["Job group", (p) => p.stratum], ["Description source", (p) => p.jdSource], ["Lenny confidence", (p) => p.lConf], ["Lenny bucket", (p) => bucket(p.L)]]) {
  for (const [k, s] of groupBy(f)) lines.push(`| ${label}: ${k} | ${s.length} | ${fmt(biasOf(s))} | ${fmt(maeOf(s))} |`);
}
lines.push(``, `## Lenny recommendation vs Jev`, ``, `| Lenny recommendation | n | Lenny avg | Jev avg |`, `| --- | --- | --- | --- |`);
for (const [k, s] of [...groupBy((p) => p.lRec)].sort((a, b) => mean(b[1].map((p) => p.L)) - mean(a[1].map((p) => p.L)))) {
  lines.push(`| ${k} | ${s.length} | ${fmt(mean(s.map((p) => p.L)), 1)} | ${fmt(mean(s.map((p) => p.D)), 1)} |`);
}
lines.push(``, `## Biggest disagreements`, ``, `| Job | Lenny | Jev | Jev's main factor | Lenny's summary |`, `| --- | --- | --- | --- | --- |`);
for (const p of [...pairs].sort((a, b) => Math.abs(b.D - b.L) - Math.abs(a.D - a.L)).slice(0, 10)) {
  lines.push(`| ${p.title} at ${p.company} | ${p.L} | ${p.D} | ${p.jWhy} | ${p.lSummary.replace(/\|/g, "/").slice(0, 180)} |`);
}
lines.push(``, `## Cost and speed`, ``);
lines.push(`Jev used ${tokens.toLocaleString("en-US")} input tokens for ${n} jobs, about $${estimateCost(tokens).toFixed(4)} in total. Median Jev call: ${Math.round(median(pairs.map((p) => p.jMs)))} ms. Median Lenny run in the browser, including streaming: ${(median(pairs.map((p) => p.lMs)) / 1000).toFixed(1)} s. These measure different things, so treat them as context, not a race.`);
if (excluded.length) {
  lines.push(``, `## Excluded pairs`, ``, `| Job | Why |`, `| --- | --- |`);
  for (const e of excluded) lines.push(`| ${e.title} at ${e.company} | ${e.problem} |`);
}
await writeFile(`${args.out}/${args.name}.md`, lines.join("\n") + "\n");

const csvCols = ["key", "title", "company", "stratum", "jdSource", "L", "D", "J", "lConf", "jConf", "lRec", "jWhy", "jTokens", "jMs", "lMs"];
const esc = (v) => (/[",\n]/.test(String(v ?? "")) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ""));
await writeFile(`${args.out}/${args.name}-pairs.csv`, [csvCols.join(","), ...pairs.map((p) => csvCols.map((c) => esc(p[c])).join(","))].join("\n") + "\n");
console.log(`pairs=${n}  bias=${fmt(bias)}  MAE=${fmt(mae)}  spearman=${fmt(rho)}  exact=${exact}  within1=${within1}  kappa=${fmt(kappa)}  -> ${args.out}/${args.name}.md`);
