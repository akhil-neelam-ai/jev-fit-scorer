/* Jev job-fit scoring — the portable core.
 *
 * Dependency-free ES module. No Chrome APIs, no Node APIs: it runs in a
 * service worker, in Node 18+, or in a page. The Chrome extension, the CLI,
 * and the eval harness all score through this file, so a prompt change here
 * changes every surface at once.
 *
 * The contract with TypeSafe's Jev model: one POST carries the candidate and
 * the job as `state`, plus independent `questions`. Jev answers them in
 * parallel with typed, calibrated values and generates no prose.
 */

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";

// Bump when anything below changes the meaning of a cached score. The version
// is part of the cache key, so old entries fall out instead of going stale.
export const SCORING_CACHE_VERSION = 5;

// TypeSafe's published input price. Jev returns no output tokens.
export const COST_PER_MTOK = 0.042;

// Version 5 of the rubric comes from measuring Lenny's Jobs "Am I a fit?" on
// 101 jobs (eval/analyze-lenny.mjs). Its six-part scorecard explained 81% of
// its score. Required qualifications and the core function carried most of
// the weight, industry domain almost none, and eligibility issues such as work
// authorization were treated as caveats, not as gaps. The levels below follow
// Lenny's recommendation tiers.
export const FIT_CRITERIA = [
  "No match — deprioritize",
  "Weak match — deprioritize",
  "Moderate match — apply if interested",
  "Strong match — apply and tailor",
  "Exceptional match — apply now"
];

// The same six dimensions Lenny's scorecard uses, most important first.
export const DIMENSIONS = {
  required_qualifications: {
    label: "Required qualifications",
    instructions:
      "Rate how much of the job's explicitly required experience, skills, years, and degrees the resume shows. " +
      "Ignore work authorization, visa sponsorship, citizenship, export control, location, relocation, and start date. " +
      "Strong: nearly all required qualifications are shown. Moderate: some are shown. Weak: most are not shown."
  },
  function: {
    label: "Core work",
    instructions:
      "Rate how directly the resume shows the candidate doing the core work this role does day to day. " +
      "Strong: they have done this kind of work. Moderate: related or partial experience. Weak: a different kind of work."
  },
  role_level: {
    label: "Role level",
    instructions:
      "Rate how well the scope, ownership, and seniority shown in the resume match the level this role requires. " +
      "Strong: the same or higher level is shown. Moderate: somewhat below, or adjacent. Weak: clearly below the role's level."
  },
  customer_type: {
    label: "Customer type",
    instructions:
      "Rate how well the users or customers the candidate has served match this role's users or customers " +
      "(for example consumers, developers, enterprises, internal teams, or the public sector). " +
      "Strong: the same kind. Moderate: a related kind. Weak: a different kind."
  },
  company_stage: {
    label: "Company stage",
    instructions:
      "Rate how well the companies and environments in the resume match this employer's stage and operating environment " +
      "(for example early startup, growth company, large enterprise, or government). " +
      "Strong: the same kind. Moderate: a related kind. Weak: a very different kind."
  },
  domain: {
    label: "Domain",
    instructions:
      "Rate how well the candidate's industry or technical domain matches this role's domain. " +
      "Strong: the same domain. Moderate: an adjacent domain. Weak: an unrelated domain."
  }
};
const DIMENSION_LEVELS = ["Weak", "Moderate", "Strong"];

export const WHY_CRITERIA = Object.fromEntries(
  Object.entries(DIMENSIONS).map(([key, d]) => [key, `${d.label} is the strongest match or gap`])
);

const JOB_FIELDS = [
  "title",
  "company",
  "location",
  "tagline",
  "tags",
  "salary",
  "posted",
  "meta",
  "description",
  "pageUrl"
];

// djb2 — cheap stable hash for cache keys.
export function hashKey(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  }
  return "h" + h.toString(36);
}

function normalizeJob(job) {
  const out = {};
  for (const field of JOB_FIELDS) out[field] = job?.[field] || "";
  return out;
}

// A score is only valid for the exact candidate, job content, and scoring
// options used to produce it. Field order here is part of the key: changing it
// silently invalidates every cached score, so leave it alone.
export function cacheKeyFor({ resume, needsSponsorship, job }) {
  return hashKey(
    JSON.stringify({
      version: SCORING_CACHE_VERSION,
      model: JEV_MODEL,
      resume: (resume || "").trim(),
      needsSponsorship,
      job: normalizeJob(job)
    })
  );
}

