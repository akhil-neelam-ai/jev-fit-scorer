// Sends the CLI's scoring request to the student in the Unsloth app on this Mac, instead of TypeSafe.
// Preload it, and cli.js runs unchanged:
//
//   node --import ./eval/local-endpoint.mjs cli.js --resume resume.txt --job job.txt
//
// The app serves models at http://127.0.0.1:8888/v1/systemone, the same path as Jev's API.
// These rules keep the resume and the TypeSafe key on this Mac:
// - The key becomes the placeholder the app accepts for keyless access, so the real one is never read.
// - The request names the student exactly. That name can only mean a folder on this Mac, so the app
//   refuses it before reading the resume unless the student is its configured model.
// - Only that one request is allowed, with no redirects and no proxy.
// - As a second guard, an answer without the app's local-backend header is refused.
// Nothing in eval/ ships with the extension.
import { JEV_ENDPOINT } from "../scoring.js";

const LOCAL = process.env.LOCAL_DECISION_URL || "http://127.0.0.1:8888/v1/systemone";
const MODEL = process.env.LOCAL_DECISION_MODEL || "clef-ft:worth-applying-run1";
const PLACEHOLDER = "no-key-required";
const TIMEOUT_MS = 120000;
const WAIT_MS = Number(process.env.LOCAL_DECISION_WAIT_MS) || 300000; // the app answers 503 while a model loads
const RETRY_MS = Number(process.env.LOCAL_DECISION_RETRY_MS) || 5000;

const refuse = (why) => {
  throw new Error(`local-endpoint: ${why}`);
};
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(LOCAL)) refuse(`${LOCAL} isn't on this Mac, so nothing was sent.`);
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
  let res = await send();
  while (res.status === 503 && Date.now() + RETRY_MS < deadline) {
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    res = await send();
  }
  if (res.ok && !res.headers.get("x-unsloth-decision-backend")) {
    refuse("the answer didn't come from a local checkpoint, so it was refused. Check the app's decision model setting.");
  }
  return res;
};
