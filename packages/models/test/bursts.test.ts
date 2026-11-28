import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { type ChatStreamEvent, newNodeIdentity } from "@invincible/core";
import { foundFleet, LedgerStore, Vault } from "@invincible/ledger";
import { chat, GatewayTokens, handleGateway, Pacer, preset, refusedKeysOf, SpentWindows, windowsOf } from "../src/index.ts";

/*
 * Too many calls at once (28 November 2026): OpenCode Go answers a burst past about 25 calls a minute with 429, "Rate
 * limit exceeded. Please try again later.", while its allowance is far from spent, and several agents and looks on one
 * plan reach that in real work. Asked through the gateway (a tool's call, a look) or by a run's own turn (chat), such a
 * refusal is waited out and asked again, within a minute; never kept as the plan's spent window; and, still refused
 * after that, said plainly, never as a broken model or a missing key. Each stand-in here 429s a burst, then recovers.
 */

const KEY = ["FAKE", "plan", "key"].join("-");
const SAID = "Rate limit exceeded. Please try again later.";
const burst = (headers: Record<string, string> = {}, said = SAID) => () =>
  new Response(JSON.stringify({ error: { message: said } }), { status: 429, headers: { "content-type": "application/json", ...headers } });
const answered = () => Response.json({ choices: [{ message: { content: "640,400" } }] });
const GO = '{"type":"error","error":{"type":"GoUsageLimitError","message":"OpenCode Go usage limit reached (5-hour, resets in 1h 37m). To keep going now, turn on Extra Usage."}}';
const GIVEN_UP = `opencode-go is taking too many calls at once: asked 6 times over 60 s, it still answered 429 ("${SAID}"). That's a limit on how fast it's called, not its allowance: ask again in a minute.`;

