import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { newNodeIdentity } from "@galahad/core";
import { foundFleet, MindStore, Vault } from "@galahad/mind";
import { responsesUsage, usageReader } from "../src/gateway-usage.ts";
import { GatewayTokens, handleGateway } from "../src/index.ts";

/*
 * What a coding tool's call through the gateway cost, read from the answer as it is forwarded: each provider's own
 * form, however the answer is cut into chunks, and nothing made up when it says nothing.
 */

const bytes = (s: string) => new TextEncoder().encode(s);
/** Fed as one chunk, or a byte at a time: the answer reads the same either way. */
function read(kind: "openai" | "anthropic", answer: string, byByte = false) {
  const reader = usageReader(kind);
  const all = bytes(answer);
  if (byByte) for (const b of all) reader.feed(new Uint8Array([b]));
  else reader.feed(all);
  return reader.end();
}
const sse = (...events: unknown[]) => events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("");

describe("a coding tool's call, read as the gateway forwards it", () => {
  const chat = sse(
    { choices: [{ delta: { content: "Hél" } }] },
    { choices: [{ delta: { content: "lo" } }] },
    { choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 100 } } },
    "[DONE]",
  );

  test("OpenAI's chat completions: the usage on the stream's last chunk, however the stream is cut", () => {
    expect(read("openai", chat)).toEqual({ input: 120, output: 30, cached: 100 });
    expect(read("openai", chat, true)).toEqual({ input: 120, output: 30, cached: 100 });
  });

  test("a stream that wasn't asked for its usage says none, and none is made up", () => {
    expect(read("openai", sse({ choices: [{ delta: { content: "hi" } }] }, "[DONE]"))).toBeNull();
  });

  test("OpenAI's Responses (Codex): the usage of response.completed, the cached and reasoning parts within it", () => {
    const answer = `event: response.created\ndata: {"type":"response.created"}\n\nevent: response.completed\n${sse({ type: "response.completed", response: { usage: { input_tokens: 200, output_tokens: 50, input_tokens_details: { cached_tokens: 150 }, output_tokens_details: { reasoning_tokens: 20 } } } })}`;
    expect(read("openai", answer, true)).toEqual({ input: 200, output: 50, cached: 150, reasoning: 20 });
    expect(responsesUsage({ input_tokens: 5 })).toBeNull();
  });

  test("Anthropic's messages: the input from message_start (what was read from the cache and written to it too), the output from the last message_delta", () => {
    const answer = sse(
      { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 5, output_tokens: 1 } } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } },
      { type: "message_delta", usage: { output_tokens: 42 } },
      { type: "message_stop" },
    );
    expect(read("anthropic", answer, true)).toEqual({ input: 105, output: 42, cached: 90 });
  });

  test("an answer that isn't a stream: its body's usage, in whichever of the three forms it is", () => {
    expect(read("openai", JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } }))).toEqual({ input: 7, output: 3 });
    expect(read("openai", JSON.stringify({ object: "response", usage: { input_tokens: 4, output_tokens: 1 } }))).toEqual({ input: 4, output: 1 });
    expect(read("anthropic", JSON.stringify({ type: "message", usage: { input_tokens: 5, output_tokens: 2 } }))).toEqual({ input: 5, output: 2, cached: 0 });
  });

  test("what isn't an answer it knows says nothing: not JSON, no usage, a usage that isn't one", () => {
    expect(read("openai", "upstream said something else")).toBeNull();
    expect(read("openai", JSON.stringify({ choices: [] }))).toBeNull();
    expect(read("openai", JSON.stringify({ usage: { prompt_tokens: "many" } }))).toBeNull();
    expect(read("openai", "")).toBeNull();
  });

  test("a line too long to be a usage event is passed over, and what follows it is still read", () => {
    const huge = `data: {"choices":[{"delta":{"content":"${"x".repeat((1 << 20) + 10)}"}}]}\n\n`;
    expect(read("openai", huge + sse({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2 } }))).toEqual({ input: 1, output: 2 });
  });
});

/*
 * Through the gateway itself: a tool's call is forwarded exactly as the provider answered it, and what it cost is
 * told once the answer has ended, under the label of the token it called with. A listing isn't a model call.
 */
describe("the gateway tells what a tool's call cost", () => {
  const KEY = ["FAKE", "gateway", "usage", "key"].join("-");
  const answer = sse(
    { choices: [{ delta: { content: "Hello" } }] },
    { choices: [], usage: { prompt_tokens: 64, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 32 } } },
    "[DONE]",
  );
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) =>
      new URL(req.url).pathname.endsWith("/models")
        ? Response.json({ data: [{ id: "m" }] })
        : new Response(answer, { headers: { "content-type": "text/event-stream" } }),
  });
  afterAll(async () => await provider.stop(true));

  function node() {
    const identity = newNodeIdentity();
    const store = new MindStore(":memory:");
    foundFleet(store, identity, { fleetName: "camelot", nodeName: "ultra" });
    const vault = new Vault(store, identity);
    const baseUrl = `http://127.0.0.1:${provider.port}/v1`;
    vault.set("stand-in", KEY, { provider: "stand-in", origin: new URL(baseUrl).origin });
    store.emit(identity, "provider.set", { id: "stand-in", kind: "openai", baseUrl, secret: "stand-in" });
    const tokens = new GatewayTokens(new Database(":memory:"));
    const { token } = tokens.mint({ label: "sandbox:0123456789", providers: ["stand-in"], ttlMinutes: 10, maxRequests: 10 });
    const told: unknown[] = [];
    return { store, vault, tokens, token, told, onUsage: (call: unknown) => void told.push(call) };
  }

  test("forwarded byte for byte, and told once it has ended: who, which provider and model, and its tokens", async () => {
    const n = node();
    const response = await handleGateway(
      new Request("http://127.0.0.1:7777/gw/stand-in/chat/completions", { method: "POST", headers: { authorization: `Bearer ${n.token}`, "content-type": "application/json" }, body: JSON.stringify({ model: "glm-5.3", stream: true, messages: [] }) }),
      n,
    );
    expect(n.told).toEqual([]);
    expect(await response.text()).toBe(answer);
    expect(n.told).toEqual([{ label: "sandbox:0123456789", provider: "stand-in", model: "glm-5.3", usage: { input: 64, output: 8, cached: 32 } }]);
  });

  test("a listing of models is no model call: nothing is told of it", async () => {
    const n = node();
    const response = await handleGateway(new Request("http://127.0.0.1:7777/gw/stand-in/models", { headers: { authorization: `Bearer ${n.token}` } }), n);
    expect(await response.json()).toEqual({ data: [{ id: "m" }] });
    expect(n.told).toEqual([]);
  });
});
