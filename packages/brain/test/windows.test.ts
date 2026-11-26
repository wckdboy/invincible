import { describe, expect, test } from "bun:test";
import { type ChatStreamEvent, newNodeIdentity } from "@galahad/core";
import { foundFleet, MindStore, Vault } from "@galahad/mind";
import { chat } from "../src/index.ts";
import { type SpentWindow, SpentWindows, spentUntil, windowScope, windowsOf } from "../src/windows.ts";

/*
 * A plan's allowance runs in windows (OpenCode Go: five hours). Once its provider has said the window is spent and
 * when it resets, asking it again before then only fails again, slowly: on 14 November 2026 every call of a sweep
 * did, each time before the next model was tried. So a node remembers the window, passes the plan's models over
 * without asking until it ends, and says until when; then it asks again.
 */

const MIN = 60_000;
const GO = `opencode-go → 429 {"type":"error","error":{"type":"GoUsageLimitError","message":"Go usage limit reached (5-hour, resets in 1h 37m). Upgrade or wait."}}`;

describe("reading a spent allowance from a provider's refusal", () => {
  test("its reset, as OpenCode Go and others put it", () => {
    expect(spentUntil(GO, 1_000)).toBe(1_000 + 97 * MIN);
    expect(spentUntil("429 quota exceeded: resets in 45m", 0)).toBe(45 * MIN);
    expect(spentUntil("429 daily limit reached; resets in 2 hours", 0)).toBe(120 * MIN);
    expect(spentUntil("weekly usage limit reached, resets in 3 days", 0)).toBe(3 * 24 * 60 * MIN);
    expect(spentUntil("429 rate limit reached for requests; try again in 20s", 0)).toBe(20_000);
  });

  test("a refusal that is not about an allowance, or says nothing of when, is no window", () => {
    expect(spentUntil("429 Too Many Requests", 0)).toBeNull();
    expect(spentUntil("usage limit reached", 0)).toBeNull();
    expect(spentUntil("500 internal error, resets in 5m", 0)).toBeNull();
    expect(spentUntil("You've hit your usage limit. Try again at 3:45 PM.", 0)).toBeNull();
    // Nothing absurd: a "reset" months away is not believed.
    expect(spentUntil("usage limit reached, resets in 400 days", 0)).toBeNull();
  });
});

function brain() {
  const identity = newNodeIdentity();
  const store = new MindStore(":memory:");
  foundFleet(store, identity, { fleetName: "camelot", nodeName: "n" });
  const vault = new Vault(store, identity);
  store.emit(identity, "provider.set", { id: "plan", kind: "openai", baseUrl: "http://127.0.0.1:9/v1" });
  store.emit(identity, "provider.set", { id: "spare", kind: "openai", baseUrl: "http://localhost:9/v1" });
  // (A router of many vendors' models, on this machine so it needs no key here.)
  store.emit(identity, "provider.set", { id: "router", kind: "openai", baseUrl: "http://localhost:8/v1" });
  store.emit(identity, "roster.set", { role: "planner", models: ["plan/a", "spare/b"] });
  return { store, vault };
}

