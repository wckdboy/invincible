import { describe, expect, test } from "bun:test";
import { type ChatStreamEvent, newNodeIdentity, type Usage } from "@galahad/core";
import { foundFleet, MindStore, Vault } from "@galahad/mind";
import { anthropicUsage, chat, type ChatTools, openAIConversation, openAIUsage } from "../src/index.ts";

/*
 * What a model call cost, as its provider reported it: read from the stream's own
 * usage, carried out of chat() as an event per call, and never estimated. A provider
 * that says nothing gives "unknown"; a call that never reached a model gives nothing.
 */

function brain(models: string[], baseUrl = "http://127.0.0.1:9/v1") {
  const identity = newNodeIdentity();
  const store = new MindStore(":memory:");
  foundFleet(store, identity, { fleetName: "camelot", nodeName: "n" });
  const vault = new Vault(store, identity);
  store.emit(identity, "provider.set", { id: "local", kind: "openai", baseUrl });
  for (const role of ["planner", "reviewer"]) store.emit(identity, "roster.set", { role, models });
  return { store, vault };
}

type Reply = (body: any) => Response;

function scripted(replies: Reply[]) {
  const bodies: any[] = [];
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    const next = replies.shift();
    return next ? next(body) : new Response("no more responses", { status: 500 });
  }) as typeof globalThis.fetch;
  return { fetch, bodies };
}

const frame = (chunk: object) => `data: ${JSON.stringify(chunk)}\n\n`;
const sse = (body: string): Response => new Response(body, { headers: { "content-type": "text/event-stream" } });
const whole = (...chunks: object[]): Reply => () => sse(chunks.map(frame).join("") + "data: [DONE]\n\n");
const stop = { choices: [{ delta: {}, finish_reason: "stop" }] };
const words = (text: string) => ({ choices: [{ delta: { content: text } }] });
/** The last chunk of a stream that was asked for its usage: no choices, the counts. */
const counted = (usage: object) => ({ choices: [], usage });
const toolCall = (id: string) => [{ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: "look", arguments: "{}" } }] } }] }, { choices: [{ delta: {}, finish_reason: "tool_calls" }] }];

const ask = (content: string) => [{ role: "user" as const, content }];
const all = async (events: AsyncGenerator<ChatStreamEvent>) => {
  const out: ChatStreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
};
const usages = (events: ChatStreamEvent[]) => events.flatMap((e) => (e.type === "usage" ? [{ ref: e.ref, usage: e.usage }] : []));

describe("reading a provider's usage", () => {
  test("OpenAI-compatible: prompt and completion tokens, the cached and the reasoning part where it says", () => {
    expect(openAIUsage({ prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 })).toEqual({ input: 1200, output: 300 });
    expect(openAIUsage({ prompt_tokens: 1200, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 1000 }, completion_tokens_details: { reasoning_tokens: 250 } })).toEqual({ input: 1200, output: 300, cached: 1000, reasoning: 250 });
    // DeepSeek says what hit its cache in a field of its own.
    expect(openAIUsage({ prompt_tokens: 900, completion_tokens: 40, prompt_cache_hit_tokens: 640, prompt_cache_miss_tokens: 260 })).toEqual({ input: 900, output: 40, cached: 640 });
    // Not a usage: nothing is made of it.
    for (const raw of [null, undefined, "12", {}, { prompt_tokens: "many", completion_tokens: 3 }, { prompt_tokens: -1, completion_tokens: 3 }]) expect(openAIUsage(raw)).toBeNull();
  });

  test("Anthropic: the input is what was sent fresh, read from the cache and written to it; the cached part is what was read", () => {
    expect(anthropicUsage({ input_tokens: 200, output_tokens: 90, cache_read_input_tokens: 5000, cache_creation_input_tokens: 300, output_tokens_details: { thinking_tokens: 60 } })).toEqual({ input: 5500, output: 90, cached: 5000, reasoning: 60 });
    expect(anthropicUsage({ input_tokens: 200, output_tokens: 90, cache_read_input_tokens: null, cache_creation_input_tokens: null })).toEqual({ input: 200, output: 90, cached: 0 });
    expect(anthropicUsage({ output_tokens: 90 })).toBeNull();
  });
});

