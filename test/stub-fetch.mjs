// Preloaded by test/cli.test.mjs with `node --import`, so cli.js never reaches
// the network. Replaces fetch with a fake Jev that answers from the
// STUB_JEV_REPLY environment variable, keeping only the questions it was
// asked, like the real API. Appends each request to the STUB_FETCH_LOG file.
import { appendFileSync } from "node:fs";

globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  appendFileSync(process.env.STUB_FETCH_LOG, JSON.stringify({ url, auth: init.headers.Authorization, body }) + "\n");
  const reply = JSON.parse(process.env.STUB_JEV_REPLY);
  reply.answers = Object.fromEntries(Object.entries(reply.answers).filter(([question]) => question in body.questions));
  return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
};
