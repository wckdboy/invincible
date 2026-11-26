import { expect, test } from "bun:test";
import type { RouteName } from "@galahad/core";
import { preset } from "@galahad/brain";
import { keyAddCommand, keyElsewhereLine, planAdvice } from "../src/key-cli.ts";

/* `galahad key add` at a terminal, against what the node would answer. */

// (Fakes, in the form of the real things.)
const OAT = "sk-ant-oat01-FAKE-not-a-token-0000000000000000";
const API_KEY = "sk-ant-api03-FAKE-key-for-tests-0000";
const PLAN_KEY = "0123456789abcdef0123456789abcdef.FAKEfakeFAKEfake";

function node(engineer: string[] = ["anthropic/claude-opus-5-5"]) {
  const calls: { name: RouteName; input: any }[] = [];
  const api = {
    async call<T>(name: RouteName, input?: unknown): Promise<T> {
      calls.push({ name, input });
      if (name === "setSecret") return { secret: { origin: (input as { baseUrl?: string }).baseUrl ? new URL((input as { baseUrl: string }).baseUrl).origin : "https://pinned.example.test" } } as T;
      if (name === "roster") return { roster: { engineer: { models: engineer, configured: true } } } as T;
      return {} as T;
    },
  };
  return { api, calls };
}

const run = async (value: string, flags: Record<string, string> = {}, engineer?: string[]) => {
  const lines: string[] = [];
  const { api, calls } = node(engineer);
  await keyAddCommand(api, value, flags, (line) => lines.push(line));
  return { lines: lines.join("\n"), calls };
};

test("a key whose form says whose it is is sealed for that provider and the provider configured, as ever", async () => {
  const { lines, calls } = await run(API_KEY);
  expect(calls).toEqual([
    { name: "setSecret", input: { name: "anthropic", value: API_KEY, provider: "anthropic" } },
    { name: "setProvider", input: { id: "anthropic", baseUrl: "https://api.anthropic.com", kind: "anthropic", secret: "anthropic" } },
    { name: "roster", input: undefined },
  ]);
  expect(lines).toContain('Key stored and provider "anthropic" configured. Every full node can now use it.');
  expect(lines).toContain("It will only ever be sent to https://pinned.example.test.");
  expect(lines).not.toContain("coding plan");
  // His roles name its model: nothing more to do.
  expect(lines).not.toContain("None of his roles");
});

test("a key his roles name no model of says how to hire one; one they name says nothing more", async () => {
  // OpenAI's form is told, and pinned to its own address; the roster named here has none of its models.
  const openai = await run("sk-proj-FAKE-key-for-tests-0000000000");
  expect(openai.calls[1]!.input).toEqual({ id: "openai", baseUrl: "https://api.openai.com/v1", kind: "openai", secret: "openai" });
  expect(openai.lines).toContain("None of his roles has a model of openai's yet: hire one with galahad roster set planner openai/<model>");
  expect(openai.lines).toContain("galahad provider models openai lists what it serves");
  // A role's defaults on a provider you set up are what it runs on (roster.ts): the node says DeepSeek's model is named.
  const deepseek = await run("sk-FAKE0000000000000000000000000000", { provider: "deepseek" }, ["deepseek/deepseek-v4-pro"]);
  expect(deepseek.lines).not.toContain("None of his roles");
});

test("a subscription's sign-in is told from a key before anything is sent anywhere, whatever provider was named", async () => {
  for (const flags of [{}, { provider: "anthropic" }, { provider: "zai-coding" }]) {
    const { api, calls } = node();
    await expect(keyAddCommand(api, OAT, flags, () => {})).rejects.toThrow(/sign-in, not an API key/);
    expect(calls).toEqual([]);
  }
});

test("a plan's key whose form says whose it is needs no flag: Kimi Code's is sealed for the plan, pinned to the plan's host", async () => {
  const { lines, calls } = await run("sk-kimi-FAKE-membership-key-0000");
  expect(calls[0]!.input).toEqual({ name: "kimi-coding", value: "sk-kimi-FAKE-membership-key-0000", provider: "kimi-coding" });
  expect(calls[1]!.input).toEqual({ id: "kimi-coding", baseUrl: "https://api.kimi.ai/coding/v1", kind: "openai", secret: "kimi-coding" });
  expect(lines).toContain("Kimi Code is a coding plan");
  expect(lines).toContain('"Kimi Code subscriptions are for interactive use only"');
});

test("a key that says nothing of whose it is asks for the provider, and is sent nowhere", async () => {
  const { api, calls } = node();
  await expect(keyAddCommand(api, PLAN_KEY, {}, () => {})).rejects.toThrow(/--provider/);
  expect(calls).toEqual([]);
});

