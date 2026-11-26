import { describe, expect, test } from "bun:test";
import { newNodeIdentity } from "@galahad/core";
import { foundFleet, MindStore, Vault } from "@galahad/mind";
import { carryOf, chat, conversationFor, RefusalError, type ResolvedProvider, speaksResponses } from "../src/index.ts";

/*
 * OpenAI's own models through its Responses API: GPT-6.2 Astra calls no tool through Chat Completions (OpenAI's own
 * docs, read 22 November 2026), so on api.openai.com Galahad speaks Responses, statelessly, its reasoning given back
 * encrypted to the model it came from. The endpoint here is a stand-in that streams events in the documented shapes;
 * no real OpenAI call is made (none is on this fleet: unverified against the live API).
 */

const OPENAI: ResolvedProvider = { id: "openai", kind: "openai", baseUrl: "https://api.openai.com/v1", apiKey: ["FAKE", "openai", "key"].join("-"), local: false } as ResolvedProvider;

/** A stream of Responses events, each as the API sends it: an `event:` line and its JSON on a `data:` line. */
const stream = (...events: Record<string, unknown>[]) => new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const completed = (usage = { input_tokens: 1200, input_tokens_details: { cached_tokens: 1000 }, output_tokens: 300, output_tokens_details: { reasoning_tokens: 200 }, total_tokens: 1500 }) => ({ type: "response.completed", response: { status: "completed", usage } });
const REASONING = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "gAAAA-sealed-reasoning" };

function standIn(...answers: Response[]) {
  const asked: { url: string; body: Record<string, any> }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    asked.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return answers.shift() ?? new Response("{}", { status: 500 });
  }) as typeof globalThis.fetch;
  return { asked, fetch };
}

async function drain<T>(turn: AsyncGenerator<string, T>): Promise<{ said: string; end: T }> {
  let said = "";
  for (let next = await turn.next(); ; next = await turn.next()) {
    if (next.done) return { said, end: next.value };
    said += next.value;
  }
}

