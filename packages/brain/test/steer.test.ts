import { describe, expect, test } from "bun:test";
import { type ChatStreamEvent, newNodeIdentity } from "@galahad/core";
import { foundFleet, MindStore, Vault } from "@galahad/mind";
import { anthropicConversation, chat as chatWithUsage, type ChatTools, INTERJECTED, openAIConversation, Steering, type ToolCall } from "../src/index.ts";

// What each call cost is usage.test.ts's to check: these read the answer's own flow, event by event.
async function* chat(...args: Parameters<typeof chatWithUsage>): AsyncGenerator<ChatStreamEvent> {
  for await (const event of chatWithUsage(...args)) if (event.type !== "usage") yield event;
}

/*
 * Steering: a message from the owner reaches an answer that's under way, at the next
 * safe point. A model call is ended cleanly (what it had said stays said); a tool that
 * is running finishes and its outcome is reported, and tools that hadn't started are
 * not run; then the model is called again with the message. Both provider formats.
 */

function brain(models: string[], anthropic = false) {
  const identity = newNodeIdentity();
  const store = new MindStore(":memory:");
  foundFleet(store, identity, { fleetName: "camelot", nodeName: "n" });
  const vault = new Vault(store, identity);
  store.emit(identity, "provider.set", { id: "local", kind: "openai", baseUrl: "http://127.0.0.1:9/v1" });
  if (anthropic) {
    vault.set("claude", "test-anthropic-key-FAKE-0000", { provider: "claude", origin: "https://anthropic.test" });
    store.emit(identity, "provider.set", { id: "claude", kind: "anthropic", baseUrl: "https://anthropic.test", secret: "claude" });
  }
  store.emit(identity, "roster.set", { role: "planner", models });
  return { store, vault };
}

type Reply = (signal: AbortSignal | null | undefined) => Response;

/** A stand-in model: each request gets the next scripted reply (which is handed the request's signal); bodies are kept. */
function scripted(replies: Reply[]) {
  const bodies: any[] = [];
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const next = replies.shift();
    return next ? next(init?.signal) : new Response("no more responses", { status: 500 });
  }) as typeof globalThis.fetch;
  return { fetch, bodies };
}

const frame = (chunk: object) => `data: ${JSON.stringify(chunk)}\n\n`;
const openai = (...chunks: object[]): Reply => () => new Response(chunks.map(frame).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
const say = (text: string) => openai({ choices: [{ delta: { content: text } }] });

/** A reply that streams its first words and then hangs until the request is aborted, as a slow model does. */
const hangAfter = (text: string): Reply => (signal) => {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(frame({ choices: [{ delta: { content: text } }] })));
        signal?.addEventListener("abort", () => controller.error(new DOMException("The operation was aborted.", "AbortError")));
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
};

const ask = (content: string) => [{ role: "user" as const, content }];
const types = (events: ChatStreamEvent[]) => events.map((e) => e.type);
const textOf = (events: ChatStreamEvent[]) => events.flatMap((e) => (e.type === "text" ? [e.text] : [])).join("");

/** Tools whose first run waits until the test lets it finish. */
function slowTools() {
  const runs: ToolCall[] = [];
  let release: () => void = () => {};
  let started: () => void = () => {};
  const running = new Promise<void>((resolve) => (started = resolve));
  const tools: ChatTools = {
    specs: [{ name: "post", description: "Post a note.", inputSchema: { type: "object", properties: { text: { type: "string" } } } }],
    describe: (call) => ({ title: "Post a note", input: JSON.stringify(call.input) }),
    run: async (call) => {
      runs.push(call);
      if (runs.length === 1) {
        started();
        await new Promise<void>((resolve) => (release = resolve));
      }
      return { content: `posted ${JSON.stringify(call.input)}`, summary: "posted" };
    },
  };
  return { tools, runs, running, finish: () => release() };
}

const twoCalls = openai({
  choices: [
    {
      delta: {
        tool_calls: [
          { index: 0, id: "call_1", function: { name: "post", arguments: '{"text":"one"}' } },
          { index: 1, id: "call_2", function: { name: "post", arguments: '{"text":"two"}' } },
        ],
      },
    },
  ],
});

