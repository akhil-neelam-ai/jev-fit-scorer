---
title: Route a CLI to a local model by guarding the request before it leaves
date: 2026-10-18
category: architecture-patterns
module: local-student-serving
problem_type: architecture_pattern
component: tooling
related_components: ["development_workflow", "testing_framework"]
severity: high
applies_when:
  - A CLI or extension calls a hosted model API, and a local model should answer the same call with the code unchanged
  - The request carries a resume, an API key or other data that must not leave the machine
  - A local server accepts a default alias such as jev-latest, which can resolve to a remote provider
  - The only guard reads the response, such as a backend header, so it runs after the request is gone
  - A desktop app can't serve the model on this hardware, so a small loopback server stands in
symptoms:
  - Code review found the draft request still named jev-latest, an alias the Unsloth app can route to a hosted decision provider
  - The x-unsloth-decision-backend check read the answer, after the app could already have forwarded the resume
  - The Unsloth app refused the student with "Clef models need an NVIDIA or AMD GPU; this machine has none."
  - The app sends yes-or-no (noul) answers as one number, so the serving check had no probabilities to compare for the visa question
root_cause: missing_validation
resolution_type: code_fix
tags: ["local-inference", "pii", "model-alias", "request-guard", "fetch-preload", "fail-closed", "serving-parity", "unsloth-studio"]
---

# Route a CLI to a local model by guarding the request before it leaves

## Context

`cli.js` scores a resume against a job posting with one POST to TypeSafe's Jev API. `scoring.js` puts `"model": "jev-latest"` in every request body. We trained a small student model on the Mac and wanted it to answer that same call. The resume and the TypeSafe key had to stay on the machine, and nothing in the Chrome Web Store build could change.

The first draft was a Node preload, `eval/local-endpoint.mjs`, run as `node --import ./eval/local-endpoint.mjs cli.js ...`. It replaced `globalThis.fetch` and sent the call to the Unsloth Studio app's `/v1/systemone` on 127.0.0.1. It refused any answer without the `x-unsloth-decision-backend` header, which the app sets only when a local checkpoint answered.

A code review found the hole before the draft was committed. The draft passed the CLI's body through, so it still asked for `jev-latest`. In the app, that name is a default alias for whatever decision model is configured. The app's provider list includes hosted ones, such as TypeSafe's Jev and Liquid AI's `d1:free`. The header check reads the answer. By the time it runs, the app could already have forwarded the resume.

Then the app refused to serve the student at all, with `Clef models need an NVIDIA or AMD GPU; this machine has none.` Only a live run against the app showed that. The tests' fake servers couldn't.

## Guidance

### Name the exact local target, and refuse aliases before sending

The preload overwrites the model field with a name the server can only resolve locally. It refuses anything that looks like an alias at import time, before any request exists.

