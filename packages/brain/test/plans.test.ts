import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { type ChatStreamEvent, newNodeIdentity } from "@galahad/core";
import { foundFleet, MindStore, Vault } from "@galahad/mind";
import { chat, chooseAgentModels, decide, detectProvider, embed, eyesOf, GatewayTokens, handleGateway, offersModel, originOf, planOf, preset, PRESETS, resolveProvider, signIn } from "../src/index.ts";

/*
 * Coding plans and sign-ins. A coding plan is a subscription whose key is for coding (its terms
 * say so), not for calling the API from any program for anything. Galahad and the knights are
 * a coding tool: he calls a plan himself for coding work, under his own name; he lends it to the
 * other coding tools in the knights' VMs through the gateway, each calling as itself; and nothing
 * else he does (his talk with you, his loops, embeddings, decisions) is handed its key. A
 * subscription's sign-in is not a key at all, and is never sent to an API from here.
 */

const PLAN_KEY = "0123456789abcdef0123456789abcdef.FAKEfakeFAKEfake";
const OWN_KEY = "sk-ant-api03-FAKE-key-for-tests-0000";
const GO_KEY = "sk-FAKE-opencode-go-key-for-tests-0000";

function mind(roster: Record<string, string[]>) {
  const identity = newNodeIdentity();
  const store = new MindStore(":memory:");
  foundFleet(store, identity, { fleetName: "camelot", nodeName: "n" });
  const vault = new Vault(store, identity);
  const plan = preset("zai-coding")!;
  vault.set("zai-coding", PLAN_KEY, { provider: "zai-coding", origin: originOf(plan.baseUrl)! });
  store.emit(identity, "provider.set", { id: "zai-coding", kind: plan.kind, baseUrl: plan.baseUrl, secret: "zai-coding" });
  const go = preset("opencode-go")!;
  vault.set("opencode-go", GO_KEY, { provider: "opencode-go", origin: originOf(go.baseUrl)! });
  store.emit(identity, "provider.set", { id: "opencode-go", kind: go.kind, baseUrl: go.baseUrl, secret: "opencode-go" });
  const kimi = preset("kimi-coding")!;
  vault.set("kimi-coding", PLAN_KEY, { provider: "kimi-coding", origin: originOf(kimi.baseUrl)! });
  store.emit(identity, "provider.set", { id: "kimi-coding", kind: kimi.kind, baseUrl: kimi.baseUrl, secret: "kimi-coding" });
  vault.set("own", OWN_KEY, { provider: "own", origin: "https://models.example.test" });
  store.emit(identity, "provider.set", { id: "own", kind: "openai", baseUrl: "https://models.example.test/v1", secret: "own" });
  for (const [role, models] of Object.entries(roster)) store.emit(identity, "roster.set", { role, models });
  return { store, vault };
}

/** Every request made, and one spoken word for an answer. */
function recorded() {
  const seen: { url: string; headers: Headers }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), headers: new Headers(init?.headers) });
    return new Response('data: {"choices":[{"delta":{"content":"aye"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  }) as typeof globalThis.fetch;
  return { seen, fetch };
}

const all = async (events: AsyncGenerator<ChatStreamEvent>) => {
  const out: ChatStreamEvent[] = [];
  for await (const e of events) if (e.type !== "usage") out.push(e);
  return out;
};
const ask = [{ role: "user" as const, content: "hello" }];