describe("Steering: the owner's messages for an answer under way", () => {
  test("taken in order; at the answer's end, what arrived in time is taken and nothing after", () => {
    const steering = new Steering();
    let arrivals = 0;
    const stop = steering.onArrive(() => arrivals++);
    expect(steering.offer("first")).toBe(true);
    expect(steering.offer("second")).toBe(true);
    expect(steering.waiting).toBe(2);
    expect(arrivals).toBe(2);
    expect(steering.take()).toEqual(["first", "second"]);
    expect(steering.take()).toEqual([]);
    // Something arrived just before the end: the answer goes on with it, and more may come.
    steering.offer("late");
    expect(steering.finish()).toEqual(["late"]);
    expect(steering.offer("later still")).toBe(true);
    stop();
    steering.offer("unheard");
    expect(arrivals).toBe(4);
    expect(steering.take()).toEqual(["later still", "unheard"]);
    // Nothing waiting at the end: it's over, and a message after that is refused (it's a new turn's).
    expect(steering.finish()).toEqual([]);
    expect(steering.offer("too late")).toBe(false);
    expect(steering.waiting).toBe(0);
  });

  test("an answer that ended some other way hands back what never reached him", () => {
    const steering = new Steering();
    steering.offer("never delivered");
    expect(steering.close()).toEqual(["never delivered"]);
    expect(steering.offer("after")).toBe(false);
  });
});

