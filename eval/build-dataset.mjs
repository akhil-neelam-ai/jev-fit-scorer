#!/usr/bin/env node
// Assemble every collected job into one local, browsable archive:
//   eval/private/dataset/README.md       index of all jobs, with scores and links
//   eval/private/dataset/dataset.json    everything, machine-readable
//   eval/private/dataset/dataset.csv     one row per job
//   eval/private/dataset/jobs/*.md       one readable file per job
// Personal data (resume-based analyses, job search) stays in eval/private, which git ignores.
import { readFile, readdir, writeFile, mkdir, rm } from "node:fs/promises";
import { displayScore, recommendationFor, toTenPointScale, DIMENSIONS, SCORING_CACHE_VERSION } from "../scoring.js";

const P = "eval/private", OUT = `${P}/dataset`;
await rm(OUT, { recursive: true, force: true });
await mkdir(`${OUT}/jobs`, { recursive: true });
const readJson = async (f) => JSON.parse(await readFile(f, "utf8"));
const tryJson = async (f) => readJson(f).catch(() => null);

const GENERIC = new Set("product products manager management senior sr staff principal lead associate intern internship the and of for with ii iii iv 2026 2027 summer mba group director head technical tech".split(" "));
const distinct = (t) => (t || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !GENERIC.has(w));
function quality(l) {
  const d = (l.job?.description || "").toLowerCase();
  if (!d) return "excluded: saved before descriptions were stored";
  if (d.length < 1000) return `excluded: description only ${d.length} characters`;
  if (/\d[\d,]* jobs? matched|jobs search results/.test(d.slice(0, 800))) return "excluded: description is a job-search listing page";
  const t = distinct(l.card.title);
  if (t.length && !t.some((w) => d.includes(w))) return "excluded: description never mentions the role";
  if (!t.length) {
    const all = (l.card.title || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    if (all.length && all.filter((w) => d.includes(w)).length / all.length < 0.6) return "excluded: description doesn't match the role's title";
  }
  return "clean";
}
const predictions = Object.fromEntries(((await tryJson(`${P}/analysis/predictions.json`)) || []).map((p) => [p.key, p]));

const jobs = [];
for (const f of (await readdir(`${P}/lenny`)).filter((f) => f.endsWith(".json")).sort()) {
  const l = await readJson(`${P}/lenny/${f}`);
  const v4 = await tryJson(`${P}/jev/${f}`), v5 = await tryJson(`${P}/jev-v5/${f}`);
  const r = l.lenny.result;
  const lennyScorecard = Object.fromEntries((r.scorecard || []).map((d) => [d.dimension, { rating: d.rating, note: d.note }]));
  const v5Display = v5 ? displayScore(v5.result) : null;
  jobs.push({
    key: l.key, title: l.card.title, company: l.card.company, group: l.stratum || "default-pm", search: l.query ?? null,
    postingUrl: l.card.url, collectedAt: l.collectedAt, quality: quality(l),
    boardCard: l.card.cardText,
    job: l.job ? { pageTitle: l.job.title, pageCompany: l.job.company, finalUrl: l.job.pageUrl, descriptionSource: l.job.jdSource, extractedChars: l.job.extractedChars, description: l.job.description } : null,
    lenny: {
      fitScore: r.fit_score, confidence: r.confidence, recommendation: r.recommendation, contextLimitation: r.context_limitation,
      summary: r.summary_opinion, scorecard: lennyScorecard, strengths: r.strengths, gaps: r.gaps,
      runMs: l.runMs, atsJobRef: l.lenny.request?.ats_job_ref ?? null, displayedText: l.lenny.dialogText
    },
    jevV5: v5 ? { scoringVersion: v5.scoringVersion, display: v5Display, recommendation: recommendationFor(v5Display), ...v5.result, usage: v5.usage } : null,
    jevV4: v4 ? { scoringVersion: v4.scoringVersion, display: toTenPointScale(v4.result.fit), ...v4.result, usage: v4.usage } : null,
    crossValidated: predictions[l.key] || null
  });
}

await writeFile(`${OUT}/dataset.json`, JSON.stringify({ builtAt: new Date().toISOString(), currentScoringVersion: SCORING_CACHE_VERSION, jobs }, null, 2));

const DIMS = Object.keys(DIMENSIONS);
const cols = ["key", "title", "company", "group", "search", "quality", "descriptionSource", "postingUrl",
  "lennyScore", "lennyConfidence", "lennyRecommendation", "lennyContextLimitation", ...DIMS.map((d) => `lenny_${d}`),
  "jevV5Display", "jevV5Recommendation", "jevV5Raw", "jevV5Confidence", "jevV5MainFactor", ...DIMS.map((d) => `jevV5_${d}`), "jevV5Visa", "jevV5Tokens", "jevV5Ms",
  "jevV4Display", "jevV4Raw", "jevV4Confidence", "jevV4MainFactor", "gapV5", "gapV4", "lennyRunMs"];
const esc = (v) => (/[",\n]/.test(String(v ?? "")) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ""));
const row = (j) => ({
  key: j.key, title: j.title, company: j.company, group: j.group, search: j.search, quality: j.quality, descriptionSource: j.job?.descriptionSource, postingUrl: j.postingUrl,
  lennyScore: j.lenny.fitScore, lennyConfidence: j.lenny.confidence, lennyRecommendation: j.lenny.recommendation, lennyContextLimitation: j.lenny.contextLimitation,
  ...Object.fromEntries(DIMS.map((d) => [`lenny_${d}`, j.lenny.scorecard[d]?.rating])),
  jevV5Display: j.jevV5?.display, jevV5Recommendation: j.jevV5?.recommendation, jevV5Raw: j.jevV5?.fit?.toFixed(3), jevV5Confidence: j.jevV5?.fitConfidence?.toFixed(2), jevV5MainFactor: j.jevV5?.why,
  ...Object.fromEntries(DIMS.map((d) => [`jevV5_${d}`, j.jevV5?.scorecard?.[d]?.label?.toLowerCase()])),
  jevV5Visa: j.jevV5?.visa?.toFixed(2), jevV5Tokens: j.jevV5?.inputTokens, jevV5Ms: j.jevV5?.elapsedMs,
  jevV4Display: j.jevV4?.display, jevV4Raw: j.jevV4?.fit?.toFixed(3), jevV4Confidence: j.jevV4?.fitConfidence?.toFixed(2), jevV4MainFactor: j.jevV4?.why,
  gapV5: j.jevV5 ? j.jevV5.display - j.lenny.fitScore : "", gapV4: j.jevV4 ? j.jevV4.display - j.lenny.fitScore : "", lennyRunMs: j.lenny.runMs
});
await writeFile(`${OUT}/dataset.csv`, [cols.join(","), ...jobs.map((j) => { const r = row(j); return cols.map((c) => esc(r[c])).join(","); })].join("\n") + "\n");

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "n/a");
const pretty = (s) => (s ? s.replace(/_/g, " ") : "n/a");
const pct = (v) => (Number.isFinite(v) ? `${Math.round(v * 100)}%` : "n/a");
const ordered = [...jobs].sort((a, b) => b.lenny.fitScore - a.lenny.fitScore || a.company.localeCompare(b.company));
const fileOf = (j) => `jobs/${j.key}.md`;
for (const j of jobs) {
  const L = j.lenny, v5 = j.jevV5, v4 = j.jevV4;
  const md = [];
  md.push(`# ${j.title}`, ``, `**${j.company}** · group: ${j.group}${j.search ? ` (search "${j.search}")` : ""} · [posting](${j.postingUrl}) · collected ${j.collectedAt?.slice(0, 10) || "n/a"}`, ``);
  md.push(`Data quality: ${j.quality}. Description source: ${j.job?.descriptionSource === "pasted" ? "pasted into Lenny, so both models read the identical text" : j.job ? "Lenny used TrueUp's stored copy, Jev read the posting page" : "none saved"}.`, ``);
  md.push(`## Scores`, ``, `| | Lenny's Jobs | Jev v5 (current) | Jev v4 (before) |`, `| --- | --- | --- | --- |`);
  md.push(`| Fit out of 10 | ${L.fitScore} | ${v5?.display ?? "n/a"} | ${v4?.display ?? "n/a"} |`);
  md.push(`| Recommendation | ${pretty(L.recommendation)} | ${v5?.recommendation ?? "n/a"} | n/a |`);
  md.push(`| Confidence | ${L.confidence} | ${pct(v5?.fitConfidence)} | ${pct(v4?.fitConfidence)} |`);
  md.push(`| Raw Jev fit (0 to 4) | | ${v5?.fit?.toFixed(2) ?? "n/a"} | ${v4?.fit?.toFixed(2) ?? "n/a"} |`);
  md.push(`| Main factor | | ${pretty(v5?.why)} | ${pretty(v4?.why)} |`);
  if (v5?.visa != null) md.push(`| Sponsorship likely | | ${pct(v5.visa)} | ${pct(v4?.visa)} |`);
  md.push(``, `## Scorecard`, ``, `| Dimension | Lenny | Jev v5 | Lenny's note |`, `| --- | --- | --- | --- |`);
  for (const d of DIMS) md.push(`| ${DIMENSIONS[d].label} | ${cap(L.scorecard[d]?.rating)} | ${v5?.scorecard?.[d] ? `${v5.scorecard[d].label} (${v5.scorecard[d].score.toFixed(2)})` : "n/a"} | ${(L.scorecard[d]?.note || "").replace(/\|/g, "/")} |`);
  md.push(``, `## Lenny's analysis`, ``, L.summary || "", ``);
  if (L.contextLimitation && L.contextLimitation !== "none") md.push(`Context limitation flagged: ${L.contextLimitation}.`, ``);
  md.push(`**Strengths**`, ``, ...(L.strengths || []).map((s) => `- ${s}`), ``, `**Gaps**`, ``, ...(L.gaps || []).map((s) => `- ${s}`), ``);
  md.push(`<details><summary>Exactly as Lenny's popup displayed it</summary>`, ``, "```", L.displayedText || "", "```", ``, `</details>`, ``);
  md.push(`## Jev's analysis`, ``);
  if (v5) md.push(`v5 answered nine questions in ${v5.elapsedMs} ms using ${v5.inputTokens} input tokens. Label for its raw level: ${v5.fitLabel || "n/a"}.`, ``);
  if (v4) md.push(`v4 answered three questions in ${v4.elapsedMs} ms using ${v4.inputTokens} input tokens. Label for its raw level: ${v4.fitLabel || "n/a"}.`, ``);
  if (j.crossValidated) md.push(`Cross-validated display scores for this job (each from a model that never saw it): ${Object.entries(j.crossValidated).filter(([k]) => /^[A-G]2?$/.test(k)).map(([k, v]) => `${k}=${v}`).join(", ")}.`, ``);
  md.push(`## Job description`, ``, j.job ? `Read from ${j.job.finalUrl} (${j.job.extractedChars} characters extracted${j.job.descriptionSource === "pasted" ? ", first 20,000 pasted into Lenny" : ""}).` : "Not saved.", ``);
  if (j.job) md.push("```text", j.job.description, "```");
  await writeFile(`${OUT}/${fileOf(j)}`, md.join("\n") + "\n");
}

const clean = jobs.filter((j) => j.quality === "clean");
const idx = [];
idx.push(`# Jev vs Lenny's Jobs: the 100-job dataset`, ``);
idx.push(`${jobs.length} jobs from Lenny's Jobs, collected on ${jobs[0]?.collectedAt?.slice(0, 10)}. ${clean.length} pass the data-quality check. Each job has Lenny's full "Am I a fit?" analysis, Jev's analysis under the old (v4) and current (v5) scoring, and the job description both were scored on.`, ``);
idx.push(`Everything here is private: the analyses are about one person's resume and job search. This folder is git-ignored.`, ``);
idx.push(`## Files`, ``, `| File | What it holds |`, `| --- | --- |`);
idx.push(`| \`jobs/*.md\` | One readable file per job: scores side by side, both scorecards, Lenny's summary, strengths, gaps, and raw popup text, Jev's answers, and the full job description |`);
idx.push(`| \`dataset.json\` | Everything above, machine-readable |`);
idx.push(`| \`dataset.csv\` | One row per job, for a spreadsheet |`);
idx.push(`| \`../analysis/lenny-patterns.md\` | How Lenny turns its scorecard into a score |`);
idx.push(`| \`../analysis/version-comparison.md\` | Cross-validated comparison of seven ways to display Jev's score |`);
idx.push(`| \`../analysis/report-v4.md\`, \`report-v5.md\` | Agreement reports for each version |`);
idx.push(`| \`../resume.txt\` | The resume both models scored against |`);
idx.push(`| \`../lenny/\`, \`../jev/\`, \`../jev-v5/\` | Raw collected records |`);
idx.push(`| \`../runs.jsonl\`, \`../skipped.jsonl\` | Every collection attempt and skip, with reasons |`, ``);
idx.push(`## How it was collected`, ``);
idx.push(`A script drove Lenny's Jobs in a logged-in browser, one job at a time at human pace. For each job it opened the company's posting and extracted the description with the extension's own code. Then it clicked "Am I a fit?" and saved Lenny's full answer. When TrueUp had no stored description, the script pasted ours, so both models read identical text. Jobs were drawn from six groups to cover the whole scale: the default product feed, entry and APM roles, internships, new-grad roles, roles in the candidate's domains, and clear mismatches.`, ``);
idx.push(`## All jobs`, ``, `Sorted by Lenny's score. Gap is Jev v5 minus Lenny.`, ``, `| Job | Company | Group | Lenny | Jev v5 | Jev v4 | Gap | Quality |`, `| --- | --- | --- | --- | --- | --- | --- | --- |`);
for (const j of ordered) idx.push(`| [${j.title.replace(/\|/g, "/")}](${fileOf(j)}) | ${j.company} | ${j.group} | ${j.lenny.fitScore} | ${j.jevV5?.display ?? "n/a"} | ${j.jevV4?.display ?? "n/a"} | ${j.jevV5 ? j.jevV5.display - j.lenny.fitScore : "n/a"} | ${j.quality === "clean" ? "clean" : "excluded"} |`);
await writeFile(`${OUT}/README.md`, idx.join("\n") + "\n");
console.log(`dataset: ${jobs.length} jobs (${clean.length} clean) -> ${OUT}`);