describe("coding plans are presets that say what they are", () => {
  test("each names its plan and where its terms are, on its vendor's own site, and points at the plan's own endpoint", () => {
    const plans = PRESETS.filter((p) => p.plan);
    expect(plans.map((p) => p.id).sort()).toEqual([
      "alibaba-coding", "alibaba-token", "byteplus-coding", "kimi-coding", "mimo-token", "minimax-mplan",
      "opencode-go", "qianfan-token", "stepfun-plan", "tencent-coding", "volcengine-coding", "zai-coding",
    ]);
    for (const p of plans) {
      expect([p.id, p.baseUrl.startsWith("https://")]).toEqual([p.id, true]);
      expect([p.id, p.plan!.name.length > 3, p.plan!.terms.startsWith("https://")]).toEqual([p.id, true, true]);
      // What its vendor says it is for, and who says so.
      expect([p.id, p.plan!.says.length > 40, /^(Z\.ai|Kimi|Alibaba|OpenCode|Xiaomi|MiniMax|Volcengine|BytePlus|StepFun|Tencent|Baidu): /.test(p.plan!.says)]).toEqual([p.id, true, true]);
      expect([p.id, p.plan!.models.length > 0]).toEqual([p.id, true]);
    }
    expect(preset("zai-coding")).toMatchObject({ kind: "openai", baseUrl: "https://api.z.ai/api/coding/paas/v4" });
    // The same vendor's ordinary API is a provider of its own, at its own endpoint: a plan is never taken for it.
    expect(preset("zai")).toMatchObject({ kind: "openai", baseUrl: "https://api.z.ai/api/paas/v4" });
    expect(preset("zai")!.plan).toBeUndefined();
  });

  test("a provider is on a plan when it was added as one; a provider of your own making is yours", () => {
    expect(planOf("zai-coding")?.name).toBe("GLM Coding Plan");
    expect(planOf("kimi-coding")?.name).toContain("Kimi");
    expect(planOf("anthropic")).toBeNull();
    expect(planOf("deepseek")).toBeNull();
    expect(planOf("my-own-endpoint")).toBeNull();
  });
});

describe("a model the owner wants on no role is offered for none (gpt-6-luna, 16 November 2026)", () => {
  test("OpenCode Go offers the models its docs list (opencode.ai/docs/console/go), gpt-6-luna not among them", () => {
    expect(preset("opencode-go")!.plan!.models).toEqual(["glm-5.3", "kimi-k3.1-pro", "kimi-k3", "deepseek-v4-pro", "qwen3.8-max", "qwen4-max"]);
    expect(offersModel("opencode-go/gpt-6-luna")).toBe(false);
    expect(offersModel("opencode-go/glm-5.3")).toBe(true);
    // A provider of your own offers whatever it serves.
    expect(offersModel("own/anything")).toBe(true);
  });

  test("a knight's eyes are chosen by evidence only among the models he offers; a model named for the role is yours, and stands", () => {
    const sees = (meanErrorPx: number) => ({ at: 1, reads: { ok: true, said: "x" }, places: { targets: 8, landed: 8, meanErrorPx } });
    const checks = [{ ref: "opencode-go/gpt-6-luna", check: sees(1) }, { ref: "opencode-go/glm-5.3", check: sees(9) }];
    expect(eyesOf([], checks, () => true)).toBe("opencode-go/glm-5.3");
    expect(eyesOf([], checks.slice(0, 1), () => true)).toBeNull();
    expect(eyesOf(["opencode-go/gpt-6-luna"], checks, () => true)).toBe("opencode-go/gpt-6-luna");
  });
});

