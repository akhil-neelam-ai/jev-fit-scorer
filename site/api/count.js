// Takes usage counts from the Worth Applying? extension and passes them on to
// PostHog. A count is an event name, the extension's version and a random
// install ID. Anything else is turned away, and the sender's IP address is
// never passed on.

const STORE_ORIGIN = "chrome-extension://ppcfjfgonfggaaeoomjakdjkjpjbokbc";

// Every event the extension sends. background.js counts the same names.
export const EVENTS = new Set([
  "install", "guide_intro", "guide_pin", "guide_key", "guide_resume", "guide_try", "guide_done",
  "setup_done", "first_score", "active_day", "popup_open", "score", "score_error"
]);

const VERSION = /^\d+(\.\d+){0,3}$/;
const INSTALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store"
};
const reply = (status) => new Response(null, { status, headers: HEADERS });

export function OPTIONS() {
  return reply(204);
}

export async function POST(request) {
  // Chrome sends the extension's own origin. Every store install shares one
  // ID. A copy loaded from a folder gets another, so its counts stay apart.
  const origin = request.headers.get("origin") || "";
  const source = origin === STORE_ORIGIN ? "store" : origin.startsWith("chrome-extension://") ? "unpacked" : null;
  if (!source) return reply(403);

  const text = await request.text();
  let body = null;
  try {
    if (text.length <= 300) body = JSON.parse(text);
  } catch {}
  const { e, v, id } = body || {};
  if (!EVENTS.has(e) || !VERSION.test(v) || !INSTALL_ID.test(id)) return reply(400);

  const key = process.env.POSTHOG_PROJECT_KEY;
  if (!key) {
    console.error("POSTHOG_PROJECT_KEY isn't set, so the count was dropped.");
    return reply(503);
  }
  const host = process.env.POSTHOG_HOST || "https://us.i.posthog.com";
  try {
    const response = await fetch(`${host}/i/v0/e/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        event: e,
        distinct_id: id,
        properties: {
          version: v,
          source,
          // No person profiles, and no location lookup from an IP address.
          $process_person_profile: false,
          $geoip_disable: true
        }
      }),
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) {
      console.error(`PostHog answered ${response.status}, so the count was dropped.`);
      return reply(502);
    }
  } catch (error) {
    console.error("Couldn't reach PostHog, so the count was dropped.", error);
    return reply(502);
  }
  return reply(204);
}
