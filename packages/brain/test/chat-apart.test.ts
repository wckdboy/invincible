import { describe, expect, test } from "bun:test";
import { type ChatStreamEvent, newNodeIdentity } from "@galahad/core";
import { foundFleet, MindStore, Vault } from "@galahad/mind";
import { chat } from "../src/index.ts";

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

function models(...calls: ((signal: AbortSignal) => Promise<Response>)[]) {
  return (async (_url: string | URL | Request, init?: RequestInit) => calls.shift()!(init!.signal!)) as typeof fetch;
}
const never = (signal: AbortSignal) => new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
const saying = (texts: string[]) => async () =>
  sse(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const text of texts) controller.enqueue(chunk(text));
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
const modelsAsked = (events: ChatStreamEvent[]) => events.filter((e) => e.type === "model").map((e) => (e as { ref: string }).ref);

describe("a review asked apart from a model", () => {
  test("asks the models that aren't it first, and the one that is it last, in their own order", async () => {
    const events = await collect(chat({ ...brain(["local/alpha", "local/beta", "local/gamma"]), fetch: models(never, saying(["From gamma."])) }, { messages: ask, apart: "other/beta" }));
    // alpha (another model) is asked first and fails; gamma (another model) is asked next and answers: beta (the same
    // model as `apart`) was put last, after every other candidate.
    expect(modelsAsked(events)).toEqual(["local/alpha", "local/gamma"]);
    expect(events.some((e) => e.type === "model" && (e as { ref: string }).ref === "local/beta")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  test("still answers when the same model is all the role has", async () => {
    const events = await collect(chat({ ...brain(["local/beta"]), fetch: models(saying(["Only beta."])) }, { messages: ask, apart: "other/beta" }));
    expect(modelsAsked(events)).toEqual(["local/beta"]);
    expect(events.map((e) => e.type)).toEqual(["model", "text", "done"]);
    expect(events.some((e) => e.type === "text" && (e as { text: string }).text.includes("Only beta."))).toBe(true);
  });
});