describe("steering an answer (OpenAI-compatible)", () => {
  test("while he's writing: the model call ends, what he'd said stays said, and the turn goes on with your message", async () => {
    const model = scripted([hangAfter("Your bank, as I recall, "), say("The weather: dry and cold.")]);
    const steering = new Steering();
    const events: ChatStreamEvent[] = [];
    for await (const event of chat({ ...brain(["local/m"]), fetch: model.fetch }, { messages: ask("What do you know about my bank?"), steering })) {
      events.push(event);
      if (event.type === "text" && events.filter((e) => e.type === "text").length === 1) expect(steering.offer("Never mind the bank. How's the weather?")).toBe(true);
    }
    expect(types(events)).toEqual(["model", "text", "steer", "text", "done"]);
    expect(events[2]).toEqual({ type: "steer", text: "Never mind the bank. How's the weather?" });
    // No paragraph break is carried over: what follows your message is a new answer.
    expect(textOf(events.slice(3))).toBe("The weather: dry and cold.");
    expect(model.bodies).toHaveLength(2);
    expect(model.bodies[1].messages.slice(-3)).toEqual([
      { role: "user", content: "What do you know about my bank?" },
      { role: "assistant", content: "Your bank, as I recall, " },
      { role: "user", content: "Never mind the bank. How's the weather?" },
    ]);
    // It's over: a message now is a new turn's.
    expect(steering.offer("one more")).toBe(false);
  });

  test("during a tool call: the tool finishes and is reported, the ones not started aren't run, then he's told", async () => {
    const model = scripted([twoCalls, say("Only the first went out; I've stopped as you asked.")]);
    const { tools, runs, running, finish } = slowTools();
    const steering = new Steering();
    const events: ChatStreamEvent[] = [];
    const answer = (async () => {
      for await (const event of chat({ ...brain(["local/m"]), fetch: model.fetch }, { messages: ask("Post one, then two."), tools, steering })) events.push(event);
    })();
    await running;
    // Mid-tool: nothing is cut off, and nothing is reported yet.
    expect(steering.offer("Stop after the first.")).toBe(true);
    expect(events.filter((e) => e.type === "tool_result")).toEqual([]);
    finish();
    await answer;

    expect(runs).toEqual([{ id: "call_1", name: "post", input: { text: "one" } }]);
    expect(types(events)).toEqual(["model", "tool", "tool_result", "tool", "tool_result", "steer", "text", "done"]);
    expect(events[2]).toEqual({ type: "tool_result", id: "call_1", name: "post", ok: true, summary: "posted" });
    expect(events[4]).toMatchObject({ type: "tool_result", id: "call_2", ok: false, summary: "not run: your new message came first" });
    // Every call has its outcome (the real one, and "not run"), then his own pause, then your message.
    const sent = model.bodies[1].messages;
    expect(sent.slice(-4)).toEqual([
      { role: "tool", tool_call_id: "call_1", content: 'posted {"text":"one"}' },
      { role: "tool", tool_call_id: "call_2", content: expect.stringContaining("Error: Not run") },
      { role: "assistant", content: INTERJECTED },
      { role: "user", content: "Stop after the first." },
    ]);
    expect(sent.at(-5)).toMatchObject({ role: "assistant", tool_calls: [{ id: "call_1" }, { id: "call_2" }] });
  });

  test("a message that arrives as the answer ends is answered in the same turn, after the whole answer", async () => {
    const steering = new Steering();
    // The stand-in ignores the abort: the reply is complete when the message lands.
    const model = scripted([
      () => {
        steering.offer("And tomorrow?");
        return say("Dry and cold today.")(null);
      },
      say("Rain tomorrow."),
    ]);
    const events: ChatStreamEvent[] = [];
    for await (const event of chat({ ...brain(["local/m"]), fetch: model.fetch }, { messages: ask("How's the weather?"), steering })) events.push(event);
    expect(types(events)).toEqual(["model", "text", "steer", "text", "done"]);
    expect(model.bodies[1].messages.slice(-2)).toEqual([
      { role: "assistant", content: "Dry and cold today." },
      { role: "user", content: "And tomorrow?" },
    ]);
  });

  test("several messages at once reach him together, in order, each shown", async () => {
    const steering = new Steering();
    steering.offer("First: be brief.");
    steering.offer("Second: in Danish.");
    const model = scripted([say("Koldt og tørt.")]);
    const events: ChatStreamEvent[] = [];
    for await (const event of chat({ ...brain(["local/m"]), fetch: model.fetch }, { messages: ask("How's the weather?"), steering })) events.push(event);
    expect(types(events)).toEqual(["model", "steer", "steer", "text", "done"]);
    expect(model.bodies[0].messages.slice(-2)).toEqual([
      { role: "assistant", content: INTERJECTED },
      { role: "user", content: "First: be brief.\n\nSecond: in Danish." },
    ]);
  });

  test("a steer gives the tool rounds of a new message, never more at once", async () => {
    // Eleven rounds, a steer, then eleven more: 22 tool rounds in one turn, each within its own limit. (Each posts something
    // new: the same call that said the same twice is stopped sooner, chat-tools.test.ts.)
    const call = (i: number) => openai({ choices: [{ delta: { tool_calls: [{ index: 0, id: `c${i}`, function: { name: "post", arguments: `{"n":${i}}` } }] } }] });
    const steering = new Steering();
    const replies: Reply[] = [...Array.from({ length: 22 }, (_, i) => call(i)), say("Done.")];
    const model = scripted(replies);
    let ran = 0;
    const tools: ChatTools = {
      specs: [{ name: "post", description: "Post.", inputSchema: { type: "object", properties: {} } }],
      describe: () => ({ title: "Post", input: "" }),
      run: async () => {
        ran += 1;
        if (ran === 11) steering.offer("Keep going.");
        return { content: "ok", summary: "ok" };
      },
    };
    const events: ChatStreamEvent[] = [];
    for await (const event of chat({ ...brain(["local/m"]), fetch: model.fetch }, { messages: ask("Post many."), tools, steering })) events.push(event);
    expect(ran).toBe(22);
    expect(events.at(-1)).toEqual({ type: "done", ref: "local/m" });
  });

  test("a new message lets him look again: the same call that said the same twice runs once more after a steer", async () => {
    const call = (i: number) => openai({ choices: [{ delta: { tool_calls: [{ index: 0, id: `c${i}`, function: { name: "checks", arguments: '{"ref":"main"}' } }] } }] });
    const steering = new Steering();
    const model = scripted([call(0), call(1), call(2), call(3), say("Still running.")]);
    let ran = 0;
    const tools: ChatTools = {
      specs: [{ name: "checks", description: "CI checks.", inputSchema: { type: "object", properties: { ref: { type: "string" } } } }],
      describe: () => ({ title: "Checks", input: "main" }),
      run: async () => {
        ran += 1;
        return { content: "running", summary: "running" };
      },
    };
    const events: ChatStreamEvent[] = [];
    // After two that said the same, the third isn't run; then "look again" arrives, and the fourth runs.
    let refused = 0;
    for await (const event of chat({ ...brain(["local/m"]), fetch: model.fetch }, { messages: ask("Is CI done?"), tools, steering })) {
      events.push(event);
      if (event.type === "tool_result" && !event.ok && ++refused === 1) steering.offer("Look again.");
    }
    expect(ran).toBe(3);
    expect(events.at(-1)).toEqual({ type: "done", ref: "local/m" });
  });

  test("a stop is still a stop: the turn's own signal ends the answer, and a waiting message isn't delivered", async () => {
    const model = scripted([hangAfter("Thinking"), say("never")]);
    const steering = new Steering();
    const stop = new AbortController();
    const events: ChatStreamEvent[] = [];
    for await (const event of chat({ ...brain(["local/m"]), fetch: model.fetch }, { messages: ask("hi"), steering, signal: stop.signal })) {
      events.push(event);
      if (event.type === "text") stop.abort();
    }
    expect(types(events)).toEqual(["model", "text", "error"]);
    expect(model.bodies).toHaveLength(1);
  });

  test("a model that fails before it said anything hands the turn, your message included, to the next model", async () => {
    const steering = new Steering();
    steering.offer("Be brief.");
    const model = scripted([() => new Response("overloaded", { status: 529 }), say("Brief.")]);
    const events: ChatStreamEvent[] = [];
    for await (const event of chat({ ...brain(["local/a", "local/b"]), fetch: model.fetch }, { messages: ask("hi"), steering })) events.push(event);
    // Told once, though two models were handed it.
    expect(types(events)).toEqual(["model", "steer", "fallback", "model", "text", "done"]);
    expect(model.bodies[1].messages.slice(-2)).toEqual([
      { role: "assistant", content: INTERJECTED },
      { role: "user", content: "Be brief." },
    ]);
  });
});

