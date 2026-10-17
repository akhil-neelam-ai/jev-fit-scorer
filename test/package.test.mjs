// Checks the Web Store packager: the zip holds exactly the allowlist, nothing private
// can get on the list, and a file the extension loads can't be left off it.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALLOWLIST, buildZip, checkAllowlist, referencedFiles } from "../scripts/package.mjs";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
}

const current = checkAllowlist();
check("the allowlist passes every check", current.problems.length === 0, current.problems.join(" | "));

const referenced = referencedFiles();
check("everything the extension loads is on the allowlist", [...referenced].every((f) => ALLOWLIST.includes(f)), [...referenced].join(", "));

const missingFile = checkAllowlist(ALLOWLIST.filter((f) => f !== "scoring.js"));
check("leaving a loaded file off the list is caught", missingFile.problems.some((p) => p.includes("loads scoring.js")));

// The worker opens the setup guide with chrome.runtime.getURL, so the walk
// has to follow getURL to find it.
check("the setup guide counts as loaded", referenced.has("welcome.html") && referenced.has("welcome.js"));
const missingGuide = checkAllowlist(ALLOWLIST.filter((f) => f !== "welcome.html"));
check("leaving the setup guide off the list is caught", missingGuide.problems.some((p) => p.includes("loads welcome.html")));

for (const bad of ["eval/private/resume.txt", "eval/private/backups/x.bundle", "model/private/rows/train.jsonl",
  "model/private/resumes/generated/p001.txt", ".env", "site/index.html", "README.md", "cli.js"]) {
  const result = checkAllowlist([...ALLOWLIST, bad]);
  // Pin the reason, not just the path: a file that doesn't exist on disk also starts its message with the path.
  check(`${bad} can never be added to the list`, result.problems.some((p) => p.startsWith(bad) && p.includes("must never ship")));
}

const out = mkdtempSync(join(tmpdir(), "package-test-"));
try {
  const { zipPath, shipped } = buildZip(out);
  check("the zip holds exactly the allowlist", shipped.join() === [...ALLOWLIST].sort().join(), shipped.join(", "));
  check("the zip holds nothing from eval, site, test or scripts", !shipped.some((f) => /^(eval|site|test|scripts)\//.test(f)));
  const listing = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" });
  check("no file name in the zip mentions a resume or private data", !/resume|private/i.test(listing));
} finally {
  rmSync(out, { recursive: true, force: true });
}

if (failed) {
  console.log(`\n${failed} PACKAGE CHECK(S) FAILED`);
  process.exit(1);
}
console.log("\nALL PACKAGE CHECKS PASSED");
