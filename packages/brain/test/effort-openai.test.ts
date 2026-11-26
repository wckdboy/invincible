import { describe, expect, test } from "bun:test";
import { effortOf, openAIConversation, preset } from "../src/index.ts";

/*
 * How hard an OpenAI-compatible model thinks. DeepSeek's chat completions take `reasoning_effort`
 * ("none" disables thinking; low / high / max enable it), mapped from Galahad's five levels by its
 * preset (low→low, medium→high, high→high, xhigh→max, max→max). A gateway's models each take their
 * own levels (OpenCode Go's, Z.ai's GLM): a level is asked as the lowest of a model's at or above it,
 * else its highest. Every other provider, and a model its preset doesn't name, is asked as now, with
 * no level. A model that refuses the field is asked without it, and without it from then on, as
 * `stream_options` is; another model at the same address still is.
 */

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

type Level = "low" | "medium" | "high" | "xhigh" | "max";
const msg = (content: string, effort?: Level) => ({ role: "user" as const, content, ...(effort ? { effort } : {}) });

const drain = async (turn: AsyncGenerator<string, unknown>) => {
  for (let next = await turn.next(); !next.done; next = await turn.next());
};

const deepseek = { id: "deepseek", kind: "openai" as const, baseUrl: "http://127.0.0.1:9/v1", apiKey: null, local: true };
const opencodeGo = { id: "opencode-go", kind: "openai" as const, baseUrl: "http://127.0.0.1:9/go/v1", apiKey: null, local: true };
const zai = { id: "zai", kind: "openai" as const, baseUrl: "http://127.0.0.1:9/zai/v4", apiKey: null, local: true };
const LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
/** What a model is sent at each of Galahad's five levels, low to max (undefined: no level). */
async function sentAt(provider: typeof deepseek, modelId: string): Promise<(string | undefined)[]> {
  const sent: (string | undefined)[] = [];
  for (const level of LEVELS) {
    const model = scripted([whole(words("ok"), stop)]);
    const conversation = openAIConversation({ provider, model: modelId, system: "s", messages: [msg("Hi")], effort: level, fetch: model.fetch });
    await drain(conversation.turn([]));
    sent.push(model.bodies[0].reasoning_effort);
  }
  return sent;
}
const openai = { id: "openai", kind: "openai" as const, baseUrl: "http://127.0.0.1:9/v1", apiKey: null, local: true };

describe("a provider that takes a thinking level", () => {
  test("DeepSeek is asked reasoning_effort mapped from each of Galahad's levels", async () => {
    const mapped = [["low", "low"], ["medium", "high"], ["high", "high"], ["xhigh", "max"], ["max", "max"]] as const;
    for (const [level, sent] of mapped) {
      const model = scripted([whole(words("ok"), stop)]);
      const conversation = openAIConversation({ provider: deepseek, model: "deepseek-v4-pro", system: "s", messages: [msg("Hi")], effort: level, fetch: model.fetch });
      await drain(conversation.turn([]));
      expect(model.bodies[0].reasoning_effort).toBe(sent);
    }
  });

  test("the newest message that says a level is the one sent, over the call's", async () => {
    const model = scripted([whole(words("ok"), stop)]);
    const conversation = openAIConversation({
      provider: deepseek,
      model: "deepseek-v4-pro",
      system: "s",
      messages: [msg("first", "medium"), msg("then", "xhigh"), msg("last", "low")],
      effort: "high",
      fetch: model.fetch,
    });
    await drain(conversation.turn([]));
    expect(model.bodies[0].reasoning_effort).toBe("low");
  });
});

describe("a gateway whose models each take their own levels", () => {
  test("OpenCode Go: GLM-5.3 and Kimi K3.1 Pro low, high or max; DeepSeek V4 Pro high or max; each level asked as the least of its at or above it", async () => {
    expect(await sentAt(opencodeGo, "glm-5.3")).toEqual(["low", "high", "high", "max", "max"]);
    expect(await sentAt(opencodeGo, "kimi-k3.1-pro")).toEqual(["low", "high", "high", "max", "max"]);
    expect(await sentAt(opencodeGo, "deepseek-v4-pro")).toEqual(["high", "high", "high", "max", "max"]);
  });

  test("a model it doesn't name (its Qwen, served at its Anthropic-compatible address) is asked with no level", async () => {
    expect(await sentAt(opencodeGo, "qwen3.8-max")).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });

  test("Z.ai's own API: GLM-5.3 low, high or max; GLM-5.2 high or max", async () => {
    expect(await sentAt(zai, "glm-5.3")).toEqual(["low", "high", "high", "max", "max"]);
    expect(await sentAt(zai, "glm-5.2")).toEqual(["high", "high", "high", "max", "max"]);
  });

  test("the rule: the lowest of a model's levels at or above the one asked for, else its highest; words it can't place are passed over", () => {
    const spec = { field: "reasoning_effort", models: { qwen: ["low", "medium", "xhigh"], one: ["max"], odd: ["turbo", "low"] } };
    expect(LEVELS.map((level) => effortOf(spec, "qwen", level)?.value)).toEqual(["low", "medium", "xhigh", "xhigh", "xhigh"]);
    expect(LEVELS.map((level) => effortOf(spec, "one", level)?.value)).toEqual(["max", "max", "max", "max", "max"]);
    expect(LEVELS.map((level) => effortOf(spec, "odd", level)?.value)).toEqual(["low", "low", "low", "low", "low"]);
    expect(effortOf(spec, "unnamed", "high")).toBeNull();
    // DeepSeek's one map for every model is the same rule over low, high and max.
    expect(LEVELS.map((level) => effortOf(preset("deepseek")!.effort, "any", level)?.value)).toEqual(LEVELS.map((level) => effortOf({ field: "f", models: { m: ["low", "high", "max"] } }, "m", level)?.value));
  });
});