describe("coding is what a coding plan is for: he codes on it himself, as himself", () => {
  test("a quest's or a knight's work goes to the plan first, in the roster's order, under his own name", async () => {
    const { seen, fetch } = recorded();
    const events = await all(chat({ ...mind({ engineer: ["opencode-go/glm-5.3", "own/m"] }), fetch }, { role: "engineer", messages: ask, coding: true }));
    expect(events.map((e) => e.type)).toEqual(["model", "text", "done"]);
    expect(events[0]).toEqual({ type: "model", ref: "opencode-go/glm-5.3" });
    expect(seen.map((s) => s.url)).toEqual(["https://opencode.ai/inference/go/openai/v1/chat/completions"]);
    expect(seen[0]!.headers.get("authorization")).toBe(`Bearer ${GO_KEY}`);
    // He says who he is: his own name, and no other tool's.
    const agent = seen[0]!.headers.get("user-agent") ?? "";
    expect(agent).toMatch(/^Galahad\b/);
    expect(agent).not.toMatch(/opencode|claude|codex|kimi|cline|roo|cursor|hermes/i);
  });

  test("a model of his own is called as it always was: he names himself only to a plan", async () => {
    const { seen, fetch } = recorded();
    await all(chat({ ...mind({ engineer: ["own/m"] }), fetch }, { role: "engineer", messages: ask, coding: true }));
    expect(seen[0]!.headers.has("user-agent")).toBe(false);
  });

  test("whatever the plan serves first (opencode-go/*) is the first model its preset names: the plan isn't called to find out", async () => {
    const { seen, fetch } = recorded();
    const events = await all(chat({ ...mind({ engineer: ["opencode-go/*"] }), fetch }, { role: "engineer", messages: ask, coding: true }));
    expect(events[0]).toEqual({ type: "model", ref: `opencode-go/${preset("opencode-go")!.plan!.models[0]}` });
    expect(seen.map((s) => new URL(s.url).pathname)).toEqual(["/inference/go/openai/v1/chat/completions"]);
  });
});

