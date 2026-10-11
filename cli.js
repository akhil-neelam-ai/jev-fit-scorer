#!/usr/bin/env node
// Score one job description against your resume from the terminal.
// Uses the same scoring.js the Chrome extension uses, so scores match.
//
//   export TYPESAFE_API_KEY=...   # or put it in ~/.typesafe_api_key; never pass it as a flag
//   node cli.js --resume resume.txt --job job.txt
//   pbpaste | node cli.js --resume resume.txt --job -

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import {
  DIMENSIONS,
  displayScore,
  estimateCost,
  recommendationFor,
  scoreJob,
  visaBand
} from "./scoring.js";

const HELP = `Usage: node cli.js --resume <file> --job <file|-> [options]

Scores how well a job fits your resume with TypeSafe's Jev model.
Reads your API key from TYPESAFE_API_KEY, or from ~/.typesafe_api_key.

Options:
  --resume <file>     Plain-text resume (required)
  --job <file|->      Job description text, or - to read stdin (required)
  --title <text>      Job title (default: first line of the description)
  --company <text>    Company name
  --no-sponsorship    Skip the US visa sponsorship question
  --json              Print machine-readable JSON
  -h, --help          Show this help`;


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

  const apiKey = process.env.TYPESAFE_API_KEY ||
    (await readFile(`${homedir()}/.typesafe_api_key`, "utf8").catch(() => "")).trim();
  if (!apiKey) fail("set TYPESAFE_API_KEY or create ~/.typesafe_api_key (get a key at console.typesafe.ai).");

  const resume = await readFile(args.resume, "utf8").catch(() => fail(`cannot read resume file: ${args.resume}`));
  if (!resume.trim()) fail(`the resume file is empty: ${args.resume}`);
  const description = (args.job === "-"
    ? await readStdin()
    : await readFile(args.job, "utf8").catch(() => fail(`cannot read job file: ${args.job}`))
  ).trim();
  if (description.length < 100) fail("the job description is too short to score (under 100 characters).");

  const firstLine = description.split("\n").find((line) => line.trim()) || "";
  const job = {
    title: (args.title || firstLine).trim().slice(0, 120),
    company: (args.company || "").trim(),
    description
  };

  const { result } = await scoreJob({
    apiKey,
    resume,
    needsSponsorship: !args["no-sponsorship"],
    job
  }).catch((e) => fail(e.message));

  const display = displayScore(result);
  const visa = visaBand(result.visa);
  const output = {
    title: job.title,
    company: job.company,
    display,
    recommendation: recommendationFor(display),
    ...result,
    visaPercent: visa?.percent ?? null,
    visaLabel: visa?.label ?? null,
    estimatedCostUsd: estimateCost(result.inputTokens)
  };

  if (args.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  const confidence = result.fitConfidence == null ? "n/a" : `${Math.round(result.fitConfidence * 100)}%`;
  console.log(`${job.title}${job.company ? " at " + job.company : ""}`);
  console.log(`  Fit          ${display}/10  ${output.recommendation}`);
  console.log(`               Jev raw ${result.fit.toFixed(2)} / 4, confidence ${confidence}`);
  if (result.why) console.log(`  Main factor  ${DIMENSIONS[result.why]?.label.toLowerCase() || result.why}`);
  const rows = Object.entries(DIMENSIONS).filter(([key]) => result.scorecard?.[key]);
  rows.forEach(([key, d], i) => console.log(`  ${i === 0 ? "Scorecard   " : "            "} ${d.label.padEnd(24)} ${result.scorecard[key].label}`));
  if (visa) console.log(`  Sponsorship  ${visa.label} · ${visa.percent}%`);
  console.log(
    `  Cost         ${result.inputTokens.toLocaleString("en-US")} input tokens, ` +
      `$${output.estimatedCostUsd.toFixed(5)}, ${result.elapsedMs} ms`
  );
}

main();
