/*
 * invincible.sh's one piece of code. `curl -fsSL https://invincible.sh | bash` asks for the page itself, so the root
 * answers a command-line fetch (curl, wget) with the installer and a browser with the page; /install is the installer
 * for anyone, as text. The installer is the site's own static file (/install.sh, built from scripts/install.sh), so the
 * Worker holds no copy of it. Every other path never reaches this: Cloudflare serves it from dist/ (wrangler.jsonc).
 */

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

/** What a shell fetches with. A browser, a link preview or a crawler gets the page. */
const SHELL = /^(curl|wget)\//i;

const TEXT = {
  "content-type": "text/plain; charset=utf-8",
  "x-content-type-options": "nosniff",
  "cache-control": "public, max-age=300",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const shell = SHELL.test(request.headers.get("user-agent") ?? "");
    if (url.pathname !== "/install" && !shell) return vary(await env.ASSETS.fetch(request));

    const script = await env.ASSETS.fetch(new Request(new URL("/install.sh", url), { method: "GET" }));
    if (!script.ok) {
      // `bash` would run whatever came back, so say so in words it shows and stops at.
      return new Response("echo 'invincible.sh: the installer is not available just now; try again in a minute.' >&2; exit 1\n", { status: 503, headers: { ...TEXT, "cache-control": "no-store" } });
    }
    const headers = new Headers(TEXT);
    if (url.pathname === "/") headers.set("vary", "user-agent");
    return new Response(request.method === "HEAD" ? null : script.body, { status: 200, headers });
  },
};

/** The root's page differs by who asks, so no cache keeps one answer for everyone. */
function vary(response: Response): Response {
  const page = new Response(response.body, response);
  page.headers.append("vary", "user-agent");
  return page;
}
