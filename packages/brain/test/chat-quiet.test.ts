import { describe, expect, test } from "bun:test";
import { type ChatStreamEvent, newNodeIdentity } from "@galahad/core";
import { foundFleet, MindStore, Vault } from "@galahad/mind";
import { chat } from "../src/index.ts";

/*
 * A model's call that goes silent is ended as a failed one (providers.ts QUIET_MS), measured on the bytes it sends: the
 * roster's next model takes the answer when nothing had been said yet; an answer cut off in the middle fails, for the
 * caller to ask again; one that keeps sending, however slowly, is never cut.
 */

function brain(models: string[]) {
  const identity = newNodeIdentity();
  const store = new MindStore(":memory:");
  foundFleet(store, identity, { fleetName: "camelot", nodeName: "n" });
  const vault = new Vault(store, identity);
  store.emit(identity, "provider.set", { id: "local", kind: "openai", baseUrl: "http://127.0.0.1:9/v1" });
  store.emit(identity, "roster.set", { role: "planner", models });
  return { store, vault, quietMs: 60 };
}

const encoder = new TextEncoder();
const chunk = (text: string) => encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
const sse = (body: ReadableStream<Uint8Array>) => new Response(body, { headers: { "content-type": "text/event-stream" } });

/** A stand-in model per call, in turn: each is given the call's signal, as fetch is. */
function models(...calls: ((signal: AbortSignal) => Promise<Response>)[]) {
  return (async (_url: string | URL | Request, init?: RequestInit) => calls.shift()!(init!.signal!)) as typeof fetch;
}
/** It never answers (until it is aborted, as fetch is). */
const never = (signal: AbortSignal) => new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
/** It says these, `gapMs` apart, then ends (`stall`: then sends nothing more, ever). */
const saying = (texts: string[], gapMs: number, stall = false) => async () =>
  sse(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const text of texts) {
          controller.enqueue(chunk(text));
          await Bun.sleep(gapMs);
        }
        if (stall) return;
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
  );

async function collect(stream: AsyncGenerator<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const event of stream) if (event.type !== "usage") out.push(event);
  return out;
}
const ask = [{ role: "user" as const, content: "hi" }];
const said = (events: ChatStreamEvent[]) => events.flatMap((e) => (e.type === "text" ? [e.text] : [])).join("");

describe("a model's call that goes silent", () => {
  test("one that never answers is ended, and the next model answers", async () => {
    const events = await collect(chat({ ...brain(["local/a", "local/b"]), fetch: models(never, saying(["From b."], 1)) }, { messages: ask }));
    expect(events.map((e) => e.type)).toEqual(["model", "fallback", "model", "text", "done"]);
    expect((events[1] as { error: string }).error).toContain("the model sent nothing for 0 seconds");
    expect(said(events)).toBe("From b.");
  });

  test("one that stops in the middle of its answer fails, never ends as if it were whole", async () => {
    const events = await collect(chat({ ...brain(["local/a"]), fetch: models(saying(["Half an ", "answer"], 5, true)) }, { messages: ask }));
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect((events.at(-1) as { error: string }).error).toContain("sent nothing");
    expect(events.some((e) => e.type === "done")).toBe(false);
  });

  test("one that keeps sending, however long it takes, is never cut", async () => {
    // Twelve words 30 ms apart: 360 ms in all, six times the limit, never silent for as long as it.
    const words = Array.from({ length: 12 }, (_, i) => `w${i} `);
    const events = await collect(chat({ ...brain(["local/a"]), fetch: models(saying(words, 30)) }, { messages: ask }));
    expect(events.map((e) => e.type).at(-1)).toBe("done");
    expect(said(events)).toBe(words.join(""));
  });
});