describe("OpenAI's own API, through Responses", () => {
  test("is told by its own address; every other OpenAI-compatible provider is asked as before", () => {
    expect(speaksResponses({ kind: "openai", baseUrl: "https://api.openai.com/v1" })).toBe(true);
    for (const baseUrl of ["https://api.deepseek.com", "https://api.orcarouter.ai/v1", "https://openrouter.ai/api/v1", "http://127.0.0.1:11434/v1"]) expect(speaksResponses({ kind: "openai", baseUrl })).toBe(false);
    expect(speaksResponses({ kind: "anthropic", baseUrl: "https://api.anthropic.com" })).toBe(false);
  });

  test("a tool turn: the call read from its items, its reasoning given back encrypted with the call's output, and the answer after", async () => {
    const { asked, fetch } = standIn(
      stream(
        { type: "response.created", response: { status: "in_progress" } },
        { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [] } },
        { type: "response.output_item.done", output_index: 0, item: REASONING },
        { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "recall", arguments: "" } },
        { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 1, delta: '{"query":' },
        { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 1, delta: '"the oath"}' },
        { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 1, arguments: '{"query":"the oath"}' },
        { type: "response.output_item.done", output_index: 1, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "recall", arguments: '{"query":"the oath"}' } },
        completed(),
      ),
      stream({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "Courteous, " }, { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "candid, bound." }, completed()),
    );
    const c = conversationFor({ provider: OPENAI, model: "gpt-6.2-astra", system: "You are Galahad.", context: "Today: Sunday.", messages: [{ role: "user", content: "What is your oath?", effort: "high" }], effort: "medium", fetch });
    const first = await drain(c.turn([{ name: "recall", description: "Search what you keep.", inputSchema: { type: "object", properties: { query: { type: "string" } } } }]));
    expect(first.end).toEqual({ calls: [{ id: "call_1", name: "recall", input: { query: "the oath" } }], truncated: false });
    expect(c.spent!()).toEqual({ input: 1200, output: 300, cached: 1000, reasoning: 200 });
    // As OpenAI asks of a call it doesn't keep: Responses, stateless, its reasoning to be given back, a flat function tool.
    expect(asked[0]!.url).toBe("https://api.openai.com/v1/responses");
    expect(asked[0]!.body).toMatchObject({
      model: "gpt-6.2-astra",
      instructions: "You are Galahad.\n\nToday: Sunday.",
      input: [{ role: "user", content: "What is your oath?" }],
      stream: true,
      store: false,
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: "high" },
      tools: [{ type: "function", name: "recall", description: "Search what you keep.", parameters: { type: "object", properties: { query: { type: "string" } } }, strict: false }],
    });
    c.answer([{ id: "call_1", content: "I keep the oath of courtesy." }]);
    const second = await drain(c.turn([]));
    expect(second).toEqual({ said: "Courteous, candid, bound.", end: { calls: [], truncated: false, detail: "status: completed" } });
    // Its output goes back as it came, every item in its order (OpenAI: "preserve every item in the response's output").
    const CALL = { type: "function_call", id: "fc_1", call_id: "call_1", name: "recall", arguments: '{"query":"the oath"}' };
    expect(asked[1]!.body.input).toEqual([{ role: "user", content: "What is your oath?" }, REASONING, CALL, { type: "function_call_output", call_id: "call_1", output: "I keep the oath of courtesy." }]);
    // And goes on with the answer that called, to this model alone.
    expect(JSON.parse(c.carry!()!)).toMatchObject({ provider: "openai", model: "gpt-6.2-astra", blocks: [REASONING, CALL] });
  });

  test("a tool turn kept in the chat's history goes back with its reasoning to the model it came from, and without to another", async () => {
    const carry = carryOf("openai", "gpt-6.2-astra", { blocks: [REASONING] });
    const history = [
      { role: "user" as const, content: "What is your oath?" },
      { role: "assistant" as const, content: "", calls: [{ id: "call_1", name: "recall", input: { query: "the oath" } }], carry },
      { role: "user" as const, content: "", results: [{ id: "call_1", content: "Courtesy." }] },
    ];
    const bodies: Record<string, any>[] = [];
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return stream(completed());
    }) as typeof globalThis.fetch;
    for (const model of ["gpt-6.2-astra", "gpt-6.2-sol"]) await drain(conversationFor({ provider: OPENAI, model, system: "s", messages: history, effort: "medium", fetch }).turn([]));
    expect(bodies[0]!.input).toEqual([{ role: "user", content: "What is your oath?" }, REASONING, { type: "function_call", call_id: "call_1", name: "recall", arguments: '{"query":"the oath"}' }, { type: "function_call_output", call_id: "call_1", output: "Courtesy." }]);
    expect(bodies[1]!.input).toEqual([{ role: "user", content: "What is your oath?" }, { type: "function_call", call_id: "call_1", name: "recall", arguments: '{"query":"the oath"}' }, { type: "function_call_output", call_id: "call_1", output: "Courtesy." }]);
  });

  test("an answer's words and their phase go back as they came, never said twice", async () => {
    const MESSAGE = { type: "message", id: "msg_1", role: "assistant", status: "completed", phase: "commentary", content: [{ type: "output_text", text: "Looking.", annotations: [] }] };
    const CALL = { type: "function_call", id: "fc_2", call_id: "call_2", name: "recall", arguments: "{}" };
    const { asked, fetch } = standIn(
      stream(
        { type: "response.output_text.delta", output_index: 0, delta: "Looking." },
        { type: "response.output_item.done", output_index: 0, item: MESSAGE },
        { type: "response.output_item.added", output_index: 1, item: { ...CALL, arguments: "" } },
        { type: "response.output_item.done", output_index: 1, item: CALL },
        completed(),
      ),
      stream(completed()),
    );
    const c = conversationFor({ provider: OPENAI, model: "gpt-6.2-astra", system: "s", messages: [{ role: "user", content: "Look it up" }], effort: "medium", fetch });
    expect((await drain(c.turn([]))).end.calls).toEqual([{ id: "call_2", name: "recall", input: {} }]);
    c.answer([{ id: "call_2", content: "Nothing." }]);
    await drain(c.turn([]));
    expect(asked[1]!.body.input).toEqual([{ role: "user", content: "Look it up" }, MESSAGE, CALL, { type: "function_call_output", call_id: "call_2", output: "Nothing." }]);
    // Kept in the chat's history with its words and its call, it goes back the same way, the call not added again.
    const history = [
      { role: "user" as const, content: "Look it up" },
      { role: "assistant" as const, content: "Looking.", calls: [{ id: "call_2", name: "recall", input: {} }], carry: c.carry!() },
      { role: "user" as const, content: "", results: [{ id: "call_2", content: "Nothing." }] },
    ];
    const again = standIn(stream(completed()));
    await drain(conversationFor({ provider: OPENAI, model: "gpt-6.2-astra", system: "s", messages: history, effort: "medium", fetch: again.fetch }).turn([]));
    expect(again.asked[0]!.body.input).toEqual(asked[1]!.body.input);
  });

  test("its end is read from the response's own status, whatever the event that carries it is called", async () => {
    const said = await drain(conversationFor({ provider: OPENAI, model: "gpt-6.2-astra", system: "s", messages: [{ role: "user", content: "Go on" }], effort: "medium", fetch: standIn(stream({ type: "response.output_text.delta", delta: "Done." }, { type: "response.done", response: { status: "completed", usage: { input_tokens: 3, output_tokens: 2 } } })).fetch }).turn([]));
    expect(said).toEqual({ said: "Done.", end: { calls: [], truncated: false, detail: "status: completed" } });
  });

  test("cut off by its output limit it is truncated; declined, or ended by a filter, it is a refusal; failed, an error in its words; stopped short, never an answer", async () => {
    const ask = async (...events: Record<string, unknown>[]) => drain(conversationFor({ provider: OPENAI, model: "gpt-6.2-astra", system: "s", messages: [{ role: "user", content: "Go on" }], effort: "medium", fetch: standIn(stream(...events)).fetch }).turn([]));
    expect((await ask({ type: "response.output_text.delta", delta: "Half" }, { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } })).end).toMatchObject({ calls: [], truncated: true });
    await expect(ask({ type: "response.refusal.delta", delta: "I can't help with that." }, completed())).rejects.toBeInstanceOf(RefusalError);
    await expect(ask({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "content_filter" } } })).rejects.toBeInstanceOf(RefusalError);
    await expect(ask({ type: "response.failed", response: { status: "failed", error: { code: "server_error", message: "The model failed." } } })).rejects.toThrow("openai → server_error: The model failed.");
    await expect(ask({ type: "error", code: "rate_limit_exceeded", message: "Slow down." })).rejects.toThrow("openai → rate_limit_exceeded: Slow down.");
    await expect(ask({ type: "response.output_text.delta", delta: "Half" })).rejects.toThrow("its reply stopped arriving before it was finished");
  });

  test("chat asks OpenAI's own API through Responses, and any other OpenAI-compatible one as ever", async () => {
    const identity = newNodeIdentity();
    const store = new MindStore(":memory:");
    foundFleet(store, identity, { fleetName: "camelot", nodeName: "n" });
    const vault = new Vault(store, identity);
    vault.set("openai", OPENAI.apiKey!, { provider: "openai", origin: "https://api.openai.com" });
    store.emit(identity, "provider.set", { id: "openai", kind: "openai", baseUrl: "https://api.openai.com/v1", secret: "openai" });
    const urls: string[] = [];
    const fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return stream({ type: "response.output_text.delta", delta: "Aye." }, completed());
    }) as typeof globalThis.fetch;
    let said = "";
    for await (const e of chat({ store, vault, fetch }, { model: "openai/gpt-6.2-astra", messages: [{ role: "user", content: "Well met" }] })) if (e.type === "text") said += e.text;
    expect(said).toBe("Aye.");
    expect(urls).toEqual(["https://api.openai.com/v1/responses"]);
  });
});

test("a model that doesn't reason refuses a level: it is asked again without one, and from then on", async () => {
  const refusal = new Response('{"error":{"message":"Unsupported parameter: \'reasoning.effort\' is not supported with this model.","type":"invalid_request_error","param":"reasoning.effort","code":"unsupported_parameter"}}', { status: 400, headers: { "content-type": "application/json" } });
  const { asked, fetch } = standIn(refusal, stream({ type: "response.output_text.delta", delta: "Aye." }, completed()), stream(completed()));
  const ask = () => drain(conversationFor({ provider: OPENAI, model: "gpt-4.1", system: "s", messages: [{ role: "user", content: "Go on" }], effort: "medium", fetch }).turn([]));
  expect((await ask()).said).toBe("Aye.");
  await ask();
  expect(asked.map((a) => [a.body.reasoning?.effort ?? null, a.body.include ?? null])).toEqual([["medium", ["reasoning.encrypted_content"]], [null, null], [null, null]]);
});
