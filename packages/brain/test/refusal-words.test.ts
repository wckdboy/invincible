import { describe, expect, test } from "bun:test";
import { type ChatStreamEvent, newNodeIdentity } from "@galahad/core";
import { foundFleet, MindStore, Vault } from "@galahad/mind";
import { chat, refusalWords, windowsOf } from "../src/index.ts";

/*
 * A provider's refusal, in its own words wherever it is shown. On the owner's node (22 November 2026) the doctor and
 * every chat that fell back quoted Anthropic's and Cloudflare's refusals as raw JSON, cut mid-word: a call's error keeps
 * the first 300 characters of the body, and Cloudflare's AI Gateway says its message twice in some 450.
 */

const CLOUDFLARE = '{"success":false,"result":[],"messages":[],"error":[{"code":2021,"message":"Insufficient unified billing credits. Please add additional credits on the AI Gateway Cloudflare dashboard to continue using provider models."}],"name":"AiGatewayError","httpCode":402,"internalCode":2021,"message":"Insufficient unified billing credits. Please add additional credits on the AI Gateway Cloudflare dashboard to continue using provider models."}';
const SAID = "Insufficient unified billing credits. Please add additional credits on the AI Gateway Cloudflare dashboard to continue using provider models.";

describe("a provider's refusal, read as words", () => {
  test("whoever said it stays in front of its status; a body cut short is read by its first whole message", () => {
    expect(refusalWords(`cloudflare-ai → 402 ${CLOUDFLARE}`, 500)).toBe(`cloudflare-ai → 402: ${SAID}`);
    expect(refusalWords(`cloudflare-ai → 402 ${CLOUDFLARE.slice(0, 300)}`, 500)).toBe(`cloudflare-ai → 402: ${SAID}`);
    // Cut before any message is whole: said as it came.
    expect(refusalWords('orcarouter → 500 {"error":{"message":"upstream ti', 500)).toBe('orcarouter → 500 {"error":{"message":"upstream ti');
    // An escaped quote in the message is read as the provider wrote it.
    expect(refusalWords('x → 400 {"error":{"message":"model \\"glm-9\\" does not exist"', 500)).toBe('x → 400: model "glm-9" does not exist');
  });

  test("words that aren't a status and a body are left as they came", () => {
    expect(refusalWords("its allowance is spent until 23:14 UTC (22h 51m from now), as its provider said: passed over without asking", 500)).toBe("its allowance is spent until 23:14 UTC (22h 51m from now), as its provider said: passed over without asking");
    expect(refusalWords("fetch failed: connect ECONNREFUSED 127.0.0.1:9", 500)).toBe("fetch failed: connect ECONNREFUSED 127.0.0.1:9");
  });
});

describe("a chat that falls back", () => {
  function brain(answer: () => Response) {
    const identity = newNodeIdentity();
    const store = new MindStore(":memory:");
    foundFleet(store, identity, { fleetName: "camelot", nodeName: "n" });
    const vault = new Vault(store, identity);
    // (On this machine, so neither needs a key here.)
    store.emit(identity, "provider.set", { id: "gateway", kind: "openai", baseUrl: "http://127.0.0.1:9/v1" });
    store.emit(identity, "provider.set", { id: "spare", kind: "openai", baseUrl: "http://localhost:9/v1" });
    const fetch = (async (url: string | URL | Request) => {
      if (new URL(String(url)).host === "127.0.0.1:9") return answer();
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "Answered." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    }) as typeof globalThis.fetch;
    return { store, vault, fetch };
  }
  const fallbacks = async (ctx: ReturnType<typeof brain>) => {
    const out: Extract<ChatStreamEvent, { type: "fallback" }>[] = [];
    for await (const e of chat(ctx, { models: ["gateway/anthropic/claude-opus-5-5", "spare/b"], messages: [{ role: "user", content: "Go on" }] })) if (e.type === "fallback") out.push(e);
    return out;
  };

  test("says the provider's own words, which every app shows as the step's detail", async () => {
    const said = await fallbacks(brain(() => new Response(CLOUDFLARE, { status: 402, headers: { "content-type": "application/json" } })));
    expect(said).toEqual([{ type: "fallback", from: "gateway/anthropic/claude-opus-5-5", error: `gateway → 402: ${SAID}` }]);
  });

  test("and a spent window is still learned from all it said", async () => {
    const go = '{"type":"error","error":{"type":"GoUsageLimitError","message":"OpenCode Go usage limit reached (5-hour, resets in 1h 37m)."}}';
    const ctx = brain(() => new Response(go, { status: 429, headers: { "content-type": "application/json" } }));
    windowsOf(ctx.store).now = () => 0;
    expect((await fallbacks(ctx))[0]!.error).toBe("gateway → 429: OpenCode Go usage limit reached (5-hour, resets in 1h 37m).");
    expect(windowsOf(ctx.store).spentFor("gateway/anthropic/claude-opus-5-5")).toMatchObject({ until: 97 * 60_000, said: expect.stringContaining("GoUsageLimitError") });
  });
});
