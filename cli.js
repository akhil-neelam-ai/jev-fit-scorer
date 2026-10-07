#!/usr/bin/env node
// Score one job description against your resume from the terminal.
// Uses the same scoring.js the Chrome extension uses, so scores match.
//
//   export TYPESAFE_API_KEY=...            # never pass the key as a flag
//   node cli.js --resume resume.txt --job job.txt
//   pbpaste | node cli.js --resume resume.txt --job -

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  FIT_CRITERIA,
  WHY_CRITERIA,
  estimateCost,
  scoreJob,
  toTenPointScale
} from "./scoring.js";

const HELP = `Usage: node cli.js --resume <file> --job <file|-> [options]

Scores how well a job fits your resume with TypeSafe's Jev model.
Reads your API key from the TYPESAFE_API_KEY environment variable.

Options:
  --resume <file>     Plain-text resume (required)
  --job <file|->      Job description text, or - to read stdin (required)
  --title <text>      Job title (default: first line of the description)
  --company <text>    Company name
  --no-sponsorship    Skip the US visa sponsorship question
  --json              Print machine-readable JSON
  -h, --help          Show this help`;

const WHY_LABELS = {
  role_match: "role match",
  seniority_scope: "seniority or scope",
  technical_domain: "technical or domain background",
  required_qualifications: "required qualifications",
  operating_environment: "operating environment"
};

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

async function main() {
  let args;
  try {
    ({ values: args } = parseArgs({
      options: {
        resume: { type: "string" },
        job: { type: "string" },
        title: { type: "string" },
        company: { type: "string" },
        "no-sponsorship": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false }
      }
    }));
  } catch (e) {
    fail(`${e.message}\n\n${HELP}`);
  }

  if (args.help) {
    console.log(HELP);
    return;
  }
  if (!args.resume || !args.job) fail(`--resume and --job are required.\n\n${HELP}`);

  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) fail("set TYPESAFE_API_KEY in your environment (get a key at console.typesafe.ai).");

  const resume = await readFile(args.resume, "utf8").catch(() => fail(`cannot read resume file: ${args.resume}`));
  const description = (args.job === "-"
    ? await readStdin()
    : await readFile(args.job, "utf8").catch(() => fail(`cannot read job file: ${args.job}`))
  ).trim();
  if (description.length < 100) fail("the job description is too short to score (under 100 characters).");

  const firstLine = description.split("\n").find((line) => line.trim()) || "";
  const job = {
    title: (args.title || firstLine).trim().slice(0, 120),
    company: (args.company || "").trim(),
    description: description.slice(0, 60000)
  };

  const { result } = await scoreJob({
    apiKey,
    resume,
    needsSponsorship: !args["no-sponsorship"],
    job
  }).catch((e) => fail(e.message));

  const output = {
    title: job.title,
    company: job.company,
    fitOutOf10: toTenPointScale(result.fit),
    ...result,
    estimatedCostUsd: estimateCost(result.inputTokens)
  };

  if (args.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  const confidence = result.fitConfidence == null ? "n/a" : `${Math.round(result.fitConfidence * 100)}%`;
  const label = result.fitLabel || FIT_CRITERIA[Math.round(result.fit)] || "";
  console.log(`${job.title}${job.company ? " at " + job.company : ""}`);
  console.log(`  Fit          ${output.fitOutOf10}/10  ${label}`);
  console.log(`               Jev ${result.fit.toFixed(2)} / 4, confidence ${confidence}`);
  if (result.why) console.log(`  Main factor  ${WHY_LABELS[result.why] || result.why}`);
  if (result.visa != null) console.log(`  Sponsorship  ${Math.round(result.visa * 100)}% likely`);
  console.log(
    `  Cost         ${result.inputTokens.toLocaleString("en-US")} input tokens, ` +
      `$${output.estimatedCostUsd.toFixed(5)}, ${result.elapsedMs} ms`
  );
}

// WHY_CRITERIA is imported so a renamed choice fails loudly here instead of
// printing a raw key: every label must map to a choice Jev can return.
for (const key of Object.keys(WHY_LABELS)) {
  if (!(key in WHY_CRITERIA)) fail(`WHY_LABELS has "${key}" but scoring.js does not.`);
}

main();