```js
// eval/local-endpoint.mjs
const MODEL = process.env.LOCAL_DECISION_MODEL || "clef-ft:worth-applying-run1";
// A fine-tune or local folder name. A default alias such as jev-latest could point at a hosted model.
if (!/^((clef|laya)-ft:[\w.-]+|laya-local)$/.test(MODEL)) refuse(`${MODEL} isn't a local model name, so nothing was sent.`);
```

In the Unsloth app, `clef-ft:<folder>` maps to a folder in `~/.unsloth/studio/outputs`. Our own server answers to one name and nothing else.

### Pin the address, the key and the route

```js
// eval/local-endpoint.mjs
// 127.0.0.1 only: on macOS, localhost can mean IPv6, where another process could be listening.
if (!/^http:\/\/127\.0\.0\.1(:\d+)?\//.test(LOCAL)) refuse(`${LOCAL} isn't 127.0.0.1 on this Mac, so nothing was sent.`);
if (process.env.NODE_USE_ENV_PROXY || process.execArgv.some((arg) => arg.startsWith("--use-env-proxy"))) {
  refuse("fetch is set to use a proxy, so the request might leave this Mac.");
}
process.env.TYPESAFE_API_KEY = PLACEHOLDER;
```

The placeholder goes into `TYPESAFE_API_KEY` before `cli.js` reads it. The CLI tries the environment first, so it never opens `~/.typesafe_api_key`.

Inside the fetch wrapper, only the scoring URL passes, and a redirect is an error. A 307 would send the same body somewhere else.

```js
if (String(url) !== JEV_ENDPOINT) refuse(`refused a request to ${url}. Only the scoring call is allowed.`);
const send = () => realFetch(LOCAL, {
  ...init,
  body: JSON.stringify({ ...JSON.parse(init.body), model: MODEL }),
  headers: { ...init.headers, Authorization: `Bearer ${PLACEHOLDER}` },
  redirect: "error",
  signal: AbortSignal.timeout(TIMEOUT_MS)
});
```

### Keep the response check, as a guard on the answer only

The header check still refuses an answer that came from a hosted model. That catches a misconfigured server. It can't stop a request, so it never works alone.

The preload's own comment states the limit. Whatever holds the port gets the resume. Anything that could take the port runs as the user, though, and could read the resume file directly.

### Serve the model yourself when the app can't

`model/serve_student.py` is about 120 lines on the standard library's `http.server`. It loads the student with the loader the grade used, binds 127.0.0.1:8899 and answers only to the exact model name. Its checks run before it reads the body:

```python
# model/serve_student.py, in do_POST()
# Only a local client sends Host 127.0.0.1. Requiring JSON makes a browser ask first, and it gets no answer.
if self.headers.get("Host") != f"127.0.0.1:{self.server.server_port}":
    return self.reply(400, {"error": "Send requests to 127.0.0.1."})
if (self.headers.get("Content-Type") or "").split(";")[0].strip() != "application/json":
    return self.reply(415, {"error": "Send JSON."})
```

The Host check stops a web page that reaches the port through DNS rebinding, since that page sends its own host name. A body must be 1 byte to 2 MB. The local-backend header goes out only on a 200. Errors print only their type, and the request log is off, so no reply or log repeats the resume.

On an NVIDIA or AMD machine, the app could serve the student instead. That route is untested.

### Prove the server answers like the trained model, on generated data first

`model/serve_check.py` sends the run's `preview.json` rows. They hold generated resumes and the answers the model gave in memory right after training. The check fails unless every probability comes back within 0.02, the reload check's tolerance. It also fails without the header, or when nothing was compared. The app sends a yes-or-no answer as one number, so the check converts it first:

```python
# model/serve_check.py
def with_probabilities(answer):
    """The app sends a yes-or-no answer as one number, the chance of yes."""
    if "probabilities" not in answer and isinstance(answer.get("noul"), (int, float)):
        return {**answer, "probabilities": {"true": answer["noul"], "false": 1 - answer["noul"]}}
    return answer
```

Only after it passed did a made-up resume go through the CLI, and then the real one.

## Why This Matters

- A response check feels like a guard, but it reads what came back. By then the request has gone. The draft's only guard would have fired after a hosted provider had the resume.
- A default alias hands the routing choice to someone else's settings. The app's settings, not our code, would have decided where the resume went.
- The served model can drift from the trained one through a wrong folder or a 4-bit copy. Comparing every probability on generated rows catches that before private text goes in. Run 1's served answers matched to 0.0107. The real resume's fit then landed within 0.1 of its graded answer, on the 0 to 4 scale.
- The app's GPU rule only showed up on a live run. Fake servers in tests pin our assumptions about an app, not its behavior.

## When to Apply

- A preload or proxy stands in for a hosted API, and the request carries a resume, a key or other private data.
- The local server accepts aliases or a fallback route that could reach a remote provider.
- The only guard inspects the response.
- A desktop app can't serve the model on this hardware, so a small local server takes its place.

Skip the server half when the app serves the model and accepts an exact local name. Keep the request checks either way.

## Examples

**Proving a refusal came first.** Each refusal test asserts the fake server saw nothing. Sentinel keys sit in `TYPESAFE_API_KEY` and `~/.typesafe_api_key`, and neither may reach it. Look-alike addresses that would connect if allowed, such as `127.1:<port>` and `localhost:<port>`, make "nothing arrived" mean something.

```js
// test/local-endpoint.test.mjs
r = await cli(fake.url, { extra: { LOCAL_DECISION_MODEL: "jev-latest" } });
check("a default alias as the model name is refused", r.code !== 0 && r.err.includes("isn't a local model name") &&
  fake.seen.length === 0, r.err.trim().split("\n")[0]);
```

**Proving nothing is repeated.** A marker in the request must not appear in any reply or log:

```python
# model/tests/test_pipeline.py, StudentServer
self.assertNotIn("RESUME-MARKER-77", json.dumps(body) + printed.getvalue())
```

**Two test traps.** Port 9 is on fetch's blocked "bad port" list, so a "no server" test there fails with `bad port`, never `ECONNREFUSED`. Use a port that just closed. The first proxy test deleted the inherited `NODE_USE_ENV_PROXY` after merging in its own, which removed its own setting, so the refusal never fired. Delete first, then merge.

**Keeping three files in step.** `test_the_server_and_both_clients_agree_on_names_and_ports` checks that the server, the preload and `serve_check.py` agree on the student's name and port.

## Related

- `docs/solutions/conventions/package-chrome-extension-from-allowlist-never-zip-repo-root.md` keeps the same resume out of a public zip. Both refuse before the step that can't be undone, and both test the refusal itself.
- `docs/solutions/architecture-patterns/stamp-teacher-labels-with-a-prompt-hash-and-refuse-to-mix-stamps.md` guards the same pipeline earlier. Both prove the thing in use matches the thing made, and each refusal names the next command, such as "Start model/serve_student.py first."
- `model/LEARNING.md`, lesson 18, is the project-log account. Lesson 14 explains the reload check behind the 0.02 tolerance.
- `docs/plans/2026-10-16-001-feat-train-student-decision-model-plan.md`, unit U6, has the plan and its corrected assumption.
- `eval/local-endpoint.mjs`, `model/serve_student.py`, `model/serve_check.py`, `test/local-endpoint.test.mjs` and `model/tests/test_pipeline.py` hold the code.