describe("a provider whose allowance is spent", () => {
  test("is passed over without being asked until its window ends, and says until when; then it is asked again", async () => {
    const asked: string[] = [];
    let planSpent = true;
    const fetch = (async (url: string | URL | Request) => {
      const host = new URL(String(url)).host;
      asked.push(host === "127.0.0.1:9" ? "plan" : "spare");
      if (host === "127.0.0.1:9" && planSpent) return new Response(GO.slice(GO.indexOf("{")), { status: 429 });
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "Answered." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    }) as typeof globalThis.fetch;
    const ctx = { ...brain(), fetch };
    let now = Date.UTC(2026, 10, 14, 6, 18);
    windowsOf(ctx.store).now = () => now;
    const run = async () => {
      const events: ChatStreamEvent[] = [];
      for await (const e of chat(ctx, { messages: [{ role: "user", content: "Go on" }] })) if (e.type !== "usage") events.push(e);
      return events;
    };
    // The first time it is asked, refuses, and the next model answers.
    const first = await run();
    expect(asked).toEqual(["plan", "spare"]);
    expect(first.find((e) => e.type === "fallback")).toMatchObject({ from: "plan/a", error: expect.stringContaining("resets in 1h 37m") });
    // Ten minutes on, it isn't asked at all, and the reason says until when.
    now += 10 * MIN;
    asked.length = 0;
    const second = await run();
    expect(asked).toEqual(["spare"]);
    expect(second.find((e) => e.type === "fallback")).toMatchObject({ from: "plan/a", error: "its allowance is spent until 07:55 UTC (1h 27m from now), as its provider said: passed over without asking" });
    // (A provider of yours that isn't a coding plan's preset: the window is the model's, as any API's or router's is.)
    expect(windowsOf(ctx.store).list()).toEqual([{ provider: "plan/a", until: Date.UTC(2026, 10, 14, 7, 55), noted: Date.UTC(2026, 10, 14, 6, 18), said: expect.stringContaining("GoUsageLimitError") }]);
    // Once the window has ended it is asked again, and answers.
    now = Date.UTC(2026, 10, 14, 7, 56);
    planSpent = false;
    asked.length = 0;
    const third = await run();
    expect(asked).toEqual(["plan"]);
    expect(third.some((e) => e.type === "fallback")).toBe(false);
    expect(windowsOf(ctx.store).list()).toEqual([]);
  });

  test("each window is handed on to be kept, and those kept from before a restart are taken up while they last", () => {
    const now = 1_795_262_400_000;
    const told: SpentWindow[] = [];
    const before = new SpentWindows();
    before.now = () => now;
    before.kept = (window) => void told.push(window);
    const window = before.note("opencode-go", GO)!;
    expect(told).toEqual([window]);
    // A restart: a fresh record, given what was kept (one still open, one long over).
    const after = new SpentWindows();
    after.now = () => now + 10 * MIN;
    after.restore([window, { provider: "old-plan", until: now - 1, noted: now - 90 * MIN, said: "spent" }]);
    expect(after.spent("opencode-go")).toEqual(window);
    expect(after.spent("old-plan")).toBeNull();
    expect(after.list()).toEqual([window]);
  });

  test("a coding plan's window holds back every model of it; any other provider's, the model told to wait alone", async () => {
    // A router (OrcaRouter, OpenRouter, a Cloudflare AI Gateway) serves many vendors' models, and an API limits each
    // model apart: one told to wait says nothing of the others.
    expect(windowScope("opencode-go/glm-5.3")).toBe("opencode-go");
    expect(windowScope("orcarouter/anthropic/claude-opus-5.5")).toBe("orcarouter/anthropic/claude-opus-5.5");
    const windows = new SpentWindows();
    windows.now = () => 0;
    windows.note(windowScope("opencode-go/glm-5.3"), GO);
    windows.note(windowScope("orcarouter/anthropic/claude-opus-5.5"), "orcarouter → 429 rate limit reached for this model; try again in 2h");
    expect(windows.spentFor("opencode-go/deepseek-v4-pro")?.provider).toBe("opencode-go");
    expect(windows.spentFor("orcarouter/anthropic/claude-opus-5.5")?.provider).toBe("orcarouter/anthropic/claude-opus-5.5");
    expect(windows.spentFor("orcarouter/google/gemini-3.1-pro-preview")).toBeNull();

    // Through chat: the router's other model is asked, and answers, while the one told to wait is passed over.
    const ctx0 = brain();
    const asked: string[] = [];
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const model = (JSON.parse(String(init?.body)) as { model: string }).model;
      asked.push(model);
      if (model === "a") return new Response('{"error":{"message":"rate limit reached for a; try again in 2h"}}', { status: 429 });
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "Answered." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    }) as typeof globalThis.fetch;
    const ctx = { ...ctx0, fetch };
    windowsOf(ctx.store).now = () => 0;
    const run = async () => {
      for await (const _ of chat(ctx, { models: ["router/a", "router/b"], messages: [{ role: "user", content: "Go on" }] }));
    };
    await run();
    expect(asked).toEqual(["a", "b"]);
    await run();
    expect(asked).toEqual(["a", "b", "b"]);
    expect(windowsOf(ctx.store).list().map((w) => w.provider)).toEqual(["router/a"]);
  });

  test("each node keeps its own: another mind's windows are not this one's", () => {
    const a = brain(), b = brain();
    windowsOf(a.store).note("plan", GO);
    expect(windowsOf(a.store).spent("plan")).not.toBeNull();
    expect(windowsOf(b.store).spent("plan")).toBeNull();
  });
});
