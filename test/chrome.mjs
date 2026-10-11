// Shared by the browser-backed tests: serves pages from a local port, and
// starts headless Chrome for Testing with an empty profile to drive one page
// over the DevTools protocol. Needs Node 22 or newer for the global WebSocket.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Serves route(pathname) over HTTP on a free local port. route returns
// { type, body }, or null for a 404.
export async function serve(route) {
  const server = createServer((request, response) => {
    const found = route(decodeURIComponent(new URL(request.url, "http://localhost").pathname));
    if (!found) return response.writeHead(404).end();
    response.writeHead(200, { "content-type": found.type }).end(found.body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

// Starts Chrome and returns its first page. errors collects what the page
// throws or logs as an error.
export async function openChrome(bin) {
  if (!bin) throw new Error("Set CHROME_BIN to a Chrome for Testing binary.");
  const profile = mkdtempSync(join(tmpdir(), "jev-chrome-"));
  const chrome = spawn(bin, [
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--headless=new", "--no-first-run", "--no-default-browser-check",
    // Keep test pages off the network: every host but this machine fails to resolve.
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    "about:blank"
  ], { stdio: "ignore" });
  const quit = async () => {
    chrome.kill("SIGKILL");
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
  };

  try {
    // Chrome picks a free port and writes it to DevToolsActivePort.
    const portFile = join(profile, "DevToolsActivePort");
    let target = null;
    for (let i = 0; i < 60 && !target; i++) {
      await sleep(250);
      if (!existsSync(portFile)) continue;
      const port = readFileSync(portFile, "utf8").split("\n")[0];
      try {
        target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page");
      } catch {}
    }
    if (!target) throw new Error("Chrome did not start. CHROME_BIN must be Chromium or Chrome for Testing.");

    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let nextId = 1;
    const pending = new Map();
    const listeners = new Set();
    const errors = [];
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
      if (message.method === "Runtime.exceptionThrown") {
        errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      }
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
        errors.push(message.params.args.map((a) => a.value ?? a.description).join(" "));
      }
      for (const listener of listeners) listener(message);
    };
    const send = (method, params = {}) => new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });
    const nextEvent = (method) => new Promise((resolve) => {
      const listener = (message) => {
        if (message.method !== method) return;
        listeners.delete(listener);
        resolve(message.params);
      };
      listeners.add(listener);
    });

    // Returns the expression's value in the page, awaiting a promise. Throws
    // what the page throws.
    const evaluate = async (expression) => {
      const { result } = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result?.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      }
      return result?.result?.value;
    };
    // Loads a URL and waits for its load event.
    const goto = async (url) => {
      const loaded = nextEvent("Page.loadEventFired");
      await send("Page.navigate", { url });
      await loaded;
    };
    // Polls the expression until it's truthy or timeoutMs passes, and
    // returns its last value.
    const waitFor = async (expression, timeoutMs = 5000) => {
      const end = Date.now() + timeoutMs;
      let value;
      while (Date.now() < end) {
        value = await evaluate(expression).catch(() => undefined);
        if (value) break;
        await sleep(50);
      }
      return value;
    };

    await send("Page.enable");
    await send("Runtime.enable");
    return {
      send, evaluate, goto, waitFor, errors,
      close: async () => {
        socket.close();
        await quit();
      }
    };
  } catch (error) {
    await quit();
    throw error;
  }
}
