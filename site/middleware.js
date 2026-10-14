// Markdown for agents: a request that asks for text/markdown gets the page's
// markdown copy (index.md or privacy.md). Browsers still get the HTML.
export const config = { matcher: ["/", "/privacy"] };

const MARKDOWN = { "/": "/index.md", "/privacy": "/privacy.md" };

export default function middleware(request) {
  if (!/text\/markdown/i.test(request.headers.get("accept") || "")) return;
  const url = new URL(request.url);
  return new Response(null, { headers: { "x-middleware-rewrite": new URL(MARKDOWN[url.pathname], url).href } });
}