describe("every other OpenAI-compatible provider", () => {
  test("is asked with no level, whatever its messages say", async () => {
    const model = scripted([whole(words("ok"), stop)]);
    const conversation = openAIConversation({ provider: openai, model: "gpt-6.2-astra", system: "s", messages: [msg("Hi", "max")], effort: "max", fetch: model.fetch });
    await drain(conversation.turn([]));
    expect(model.bodies[0]).not.toHaveProperty("reasoning_effort");
    expect(model.bodies[0].stream_options).toEqual({ include_usage: true });
  });
});

describe("an endpoint that refuses the field", () => {
  test("is asked again without it, and so is the next call", async () => {
    const strict = { ...deepseek, baseUrl: "http://127.0.0.1:9/strict/v1" };
    const refuse: Reply = (body) =>
      body.reasoning_effort
        ? new Response(JSON.stringify({ error: { message: "Unrecognized request argument supplied: reasoning_effort" } }), { status: 400 })
        : sse(frame(words("ok")) + frame(stop) + "data: [DONE]\n\n");
    const model = scripted([refuse, refuse, refuse]);
    const first = openAIConversation({ provider: strict, model: "deepseek-v4-pro", system: "s", messages: [msg("Hi")], effort: "high", fetch: model.fetch });
    await drain(first.turn([]));
    expect(model.bodies.map((b) => b.reasoning_effort)).toEqual(["high", undefined]);
    const second = openAIConversation({ provider: strict, model: "deepseek-v4-pro", system: "s", messages: [msg("Again")], effort: "high", fetch: model.fetch });
    await drain(second.turn([]));
    expect(model.bodies.map((b) => b.reasoning_effort)).toEqual(["high", undefined, undefined]);
  });

  test("one that refuses the level it was asked for, in other words, is asked without it too", async () => {
    const gateway = { ...opencodeGo, baseUrl: "http://127.0.0.1:9/go-words/v1" };
    const refuse: Reply = (body) =>
      body.reasoning_effort
        ? new Response(JSON.stringify({ error: { message: "Invalid effort 'high' for this model: expected one of max" } }), { status: 400 })
        : sse(frame(words("ok")) + frame(stop) + "data: [DONE]\n\n");
    const model = scripted([refuse, refuse]);
    await drain(openAIConversation({ provider: gateway, model: "deepseek-v4-pro", system: "s", messages: [msg("Hi")], effort: "medium", fetch: model.fetch }).turn([]));
    expect(model.bodies.map((b) => b.reasoning_effort)).toEqual(["high", undefined]);
  });

  test("at a gateway, one model's refusal leaves the others asked", async () => {
    const gateway = { ...opencodeGo, baseUrl: "http://127.0.0.1:9/go-strict/v1" };
    const refuse: Reply = (body) =>
      body.reasoning_effort && body.model === "kimi-k3.1-pro"
        ? new Response(JSON.stringify({ error: { message: "reasoning_effort is not supported for this model" } }), { status: 400 })
        : sse(frame(words("ok")) + frame(stop) + "data: [DONE]\n\n");
    const model = scripted([refuse, refuse, refuse]);
    await drain(openAIConversation({ provider: gateway, model: "kimi-k3.1-pro", system: "s", messages: [msg("Hi")], effort: "xhigh", fetch: model.fetch }).turn([]));
    await drain(openAIConversation({ provider: gateway, model: "glm-5.3", system: "s", messages: [msg("Hi")], effort: "xhigh", fetch: model.fetch }).turn([]));
    expect(model.bodies.map((b) => [b.model, b.reasoning_effort])).toEqual([["kimi-k3.1-pro", "max"], ["kimi-k3.1-pro", undefined], ["glm-5.3", "max"]]);
  });
});
