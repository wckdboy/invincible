import { describe, expect, test } from "bun:test";
import { type ChatStreamEvent, newNodeIdentity } from "@invincible/core";
import { foundFleet, LedgerStore, Vault } from "@invincible/ledger";
import { chat, countable, originOf, paidFor, preset } from "../src/index.ts";

/*
 * Work with a budget of yours (an agent's task given one, an outcome's looks) is measured at your prices, and a model
 * you've set no price for counts as nothing: on one, the work would spend past its budget with nothing said. So such
 * work is given only to a model whose spend it can count, one you've priced (or its provider) or one on this machine,
 * and any other is passed over, saying why.
 */

const GO_KEY = "sk-FAKE-opencode-go-key-for-tests-0000";
const OWN_KEY = "sk-FAKE-own-key-for-tests-0000";

function mind(roster: Record<string, string[]>, prices: Record<string, { input: number; output: number }> = {}) {
  const identity = newNodeIdentity();
  const store = new LedgerStore(":memory:");
  foundFleet(store, identity, { fleetName: "homelab", nodeName: "n" });
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
    expect(why).toContain("invincible price set own/m");
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

/*
 * Work another node handed over is bounded by its budget (the fabric's second re-review, N7). A budget counts some
 * models' spend as nothing: one on this machine you've set no price for, a coding plan's (paid for already, priced or
 * not: moneyPrices) and one you've priced at nothing. On one of those the work would go on unbounded by what it may
 * spend, so it runs only on a model its budget counts at more than $0.
 */
describe("work another node handed over runs only on a model its budget counts at more than $0", () => {
  const PRICES = { ...GO_PRICE, "own/*": { input: 1, output: 2 }, "own/free": { input: 0, output: 0 } };

  test("one on this machine, a coding plan's and one priced at nothing are passed over, saying why; a priced one answers", async () => {
    const events = await all(chat({ ...mind({ engineer: ["ollama/qwen", "opencode-go/glm-5.3", "own/free", "own/m"] }, PRICES), fetch: answering }, { role: "engineer", messages: ask, coding: true, budgeted: true, paidOnly: true }));
    expect(events.map((e) => e.type)).toEqual(["fallback", "fallback", "fallback", "model", "text", "done"]);
    expect(events.slice(0, 3).map((e) => (e as { from: string }).from)).toEqual(["ollama/qwen", "opencode-go/glm-5.3", "own/free"]);
    for (const e of events.slice(0, 3)) expect((e as { error: string }).error).toContain("counts at more than $0");
    expect((events[1] as { error: string }).error).toContain("coding plan");
    expect(events[3]).toEqual({ type: "model", ref: "own/m" });
  });

  test("with none it ends in an error, and nothing is called; your own work with a budget may still take them", async () => {
    let called = 0;
    const counting = (async (...args: Parameters<typeof fetch>) => (called++, answering(...args))) as typeof fetch;
    const handed = await all(chat({ ...mind({ engineer: ["ollama/qwen", "opencode-go/glm-5.3"] }, GO_PRICE), fetch: counting }, { role: "engineer", messages: ask, coding: true, budgeted: true, paidOnly: true }));
    expect(handed.map((e) => e.type)).toEqual(["fallback", "fallback", "error"]);
    expect(called).toBe(0);
    const yours = await all(chat({ ...mind({ engineer: ["ollama/qwen"] }), fetch: answering }, { role: "engineer", messages: ask, coding: true, budgeted: true }));
    expect(yours[0]).toEqual({ type: "model", ref: "ollama/qwen" });
  });

  test("from a node of your own (onPlans), a coding plan's model priced above nothing answers, at its list price; one you haven't priced, or priced at nothing, is passed over", async () => {
    const roster = { engineer: ["opencode-go/kimi-k3", "opencode-go/free", "opencode-go/glm-5.3", "own/m"] };
    const prices = { ...PRICES, "opencode-go/free": { input: 0, output: 0 } };
    const events = await all(chat({ ...mind(roster, prices), fetch: answering }, { role: "engineer", messages: ask, coding: true, budgeted: true, paidOnly: true, onPlans: true }));
    expect(events.map((e) => e.type)).toEqual(["fallback", "fallback", "model", "text", "done"]);
    expect(events.slice(0, 2).map((e) => (e as { from: string }).from)).toEqual(["opencode-go/kimi-k3", "opencode-go/free"]);
    expect((events[0] as { error: string }).error).toContain("no price");
    expect((events[1] as { error: string }).error).toContain("priced it at nothing");
    expect(events[2]).toEqual({ type: "model", ref: "opencode-go/glm-5.3" });
    // Not from a node of yours: the plan's model is passed over, as ever, and the key's answers.
    const other = await all(chat({ ...mind(roster, prices), fetch: answering }, { role: "engineer", messages: ask, coding: true, budgeted: true, paidOnly: true }));
    expect(other.find((e) => e.type === "model")).toEqual({ type: "model", ref: "own/m" });
    expect(other.some((e) => e.type === "fallback" && e.from === "opencode-go/glm-5.3" && e.error.includes("coding plan"))).toBe(true);
  });

  test("paidFor says the same of a model as the choice does", () => {
    const { store, vault } = mind({}, PRICES);
    expect(paidFor(store, "own/m")).toBe(true);
    expect(paidFor(store, "own/free")).toBe(false);
    expect(paidFor(store, "opencode-go/glm-5.3")).toBe(false);
    expect(paidFor(store, "ollama/qwen")).toBe(false);
    expect(paidFor(store, "nowhere/m")).toBe(false);
    // One on this machine you've priced is counted at that price.
    const priced = mind({}, { "ollama/*": { input: 0.1, output: 0.2 } });
    expect(paidFor(priced.store, "ollama/qwen")).toBe(true);
    // On your plans (a node of your own's hand-off), a plan's model priced above nothing is counted at that price.
    expect(paidFor(store, "opencode-go/glm-5.3", undefined, true)).toBe(true);
    expect(paidFor(store, "opencode-go/deepseek-v4-pro", undefined, true)).toBe(false);
    expect(paidFor(store, "own/m", undefined, true)).toBe(true);
    expect(paidFor(store, "own/free", undefined, true)).toBe(false);
  });
});
