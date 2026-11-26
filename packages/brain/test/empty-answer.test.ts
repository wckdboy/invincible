import { describe, expect, test } from "bun:test";
import { type ChatStreamEvent, newNodeIdentity } from "@galahad/core";
import { foundFleet, MindStore, Vault } from "@galahad/mind";
import { chat, type ChatTools, MAX_REFUSAL_RETRIES } from "../src/index.ts";

/*
 * An answer with no words in it is never an answer. A reply that stops arriving before
 * the model was done, or one that ends cleanly with nothing said, is a failure that
 * says so: the next model takes over if nothing had happened yet, and otherwise the
 * answer ends with an error. Neither is ever kept as "done".
 */

function brain(models: string[]) {
  const identity = newNodeIdentity();
  const store = new MindStore(":memory:");
  foundFleet(store, identity, { fleetName: "camelot", nodeName: "n" });
  const vault = new Vault(store, identity);
  store.emit(identity, "provider.set", { id: "local", kind: "openai", baseUrl: "http://127.0.0.1:9/v1" });
  store.emit(identity, "roster.set", { role: "planner", models });
  return { store, vault };
}

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

const frame = (chunk: object) => `data: ${JSON.stringify(chunk)}\n\n`;
const sse = (body: string): Response => new Response(body, { headers: { "content-type": "text/event-stream" } });
/** A whole reply: its chunks, then the stream's own end. */
const whole = (...chunks: object[]): Reply => () => sse(chunks.map(frame).join("") + "data: [DONE]\n\n");
const stop = { choices: [{ delta: {}, finish_reason: "stop" }] };
const words = (text: string) => ({ choices: [{ delta: { content: text } }] });
const calls = (id: string, args: object) => [{ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: "post", arguments: JSON.stringify(args) } }] } }] }, { choices: [{ delta: {}, finish_reason: "tool_calls" }] }];

const tools = (): ChatTools & { ran: number } => {
  const t = {
    ran: 0,
    specs: [{ name: "post", description: "Post a note.", inputSchema: { type: "object", properties: { text: { type: "string" } } } }],
    describe: (call: { input: unknown }) => ({ title: "Post a note", input: JSON.stringify(call.input) }),
    run: async () => {
      t.ran++;
      return { content: "posted", summary: "posted" };
    },
  };
  return t;
};

const ask = (content: string) => [{ role: "user" as const, content }];
const all = async (events: AsyncGenerator<ChatStreamEvent>) => {
  const out: ChatStreamEvent[] = [];
  // What each call cost is usage.test.ts's to check: these read the answer's own flow.
  for await (const e of events) if (e.type !== "usage") out.push(e);
  return out;
};
const types = (events: ChatStreamEvent[]) => events.map((e) => e.type);
const textOf = (events: ChatStreamEvent[]) => events.flatMap((e) => (e.type === "text" ? [e.text] : [])).join("");
const errorOf = (events: ChatStreamEvent[]) => events.flatMap((e) => (e.type === "error" ? [e.error] : [])).join("");

