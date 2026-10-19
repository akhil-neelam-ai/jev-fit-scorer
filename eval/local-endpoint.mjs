// Sends the CLI's scoring request to the trained student on this Mac, instead of TypeSafe.
// Start model/serve_student.py, then preload this, and cli.js runs unchanged:
//
//   node --import ./eval/local-endpoint.mjs cli.js --resume resume.txt --job job.txt
//
// The student server listens at http://127.0.0.1:8899/v1/systemone, the same path as Jev's API.
// On an NVIDIA or AMD machine, the Unsloth app can serve the student instead (LOCAL_DECISION_URL).
// These rules keep the resume and the TypeSafe key on this Mac:
// - The key becomes a placeholder, so the real one is never read.
// - The request names the student exactly. The student server answers only to that name, and the
//   Unsloth app resolves it only to a folder on this Mac, so neither forwards it anywhere.
// - Only that one request is allowed, to 127.0.0.1, with no redirects and no proxy.
// - An answer without the local-backend header is refused. That guards the answer, not the request:
//   whatever holds the port gets the resume. Anything that could take the port runs as you, though,
//   and could read the resume file directly.
// Nothing in eval/ ships with the extension.
import { JEV_ENDPOINT } from "../scoring.js";

const LOCAL = process.env.LOCAL_DECISION_URL || "http://127.0.0.1:8899/v1/systemone";
const MODEL = process.env.LOCAL_DECISION_MODEL || "clef-ft:worth-applying-run1";
const PLACEHOLDER = "no-key-required";
const TIMEOUT_MS = 120000;
const WAIT_MS = Number(process.env.LOCAL_DECISION_WAIT_MS) || 300000; // the app answers 503 while a model loads
const RETRY_MS = Number(process.env.LOCAL_DECISION_RETRY_MS) || 5000;

const refuse = (why) => {
  throw new Error(`local-endpoint: ${why}`);
};
// 127.0.0.1 only: on macOS, localhost can mean IPv6, where another process could be listening.
if (!/^http:\/\/127\.0\.0\.1(:\d+)?\//.test(LOCAL)) refuse(`${LOCAL} isn't 127.0.0.1 on this Mac, so nothing was sent.`);
// A fine-tune or local folder name. A default alias such as jev-latest could point at a hosted model.
if (!/^((clef|laya)-ft:[\w.-]+|laya-local)$/.test(MODEL)) refuse(`${MODEL} isn't a local model name, so nothing was sent.`);
if (process.env.NODE_USE_ENV_PROXY || process.execArgv.some((arg) => arg.startsWith("--use-env-proxy"))) {
  refuse("fetch is set to use a proxy, so the request might leave this Mac.");
}
process.env.TYPESAFE_API_KEY = PLACEHOLDER;

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  if (String(url) !== JEV_ENDPOINT) refuse(`refused a request to ${url}. Only the scoring call is allowed.`);
  const send = () => realFetch(LOCAL, {
    ...init,
    body: JSON.stringify({ ...JSON.parse(init.body), model: MODEL }),
    headers: { ...init.headers, Authorization: `Bearer ${PLACEHOLDER}` },
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const deadline = Date.now() + WAIT_MS;
  let res = await send().catch((error) => {
    if (error.cause?.code === "ECONNREFUSED") refuse(`nothing answered at ${LOCAL}. Start model/serve_student.py first.`);
    throw error;
  });
  while (res.status === 503 && Date.now() + RETRY_MS < deadline) {
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    res = await send();
  }
  if (res.ok && !res.headers.get("x-unsloth-decision-backend")) {
    refuse("the answer didn't come from a local checkpoint, so it was refused.");
  }
  return res;
};