/** A node and its gateway, its plan's provider a stand-in that answers each call in turn (the last again and again). */
function gateway(answers: (() => Response)[], pacer?: Pacer) {
  const id = "opencode-go";
  const identity = newNodeIdentity();
  const store = new LedgerStore(":memory:");
  foundFleet(store, identity, { fleetName: "homelab", nodeName: "ultra" });
  const vault = new Vault(store, identity);
  const baseUrl = "https://plan.invalid/v1";
  vault.set(id, KEY, { provider: id, origin: new URL(baseUrl).origin });
  store.emit(identity, "provider.set", { id, kind: "openai", baseUrl, secret: id });
  const tokens = new GatewayTokens(new Database(":memory:"));
  const { token } = tokens.mint({ label: "sandbox:0123456789", providers: [id], ttlMinutes: 10, maxRequests: 20 });
  let asked = 0;
  const slept: number[] = [];
  const ctx = {
    store,
    vault,
    tokens,
    fetch: (async () => answers[Math.min(asked++, answers.length - 1)]!()) as unknown as typeof fetch,
    sleep: async (ms: number) => void slept.push(ms),
    ...(pacer ? { pacer } : {}),
  };
  let now = Date.UTC(2026, 10, 28, 1, 30);
  windowsOf(store).now = () => now;
  const call = (headers: Record<string, string> = {}, signal?: AbortSignal) =>
    handleGateway(
      new Request(`http://127.0.0.1:7400/gw/${id}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
        body: JSON.stringify({ model: "kimi-k3.1-pro", messages: [] }),
        ...(signal ? { signal } : {}),
      }),
      ctx,
    );
  return { store, ctx, call, slept, asked: () => asked, later: (ms: number) => (now += ms) };
}

const messageOf = async (response: Response) => ((await response.json()) as { error: { message: string } }).error.message;

describe("a burst through the gateway: a tool's call, and a look", () => {
  const callers = [
    ["a tool's call", {}],
    ["a look", { "user-agent": "invincible-desktop/2" }],
  ] as const;

  test.each(callers)("%s that meets a burst (a 429 that names no allowance and no wait) is asked again after 2 s, then 4 s, and gets its answer: nothing kept as spent", async (_, headers) => {
    const g = gateway([burst(), burst(), answered]);
    const response = await g.call(headers);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { choices: { message: { content: string } }[] }).choices[0]!.message.content).toBe("640,400");
    expect(g.asked()).toBe(3);
    expect(g.slept).toEqual([2000, 4000]);
    expect(windowsOf(g.store).list()).toEqual([]);
    expect(refusedKeysOf(g.store).list()).toEqual([]);
  });

  test("its own wait is honoured, by its retry-after or its words, and is never shorter than the backoff's", async () => {
    const told = gateway([burst({ "retry-after": "3" }), answered]);
    expect((await told.call()).status).toBe(200);
    expect(told.slept).toEqual([3000]);
    const short = gateway([burst({ "retry-after": "1" }), burst({ "retry-after": "1" }), answered]);
    expect((await short.call()).status).toBe(200);
    expect(short.slept).toEqual([2000, 4000]);
    const worded = gateway([burst({}, "Rate limit reached for requests; try again in 20s."), answered]);
    expect((await worded.call()).status).toBe(200);
    expect(worded.slept).toEqual([20_000]);
    for (const g of [told, short, worded]) expect(windowsOf(g.store).list()).toEqual([]);
  });

  test.each(callers)("%s whose burst doesn't clear in a minute is told so plainly: too many calls at once, not a broken model or a spent allowance; nothing kept as spent", async (_, headers) => {
    const g = gateway([burst()]);
    const response = await g.call(headers);
    expect(response.status).toBe(429);
    expect(g.asked()).toBe(6);
    expect(g.slept).toEqual([2000, 4000, 8000, 16_000, 30_000]);
    expect(response.headers.get("x-invincible-waited")).toBe("6 asks, 60000 ms");
    expect(await messageOf(response)).toBe(GIVEN_UP);
    expect(windowsOf(g.store).list()).toEqual([]);
    expect(refusedKeysOf(g.store).list()).toEqual([]);
    // Its next call is asked of the provider as ever: no window holds it back.
    g.later(60_000);
    await g.call(headers);
    expect(g.asked()).toBe(12);
  });

  test("a burst that keeps asking to wait 20 s is waited out three times, then told so, its retry-after kept", async () => {
    const g = gateway([burst({ "retry-after": "20" })]);
    const response = await g.call();
    expect(response.status).toBe(429);
    expect(g.slept).toEqual([20_000, 20_000, 20_000]);
    expect(g.asked()).toBe(4);
    expect(response.headers.get("retry-after")).toBe("20");
    expect(await messageOf(response)).toContain("too many calls at once: asked 4 times over 60 s");
    expect(windowsOf(g.store).list()).toEqual([]);
  });

  test("a refusal that names an allowance, or asks for longer than a minute, is no burst: asked once, said as before", async () => {
    const spent = gateway([() => new Response(GO, { status: 429, headers: { "content-type": "application/json", "retry-after": "5820" } })]);
    expect((await spent.call()).status).toBe(402);
    const long = gateway([burst({ "retry-after": "7200" }, "Too Many Requests")]);
    expect((await long.call()).status).toBe(402);
    const quota = gateway([burst({}, "You exceeded your current quota, please check your plan and billing details.")]);
    const refused = await quota.call();
    expect(refused.status).toBe(429);
    expect(await messageOf(refused)).toBe("You exceeded your current quota, please check your plan and billing details.");
    for (const g of [spent, long, quota]) {
      expect(g.asked()).toBe(1);
      expect(g.slept).toEqual([]);
    }
    expect(windowsOf(spent.store).list().map((w) => w.provider)).toEqual(["opencode-go"]);
    expect(windowsOf(long.store).list().map((w) => w.provider)).toEqual(["opencode-go"]);
  });

  test("a caller that has gone stops the wait: its call isn't asked again", async () => {
    const g = gateway([burst(), answered]);
    const gone = new AbortController();
    g.ctx.sleep = async (ms: number) => {
      g.slept.push(ms);
      gone.abort();
    };
    expect((await g.call({}, gone.signal)).status).toBe(429);
    expect(g.asked()).toBe(1);
    expect(windowsOf(g.store).list()).toEqual([]);
  });
});

/** A node whose run's turns go to its plan's provider itself (chat, no gateway): a stand-in, in turn, as above. */
function brain(answers: (() => Response)[], pacer?: Pacer) {
  const identity = newNodeIdentity();
  const store = new LedgerStore(":memory:");
  foundFleet(store, identity, { fleetName: "homelab", nodeName: "ultra" });
  const vault = new Vault(store, identity);
  const baseUrl = "https://plan.invalid/v1";
  vault.set("opencode-go", KEY, { provider: "opencode-go", origin: new URL(baseUrl).origin });
  store.emit(identity, "provider.set", { id: "opencode-go", kind: "openai", baseUrl, secret: "opencode-go" });
  const asked: string[] = [];
  const slept: number[] = [];
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    asked.push(init?.body ? (JSON.parse(String(init.body)) as { model: string }).model : `${init?.method ?? "GET"} without a body`);
    return answers[Math.min(asked.length - 1, answers.length - 1)]!();
  }) as unknown as typeof globalThis.fetch;
  const ctx = { store, vault, fetch, sleep: async (ms: number) => void slept.push(ms), ...(pacer ? { pacer } : {}) };
  windowsOf(store).now = () => Date.UTC(2026, 10, 28, 1, 30);
  const turn = async (models: string[]) => {
    const events: ChatStreamEvent[] = [];
    // (A run's turn: coding work, which a plan's key is for.)
    for await (const e of chat(ctx, { coding: true, models, messages: [{ role: "user", content: "Go on" }] })) if (e.type !== "usage") events.push(e);
    return events;
  };
  return { store, asked, slept, turn };
}

const streamed = () =>
  new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "Answered." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });

describe("a burst in a run's own turn (chat, to the provider itself)", () => {
  test("is waited out the same way, and the same model answers: no fallback, nothing kept as spent", async () => {
    const b = brain([burst(), burst(), streamed]);
    const events = await b.turn(["opencode-go/glm-5.3", "opencode-go/kimi-k3.1-pro"]);
    expect(events.filter((e) => e.type === "fallback")).toEqual([]);
    expect(events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("")).toBe("Answered.");
    expect(b.asked).toEqual(["glm-5.3", "glm-5.3", "glm-5.3"]);
    expect(b.slept).toEqual([2000, 4000]);
    expect(windowsOf(b.store).list()).toEqual([]);
  });

  test("given up on, it is said plainly: the plan's other models aren't waited on again in that turn, and with none left, too many calls at once, never 'add a key'", async () => {
    const b = brain([burst()]);
    const events = await b.turn(["opencode-go/glm-5.3", "opencode-go/kimi-k3.1-pro"]);
    const fallbacks = events.filter((e) => e.type === "fallback") as { from: string; error: string }[];
    expect(fallbacks.map((f) => f.from)).toEqual(["opencode-go/glm-5.3", "opencode-go/kimi-k3.1-pro"]);
    expect(fallbacks[0]!.error).toContain("opencode-go is taking too many calls at once: asked 6 times over 60 s");
    expect(fallbacks[1]!.error).toBe("opencode-go is taking too many calls at once just now (waited out for opencode-go/glm-5.3): passed over without asking");
    const last = events.at(-1) as { type: string; error: string };
    expect(last.type).toBe("error");
    expect(last.error).toStartWith("no model in the roster could answer just now: too many calls at once, a limit on how fast they're called, not their allowance; ask again in a minute (");
    expect(last.error).not.toContain("add a key");
    expect(b.asked).toEqual(Array(6).fill("glm-5.3"));
    expect(b.slept).toEqual([2000, 4000, 8000, 16_000, 30_000]);
    expect(windowsOf(b.store).list()).toEqual([]);
  });

  test("a burst a gateway has already waited out (a turn through another node's gateway) isn't waited out again", async () => {
    const b = brain([() => Response.json({ error: { type: "invincible_burst", message: GIVEN_UP } }, { status: 429, headers: { "x-invincible-waited": "6 asks, 60000 ms" } })]);
    const events = await b.turn(["opencode-go/glm-5.3"]);
    expect(b.asked).toEqual(["glm-5.3"]);
    expect(b.slept).toEqual([]);
    expect((events.find((e) => e.type === "fallback") as { error: string }).error).toContain(GIVEN_UP.slice(0, 60));
    expect(windowsOf(b.store).list()).toEqual([]);
  });
});

describe("a burst is never a spent window", () => {
  test("a 429 that names no allowance, its wait a minute at most, isn't kept; one that names an allowance, or waits longer, is", () => {
    const windows = new SpentWindows();
    const now = Date.UTC(2026, 10, 28, 1, 30);
    windows.now = () => now;
    expect(windows.note("opencode-go", "opencode-go → 429 rate limit reached for requests; try again in 20s")).toBeNull();
    expect(windows.note("opencode-go", 'opencode-go → 429 {"error":{"message":"Too Many Requests"}}', now + 30_000)).toBeNull();
    expect(windows.note("opencode-go", `429 {"error":{"type":"invincible_burst","message":${JSON.stringify(GIVEN_UP)}}}`, now + 20_000)).toBeNull();
    expect(windows.list()).toEqual([]);
    expect(windows.note("a/quota", "429 quota exceeded: resets in 45m")?.until).toBe(now + 45 * 60_000);
    expect(windows.note("a/long", 'a → 429 {"error":{"message":"Too Many Requests"}}', now + 2 * 3_600_000)?.until).toBe(now + 2 * 3_600_000);
    expect(windows.note("a/short", "a → 429 usage limit reached; resets in 30s")?.until).toBe(now + 30_000);
    expect(windows.list().map((w) => w.provider)).toEqual(["a/quota", "a/long", "a/short"]);
  });
});

describe("a plan's pace, kept by every caller on a node (Pacer)", () => {
  test("a call takes the first moment it can begin within the pace: the next waits behind it, a minute after the one it follows", () => {
    const pacer = new Pacer();
    // Two a minute: the third and the fourth wait for the first and the second to be a minute old.
    expect([0, 1_000, 2_000, 3_000].map((at) => pacer.turn("go", 2, at))).toEqual([0, 0, 58_000, 58_000]);
    // Another provider's calls are its own; and past their minute, those before are forgotten.
    expect(pacer.turn("other", 2, 3_000)).toBe(0);
    expect(pacer.turn("go", 2, 200_000)).toBe(0);
  });

  test("OpenCode Go's: a call or two under the burst it refused (28 November 2026: past about 25 a minute)", () => {
    expect(preset("opencode-go")?.pace).toBe(24);
    // A provider whose burst nobody has measured has none: its 429s are waited out, as ever.
    expect(preset("deepseek")?.pace).toBeUndefined();
  });

  test("a run's turns on it wait their turn, when the node gives a pacer: the 25th in a minute waits for the first to be a minute old", async () => {
    const b = brain([streamed], new Pacer());
    for (let i = 0; i < 25; i++) await b.turn(["opencode-go/glm-5.3"]);
    expect(b.asked).toHaveLength(25);
    expect(b.slept).toEqual([60_000]);
    // Without one (a test, a chore of its own), as ever: no wait.
    const unpaced = brain([streamed]);
    for (let i = 0; i < 25; i++) await unpaced.turn(["opencode-go/glm-5.3"]);
    expect(unpaced.slept).toEqual([]);
  });

  test("so do a tool's calls through the gateway, on the same pacer: one pace a node, whoever calls", async () => {
    const pacer = new Pacer();
    // (The gateway's token here takes 20 calls: the minute's other 4 are a run's own turns.)
    const g = gateway([answered], pacer);
    for (let i = 0; i < 20; i++) expect((await g.call()).status).toBe(200);
    expect(g.slept).toEqual([]);
    const b = brain([streamed], pacer);
    for (let i = 0; i < 4; i++) await b.turn(["opencode-go/glm-5.3"]);
    expect(b.slept).toEqual([]);
    // The minute's 24 taken between them: the next, whoever calls, waits for the first to be a minute old.
    await b.turn(["opencode-go/glm-5.3"]);
    expect(b.slept).toEqual([60_000]);
  });
});
