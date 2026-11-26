import { describe, expect, test } from "bun:test";
import { type ChatStreamEvent, newNodeIdentity } from "@galahad/core";
import { foundFleet, MindStore, Vault } from "@galahad/mind";
import { chat, countable, originOf, preset } from "../src/index.ts";

/*
 * Work with a budget of yours (a knight's task given one, an outcome's looks) is measured at your prices, and a model
 * you've set no price for counts as nothing: on one, the work would spend past its budget with nothing said. So such
 * work is given only to a model whose spend it can count, one you've priced (or its provider) or one on this machine,
 * and any other is passed over, saying why.
 */

const GO_KEY = "sk-FAKE-opencode-go-key-for-tests-0000";
const OWN_KEY = "sk-FAKE-own-key-for-tests-0000";

function mind(roster: Record<string, string[]>, prices: Record<string, { input: number; output: number }> = {}) {
  const identity = newNodeIdentity();
  const store = new MindStore(":memory:");
  foundFleet(store, identity, { fleetName: "camelot", nodeName: "n" });
  const vault = new Vault(store, identity);
  const go = preset("opencode-go")!;
  vault.set("opencode-go", GO_KEY, { provider: "opencode-go", origin: originOf(go.baseUrl)! });
  store.emit(identity, "provider.set", { id: "opencode-go", kind: go.kind, baseUrl: go.baseUrl, secret: "opencode-go" });
  vault.set("own", OWN_KEY, { provider: "own", origin: "https://models.example.test" });
  store.emit(identity, "provider.set", { id: "own", kind: "openai", baseUrl: "https://models.example.test/v1", secret: "own" });
  // A model server on this machine: no key, and nothing to pay.
  store.emit(identity, "provider.set", { id: "ollama", kind: "openai", baseUrl: "http://127.0.0.1:11434/v1" });
  for (const [role, models] of Object.entries(roster)) store.emit(identity, "roster.set", { role, models });
  for (const [model, price] of Object.entries(prices)) store.emit(identity, "price.set", { model, price });
  return { store, vault };
}

const answering = (async () =>
  new Response('data: {"choices":[{"delta":{"content":"aye"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;

const all = async (events: AsyncGenerator<ChatStreamEvent>) => {
  const out: ChatStreamEvent[] = [];
  for await (const e of events) if (e.type !== "usage") out.push(e);
  return out;
};
const ask = [{ role: "user" as const, content: "hello" }];
const GO_PRICE = { "opencode-go/glm-5.3": { input: 0.6, output: 2.2 } };

describe("work with a budget runs only on a model whose spend it can count", () => {
  test("a model you've set no price for is passed over, saying why and how to price it, and the next one answers", async () => {
    const events = await all(chat({ ...mind({ engineer: ["own/m", "opencode-go/glm-5.3"] }, GO_PRICE), fetch: answering }, { role: "engineer", messages: ask, coding: true, budgeted: true }));
    expect(events.map((e) => e.type)).toEqual(["fallback", "model", "text", "done"]);
    expect(events[0]).toMatchObject({ type: "fallback", from: "own/m" });
    const why = (events[0] as { error: string }).error;
    expect(why).toContain("no price");
    expect(why).toContain("galahad price set own/m");
    expect(events[1]).toEqual({ type: "model", ref: "opencode-go/glm-5.3" });
  });

  test("a price for its provider (own/*) counts it, and a model on this machine needs none", async () => {
    const byProvider = await all(chat({ ...mind({ engineer: ["own/m"] }, { "own/*": { input: 1, output: 2 } }), fetch: answering }, { role: "engineer", messages: ask, coding: true, budgeted: true }));
    expect(byProvider[0]).toEqual({ type: "model", ref: "own/m" });
    const local = await all(chat({ ...mind({ engineer: ["ollama/qwen"] }), fetch: answering }, { role: "engineer", messages: ask, coding: true, budgeted: true }));
    expect(local[0]).toEqual({ type: "model", ref: "ollama/qwen" });
  });

  test("when no model can be counted it ends in an error that names each and why, and nothing is called", async () => {
    let called = 0;
    const counting = (async (...args: Parameters<typeof fetch>) => (called++, answering(...args))) as typeof fetch;
    const events = await all(chat({ ...mind({ engineer: ["own/m", "opencode-go/glm-5.3"] }), fetch: counting }, { role: "engineer", messages: ask, coding: true, budgeted: true }));
    expect(events.map((e) => e.type)).toEqual(["fallback", "fallback", "error"]);
    const error = (events.at(-1) as { error: string }).error;
    expect(error).toContain("own/m");
    expect(error).toContain("opencode-go/glm-5.3");
    expect(called).toBe(0);
  });

  test("work with no budget is given to a model you haven't priced, as ever", async () => {
    const events = await all(chat({ ...mind({ engineer: ["own/m"] }), fetch: answering }, { role: "engineer", messages: ask, coding: true }));
    expect(events[0]).toEqual({ type: "model", ref: "own/m" });
  });

  test("countable says the same of a model as the choice does", () => {
    const { store, vault } = mind({}, { ...GO_PRICE, "own/*": { input: 1, output: 2 } });
    expect(countable(store, vault, "opencode-go/glm-5.3")).toBe(true);
    expect(countable(store, vault, "opencode-go/deepseek-v4-pro")).toBe(false);
    expect(countable(store, vault, "own/anything")).toBe(true);
    expect(countable(store, vault, "ollama/qwen")).toBe(true);
    expect(countable(store, vault, "nowhere/m")).toBe(false);
  });
});
