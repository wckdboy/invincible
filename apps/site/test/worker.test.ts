import { expect, test } from "bun:test";
import worker, { type Env } from "../src/worker.ts";

/*
 * invincible.sh answers `curl -fsSL https://invincible.sh | bash` with the installer and a browser with the page. The
 * site's static files stand in for Cloudflare's: the page at /, the installer at /install.sh.
 */

const PAGE = "<!doctype html><title>Invincible</title>";
const SCRIPT = "#!/usr/bin/env bash\necho installing\n";

function site(files: Record<string, string> = { "/": PAGE, "/install.sh": SCRIPT }): Env {
  return {
    ASSETS: {
      async fetch(request: Request) {
        const body = files[new URL(request.url).pathname];
        return body === undefined ? new Response("not found", { status: 404 }) : new Response(body, { headers: { "content-type": "text/html" } });
      },
    },
  };
}

const ask = (path: string, agent: string, method = "GET", env = site()) =>
  worker.fetch(new Request(`https://invincible.sh${path}`, { method, headers: { "user-agent": agent } }), env);

test("curl and wget at the root get the installer, as plain text, and caches keep it apart from the page", async () => {
  for (const agent of ["curl/8.7.1", "Wget/1.21.4"]) {
    const response = await ask("/", agent);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(SCRIPT);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("vary")).toBe("user-agent");
  }
});

test("a browser at the root gets the page, marked as varying by who asks", async () => {
  const response = await ask("/", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15");
  expect(await response.text()).toBe(PAGE);
  expect(response.headers.get("vary")).toBe("user-agent");
});

test("/install is the installer for anyone, a browser included, so it can be read before it is run", async () => {
  const response = await ask("/install", "Mozilla/5.0");
  expect(await response.text()).toBe(SCRIPT);
  expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
});

test("HEAD says what a GET would bring, without the body", async () => {
  const response = await ask("/", "curl/8.7.1", "HEAD");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(await response.text()).toBe("");
});

test("with no installer to give, bash is handed a line that says so and stops, never a page to run", async () => {
  const response = await ask("/", "curl/8.7.1", "GET", site({ "/": PAGE }));
  expect(response.status).toBe(503);
  const said = await response.text();
  expect(said).toStartWith("echo ");
  expect(said).toContain("exit 1");
  expect(said).not.toContain("<");
});
