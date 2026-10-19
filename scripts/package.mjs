// Builds the Chrome Web Store upload from an explicit allowlist. Only the files the
// extension loads ship. Everything else in this folder stays out, especially
// eval/private, which holds a real resume and private job data.
//
// Usage:
//   npm run package                        writes dist/worth-applying-<version>.zip
//   node scripts/package.mjs --check       runs every check and writes nothing
//   OUT_DIR=/tmp/x node scripts/package.mjs   writes the zip somewhere else (the tests do this)
//
// Never zip the folder by hand for an upload. Use this script.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// The only files that ship. When the extension starts loading a new file, add it here.
// The check below fails until you do, so a missing file can't produce a broken upload.
export const ALLOWLIST = [
  "manifest.json",
  "background.js",
  "scoring.js",
  "extract.js",
  "popup.html",
  "popup.js",
  "options.html",
  "options.js",
  "welcome.html",
  "welcome.js",
  "welcome.css",
  "fonts/bricolage-grotesque.css",
  "fonts/bricolage-grotesque.woff2",
  "styles.css",
  "icon16.png",
  "icon32.png",
  "icon48.png",
  "icon128.png"
];

// A second guard: nothing matching these may ship, even if someone adds it to the list above.
export const FORBIDDEN = [
  /^eval\//, /^site\//, /^test\//, /^scripts\//, /^dist\//, /^node_modules\//, /^model\//,
  /(^|\/)\./, // dotfiles and dot folders such as .git, .env and .vercel
  /resume/i, /private/i, /\.(md|zip|mjs|txt|log)$/i, /^cli\.js$/, /^package(-lock)?\.json$/
];

// Text that looks like personal data. Code files should never contain any.
const PERSONAL_DATA = [
  { name: "an email address", pattern: /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/i },
  { name: "a phone number", pattern: /\b\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/ }
];

const isText = (file) => /\.(json|js|html|css)$/.test(file);

// Every file the extension loads: what the manifest names, what each page loads
// or links to, every relative import those scripts make, and every page they
// open with chrome.runtime.getURL.
export function referencedFiles() {
  const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
  const found = new Set(["manifest.json"]);
  const queue = [];
  const add = (path, from = ".") => {
    if (!path || /^(https?:|data:|chrome:|mailto:|#)/.test(path)) return;
    const file = posix.normalize(posix.join(posix.dirname(from), path.replace(/^\//, "")));
    if (!found.has(file)) {
      found.add(file);
      queue.push(file);
    }
  };

  Object.values(manifest.icons || {}).forEach((icon) => add(icon));
  Object.values(manifest.action?.default_icon || {}).forEach((icon) => add(icon));
  [manifest.action?.default_popup, manifest.background?.service_worker, manifest.options_page, manifest.options_ui?.page].forEach((file) => add(file));
  for (const script of manifest.content_scripts || []) [...(script.js || []), ...(script.css || [])].forEach((file) => add(file));
  for (const entry of manifest.web_accessible_resources || []) (entry.resources || []).forEach((file) => add(file));

  while (queue.length) {
    const file = queue.shift();
    const full = join(ROOT, file);
    if (!isText(file) || !existsSync(full)) continue;
    const text = readFileSync(full, "utf8");
    if (file.endsWith(".html")) {
      for (const m of text.matchAll(/<(?:script|img)\b[^>]*\bsrc=["']([^"']+)["']|<(?:link|a)\b[^>]*\bhref=["']([^"']+)["']/g)) add(m[1] || m[2], file);
    }
    if (file.endsWith(".js")) {
      for (const m of text.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) add(m[1], file);
      for (const m of text.matchAll(/\bgetURL\(\s*["']([^"']+)["']\s*\)/g)) add(m[1]);
      for (const m of text.matchAll(/\bfiles\s*:\s*\[([^\]]*)\]/g)) {
        for (const f of m[1].matchAll(/["']([^"']+)["']/g)) add(f[1]);
      }
    }
    if (file.endsWith(".css")) {
      for (const m of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) add(m[1], file);
    }
  }
  return found;
}

// Returns every reason the list can't ship, plus files on the list that nothing loads.
export function checkAllowlist(list = ALLOWLIST) {
  const problems = [];
  for (const file of list) {
    const full = join(ROOT, file);
    if (FORBIDDEN.some((re) => re.test(file))) problems.push(`${file} must never ship, so it can't be on the allowlist.`);
    else if (!existsSync(full) || !statSync(full).isFile()) problems.push(`${file} is on the allowlist but doesn't exist.`);
    else if (isText(file)) {
      const lines = readFileSync(full, "utf8").split("\n");
      for (const { name, pattern } of PERSONAL_DATA) {
        const index = lines.findIndex((line) => pattern.test(line));
        if (index >= 0) problems.push(`${file}:${index + 1} contains what looks like ${name}.`);
      }
    }
  }
  const referenced = referencedFiles();
  for (const file of referenced) {
    if (!list.includes(file)) problems.push(`The extension loads ${file}, but it isn't on the allowlist.`);
  }
  const unused = list.filter((file) => !referenced.has(file));
  return { problems, unused };
}

// Zips exactly the allowlist, then reads the zip back to prove nothing else got in.
export function buildZip(outDir = join(ROOT, "dist")) {
  const { version } = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
  const zipPath = join(outDir, `worth-applying-${version}.zip`);
  mkdirSync(outDir, { recursive: true });
  rmSync(zipPath, { force: true });
  execFileSync("zip", ["-X", "-q", zipPath, ...ALLOWLIST], { cwd: ROOT });
  const shipped = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" }).split("\n").filter(Boolean).sort();
  const expected = [...ALLOWLIST].sort();
  if (shipped.join("\n") !== expected.join("\n")) throw new Error(`The zip holds ${shipped.join(", ")}, not the allowlist.`);
  const blocked = shipped.filter((file) => FORBIDDEN.some((re) => re.test(file)));
  if (blocked.length) throw new Error(`The zip holds files that must never ship: ${blocked.join(", ")}.`);
  return { zipPath, shipped, bytes: statSync(zipPath).size };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { problems, unused } = checkAllowlist();
  if (problems.length) {
    console.error("Can't package the extension:\n" + problems.map((p) => "  - " + p).join("\n"));
    process.exit(1);
  }
  for (const file of unused) console.warn(`Note: ${file} is on the allowlist, but nothing loads it.`);
  if (process.argv.includes("--check")) {
    console.log(`Allowlist OK: ${ALLOWLIST.length} files, nothing private.`);
  } else {
    const { zipPath, shipped, bytes } = buildZip(process.env.OUT_DIR || undefined);
    console.log(`Wrote ${zipPath} (${shipped.length} files, ${Math.round(bytes / 1024)} KB):`);
    for (const file of shipped) console.log("  " + file);
  }
}