export function buildState({ resume, job }) {
  const lines = ["CANDIDATE RESUME:", (resume || "").trim(), "", "JOB:"];
  lines.push(`${job.title} at ${job.company}${job.location ? " — " + job.location : ""}`);
  if (job.tagline) lines.push(job.tagline);
  if (job.tags) lines.push("Skills/tags: " + job.tags);
  if (job.salary) lines.push("Salary: " + job.salary);
  if (job.meta) lines.push("Company info: " + job.meta);
  if (job.posted) lines.push("Posted: " + job.posted);
  if (job.pageUrl) lines.push("Source: " + job.pageUrl);
  if (job.description) lines.push("FULL JOB DESCRIPTION:\n" + job.description);
  return lines.join("\n");
}

export function buildQuestions({ needsSponsorship }) {
  const questions = {
    fit: {
      type: "score",
      instructions:
        "Score how well this candidate fits this job, using only the resume and the job description. " +
        "Weigh six things, most important first: (1) the job's explicitly required qualifications, " +
        "(2) whether the candidate has done this role's core work, (3) whether their scope and seniority " +
        "match the role's level, (4) whether they have served the same kind of users or customers, " +
        "(5) whether they have worked in a similar company stage and environment, and (6) industry domain, " +
        "which matters least because adjacent domains transfer. Lower the score for required experience, " +
        "skills, or years that the resume does not show. Do not lower it for work authorization, visa " +
        "sponsorship, citizenship, export control, location, relocation, or start date unless the resume " +
        "directly conflicts with the requirement: treat those as caveats the candidate can resolve. " +
        "0: the core work does not match, or several required qualifications are clearly missing. " +
        "1: some related work, but most core requirements or the seniority are not shown. " +
        "2: credible overlap on the core work, with some required qualifications not shown. " +
        "3: the core work and most required qualifications are shown, with gaps a tailored resume can address. " +
        "4: the core work, the level, and the required qualifications are all shown.",
      criteria: FIT_CRITERIA
    },
    // Jev answers each question independently, so this is phrased to stand on
    // its own rather than as an explanation of the fit score above.
    why: {
      type: "choice",
      instructions:
        "Which is the single strongest factor, positive or negative, in the fit between the candidate and this job?",
      criteria: WHY_CRITERIA
    }
  };
  // A scorecard in the same call, one question per dimension, so every score
  // comes with the same breakdown Lenny's analysis shows.
  for (const [key, d] of Object.entries(DIMENSIONS)) {
    questions[`dim_${key}`] = { type: "score", instructions: d.instructions, criteria: DIMENSION_LEVELS };
  }
  if (needsSponsorship) {
    questions.visa = {
      type: "noul",
      instructions:
        "It is plausible the employer sponsors US work visas (or the role is open to candidates " +
        "who need sponsorship). Estimate the probability this job is sponsorship-friendly based on " +
        "explicit language in the job description and employer context."
    };
  }
  return questions;
}

export async function callJev({ state, questions, apiKey, fetchImpl = fetch }) {
  const res = await fetchImpl(JEV_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + apiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ state, model: JEV_MODEL, questions })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Jev API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// Turn a raw Jev response into the shape every surface renders. Throws when the
// fit score is unusable, because caching a malformed score would make the error
// permanent.
export function parseJevResponse(data, { elapsedMs = null } = {}) {
  const fit = data.answers?.fit || {};
  const why = data.answers?.why || {};
  const visa = data.answers?.visa || {};
  const usage = data.usage || {};

  if (!Number.isFinite(fit.score) || fit.score < 0 || fit.score > FIT_CRITERIA.length - 1) {
    throw new Error("Jev returned an invalid fit score.");
  }

  const scorecard = {};
  for (const key of Object.keys(DIMENSIONS)) {
    const a = data.answers?.[`dim_${key}`];
    if (a && Number.isFinite(a.score)) {
      scorecard[key] = {
        score: a.score,
        label: DIMENSION_LEVELS[Math.max(0, Math.min(2, Math.round(a.score)))],
        confidence: typeof a.confidence === "number" ? a.confidence : null
      };
    }
  }

  return {
    fit: fit.score,
    fitConfidence: typeof fit.confidence === "number" ? fit.confidence : null,
    scorecard,
    // Score values are probability-weighted and commonly fractional. Legends
    // are keyed by whole rubric levels, so show the nearest level's label.
    fitLabel: fit.legend ? String(fit.legend[Math.round(fit.score)] || "") : "",
    why: why.choice || "",
    visa: typeof visa.noul === "number" ? visa.noul : null,
    inputTokens: Number(usage.input_tokens) || 0,
    elapsedMs,
    ts: Date.now()
  };
}

