import { describe, expect, test } from "bun:test";
import { newNodeIdentity } from "@galahad/core";
import { foundFleet, MindStore, Vault } from "@galahad/mind";
import { anthropicConversation, chat, type ChatTools, openAIConversation } from "../src/index.ts";

/*
 * What a provider may keep in its cache from one call to the next. Anthropic caches only what a call marks: on its own
 * API every call marks the tools and the system prompt (the same in every call of a conversation, and from one turn to
 * the next) and the conversation so far, so the next call reads them at a tenth of the price or less. What changes from
 * turn to turn (the memories recalled for your question) comes after the first mark. Elsewhere nothing new is sent.
 */

type Reply = () => Response;

function scripted(replies: Reply[]) {
  const bodies: any[] = [];
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const next = replies.shift();
    return next ? next() : new Response("no more responses", { status: 500 });
  }) as typeof globalThis.fetch;
  return { fetch, bodies };
}

/** Anthropic's stream for one call: its blocks, the deltas that fill them, how it stopped. */
function anthropicStream(blocks: object[], deltas: object[][], stopReason: string): Reply {
  const events: [string, object][] = [
    ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
  ];
  blocks.forEach((block, index) => {
    events.push(["content_block_start", { type: "content_block_start", index, content_block: block }]);
    for (const delta of deltas[index] ?? []) events.push(["content_block_delta", { type: "content_block_delta", index, delta }]);
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
  });
  events.push(["message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 20 } }]);
  events.push(["message_stop", { type: "message_stop" }]);
  return () => new Response(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

const toolCall = anthropicStream([{ type: "tool_use", id: "toolu_1", name: "post", input: {} }], [[{ type: "input_json_delta", partial_json: '{"text":"hi"}' }]], "tool_use");
const answer = (text: string) => anthropicStream([{ type: "text", text: "" }], [[{ type: "text_delta", text }]], "end_turn");
const post = { name: "post", description: "Post a note.", inputSchema: { type: "object", properties: { text: { type: "string" } } } };
const ask = (content: string) => [{ role: "user" as const, content }];
const provider = (baseUrl: string, kind: "anthropic" | "openai" = "anthropic") => ({ id: "p", kind, baseUrl, apiKey: "test-key-FAKE-0000", local: false }) as never;
const drain = async (turn: AsyncGenerator<string, unknown>) => {
  for (let next = await turn.next(); !next.done; next = await turn.next());
};
/** A request body without its cache marks: what must stay byte for byte the same from one call to the next. */
const unmarked = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, v) => (key === "cache_control" ? undefined : v)));

describe("prompt caching", () => {
  test("on Anthropic's own API, each call marks the tools and system prompt, and the conversation so far, for its cache", async () => {
    const model = scripted([toolCall, answer("Posted.")]);
    const conversation = anthropicConversation({ provider: provider("https://api.anthropic.com"), model: "claude-opus-5-5", system: "Who he is.", context: "What he recalled.", messages: ask("Post hi."), effort: "low", fetch: model.fetch });
    await drain(conversation.turn([post]));
    conversation.answer([{ id: "toolu_1", content: "posted" }]);
    await drain(conversation.turn([post]));
    const [first, second] = model.bodies;
    // The tools and the system prompt end at the first mark; what he recalled comes after it, unmarked.
    expect(first.system).toEqual([
      { type: "text", text: "Who he is.", cache_control: { type: "ephemeral" } },
      { type: "text", text: "What he recalled." },
    ]);
    // The conversation so far: the API marks its last block itself, so the mark moves on as it grows.
    expect(first.cache_control).toEqual({ type: "ephemeral" });
    expect(second.cache_control).toEqual({ type: "ephemeral" });
    // What the next call reads from the cache is exactly what the call before it sent: nothing before it changed.
    expect(unmarked(second.system)).toEqual(unmarked(first.system));
    expect(unmarked(second.tools)).toEqual(unmarked(first.tools));
    expect(unmarked(second.messages.slice(0, first.messages.length))).toEqual(unmarked(first.messages));
  });

  test("an Anthropic-compatible endpoint that isn't Anthropic's is sent what it was before: one system prompt and no marks", async () => {
    const model = scripted([answer("Hi.")]);
    const conversation = anthropicConversation({ provider: provider("https://anthropic.test"), model: "claude-opus-5-5", system: "Who he is.", context: "What he recalled.", messages: ask("Hi"), effort: "low", fetch: model.fetch });
    await drain(conversation.turn([post]));
    expect(model.bodies[0].system).toBe("Who he is.\n\nWhat he recalled.");
    expect(JSON.stringify(model.bodies[0])).not.toContain("cache_control");
  });

  test("an OpenAI-compatible provider caches by prefix on its own: its system message is the prompt, then what he recalled", async () => {
    const model = scripted([() => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hi." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })]);
    const conversation = openAIConversation({ provider: provider("http://127.0.0.1:9/v1", "openai"), model: "m", system: "Who he is.", context: "What he recalled.", messages: ask("Hi"), effort: "low", fetch: model.fetch });
    await drain(conversation.turn([]));
    expect(model.bodies[0].messages[0]).toEqual({ role: "system", content: "Who he is.\n\nWhat he recalled." });
  });

  test("a chat's recalled memories go after the cached part, so a new question reads the persona and tools from the cache", async () => {
    const identity = newNodeIdentity();
    const store = new MindStore(":memory:");
    foundFleet(store, identity, { fleetName: "camelot", nodeName: "n" });
    const vault = new Vault(store, identity);
    vault.set("claude", "test-anthropic-key-FAKE-0000", { provider: "claude", origin: "https://api.anthropic.com" });
    store.emit(identity, "provider.set", { id: "claude", kind: "anthropic", baseUrl: "https://api.anthropic.com", secret: "claude" });
    store.emit(identity, "roster.set", { role: "planner", models: ["claude/claude-opus-5-5"] });
    const tools: ChatTools = { specs: [post], describe: () => ({ title: "Post", input: "" }), run: async () => ({ content: "posted", summary: "posted" }) };
    const asked = async (question: string, recalled: string) => {
      const model = scripted([answer("Noted.")]);
      for await (const _ of chat({ store, vault, fetch: model.fetch }, { messages: ask(question), context: recalled, tools }));
      return model.bodies[0];
    };
    const monday = await asked("What's on Monday?", "Recalled: the dentist on Monday.");
    const friday = await asked("And Friday?", "Recalled: a flight on Friday.");
    // The persona, its guides and the model it runs on: the same for both questions, and marked.
    expect(friday.system[0]).toEqual(monday.system[0]);
    expect(monday.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(monday.system[0].text).not.toContain("dentist");
    expect(monday.system.at(-1)).toEqual({ type: "text", text: "Recalled: the dentist on Monday." });
    expect(friday.system.at(-1)).toEqual({ type: "text", text: "Recalled: a flight on Friday." });
  });
});

/*
 * How hard Claude thinks, step by step (your word, 19 November 2026: "never fixed, always adaptable"): a quest's loop
 * says each turn's level on its message (roster.ts STEP_EFFORT). Changing the call's own level from one turn to the
 * next would start the cache again, so on Anthropic's own API the call keeps the first level and each change is a
 * system message of its own (beta mid-conversation-output-config-2026-07-01): what was sent before is sent again as it was.
 */
describe("how hard it thinks, step by step, with the cache kept", () => {
  /** Each call's body and its beta header. */
  function heard(replies: Reply[]) {
    const calls: { body: any; betas: string }[] = [];
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body)), betas: new Headers(init?.headers).get("anthropic-beta") ?? "" });
      const next = replies.shift();
      return next ? next() : new Response("no more responses", { status: 500 });
    }) as typeof globalThis.fetch;
    return { fetch, calls };
  }
  const turns = [
    { role: "user" as const, content: "The briefing.", effort: "high" as const },
    { role: "assistant" as const, content: "```sh\ncat a.ts\n```" },
    { role: "user" as const, content: "exit 0 · 3 ms\nthe file", effort: "medium" as const },
    { role: "assistant" as const, content: "```sh\nbun test\n```" },
    { role: "user" as const, content: "exit 1 · 9 ms\n1 fail", effort: "xhigh" as const },
  ];

  test("each change of level is said where it happens, by a system message with no words; the call's own is the first, every time", async () => {
    const model = heard([answer("Next."), answer("Next.")]);
    const first = anthropicConversation({ provider: provider("https://api.anthropic.com"), model: "claude-opus-5-5", system: "Who he is.", messages: turns.slice(0, 3), effort: "xhigh", fetch: model.fetch });
    await drain(first.turn([]));
    const second = anthropicConversation({ provider: provider("https://api.anthropic.com"), model: "claude-opus-5-5", system: "Who he is.", messages: turns, effort: "xhigh", fetch: model.fetch });
    await drain(second.turn([]));
    const [a, b] = model.calls;
    expect(a!.body.output_config).toEqual({ effort: "high" });
    expect(b!.body.output_config).toEqual({ effort: "high" });
    expect(b!.body.messages.map((m: any) => (m.role === "system" ? `system:${m.output_config.effort}` : m.role))).toEqual(["user", "assistant", "system:medium", "user", "assistant", "system:xhigh", "user"]);
    expect(b!.body.messages[2]).toEqual({ role: "system", content: [], output_config: { effort: "medium" } });
    expect(a!.betas).toContain("mid-conversation-output-config-2026-07-01");
    // What the second call reads from the cache is what the first sent, byte for byte.
    expect(unmarked(b!.body.messages.slice(0, a!.body.messages.length))).toEqual(unmarked(a!.body.messages));
  });

  test("a model that can't take a change inside a conversation, or an endpoint that isn't Anthropic's, thinks at the first level throughout", async () => {
    for (const [baseUrl, model] of [["https://api.anthropic.com", "claude-opus-4-8"], ["https://anthropic.test", "claude-opus-5-5"]] as const) {
      const heardIt = heard([answer("Next.")]);
      const conversation = anthropicConversation({ provider: provider(baseUrl), model, system: "Who he is.", messages: turns, effort: "xhigh", fetch: heardIt.fetch });
      await drain(conversation.turn([]));
      const [call] = heardIt.calls;
      expect(call!.body.output_config).toEqual({ effort: "high" });
      expect(call!.body.messages.map((m: any) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
      expect(call!.betas).not.toContain("mid-conversation-output-config");
    }
  });

  test("a call whose messages say no level thinks at the role's, as ever", async () => {
    const model = heard([answer("Hi.")]);
    const conversation = anthropicConversation({ provider: provider("https://api.anthropic.com"), model: "claude-opus-5-5", system: "Who he is.", messages: ask("Hi"), effort: "low", fetch: model.fetch });
    await drain(conversation.turn([]));
    expect(model.calls[0]!.body.output_config).toEqual({ effort: "low" });
    expect(model.calls[0]!.betas).not.toContain("mid-conversation-output-config");
  });

  test("a role you pinned to a level thinks at it whatever its messages say: galahad roster effort <role> <level>", async () => {
    const identity = newNodeIdentity();
    const store = new MindStore(":memory:");
    foundFleet(store, identity, { fleetName: "camelot", nodeName: "n" });
    const vault = new Vault(store, identity);
    vault.set("claude", "test-anthropic-key-FAKE-0000", { provider: "claude", origin: "https://api.anthropic.com" });
    store.emit(identity, "provider.set", { id: "claude", kind: "anthropic", baseUrl: "https://api.anthropic.com", secret: "claude" });
    store.emit(identity, "roster.set", { role: "engineer", models: ["claude/claude-opus-5-5"] });
    const called = async () => {
      const model = heard([answer("Next.")]);
      for await (const _ of chat({ store, vault, fetch: model.fetch }, { role: "engineer", messages: turns }));
      return model.calls[0]!;
    };
    const auto = await called();
    expect(auto.body.messages.filter((m: any) => m.role === "system")).toHaveLength(2);
    store.emit(identity, "roster.effort", { role: "engineer", effort: "medium" });
    const pinned = await called();
    expect(pinned.body.output_config).toEqual({ effort: "medium" });
    expect(pinned.body.messages.filter((m: any) => m.role === "system")).toHaveLength(0);
    // Back to auto, by the step again.
    store.emit(identity, "roster.effort", { role: "engineer", effort: "auto" });
    expect((await called()).body.messages.filter((m: any) => m.role === "system")).toHaveLength(2);
  });
});
