import { describe, expect, test } from "bun:test";
import { keptAlive } from "./kept-alive.ts";

const sse = (text: string) => new Response(text, { headers: { "content-type": "text/event-stream" } });
const all = async (response: Response) => new TextDecoder().decode(await response.arrayBuffer());

describe("a stand-in's answer kept alive while it waits", () => {
  test("an answer ready at once is byte for byte what it was, with no comment in it", async () => {
    const answer = 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n';
    const response = keptAlive(async () => sse(answer), 20);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await all(response)).toBe(answer);
  });

  test("a held answer has its headers at once and a comment every interval, then the answer's own bytes", async () => {
    let release!: () => void;
    const held = new Promise<void>((go) => (release = go));
    const response = keptAlive(async () => {
      await held;
      return sse("data: [DONE]\n\n");
    }, 20);
    // The headers are there before anything is answered: the node's fetch has its response.
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const seen: string[] = [];
    const reading = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        seen.push(new TextDecoder().decode(value));
      }
    })();
    await Bun.sleep(110);
    const pings = seen.filter((chunk) => chunk === ": thinking\n\n").length;
    expect(pings).toBeGreaterThanOrEqual(3);
    release();
    await reading;
    expect(seen.at(-1)).toBe("data: [DONE]\n\n");
    expect(seen.slice(0, -1).every((chunk) => chunk === ": thinking\n\n")).toBe(true);
  });

  test("a client that goes away stops the comments, and an answer that comes after is dropped quietly", async () => {
    let release!: () => void;
    const held = new Promise<void>((go) => (release = go));
    const response = keptAlive(async () => {
      await held;
      return sse("data: late\n\n");
    }, 10);
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    release();
    // Nothing is enqueued on the closed stream (it would throw), now or at the next interval.
    await Bun.sleep(40);
  });

  test("an answer that fails ends the stream as failed, never as if whole", async () => {
    const response = keptAlive(async () => {
      throw new Error("no answer");
    }, 20);
    await expect(all(response)).rejects.toThrow("no answer");
  });
});