/** Anthropic's streaming events, as the SDK reads them. */
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

describe("steering an answer (Anthropic, through the official SDK)", () => {
  test("during a tool call: thinking and the call go back as they came, every call has its result, then your message", async () => {
    const model = scripted([
      anthropicStream(
        [
          { type: "thinking", thinking: "", signature: "" },
          { type: "tool_use", id: "toolu_1", name: "post", input: {} },
          { type: "tool_use", id: "toolu_2", name: "post", input: {} },
        ],
        [
          [
            { type: "thinking_delta", thinking: "Two posts." },
            { type: "signature_delta", signature: "sig-abc" },
          ],
          [{ type: "input_json_delta", partial_json: '{"text":"one"}' }],
          [{ type: "input_json_delta", partial_json: '{"text":"two"}' }],
        ],
        "tool_use",
      ),
      anthropicStream([{ type: "text", text: "" }], [[{ type: "text_delta", text: "Stopped after the first." }]], "end_turn"),
    ]);
    const { tools, runs, running, finish } = slowTools();
    const steering = new Steering();
    const events: ChatStreamEvent[] = [];
    const answer = (async () => {
      for await (const event of chat({ ...brain(["claude/claude-opus-5-5"], true), fetch: model.fetch }, { messages: ask("Post one, then two."), tools, steering })) events.push(event);
    })();
    await running;
    steering.offer("Stop after the first.");
    finish();
    await answer;

    expect(runs).toHaveLength(1);
    expect(types(events)).toEqual(["model", "tool", "tool_result", "tool", "tool_result", "steer", "text", "done"]);
    const [, assistant, results, paused, yours] = model.bodies[1].messages;
    expect(assistant.content[0]).toMatchObject({ type: "thinking", thinking: "Two posts.", signature: "sig-abc" });
    expect(results.content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_1", content: 'posted {"text":"one"}' },
      { type: "tool_result", tool_use_id: "toolu_2", content: expect.stringContaining("Not run"), is_error: true },
    ]);
    expect(paused).toEqual({ role: "assistant", content: INTERJECTED });
    expect(yours).toEqual({ role: "user", content: "Stop after the first." });
  });
});

