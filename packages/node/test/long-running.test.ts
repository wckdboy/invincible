import { describe, expect, test } from "bun:test";
import { longRunning, streamedError } from "../src/server.ts";

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
        throw new Boom("ultra: the oath requires approval");
      }),
      10,
      20,
    );
    const body = JSON.parse(await response.text());
    expect(streamedError(body)).toEqual({ error: "ultra: the oath requires approval", status: 500 });
    expect(streamedError({ exitCode: 0, stdout: "" })).toBeNull();
  });

  test("a caller that disconnects mid-stream does not crash anything", async () => {
    const response = await longRunning(Bun.sleep(80).then(() => ({ ok: true })), 5, 10);
    await response.body!.cancel();
    await Bun.sleep(120); // heartbeats + completion fire after cancel without throwing
  });
});
