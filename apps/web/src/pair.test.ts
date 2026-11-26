import { afterAll, describe, expect, test } from "bun:test";
import { ApiError, nodeReachable, pairPost } from "./api.ts";

/*
 * Pairing must never just hang. A stalled connection (Tailscale reconnecting, a
 * phone switching networks) or no route at all has to become a clear answer the
 * page can show and retry, rather than a request that waits forever.
 */

const stalls = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Promise<Response>(() => {}) });
const refuses = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ error: "invalid input" }, { status: 400 }) });
const closed = (() => {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = s.port;
  s.stop(true);
  return port;
})();
afterAll(() => {
  stalls.stop(true);
  refuses.stop(true);
});

const at = (port: number) => {
  (globalThis as { location?: unknown }).location = new URL(`http://127.0.0.1:${port}/`);
};

describe("pairing requests never wait forever", () => {
  test("a node that never answers: a clear 'no answer' error after the timeout, which retries treat as transient", async () => {
    at(stalls.port!);
    const started = performance.now();
    const error = await pairPost("/link/pair/status", {}, 300).catch((e: unknown) => e);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(0);
    expect((error as ApiError).message).toMatch(/No answer from 127\.0\.0\.1:\d+ within 0 s|No answer from/);
  });

  test("no route at all: 'can't reach', status 0", async () => {
    at(closed!);
    const error = await pairPost("/link/pair/request", {}, 2000).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(0);
    expect((error as ApiError).message).toMatch(/Can't reach|No answer/);
  });

  test("reachable is any answer at all, even a refusal; stalls and dead ends are not", async () => {
    at(refuses.port!);
    expect(await nodeReachable(1000)).toBe(true);
    at(stalls.port!);
    expect(await nodeReachable(300)).toBe(false);
    at(closed!);
    expect(await nodeReachable(1000)).toBe(false);
  });
});

describe("pairing an app on the Home Screen by pasting the invite", () => {
  test("the invite is found in a whole link, or taken as it is; anything else is refused", async () => {
    const { inviteFrom } = await import("./screens.ts");
    expect(inviteFrom("https://node.example.ts.net:8443/#pair=gi1.eyJhIjoxfQ")).toBe("gi1.eyJhIjoxfQ");
    expect(inviteFrom("  gi1.eyJhIjoxfQ\n")).toBe("gi1.eyJhIjoxfQ");
    expect(inviteFrom("https://node/#/overview&pair=gi1.abc-_")).toBe("gi1.abc-_");
    expect(inviteFrom("https://example.com/")).toBeNull();
    expect(inviteFrom("gi1.<script>")).toBeNull();
  });
});

describe("a node that can't be reached", () => {
  test("is tried again on its own, sooner at first, never less often than every 30 s", async () => {
    const { retryDelayMs } = await import("./screens.ts");
    expect([0, 1, 2, 3, 4, 9].map(retryDelayMs)).toEqual([3000, 6000, 12_000, 24_000, 30_000, 30_000]);
  });
});