describe("steering Claude while he's writing", () => {
  /** Claude's stream: the message starts, some words come, and then it hangs until the request is aborted. */
  const hangingClaude = (text: string): Reply => (signal) => {
    const encoder = new TextEncoder();
    const events: [string, object][] = [
      ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ];
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("")));
          signal?.addEventListener("abort", () => controller.error(new DOMException("The operation was aborted.", "AbortError")));
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  };

  test("the SDK's call is ended, what he'd said goes back as his, and he answers your message", async () => {
    const model = scripted([hangingClaude("Your bank, as I recall, "), anthropicStream([{ type: "text", text: "" }], [[{ type: "text_delta", text: "Dry and cold." }]], "end_turn")]);
    const steering = new Steering();
    const events: ChatStreamEvent[] = [];
    for await (const event of chat({ ...brain(["claude/claude-opus-5-5"], true), fetch: model.fetch }, { messages: ask("What do you know about my bank?"), steering })) {
      events.push(event);
      if (event.type === "text" && events.filter((e) => e.type === "text").length === 1) steering.offer("Never mind. The weather?");
    }
    expect(types(events)).toEqual(["model", "text", "steer", "text", "done"]);
    expect(model.bodies[1].messages).toEqual([
      { role: "user", content: "What do you know about my bank?" },
      { role: "assistant", content: "Your bank, as I recall, " },
      { role: "user", content: "Never mind. The weather?" },
    ]);
  });
});

describe("how each provider format takes a message mid-answer", () => {
  const provider = (kind: "openai" | "anthropic") => ({ id: "p", kind, baseUrl: kind === "anthropic" ? "https://anthropic.test" : "http://127.0.0.1:9/v1", apiKey: "test-key-FAKE-0000", local: false }) as never;
  const drain = async (turn: AsyncGenerator<string, unknown>) => {
    for (let next = await turn.next(); !next.done; next = await turn.next());
  };

  test("Anthropic: after a whole answer, the answer goes back as it came (thinking and all), then your message", async () => {
    const model = scripted([
      anthropicStream(
        [
          { type: "thinking", thinking: "", signature: "" },
          { type: "text", text: "" },
        ],
        [
          [
            { type: "thinking_delta", thinking: "Simple." },
            { type: "signature_delta", signature: "sig-1" },
          ],
          [{ type: "text_delta", text: "Dry and cold." }],
        ],
        "end_turn",
      ),
      anthropicStream([{ type: "text", text: "" }], [[{ type: "text_delta", text: "Rain." }]], "end_turn"),
      anthropicStream([{ type: "text", text: "" }], [[{ type: "text_delta", text: "Sun." }]], "end_turn"),
    ]);
    const conversation = anthropicConversation({ provider: provider("anthropic"), model: "claude-opus-5-5", system: "s", messages: ask("Weather?"), effort: "low", fetch: model.fetch });
    await drain(conversation.turn([]));
    conversation.interject(["And tomorrow?"], null);
    await drain(conversation.turn([]));
    const [, whole, yours] = model.bodies[1].messages;
    expect(whole.content[0]).toMatchObject({ type: "thinking", signature: "sig-1" });
    expect(whole.content[1]).toMatchObject({ type: "text", text: "Dry and cold." });
    expect(yours).toEqual({ role: "user", content: "And tomorrow?" });
    // A call cut short: only what he'd said, as plain text; with nothing said, a pause in his own words.
    conversation.interject(["And the day after?"], "Rain, mos");
    conversation.interject(["In Danish."], "");
    await drain(conversation.turn([]));
    expect(model.bodies[2].messages.slice(-4)).toEqual([
      { role: "assistant", content: "Rain, mos" },
      { role: "user", content: "And the day after?" },
      { role: "assistant", content: INTERJECTED },
      { role: "user", content: "In Danish." },
    ]);
  });

  test("OpenAI-compatible: a call cut short keeps what he'd said; with nothing said, a pause in his own words", async () => {
    const model = scripted([say("unused"), say("unused")]);
    const conversation = openAIConversation({ provider: provider("openai"), model: "m", system: "s", messages: ask("Weather?"), effort: "low", fetch: model.fetch });
    conversation.interject(["Be brief."], "Dry and");
    await drain(conversation.turn([]));
    expect(model.bodies[0].messages.slice(-2)).toEqual([
      { role: "assistant", content: "Dry and" },
      { role: "user", content: "Be brief." },
    ]);
    conversation.interject(["In Danish."], "");
    await drain(conversation.turn([]));
    expect(model.bodies[1].messages.slice(-2)).toEqual([
      { role: "assistant", content: INTERJECTED },
      { role: "user", content: "In Danish." },
    ]);
  });
});