describe("an answer with no words in it", () => {
  test("a reply that stops arriving before the model was done is an error, never a finished answer", async () => {
    // Half a sentence, and then the stream just ends: no finish reason, no end-of-stream marker.
    const model = scripted([() => sse(frame(words("Half a sen")))]);
    const events = await all(chat({ ...brain(["local/a"]), fetch: model.fetch }, { messages: ask("Go on") }));
    expect(textOf(events)).toBe("Half a sen");
    expect(types(events)).not.toContain("done");
    expect(errorOf(events)).toMatch(/stopped arriving before it was finished/);
  });

  test("after his tools ran, a reply that ends cleanly with nothing said is an error that says what did arrive", async () => {
    const t = tools();
    const model = scripted([
      whole(...calls("c1", { text: "one" })),
      // It ends properly, but its words went somewhere this node doesn't read.
      whole({ choices: [{ delta: { reasoning: "I should summarise now." } }] }, stop),
    ]);
    const events = await all(chat({ ...brain(["local/a"]), fetch: model.fetch }, { messages: ask("Post it, then tell me"), tools: t }));
    expect(t.ran).toBe(1);
    expect(types(events)).not.toContain("done");
    expect(errorOf(events)).toMatch(/ended its answer without saying anything/);
    expect(errorOf(events)).toMatch(/finish reason: stop/);
    expect(errorOf(events)).toMatch(/reasoning/);
  });

  test("he may end without another word when he has already spoken in this answer", async () => {
    const t = tools();
    const model = scripted([whole(words("Posting it now."), ...calls("c1", { text: "one" })), whole(stop)]);
    const events = await all(chat({ ...brain(["local/a"]), fetch: model.fetch }, { messages: ask("Post it"), tools: t }));
    expect(textOf(events)).toBe("Posting it now.");
    expect(types(events).at(-1)).toBe("done");
    expect(errorOf(events)).toBe("");
  });

  test("a reply his provider's filter ended is asked for again: what was done stays done, and nothing runs twice", async () => {
    const t = tools();
    const filtered = whole({ choices: [{ delta: {}, finish_reason: "content_filter" }] });
    const model = scripted([whole(...calls("c1", { text: "one" })), filtered, whole(words("All posted."), stop)]);
    const events = await all(chat({ ...brain(["local/a"]), fetch: model.fetch }, { messages: ask("Post it, then tell me"), tools: t }));
    expect(t.ran).toBe(1);
    expect(textOf(events)).toBe("All posted.");
    expect(types(events).at(-1)).toBe("done");
    // The same conversation, sent again as it stood.
    expect(model.bodies).toHaveLength(3);
    expect(model.bodies[2].messages).toEqual(model.bodies[1].messages);
  });

  test("ended by the filter again and again: the answer ends saying he declined, and is never kept as done", async () => {
    const t = tools();
    const filtered = whole({ choices: [{ delta: {}, finish_reason: "content_filter" }] });
    const model = scripted([whole(...calls("c1", { text: "one" })), filtered, filtered, filtered, whole(words("Too late."), stop)]);
    const events = await all(chat({ ...brain(["local/a"]), fetch: model.fetch }, { messages: ask("Post it, then tell me"), tools: t }));
    expect(model.bodies).toHaveLength(1 + 1 + MAX_REFUSAL_RETRIES);
    expect(types(events)).not.toContain("done");
    expect(errorOf(events)).toMatch(/declined to go on/);
    expect(errorOf(events)).toMatch(/content filter/);
    expect(textOf(events)).toBe("");
  });

  test("a reply the filter cut after he had begun to speak is not asked for again (he would say it twice)", async () => {
    const model = scripted([whole(words("The first half, and"), { choices: [{ delta: {}, finish_reason: "content_filter" }] }), whole(words("never asked"), stop)]);
    const events = await all(chat({ ...brain(["local/a"]), fetch: model.fetch }, { messages: ask("Go on") }));
    expect(model.bodies).toHaveLength(1);
    expect(textOf(events)).toBe("The first half, and");
    expect(errorOf(events)).toMatch(/declined to go on/);
  });

  test("filtered before anything happened, every time: the next model takes over", async () => {
    const filtered = whole({ choices: [{ delta: {}, finish_reason: "content_filter" }] });
    const model = scripted([filtered, filtered, filtered, whole(words("Here I am."), stop)]);
    const events = await all(chat({ ...brain(["local/a", "local/b"]), fetch: model.fetch }, { messages: ask("Anyone?") }));
    expect(types(events)).toEqual(["model", "fallback", "model", "text", "done"]);
    expect(model.bodies.map((b) => b.model)).toEqual(["a", "a", "a", "b"]);
  });

  test("declined for good after he has only looked: the next model takes the answer over, and may look again", async () => {
    const t = { ...tools(), readOnly: () => true };
    const filtered = whole({ choices: [{ delta: {}, finish_reason: "content_filter" }] });
    const model = scripted([
      whole(words("Looking it up."), ...calls("c1", { text: "one" })),
      filtered,
      filtered,
      filtered,
      whole(...calls("c2", { text: "one" })),
      whole(words("Here it is."), stop),
    ]);
    const ran: string[] = [];
    t.run = async () => {
      ran.push("post");
      return { content: "posted", summary: "posted" };
    };
    const events = await all(chat({ ...brain(["local/a", "local/b"]), fetch: model.fetch }, { messages: ask("Look it up and tell me"), tools: t }));
    expect(model.bodies.map((b) => b.model)).toEqual(["a", "a", "a", "a", "b", "b"]);
    // The second model starts the answer again from your message: it isn't handed the first one's half-told turn.
    expect(model.bodies[4].messages.map((m: { role: string }) => m.role)).toEqual(["system", "user"]);
    expect(ran).toHaveLength(2);
    expect(types(events)).toEqual(["model", "text", "tool", "tool_result", "fallback", "model", "tool", "tool_result", "text", "text", "done"]);
    expect(textOf(events)).toBe("Looking it up.\n\nHere it is.");
    expect(events.find((e) => e.type === "fallback")).toMatchObject({ from: "local/a", error: expect.stringMatching(/declined to go on/) });
  });

  test("declined after a tool that changes something ran: the answer ends there, and no other model runs it again", async () => {
    const t = tools();
    const filtered = whole({ choices: [{ delta: {}, finish_reason: "content_filter" }] });
    const model = scripted([whole(...calls("c1", { text: "one" })), filtered, filtered, filtered, whole(words("Never asked."), stop)]);
    const events = await all(chat({ ...brain(["local/a", "local/b"]), fetch: model.fetch }, { messages: ask("Post it, then tell me"), tools: t }));
    expect(model.bodies.map((b) => b.model)).toEqual(["a", "a", "a", "a"]);
    expect(t.ran).toBe(1);
    expect(types(events)).not.toContain("done");
    expect(types(events)).not.toContain("fallback");
    expect(errorOf(events)).toMatch(/declined to go on/);
  });

  test("every model that could take over declines too: the answer ends saying so", async () => {
    const t = { ...tools(), readOnly: () => true };
    const filtered = whole({ choices: [{ delta: {}, finish_reason: "content_filter" }] });
    const model = scripted([whole(...calls("c1", { text: "one" })), filtered, filtered, filtered, filtered, filtered, filtered]);
    const events = await all(chat({ ...brain(["local/a", "local/b"]), fetch: model.fetch }, { messages: ask("Look it up and tell me"), tools: t }));
    expect(types(events)).not.toContain("done");
    expect(errorOf(events)).toMatch(/declined to go on/);
    expect(errorOf(events)).toMatch(/no other model/i);
  });

  test("a first reply with nothing in it: the next model takes over", async () => {
    const model = scripted([whole(stop), whole(words("Here I am."), stop)]);
    const events = await all(chat({ ...brain(["local/a", "local/b"]), fetch: model.fetch }, { messages: ask("Anyone?") }));
    expect(types(events)).toEqual(["model", "fallback", "model", "text", "done"]);
    expect(textOf(events)).toBe("Here I am.");
    expect(model.bodies.map((b) => b.model)).toEqual(["a", "b"]);
  });
});