describe("each plan is held to what its own vendor's terms allow (read 16 November 2026)", () => {
  test("what each allows: his own coding calls only where the vendor's words permit a coding agent's own calls; a tool's unattended use only where it isn't forbidden", () => {
    expect(Object.fromEntries(PRESETS.filter((p) => p.plan).map((p) => [p.id, p.plan!.allows]))).toEqual({
      // "designed for OpenCode and other coding agents", calling as themselves.
      "opencode-go": { native: true, tools: "unattended" },
      // Not "directly invoking model APIs from your own applications": only inside the coding tools it names.
      "zai-coding": { native: false, tools: "unattended" },
      // "for interactive use only": a tool you run yourself, never a knight's or a quest's unattended work.
      "kimi-coding": { native: false, tools: "interactive" },
      "alibaba-coding": { native: false, tools: "interactive" },
      "alibaba-token": { native: false, tools: "interactive" },
      "tencent-coding": { native: false, tools: "interactive" },
      "qianfan-token": { native: false, tools: "interactive" },
      // "designed for individual, interactive developer use": read as interactive, the stricter way, until it says otherwise.
      "minimax-mplan": { native: false, tools: "interactive" },
      // Only in programming tools, "such as OpenClaw, OpenCode, etc.", never "automated scripts": a coding tool in a
      // knight's VM, but not his own calls, which no list of theirs names.
      "mimo-token": { native: false, tools: "unattended" },
      // Only inside the AI coding tools they name ("Not available for API calls"), with no rule that a person must be there.
      "volcengine-coding": { native: false, tools: "unattended" },
      "byteplus-coding": { native: false, tools: "unattended" },
      "stepfun-plan": { native: false, tools: "unattended" },
    });
  });

  test("a plan whose terms forbid his own calls is never handed to them: his coding passes it over, saying why, and the next model answers", async () => {
    const { seen, fetch } = recorded();
    const events = await all(chat({ ...mind({ engineer: ["zai-coding/glm-5.3", "own/m"] }), fetch }, { role: "engineer", messages: ask, coding: true }));
    expect(events.find((e) => e.type === "fallback")).toEqual({ type: "fallback", from: "zai-coding/glm-5.3", error: expect.stringContaining("its vendor's terms allow it only inside the coding tools they name") });
    expect(seen.map((s) => new URL(s.url).host)).toEqual(["models.example.test"]);
    const { store, vault } = mind({});
    expect(resolveProvider(store, vault, "zai-coding", "coding")!.apiKey).toBeNull();
    // Lent to a coding tool it names, as ever.
    expect(resolveProvider(store, vault, "zai-coding", "tool")!.apiKey).toBe(PLAN_KEY);
  });

  test("a plan for interactive use only is lent to a tool you run yourself, never to a knight's VM or a quest's sandbox", async () => {
    const { store, vault } = mind({});
    const tokens = new GatewayTokens(new Database(":memory:"));
    const { seen, fetch } = recorded();
    const call = (token: string) => handleGateway(new Request("http://gw/gw/kimi-coding/chat/completions", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" }), { store, vault, tokens, fetch });
    const yours = tokens.mint({ label: "run:claude", providers: ["kimi-coding"], ttlMinutes: 10, maxRequests: 5 }).token;
    const knights = tokens.mint({ label: "sandbox:0123456789", providers: ["kimi-coding"], ttlMinutes: 10, maxRequests: 5 }).token;
    expect((await call(yours)).status).toBe(200);
    const refused = await call(knights);
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("for interactive use only");
    expect(seen).toHaveLength(1);
    // Nor is it chosen for a knight's coding tool to run on.
    expect(chooseAgentModels(["kimi-coding/kimi-for-coding", "own/m"], [{ id: "kimi-coding", kind: "openai", hasKey: true }, { id: "own", kind: "openai", hasKey: true }])).toEqual([{ provider: "own", model: "m" }]);
  });
});

describe("a plan that routes a conversation by its session is told which conversation this is", () => {
  const SESSION = "x-opencode-session";
  const quest = [{ role: "user" as const, content: "Quest: fix the report" }];

  test("OpenCode Go refuses a call without one: each conversation of his has a session, the same through its turns and another for another conversation", async () => {
    const { seen, fetch } = recorded();
    const ctx = { ...mind({ engineer: ["opencode-go/glm-5.3", "opencode-go/kimi-k3.1-pro"] }), fetch };
    await all(chat(ctx, { role: "engineer", messages: quest, coding: true }));
    // The same conversation a turn later: what followed is added, and its beginning is as it was.
    await all(chat(ctx, { role: "engineer", messages: [...quest, { role: "assistant", content: "```sh\nls\n```" }, { role: "user", content: "exit 0 · 3 ms\nREADME.md" }], coding: true }));
    await all(chat(ctx, { role: "engineer", messages: [{ role: "user", content: "Quest: another one" }], coding: true }));
    // Another model on the same quest is another conversation.
    await all(chat(ctx, { role: "engineer", model: "opencode-go/kimi-k3.1-pro", messages: quest, coding: true }));
    const sessions = seen.map((s) => s.headers.get(SESSION));
    expect(sessions[0]).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(sessions[1]).toBe(sessions[0]);
    expect(sessions[2]).not.toBe(sessions[0]);
    expect(sessions[3]).not.toBe(sessions[0]);
    // An id, and nothing of what was asked or of the key.
    expect(sessions.join(" ")).not.toMatch(/Quest|report|FAKE/);
    expect(seen.every((s) => s.headers.get("user-agent")?.startsWith("Galahad"))).toBe(true);
  });

  test("no other provider is sent it: a plan that names no such header, or a model of his own", async () => {
    const { seen, fetch } = recorded();
    await all(chat({ ...mind({ engineer: ["own/m"] }), fetch }, { role: "engineer", messages: quest, coding: true }));
    expect(seen.map((s) => s.headers.has(SESSION))).toEqual([false]);
  });

  test("through the gateway a tool's own session goes on as it sent it; a tool that sent none gets one of its VM's, so the plan answers it", async () => {
    const { store, vault } = mind({});
    const tokens = new GatewayTokens(new Database(":memory:"));
    const mint = (label: string) => tokens.mint({ label, providers: ["opencode-go", "zai-coding"], ttlMinutes: 10, maxRequests: 9 }).token;
    const [one, two] = [mint("sandbox:w1"), mint("sandbox:w2")];
    const { seen, fetch } = recorded();
    const call = (provider: string, token: string, headers: Record<string, string> = {}) =>
      handleGateway(new Request(`http://127.0.0.1:7777/gw/${provider}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body: "{}" }), { store, vault, tokens, fetch });
    expect((await call("opencode-go", one, { [SESSION]: "ses_the_tools_own" })).status).toBe(200);
    await call("opencode-go", one);
    await call("opencode-go", one);
    await call("opencode-go", two);
    await call("zai-coding", one, { [SESSION]: "ses_the_tools_own" });
    const sessions = seen.map((s) => s.headers.get(SESSION));
    expect(sessions[0]).toBe("ses_the_tools_own");
    expect(sessions[1]).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(sessions[2]).toBe(sessions[1]);
    expect(sessions[3]).not.toBe(sessions[1]);
    // Nothing of the VM's token is in it, and a provider that doesn't route by it isn't sent it.
    expect(one.includes(sessions[1]!) || sessions[1]!.includes(one.slice(3, 12))).toBe(false);
    expect(sessions[4]).toBeNull();
    expect(seen[1]!.headers.get("authorization")).toBe(`Bearer ${GO_KEY}`);
  });
});

describe("a plan whose allowance is spent says so", () => {
  const LIMIT = '{"type":"error","error":{"type":"GoUsageLimitError","message":"OpenCode Go usage limit reached (5-hour, resets in 1h 37m). To keep going now, turn on Extra Usage."}}';
  const spentFetch = (async () => new Response(LIMIT, { status: 429, headers: { "content-type": "application/json" } })) as unknown as typeof globalThis.fetch;

  test("held to a plan's model whose window is spent, the answer's error is the plan's own words: what was reached and when it resets", async () => {
    const events = await all(chat({ ...mind({ engineer: ["own/m"] }), fetch: spentFetch }, { role: "reviewer", model: "opencode-go/kimi-k3.1-pro", messages: ask, coding: true }));
    const error = events.find((e) => e.type === "error") as { type: "error"; error: string };
    expect(error.error).toContain("no model in the roster could answer");
    // Why, for each model that was asked: a trial that crashes on this says what to do about it, not only that it crashed.
    expect(error.error).toContain("opencode-go/kimi-k3.1-pro");
    expect(error.error).toContain("usage limit reached (5-hour, resets in 1h 37m)");
    expect(error.error.length).toBeLessThan(900);
    expect(error.error).not.toContain(GO_KEY);
  });

  test("a role with nothing configured still reads as it did, with each model's reason beside it", async () => {
    const events = await all(chat({ ...mind({ engineer: ["nowhere/a", "elsewhere/b"] }), fetch: spentFetch }, { role: "engineer", messages: ask, coding: true }));
    const error = events.find((e) => e.type === "error") as { type: "error"; error: string };
    expect(error.error).toBe('no model in the roster could answer; add a key or adjust the roster (nowhere/a: provider "nowhere" is not configured; elsewhere/b: provider "elsewhere" is not configured)');
  });

  test("a node with no provider set up at all says what to do once, not once a model", async () => {
    const identity = newNodeIdentity();
    const store = new MindStore(":memory:");
    foundFleet(store, identity, { fleetName: "camelot", nodeName: "fresh" });
    const events = await all(chat({ store, vault: new Vault(store, identity), fetch: spentFetch }, { messages: ask }));
    const error = events.find((e) => e.type === "error") as { type: "error"; error: string };
    expect(error.error).toBe("no model can answer yet: none of deepseek, zai, mistral, anthropic, openrouter, orcarouter, openai, xai is set up here. Add a key for one of them (galahad key add), or hire a model you have a key for (galahad roster set <role> <provider/model>)");
  });
});

describe("outside coding he never answers with a coding plan", () => {
  test("a role with a plan's model and one of his own: he answers with his own, and nothing is sent to the plan", async () => {
    const { seen, fetch } = recorded();
    const events = await all(chat({ ...mind({ planner: ["zai-coding/glm-5.3", "own/m"] }), fetch }, { messages: ask }));
    expect(events.map((e) => e.type)).toEqual(["model", "text", "done"]);
    expect(events[0]).toEqual({ type: "model", ref: "own/m" });
    expect(seen.map((s) => new URL(s.url).origin)).toEqual(["https://models.example.test"]);
    expect(seen.some((s) => [...s.headers.values()].some((v) => v.includes(PLAN_KEY)))).toBe(false);
  });

  test("a role with nothing but a plan's model says why he can't answer, and still sends nothing", async () => {
    const { seen, fetch } = recorded();
    const events = await all(chat({ ...mind({ planner: ["zai-coding/glm-5.3"] }), fetch }, { messages: ask }));
    expect(events.map((e) => e.type)).toEqual(["error"]);
    const error = events[0]!.type === "error" ? events[0]!.error : "";
    expect(error).toContain("zai-coding/glm-5.3");
    expect(error).toContain("coding plan");
    expect(seen).toEqual([]);
  });

  test("held to a plan's model by name (a trial's pin, a chat's choice), the same", async () => {
    const { seen, fetch } = recorded();
    const events = await all(chat({ ...mind({ planner: ["own/m"] }), fetch }, { messages: ask, model: "zai-coding/glm-5.3" }));
    expect(events.map((e) => e.type)).toEqual(["error"]);
    expect(events[0]!.type === "error" && events[0]!.error).toContain("coding plan");
    expect(seen).toEqual([]);
  });

  test("whatever the plan serves first (zai-coding/*) is never asked for: the plan isn't called to find out", async () => {
    const { seen, fetch } = recorded();
    const events = await all(chat({ ...mind({ planner: ["zai-coding/*", "own/m"] }), fetch }, { messages: ask }));
    expect(events[0]).toEqual({ type: "model", ref: "own/m" });
    expect(seen.map((s) => new URL(s.url).origin)).toEqual(["https://models.example.test"]);
  });

  test("nothing he does himself is handed a plan's key: it is given to a tool, through the gateway, and to nothing else", async () => {
    const { store, vault } = mind({ embedder: ["zai-coding/embedding-3"], decider: ["zai-coding/glm-5.3"] });
    expect(resolveProvider(store, vault, "zai-coding")).toMatchObject({ id: "zai-coding", apiKey: null });
    expect(resolveProvider(store, vault, "zai-coding", "tool")!.apiKey).toBe(PLAN_KEY);
    // His own coding calls get a plan's key only where its terms allow them (OpenCode Go's do; Z.ai's don't).
    expect(resolveProvider(store, vault, "zai-coding", "coding")!.apiKey).toBeNull();
    expect(resolveProvider(store, vault, "opencode-go", "coding")!.apiKey).toBe(GO_KEY);
    // A provider of his own is his to call, as ever.
    expect(resolveProvider(store, vault, "own")!.apiKey).toBe(OWN_KEY);
    const { seen, fetch } = recorded();
    await expect(embed({ store, vault, fetch }, ["a line"], { as: "query" })).rejects.toThrow(/coding plan/);
    await expect(decide({ store, vault, fetch }, { state: "s", questions: [{ id: "q", kind: "yes-no", text: "Is it?" }] } as never)).rejects.toThrow(/coding plan/);
    expect(seen).toEqual([]);
  });
});

describe("a coding plan serves the coding tools in the knights' VMs", () => {
  test("the harness's models are the engineer's, plans among them, in the roster's order", () => {
    const providers = [
      { id: "zai-coding", kind: "openai", hasKey: true },
      { id: "kimi-coding", kind: "openai", hasKey: false },
      { id: "own", kind: "openai", hasKey: true },
    ];
    expect(chooseAgentModels(["zai-coding/glm-5.3", "kimi-coding/kimi-for-coding", "own/m"], providers)).toEqual([
      { provider: "zai-coding", model: "glm-5.3" },
      { provider: "own", model: "m" },
    ]);
  });

  test("through the gateway the tool calls the plan as itself: its own user-agent goes on, and the gateway puts none in its place", async () => {
    const { store, vault } = mind({});
    const tokens = new GatewayTokens(new Database(":memory:"));
    const { token } = tokens.mint({ label: "sandbox:w1", providers: ["zai-coding"], ttlMinutes: 10, maxRequests: 5 });
    const { seen, fetch } = recorded();
    const call = (headers: Record<string, string>) =>
      handleGateway(new Request("http://127.0.0.1:7777/gw/zai-coding/chat/completions", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body: "{}" }), { store, vault, tokens, fetch });
    expect((await call({ "user-agent": "opencode/2.2.7" })).status).toBe(200);
    expect(seen[0]!.url).toBe("https://api.z.ai/api/coding/paas/v4/chat/completions");
    expect(seen[0]!.headers.get("authorization")).toBe(`Bearer ${PLAN_KEY}`);
    expect(seen[0]!.headers.get("user-agent")).toBe("opencode/2.2.7");
    // A tool that names nothing is passed on naming nothing.
    await call({});
    expect(seen[1]!.headers.has("user-agent")).toBe(false);
  });
});

describe("a subscription's sign-in is not an API key", () => {
  // (Fake: the form of a token from `claude setup-token`, not one.)
  const OAT = "sk-ant-oat01-FAKE-not-a-token-0000000000000000";

  test("it is recognised for what it is, and never taken for the vendor's API key", () => {
    expect(signIn(OAT)).toMatchObject({ vendor: "Anthropic", tool: "Claude Code" });
    expect(signIn(OAT)!.why.length).toBeGreaterThan(20);
    expect(detectProvider(OAT)).toBeNull();
    expect(signIn(OWN_KEY)).toBeNull();
    expect(detectProvider(OWN_KEY)).toBe("anthropic");
    expect(signIn("")).toBeNull();
    expect(signIn(PLAN_KEY)).toBeNull();
  });
});

describe("a plan's key is recognised where its form says whose it is", () => {
  test("a key whose form is one vendor's plan's is recognised; one several vendors share (sk-sp-), or none at all, is never guessed at", () => {
    // (Fakes, in the vendors' documented forms.)
    expect(detectProvider("sk-kimi-FAKE-membership-key-0000")).toBe("kimi-coding");
    expect(detectProvider("tp-FAKE-token-plan-key-0000")).toBe("mimo-token");
    // OpenAI's project and service-account keys, and xAI's, by their form; a bare sk- says nothing of whose it is.
    expect(detectProvider("sk-proj-FAKE-key-for-tests-0000")).toBe("openai");
    expect(detectProvider("sk-svcacct-FAKE-key-for-tests-0000")).toBe("openai");
    expect(detectProvider("xai-FAKE-key-for-tests-0000")).toBe("xai");
    expect(detectProvider("sk-FAKE0000000000000000000000000000")).toBeNull();
    expect(detectProvider("ttp-FAKE-team-token-plan-key-0000")).toBe("mimo-token");
    expect(detectProvider("sk-cp-FAKE-m-plan-key-0000")).toBe("minimax-mplan");
    expect(detectProvider("sk-nano-00000000-0000-0000-0000-000000000000")).toBe("nanogpt");
    // Alibaba's Coding Plan and Token Plan, and Tencent's Coding Plan, all have sk-sp- keys: it says none of them.
    expect(detectProvider("sk-sp-FAKE-coding-plan-key-0000")).toBeNull();
    expect(detectProvider(PLAN_KEY)).toBeNull();
    // A key of the ordinary kind is not taken for a plan's.
    expect(detectProvider("sk-FAKE-platform-key-0000")).toBeNull();
    expect(detectProvider("sk-or-FAKE")).toBe("openrouter");
  });
});
