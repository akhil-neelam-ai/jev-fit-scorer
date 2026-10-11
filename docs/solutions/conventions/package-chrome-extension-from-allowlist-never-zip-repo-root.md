---
title: Package a Chrome extension from an explicit allowlist, never by zipping the repo root
date: 2026-10-11
category: conventions
module: extension-packaging
problem_type: convention
component: tooling
related_components: ["development_workflow", "testing_framework", "documentation"]
severity: high
applies_when:
  - An extension's manifest.json sits at the repo root, so zipping the folder for a Web Store upload is the natural but unsafe path
  - The working folder holds git-ignored private data (a personal resume and job search) that git protects but a local zip does not
  - Adding, renaming or splitting a runtime file that the manifest, an HTML page or an import now loads
  - The current upload process is a hand-made zip that happens to be clean, with nothing to enforce it next time
symptoms:
  - Code review flagged that the repo had no packaging allowlist, so zipping the repo root would ship site/, eval/ and the git-ignored eval/private/ data
  - An earlier hand-made upload zip was clean by luck but still carried cli.js, README.md, package.json, LICENSE and .gitignore
root_cause: missing_tooling
resolution_type: tooling_addition
tags: ["chrome-extension", "chrome-web-store", "packaging", "allowlist", "pii", "gitignore", "zip", "manifest-v3"]
---

# Package a Chrome extension from an explicit allowlist, never by zipping the repo root

## Context

Worth Applying? loads unpacked from the repo root, where `manifest.json` lives. The same folder can hold `eval/private/`, a git-ignored folder with a personal resume and job search. The local folder also holds other ignored files, such as private notes and a `site/.env.local`.

That makes the risk easy to miss. The repo root is the extension root, so the obvious upload is a zip of the folder. That zip carries everything on disk: `eval/private/`, `.git`, `site/`, `test/`, `scripts/` and any `.env`. The extension loads 13 files.

`.gitignore` does not help here. Only git reads it, and `zip` does not. GitHub can look clean while the local folder, where the upload gets built, is not.

A code review flagged it. The earlier hand-made upload zip was clean only that once. It also carried five files the extension never loads, and it was already stale.

## Guidance

Build every upload with `npm run package`, which runs `scripts/package.mjs`. Never zip the folder by hand. The script stacks guards, and each one covers a gap in the others.

**1. Use an allowlist, not a denylist.** A denylist fails open: each new private path ships until someone remembers to block it. An allowlist fails closed: a new file stays out until someone adds it.

```js
// The only files that ship. When the extension starts loading a new file, add it here.
// The check below fails until you do, so a missing file can't produce a broken upload.
export const ALLOWLIST = [
  "manifest.json",
  "background.js",
  "scoring.js",
  "extract.js",
  // ...9 more, ending at "icon128.png"
];
```

**2. Keep the list complete with a load-graph check.** `referencedFiles()` starts at the manifest and follows what each HTML page, script and stylesheet loads. `checkAllowlist()` compares that set with the list. A loaded file missing from the list stops the build. A listed file that nothing loads only prints a note.

When `popup.js` started importing a newly split `extract.js`, the walk found it with no change to the walker. The walker uses regexes, not a parser. If the extension starts loading files a new way, such as `chrome.runtime.getURL`, teach `referencedFiles()` that pattern in the same change.

**3. Veto paths with a forbidden list.** These patterns refuse a path whatever the allowlist says, so one careless edit can't add a private file.

```js
export const FORBIDDEN = [
  /^eval\//, /^site\//, /^test\//, /^scripts\//, /^dist\//, /^node_modules\//,
  /(^|\/)\./, // dotfiles and dot folders such as .git, .env and .vercel
  /resume/i, /private/i, /\.(md|zip|mjs|txt|log)$/i, /^cli\.js$/, /^package(-lock)?\.json$/
];
```

The forbidden check runs before the "file exists" check, so it fires on a clean clone where `eval/private/` is absent. The patterns are blunt. A future `resume-form.js` would be blocked, so narrow a pattern in a reviewed change if a file like that is legitimate.