describe("a provider that sends its words in parts", () => {
  test("text parts are his words, in order; a thinking part is not; every text event is a string", async () => {
    // Mistral's larger models stream `content` as a list of parts (a terminal crashed printing one).
    const model = scripted([
      whole(
        { choices: [{ delta: { content: [{ type: "thinking", thinking: [{ type: "text", text: "Let me see." }] }] } }] },
        { choices: [{ delta: { content: [{ type: "text", text: "Good " }] } }] },
        { choices: [{ delta: { content: [{ type: "text", text: "morning" }, { type: "text", text: ", my liege." }] } }] },
        { choices: [{ delta: { content: "" } }] },
        stop,
      ),
    ]);
    const events = await all(chat({ ...brain(["local/a"]), fetch: model.fetch }, { messages: ask("Greet me") }));
    for (const e of events) if (e.type === "text") expect(typeof e.text).toBe("string");
    expect(textOf(events)).toBe("Good morning, my liege.");
    expect(types(events).at(-1)).toBe("done");
  });

  test("only a thinking part and nothing said: that is an answer with no words, and it says what did arrive", async () => {
    const model = scripted([whole({ choices: [{ delta: { content: [{ type: "thinking", thinking: [{ type: "text", text: "Hm." }] }] } }] }, stop)]);
    const events = await all(chat({ ...brain(["local/a"]), fetch: model.fetch }, { messages: ask("Greet me") }));
    expect(types(events)).not.toContain("done");
    expect(textOf(events)).toBe("");
    // Nothing had happened yet, so it's a skip (and there is no other model here to take over).
    expect(events.find((e) => e.type === "fallback")).toMatchObject({ error: expect.stringMatching(/without saying anything/) });
  });
});

// A call asked with no tools (a review, an audit) whose model answers with a call anyway: on Ultra, 22 November 2026,
// a knight's audit failed twice so ("undefined is not an object (evaluating 'tools.describe')"), and was asked again
// after fifteen seconds and a minute. A call it wasn't offered is never run: its words are the answer, and a reply
// with nothing else in it is one with no words, which the next model takes over.
describe("a model that asks for a tool it wasn't offered", () => {
  test("its words are the answer, and the call is never run", async () => {
    const model = scripted([whole(words("ON\nIt is reading the commits it was given."), ...calls("c1", { text: "one" }))]);
    const events = await all(chat({ ...brain(["local/a"]), fetch: model.fetch }, { messages: ask("Is the work on its task?") }));
    expect(textOf(events)).toBe("ON\nIt is reading the commits it was given.");
    expect(types(events)).not.toContain("tool");
    expect(types(events).at(-1)).toBe("done");
    expect(errorOf(events)).toBe("");
  });

  test("with nothing but the call, the next model answers in its place", async () => {
    const model = scripted([whole(...calls("c1", { text: "one" })), whole(words("ON\nIt is on its task."), stop)]);
    const events = await all(chat({ ...brain(["local/a", "local/b"]), fetch: model.fetch }, { messages: ask("Is the work on its task?") }));
    expect(textOf(events)).toBe("ON\nIt is on its task.");
    expect(types(events)).toContain("fallback");
    expect(types(events).at(-1)).toBe("done");
    expect(model.bodies.map((b) => b.model)).toEqual(["a", "b"]);
  });

  test("with nothing but the call and no model after it, the error says what it did, never a crash's words", async () => {
    const model = scripted([whole(...calls("c1", { text: "one" }))]);
    const events = await all(chat({ ...brain(["local/a"]), fetch: model.fetch }, { messages: ask("Is the work on its task?") }));
    expect(types(events)).not.toContain("done");
    expect(errorOf(events)).toMatch(/asked for a tool \(post\) when it was offered none/);
    expect(errorOf(events)).not.toMatch(/undefined is not an object/);
  });
});
