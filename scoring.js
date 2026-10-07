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
export const SCORING_CACHE_VERSION = 4;

// TypeSafe's published input price. Jev returns no output tokens.
export const COST_PER_MTOK = 0.042;

// Jev's native rubric. Index is the score; the text is what each level means.
export const FIT_CRITERIA = [
  "No meaningful match — skip",
  "Weak match",
  "Moderate match — investigate",
  "Strong match — apply soon",
  "Exceptional match — apply now"
];

export const WHY_CRITERIA = {
  role_match: "The role's core work matches (or mismatches) the candidate's skills and experience",
  seniority_scope: "The role's seniority, ownership, or leadership scope is the strongest match or gap",
  technical_domain: "The required technical or industry domain background is the strongest match or gap",
  required_qualifications: "A stated qualification or hard eligibility condition is the strongest match or gap",
  operating_environment: "The required customer, scale, or operating environment is the strongest match or gap"
};

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
        "Score how good a fit this job is for the candidate described in the resume, using only " +
        "the resume and supplied job description. Assess: (1) role level and scope, (2) functional " +
        "product experience, (3) technical or domain background, (4) required qualifications and " +
        "hard eligibility constraints, and (5) evidence of comparable users, scale, or operating " +
        "environment. Treat explicit requirements as more important than adjacent experience. " +
        "Do not infer experience or eligibility that is not shown. A 0 means no meaningful match; " +
        "1 means major gaps or a substantial stretch; 2 means some credible overlap but important " +
        "gaps; 3 means a strong match; 4 means an exceptional match.",
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

  return {
    fit: fit.score,
    fitConfidence: typeof fit.confidence === "number" ? fit.confidence : null,
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

// Jev's rubric is 0–4. Lenny's board shows 1–10. Convert for display only; the
// stored score always stays on Jev's native scale.
export function toTenPointScale(fit) {
  return Math.round(Math.max(0, Math.min(4, fit)) * 2.5);
}

export function estimateCost(inputTokens) {
  return (Number(inputTokens) || 0) / 1e6 * COST_PER_MTOK;
}