test("a coding plan is said to be one: what its key is for, where its terms are, and how to put it to work", async () => {
  const { lines, calls } = await run(PLAN_KEY, { provider: "zai-coding" });
  expect(calls.map((c) => c.name)).toEqual(["setSecret", "setProvider", "roster"]);
  expect(calls[1]!.input).toEqual({ id: "zai-coding", baseUrl: "https://api.z.ai/api/coding/paas/v4", kind: "openai", secret: "zai-coding" });
  expect(lines).toContain('Key stored and provider "zai-coding" configured.');
  expect(lines).toContain("GLM Coding Plan is a coding plan");
  // What it does is what its terms allow: Z.ai's, only inside the coding tools it names.
  expect(lines).toContain("whose terms allow it only inside the coding tools they name: Galahad never calls it himself");
  expect(lines).toContain("His talk with you, his loops and his heartbeat never use it");
  // What its vendor says it is for, in the vendor's words, and where.
  expect(lines).toContain('"for general-purpose API access or any scenarios outside such tools');
  expect(lines).toContain("https://docs.z.ai/legal-agreement/subscription-terms");
  // First for coding, with what the engineer has now still behind it.
  expect(lines).toContain("galahad roster set engineer zai-coding/glm-5.3 anthropic/claude-opus-5-5");
  // The key itself is never printed.
  expect(lines).not.toContain(PLAN_KEY);
});

test("a plan for interactive use only says so, and how to use it: never put first for coding, since nothing of his may run on it", () => {
  const lines = planAdvice("kimi-coding", preset("kimi-coding")!.plan!, ["opencode-go/glm-5.3"]).join("\n");
  expect(lines).toContain("Kimi Code is a coding plan for interactive use only, by its terms: it is lent to a tool you run yourself (galahad run --providers kimi-coding -- <tool>)");
  expect(lines).not.toContain("roster set engineer");
  // OpenCode Go's terms allow a coding agent's own calls: it codes on it himself.
  expect(planAdvice("opencode-go", preset("opencode-go")!.plan!, []).join("\n")).toContain("Galahad and the other knights code on it themselves, as Galahad");
});

test("a plan the engineer's roster already has is not offered again", async () => {
  const { lines } = await run(PLAN_KEY, { provider: "zai-coding" }, ["zai-coding/glm-5.3-flash", "anthropic/claude-opus-5-5"]);
  expect(lines).toContain("GLM Coding Plan is a coding plan");
  expect(lines).not.toContain("roster set");
  expect(lines).toContain("zai-coding/glm-5.3-flash");
});

test("a preset with no address of its own keeps the key and says what is still needed", async () => {
  const { lines, calls } = await run(["gateway", "key", "FAKE", crypto.randomUUID().slice(0, 8)].join("-"), { provider: "cloudflare-ai" });
  expect(calls.map((c) => c.name)).toEqual(["setSecret"]);
  expect(lines).toContain('Key stored as "cloudflare-ai".');
  expect(lines).toContain("--base-url");
});

test("Verda's inference API has an address of its own: its key is configured from the preset like any other", async () => {
  const { calls } = await run(["verda", "key", "FAKE", crypto.randomUUID().slice(0, 8)].join("-"), { provider: "verda" });
  expect(calls[1]!.input).toEqual({ id: "verda", baseUrl: "https://inference.verda.com/v1", kind: "openai", secret: "verda" });
});

test("your own address for a provider is what the key is pinned to", async () => {
  const { lines, calls } = await run(PLAN_KEY, { provider: "zai-coding", "base-url": "https://open.bigmodel.cn/api/coding/paas/v4" });
  expect(calls[0]!.input).toEqual({ name: "zai-coding", value: PLAN_KEY, provider: "zai-coding", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4" });
  expect(calls[1]!.input).toMatchObject({ id: "zai-coding", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4" });
  expect(lines).toContain("It will only ever be sent to https://open.bigmodel.cn.");
});

test("a provider pointed elsewhere since its key was added says where the key was for, and the line that adds it where the provider is now", () => {
  const ams = "https://token-plan-ams.xiaomimimo.com/v1";
  expect(keyElsewhereLine({ id: "mimo-token", baseUrl: ams, keyElsewhere: "https://token-plan-sgp.xiaomimimo.com" })).toBe(
    `mimo-token's key was added for https://token-plan-sgp.xiaomimimo.com, and a key goes only where it was added for: add it again for this address with \`galahad key add --provider mimo-token --base-url ${ams}\`.`,
  );
  expect(keyElsewhereLine({ id: "mimo-token", baseUrl: ams })).toBeNull();
});

test("a key added for a preset's other region is pinned there, and its provider set up there", async () => {
  const ams = "https://token-plan-ams.xiaomimimo.com/v1";
  const { calls } = await run("tp-FAKE-key-for-tests-0000", { provider: "mimo-token", "base-url": ams });
  expect(calls.find((c) => c.name === "setSecret")?.input).toMatchObject({ name: "mimo-token", provider: "mimo-token", baseUrl: ams });
  expect(calls.find((c) => c.name === "setProvider")?.input).toMatchObject({ id: "mimo-token", baseUrl: ams, secret: "mimo-token" });
});