// Score one job. No caching, no queueing: callers own those.
export async function scoreJob({ apiKey, resume, needsSponsorship, job, fetchImpl }) {
  if (!apiKey) throw new Error("No API key set — open the extension options to add it.");
  if (!(resume || "").trim()) throw new Error("No resume saved — open the extension options to paste it.");

  const state = buildState({ resume, job });
  const questions = buildQuestions({ needsSponsorship });
  const startedAt = performance.now();
  const data = await callJev({ state, questions, apiKey, fetchImpl });
  const elapsedMs = Math.round(performance.now() - startedAt);
  const usage = data.usage || {};
  try {
    return { result: parseJevResponse(data, { elapsedMs }), usage };
  } catch (e) {
    // The call succeeded and was billed even though the answer is unusable.
    // Attach usage so callers can still count the tokens.
    e.usage = usage;
    throw e;
  }
}

// ---------- Display: Jev's answers as a 1-10 score comparable to Lenny's ----------
//
// Fit on 101 jobs that Lenny's "Am I a fit?" also scored (eval/compare-versions.mjs).
// Cross-validated mean gap to Lenny: 0.59 points, against 1.60 for the old ×2.5.
// The stored answers always stay on Jev's native scales; only the display maps.

// Monotone map from Jev's raw fit (0-4) to Lenny's scale. Lenny never scored the
// calibration resume above 8, so the last segment (raw 3.31 to 4.0, shown as
// 8 to 10) is an assumption, not measured.
export const CALIBRATION_KNOTS = [
  [0, 2], [0.03, 2], [0.089, 2.45], [0.264, 2.89], [0.36, 3], [0.39, 3], [0.535, 3.9],
  [0.63, 4], [0.8, 4], [0.84, 4.33], [0.903, 4.33], [1.089, 4.71], [1.397, 4.82],
  [1.895, 5.19], [2.18, 6], [2.225, 6.5], [2.482, 6.56], [2.83, 7], [3.1, 7], [3.31, 8], [4, 10]
];

// Points per step on Jev's scorecard (0 weak, 1 moderate, 2 strong). Fit to
// Lenny's scores with weights held non-negative, so a better match on any
// dimension can never lower the score. Domain and customer type add nothing
// beyond the other dimensions, which matches how Lenny weighs them.
export const SCORECARD_WEIGHTS = {
  intercept: 2.687,
  required_qualifications: 0.96,
  role_level: 0.865,
  function: 0.423,
  company_stage: 0.064,
  customer_type: 0,
  domain: 0
};

// Lenny's recommendation tiers by score. These cutoffs reproduce Lenny's own
// recommendation for 73% of jobs and land within one tier for all of them.
export const RECOMMENDATIONS = [
  { min: 8, label: "Strongly apply" },
  { min: 6, label: "Apply and tailor" },
  { min: 4, label: "Apply if interested" },
  { min: 1, label: "Deprioritize" }
];

function interpolate(knots, x) {
  if (x <= knots[0][0]) return knots[0][1];
  for (let i = 1; i < knots.length; i++) {
    if (x <= knots[i][0]) {
      const [x0, y0] = knots[i - 1], [x1, y1] = knots[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0 || 1);
    }
  }
  return knots[knots.length - 1][1];
}

export function calibratedFit(fit) {
  return interpolate(CALIBRATION_KNOTS, Math.max(0, Math.min(4, fit)));
}

// Returns null unless all six dimensions came back, so a partial scorecard
// never skews the score.
export function scorecardEstimate(scorecard) {
  const keys = Object.keys(DIMENSIONS);
  if (!scorecard || !keys.every((k) => Number.isFinite(scorecard[k]?.score))) return null;
  return keys.reduce((sum, k) => sum + SCORECARD_WEIGHTS[k] * scorecard[k].score, SCORECARD_WEIGHTS.intercept);
}

// Unrounded: the average of the calibrated fit and the scorecard estimate.
export function comparableScore(result) {
  const calibrated = calibratedFit(result.fit);
  const estimate = scorecardEstimate(result.scorecard);
  return estimate == null ? calibrated : (calibrated + estimate) / 2;
}

export function displayScore(result) {
  return Math.max(1, Math.min(10, Math.round(comparableScore(result))));
}

export function recommendationFor(score) {
  return RECOMMENDATIONS.find((r) => score >= r.min)?.label || RECOMMENDATIONS[RECOMMENDATIONS.length - 1].label;
}

// The original display, kept for reports on version-4 results: Jev's 0-4
// multiplied by 2.5. It runs about 1.6 points below Lenny.
export function toTenPointScale(fit) {
  return Math.round(Math.max(0, Math.min(4, fit)) * 2.5);
}

export function estimateCost(inputTokens) {
  return (Number(inputTokens) || 0) / 1e6 * COST_PER_MTOK;
}
