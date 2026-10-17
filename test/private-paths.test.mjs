// Fails if private data could reach this public repo: a real resume, the
// test records and the model's training data live in folders git must ignore.
// Run: node test/private-paths.test.mjs
import { execFileSync } from "node:child_process";

const git = (...args) => {
  try {
    return { ok: true, out: execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }) };
  } catch (error) {
    return { ok: false, out: String(error.stdout || "") };
  }
};

let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!cond) failures++;
};

// Nothing under the private folders is tracked or staged. A git failure counts as a failure, not a pass.
const tracked = git("ls-files", "--", "eval/private", "model/private");
const trackedFiles = tracked.out.trim();
check("no file under eval/private or model/private is tracked", tracked.ok && trackedFiles === "",
  tracked.ok ? trackedFiles.split("\n").slice(0, 3).join(", ") : "git ls-files failed");

// New files dropped there stay ignored, by a rule in the repo's own .gitignore. A rule in a
// global excludes file or .git/info/exclude would hide a missing line from this test only.
for (const path of ["eval/private/x", "model/private/x", "model/.venv-train/x", "model/.venv/x"]) {
  const rule = git("check-ignore", "-v", path);
  const source = rule.out.split(":")[0];
  check(`${path} is ignored by the repo's .gitignore`, rule.ok && /^([\w.-]+\/)*\.gitignore$/.test(source), rule.out.trim());
}

console.log(failures ? `\n${failures} PRIVATE PATH CHECK(S) FAILED` : "\nALL PRIVATE PATH CHECKS PASSED");
process.exit(failures ? 1 : 0);
