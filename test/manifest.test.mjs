// Pins the extension's permissions, so a broad one can't slip back in. Each
// one shows up as a warning when someone installs the extension.
// Run: node test/manifest.test.mjs
import { readFileSync } from "node:fs";
import { JEV_ENDPOINT } from "../scoring.js";

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));

let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!cond) failures++;
};

// activeTab and scripting read the open tab after a click. storage keeps the
// settings and the score cache.
check("permissions are activeTab, scripting and storage",
  JSON.stringify(manifest.permissions) === JSON.stringify(["activeTab", "scripting", "storage"]), JSON.stringify(manifest.permissions));
// The worker calls one host: the API scoring.js sends every score to.
const apiHost = `${new URL(JEV_ENDPOINT).origin}/*`;
check(`host_permissions is only ${apiHost}`,
  JSON.stringify(manifest.host_permissions) === JSON.stringify([apiHost]), JSON.stringify(manifest.host_permissions));
check("no optional permissions or content scripts",
  !manifest.optional_permissions && !manifest.optional_host_permissions && !manifest.content_scripts);

console.log(`\n${failures === 0 ? "ALL MANIFEST CHECKS PASSED" : failures + " FAILURE(S)"}`);
process.exit(failures ? 1 : 0);
