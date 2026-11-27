import { describe, expect, test } from "bun:test";
import { listening, longRunning, streamedError } from "../src/server.ts";

class Boom extends Error {
  status = 409;
}

describe("long-running responses", () => {
  test("fast work is an ordinary JSON response", async () => {
    const response = await longRunning(Promise.resolve({ exitCode: 0 }), 50);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ exitCode: 0 });
  });

  test("fast failures keep their real status (they throw to the normal error path)", async () => {
    await expect(longRunning(Promise.reject(new Error("no such sandbox")), 50)).rejects.toThrow("no such sandbox");
  });

  test("slow work streams heartbeats, then valid JSON (outlives idle timers)", async () => {
    const response = await longRunning(Bun.sleep(120).then(() => ({ exitCode: 137 })), 10, 20);
    const text = await response.text();
    expect(text.startsWith(" ")).toBe(true); // heartbeats arrived before the result
    expect(JSON.parse(text)).toEqual({ exitCode: 137 }); // leading whitespace is valid JSON
  });

  test("slow failures arrive as { error, status }, which clients unwrap", async () => {
    const response = await longRunning(
      Bun.sleep(60).then(() => {
        throw new Boom("ultra: the policy requires approval");
      }),
      10,
      20,
    );
    const body = JSON.parse(await response.text());
    expect(streamedError(body)).toEqual({ error: "ultra: the policy requires approval", status: 500 });
    expect(streamedError({ exitCode: 0, stdout: "" })).toBeNull();
  });

  test("a long answer outlasts its listener's idle timer, which its heartbeats alone don't hold off; no other answer does", async () => {
    // Bun closes a request at its listener's idleTimeout however many heartbeats it has streamed (1.4.4, measured 27
    // November 2026: a byte a second, closed at the timer as a silent answer is): the node's listeners (255 s) cut making a
    // computer or a clone that ran longer. The listener lets a long answer run on, and only that one. Here a 4 s timer.
    const work = () => Bun.sleep(5_000).then(() => ({ ok: true }));
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 4,
      fetch: listening(async (req) => (new URL(req.url).pathname === "/long" ? longRunning(work(), 50, 1_000) : Response.json(await work())), "loopback"),
    });
    try {
      const ask = async (path: string): Promise<unknown> => {
        try {
          return JSON.parse((await (await fetch(`http://127.0.0.1:${server.port}${path}`)).text()).trim());
        } catch (error) {
          return `cut: ${(error as Error).message}`;
        }
      };
      const [long, silent] = await Promise.all([ask("/long"), ask("/silent")]);
      expect(long).toEqual({ ok: true });
      expect(silent).toEqual(expect.stringMatching(/^cut: /));
    } finally {
      server.stop(true);
    }
  }, 15_000);

  test("a caller that disconnects mid-stream does not crash anything", async () => {
    const response = await longRunning(Bun.sleep(80).then(() => ({ ok: true })), 5, 10);
    await response.body!.cancel();
    await Bun.sleep(120); // heartbeats + completion fire after cancel without throwing
  });
});
