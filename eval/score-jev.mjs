#!/usr/bin/env node
// Score every collected job with Jev, through the same scoring.js the extension
// uses, so the experiment measures what users actually get.
//
//   node eval/score-jev.mjs --records eval/private/lenny --resume eval/private/resume.txt --out eval/private/jev
//
// Reads the key from TYPESAFE_API_KEY, or from ~/.typesafe_api_key. Never prints it.
// Resumable: jobs that already have an output file are skipped.

import { readFile, readdir, writeFile, mkdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { scoreJob, SCORING_CACHE_VERSION } from "../scoring.js";

const { values: args } = parseArgs({
  options: {
    records: { type: "string", default: "eval/private/lenny" },
    resume: { type: "string", default: "eval/private/resume.txt" },
    out: { type: "string", default: "eval/private/jev" },
    concurrency: { type: "string", default: "3" },
    "no-sponsorship": { type: "boolean", default: false },
    limit: { type: "string" }
  }
});

const apiKey = process.env.TYPESAFE_API_KEY ||
  (await readFile(`${homedir()}/.typesafe_api_key`, "utf8").catch(() => "")).trim();
if (!apiKey) {
  console.error("error: no key. Set TYPESAFE_API_KEY or create ~/.typesafe_api_key.");
  process.exit(1);
}
const resume = await readFile(args.resume, "utf8").catch(() => {
  console.error(`error: cannot read resume at ${args.resume}`);
  process.exit(1);
});

await mkdir(args.out, { recursive: true });
const already = new Set((await readdir(args.out)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)));
let files = (await readdir(args.records)).filter((f) => f.endsWith(".json")).sort();
files = files.filter((f) => !already.has(f.slice(0, -5)));
if (args.limit) files = files.slice(0, Number(args.limit));
console.log(`to score: ${files.length} (already scored: ${already.size})`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0, failed = 0;

async function scoreOne(file) {
  let record;
  try {
    record = JSON.parse(await readFile(`${args.records}/${file}`, "utf8"));
  } catch {
    console.log(`SKIP ${file}  unreadable (probably still being written; next run picks it up)`);
    return;
  }
  if (!record.job?.description) {
    console.log(`SKIP ${record.key || file}  no job description in record`);
    return;
  }
  // Exactly what the extension would send: the posting page's own title and
  // company, the extracted description, and the page URL.
  const job = {
    title: record.job.title || record.card.title,
    company: record.job.company || "",
    description: record.job.description,
    pageUrl: record.job.pageUrl
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { result, usage } = await scoreJob({ apiKey, resume, needsSponsorship: !args["no-sponsorship"], job });
      // Write then rename, so a reader never sees a half-written file.
      await writeFile(`${args.out}/${file}.tmp`, JSON.stringify({
        key: record.key, scoredAt: new Date().toISOString(), scoringVersion: SCORING_CACHE_VERSION,
        sentTitle: job.title, sentCompany: job.company, descriptionChars: job.description.length,
        result, usage
      }, null, 2));
      await rename(`${args.out}/${file}.tmp`, `${args.out}/${file}`);
      ok++;
      console.log(`ok   ${record.key}  jev=${result.fit.toFixed(2)}/4  conf=${result.fitConfidence ?? "n/a"}  ${result.elapsedMs}ms  ${result.inputTokens} tok`);
      return;
    } catch (e) {
      const retryable = /Jev API (429|5\d\d)/.test(e.message) || /fetch failed|ECONNRESET|ETIMEDOUT/i.test(e.message);
      if (!retryable || attempt === 3) {
        failed++;
        console.log(`FAIL ${record.key}  ${e.message.slice(0, 160)}`);
        return;
      }
      await sleep(2000 * attempt);
    }
  }
}

const queue = [...files];
await Promise.all(Array.from({ length: Number(args.concurrency) }, async () => {
  while (queue.length) await scoreOne(queue.shift());
}));
console.log(`done: ${ok} scored, ${failed} failed`);