describe("a call's usage, out of the conversation", () => {
  const provider = { id: "local", kind: "openai" as const, baseUrl: "http://127.0.0.1:9/v1", apiKey: null, local: true };
  const drain = async (turn: AsyncGenerator<string, unknown>) => {
    for (let next = await turn.next(); !next.done; next = await turn.next());
  };

  test("the stream is asked for its usage, and the last chunk's counts are the call's", async () => {
    const model = scripted([whole(words("Hello."), stop, counted({ prompt_tokens: 812, completion_tokens: 7 }))]);
    const conversation = openAIConversation({ provider, model: "a", system: "s", messages: ask("Hi"), effort: "low", fetch: model.fetch });
    expect(conversation.spent!()).toBeUndefined();
    await drain(conversation.turn([]));
    expect(model.bodies[0].stream_options).toEqual({ include_usage: true });
    expect(conversation.spent!()).toEqual({ input: 812, output: 7 });
  });

  test("a provider that reports nothing: unknown, never an estimate", async () => {
    const model = scripted([whole(words("Hello."), stop)]);
    const conversation = openAIConversation({ provider, model: "a", system: "s", messages: ask("Hi"), effort: "low", fetch: model.fetch });
    await drain(conversation.turn([]));
    expect(conversation.spent!()).toBeNull();
  });

  test("an endpoint that refuses the option is asked again without it, and not asked with it again", async () => {
    const strict = { ...provider, baseUrl: "http://127.0.0.1:9/strict/v1" };
    const refuse: Reply = (body) => (body.stream_options ? new Response(JSON.stringify({ error: { message: "Unrecognized request argument supplied: stream_options" } }), { status: 400 }) : sse(frame(words("Hello.")) + frame(stop) + "data: [DONE]\n\n"));
    const model = scripted([refuse, refuse, refuse]);
    const first = openAIConversation({ provider: strict, model: "a", system: "s", messages: ask("Hi"), effort: "low", fetch: model.fetch });
    await drain(first.turn([]));
    expect(model.bodies.map((b) => !!b.stream_options)).toEqual([true, false]);
    expect(first.spent!()).toBeNull();
    const second = openAIConversation({ provider: strict, model: "a", system: "s", messages: ask("Again"), effort: "low", fetch: model.fetch });
    await drain(second.turn([]));
    expect(model.bodies.map((b) => !!b.stream_options)).toEqual([true, false, false]);
  });

  test("a request the provider refused never reached a model: there is nothing to count", async () => {
    const model = scripted([() => new Response("upstream is down", { status: 503 })]);
    const conversation = openAIConversation({ provider, model: "a", system: "s", messages: ask("Hi"), effort: "low", fetch: model.fetch });
    await expect(drain(conversation.turn([]))).rejects.toThrow(/503/);
    expect(conversation.spent!()).toBeUndefined();
  });
});

describe("chat() says what each model call cost", () => {
  test("an event per call, with the model that made it, and the holder of the context is told too", async () => {
    const model = scripted([whole(words("Forty-two."), stop, counted({ prompt_tokens: 1500, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 1024 } }))]);
    const told: { role: string; ref: string; usage: Usage | null }[] = [];
    const events = await all(chat({ ...brain(["local/a"]), fetch: model.fetch, spent: (call) => void told.push(call) }, { role: "reviewer", messages: ask("What is it?") }));
    expect(usages(events)).toEqual([{ ref: "local/a", usage: { input: 1500, output: 12, cached: 1024 } }]);
    expect(told).toEqual([{ role: "reviewer", ref: "local/a", usage: { input: 1500, output: 12, cached: 1024 } }]);
    // The count comes before the answer is called done, and carries nothing of what was said.
    expect(events.map((e) => e.type)).toEqual(["model", "text", "usage", "done"]);
    expect(JSON.stringify(usages(events))).not.toContain("Forty-two");
  });

  test("every round of tools is a call of its own", async () => {
    const model = scripted([whole(...toolCall("c1"), counted({ prompt_tokens: 900, completion_tokens: 20 })), whole(words("Done."), stop, counted({ prompt_tokens: 1100, completion_tokens: 5 }))]);
    const tools: ChatTools = {
      specs: [{ name: "look", description: "Look.", inputSchema: { type: "object", properties: {} } }],
      describe: () => ({ title: "Look", input: "" }),
      run: async () => ({ content: "seen", summary: "seen" }),
    };
    const events = await all(chat({ ...brain(["local/a"]), fetch: model.fetch }, { messages: ask("Look"), tools }));
    expect(usages(events).map((u) => u.usage)).toEqual([
      { input: 900, output: 20 },
      { input: 1100, output: 5 },
    ]);
  });

  test("a model that can't be reached costs nothing and is counted as nothing; the one that answers is counted", async () => {
    const model = scripted([() => new Response("rate limited", { status: 429 }), whole(words("Here."), stop, counted({ prompt_tokens: 40, completion_tokens: 2 }))]);
    const events = await all(chat({ ...brain(["local/a", "local/b"]), fetch: model.fetch }, { messages: ask("Hi") }));
    expect(events.map((e) => e.type)).toEqual(["model", "fallback", "model", "text", "usage", "done"]);
    expect(usages(events)).toEqual([{ ref: "local/b", usage: { input: 40, output: 2 } }]);
  });

  test("a reply cut off mid-stream still cost something: it's counted as a call with unknown usage", async () => {
    const model = scripted([() => sse(frame(words("Half a sen")))]);
    const events = await all(chat({ ...brain(["local/a"]), fetch: model.fetch }, { messages: ask("Go on") }));
    expect(usages(events)).toEqual([{ ref: "local/a", usage: null }]);
    expect(events.at(-1)!.type).toBe("error");
  });

  test("a provider that reports no usage: the call is counted, its tokens unknown", async () => {
    const model = scripted([whole(words("Fine."), stop)]);
    const events = await all(chat({ ...brain(["local/a"]), fetch: model.fetch }, { messages: ask("Hi") }));
    expect(usages(events)).toEqual([{ ref: "local/a", usage: null }]);
  });
});