**4. Scan shipped code for personal data.** Every allowlisted `.json`, `.js`, `.html` and `.css` file is checked line by line for an email address or a phone number. A hit reports the file and line, never the match. It is a tripwire for the common leaks. It won't catch a name or a street address.

**5. Delete the old zip, build, then read the archive back.**

```js
rmSync(zipPath, { force: true });
execFileSync("zip", ["-X", "-q", zipPath, ...ALLOWLIST], { cwd: ROOT });
const shipped = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" }).split("\n").filter(Boolean).sort();
const expected = [...ALLOWLIST].sort();
if (shipped.join("\n") !== expected.join("\n")) throw new Error(`The zip holds ${shipped.join(", ")}, not the allowlist.`);
```

`zip` appends to an existing archive, and the file name carries the version, so a rerun hits the same path. Deleting first means old entries can't survive. Running from the repo root with bare names puts `manifest.json` at the archive root, where the Web Store expects it. Reading the archive's own entry list checks what was built, not what was meant.

**6. Test that the guards hold.** `test/package.test.mjs` runs in `npm test`. It tries to add private files and asserts the reason, not just the path:

```js
for (const bad of ["eval/private/resume.txt", "eval/private/backups/x.bundle", ".env", "site/index.html", "README.md", "cli.js"]) {
  const result = checkAllowlist([...ALLOWLIST, bad]);
  check(`${bad} can never be added to the list`, result.problems.some((p) => p.startsWith(bad) && p.includes("must never ship")));
}
```

Pin the reason. A file that isn't on disk also gets a message starting with its path, so for those paths an assertion on the path alone kept passing with `FORBIDDEN` emptied. With the reason pinned, all six checks fail when `FORBIDDEN` is emptied.

## Why This Matters

A Web Store upload is a public file. Anyone who installs the extension can unzip it. You can unpublish a listing, but you can't recall copies. A resume in that file stays out there.

Blocking alone is not enough. If the list is too small, the upload breaks, and people then fix the build by zipping the folder again. So the checks name the missing file as well as block leaks. That removes the reason to bypass the script.

Two failures are easy to overlook. A zip without `extract.js` ships a popup whose import fails, which the load-graph check prevents. A real email left in a placeholder string would ship inside an allowed file, which the personal-data scan catches.

This is still a convention. The script guards its own output, and nothing stops someone from uploading a zip made by hand. The rule lives in `CONTRIBUTING.md` and the script's header so people and agents find it.

## When to Apply

- The folder you develop in is the folder you build the upload from.
- A git-ignored folder with personal or secret data sits beside shippable code.
- A store or release upload is a plain archive with no filter of its own. Where a tool has its own allowlist, such as npm's `files` field, use that.
- The extension starts loading a new file. Add it to `ALLOWLIST` and run `node scripts/package.mjs --check`.
- You write a negative test for a guard. Assert the reason, not only the input.

## Examples

**Before.** Zipping the folder:

```
cd jev-fit-scorer
zip -r upload.zip .
```

**After.** `npm run package` writes `dist/worth-applying-1.3.0.zip` with 13 files in 24 KB.

A bad list stops the build before anything is written:

```
Can't package the extension:
  - eval/private/resume.txt must never ship, so it can't be on the allowlist.
```

```
Can't package the extension:
  - The extension loads extract.js, but it isn't on the allowlist.
```

`node scripts/package.mjs --check` runs every check and writes nothing:

```
Allowlist OK: 13 files, nothing private.
```

## Related

- [CONTRIBUTING.md, "Package for the Chrome Web Store"](../../../CONTRIBUTING.md) states the rule for contributors.
- [scripts/package.mjs](../../../scripts/package.mjs) is the packager, and [test/package.test.mjs](../../../test/package.test.mjs) holds its 12 checks.
- [test/manifest.test.mjs](../../../test/manifest.test.mjs) pins the extension's permissions, a related store-prep guard.
