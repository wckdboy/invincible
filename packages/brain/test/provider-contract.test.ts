import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { type ChatStreamEvent, newNodeIdentity } from "@galahad/core";
import { foundFleet, MindStore, Vault } from "@galahad/mind";
import { chat, GatewayTokens, handleGateway, offeredModels, originOf, planOf, preset, PRESETS, resolveProvider, SELF } from "../src/index.ts";

/*
 * Every provider preset, called the way Galahad calls it, against a fake of its server on this machine (no network,
 * no real key). Each row is what its vendor's documentation says (read 16 November 2026; the page is on the row), not
 * what the preset says, so a preset that drifts from its vendor fails here: where a call goes, which header carries
 * the key (never the address), what the body says, how its models are found, what a failure says, and for a coding
 * plan, who may call it (his own coding calls, a knight's coding tool, or only a tool you run yourself).
 */

interface Row {
  id: string;
  /** Where its vendor says so. */
  docs: string;
  /** The address you give it, for a preset with none of its own. */
  base?: string;
  /** A model its vendor documents. */
  model: string;
  /** Where a chat call goes. */
  chat: string;
  /** The header that carries its key, and how (null: a local runtime, called with none). */
  auth: ((key: string) => Record<string, string>) | null;
  /** How its models are found: the address asked, the models offered without asking, or why there are none to offer. */
  models: { asks: string; auth?: (key: string) => Record<string, string> } | { named: string[] } | { none: string };
  /** A coding plan's terms, as the code holds it to them, and the header it routes a conversation by, where it has one. */
  plan?: { native: boolean; tools: "unattended" | "interactive"; session?: string };
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
const GATEWAY = "https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/galahad/compat";

const ROWS: Row[] = [
  // The SDK sends Authorization: Bearer for its messages; the models list goes with x-api-key, "still supported".
  { id: "anthropic", docs: "https://platform.claude.com/docs/en/api/overview", model: "claude-opus-5-5", chat: "https://api.anthropic.com/v1/messages", auth: bearer, models: { asks: "https://api.anthropic.com/v1/models?limit=100", auth: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }) } },
  { id: "deepseek", docs: "https://api-docs.deepseek.com/", model: "deepseek-v4-pro", chat: "https://api.deepseek.com/chat/completions", auth: bearer, models: { asks: "https://api.deepseek.com/models" } },
  // Read 21 November 2026, as their presets were added: OpenAI's guide names gpt-6.2-astra its strong default; xAI keeps
  // chat completions, which it calls legacy, beside its Responses API; Mistral's -latest aliases are its own.
  // (Its own models call tools only through Responses: "GPT-6.2 Astra and GPT-6.2 Sol support Chat Completions, but tool
  // calling requires Responses", developers.openai.com/api/docs/guides/latest-model, read 22 November 2026.)
  { id: "openai", docs: "https://developers.openai.com/api/reference/resources/responses/methods/create", model: "gpt-6.2-astra", chat: "https://api.openai.com/v1/responses", auth: bearer, models: { asks: "https://api.openai.com/v1/models" } },
  { id: "xai", docs: "https://docs.x.ai/developers/model-capabilities/legacy/chat-completions", model: "grok-4.7", chat: "https://api.x.ai/v1/chat/completions", auth: bearer, models: { asks: "https://api.x.ai/v1/models" } },
  { id: "mistral", docs: "https://docs.mistral.ai/api/endpoint/chat", model: "mistral-large-latest", chat: "https://api.mistral.ai/v1/chat/completions", auth: bearer, models: { asks: "https://api.mistral.ai/v1/models" } },
  { id: "abliteration", docs: "https://docs.abliteration.ai/api/openai-compatibility", model: "abliterated-model", chat: "https://api.abliteration.ai/v1/chat/completions", auth: bearer, models: { asks: "https://api.abliteration.ai/v1/models" } },
  // (Read 19 November 2026.)
  { id: "heabsy", docs: "https://api.heabsy.com/docs", model: "qwen3-coder", chat: "https://api.heabsy.com/v1/chat/completions", auth: bearer, models: { asks: "https://api.heabsy.com/v1/models" } },
  { id: "nearai", docs: "https://docs.near.ai/cloud/quickstart.md", model: "Qwen/Qwen3.8-27B-abliterated", chat: "https://cloud-api.near.ai/v1/chat/completions", auth: bearer, models: { asks: "https://cloud-api.near.ai/v1/models" } },
  { id: "orcarouter", docs: "https://docs.orcarouter.ai/api-reference/chat/create-a-chat-completion", model: "orcarouter/auto", chat: "https://api.orcarouter.ai/v1/chat/completions", auth: bearer, models: { asks: "https://api.orcarouter.ai/v1/models" } },
  { id: "openrouter", docs: "https://openrouter.ai/docs/api/reference/overview", model: "openai/gpt-5.2", chat: "https://openrouter.ai/api/v1/chat/completions", auth: bearer, models: { asks: "https://openrouter.ai/api/v1/models" } },
  { id: "moonshot", docs: "https://platform.kimi.ai/docs/api/chat", model: "kimi-k3.1-pro", chat: "https://api.moonshot.ai/v1/chat/completions", auth: bearer, models: { asks: "https://api.moonshot.ai/v1/models" } },
  { id: "zai", docs: "https://docs.z.ai/api-reference/introduction", model: "glm-5.3", chat: "https://api.z.ai/api/paas/v4/chat/completions", auth: bearer, models: { named: ["glm-5.3", "glm-5.3-flash", "glm-5.3-flashx", "glm-5.2"] } },
  { id: "zai-coding", docs: "https://docs.z.ai/devpack/tool/others.md", model: "glm-5.3", chat: "https://api.z.ai/api/coding/paas/v4/chat/completions", auth: bearer, models: { named: ["glm-5.3", "glm-5.3-flash"] }, plan: { native: false, tools: "unattended" } },
  { id: "kimi-coding", docs: "https://www.kimi.com/code/docs/en/", model: "k3.1-pro", chat: "https://api.kimi.ai/coding/v1/chat/completions", auth: bearer, models: { named: ["k3.1-pro", "k3.1-pro-highspeed", "k3", "k3-256k", "kimi-for-coding", "kimi-for-coding-highspeed"] }, plan: { native: false, tools: "interactive" } },
  { id: "alibaba-coding", docs: "https://help.aliyun.com/zh/model-studio/coding-plan", model: "qwen3.7-plus", chat: "https://coding.dashscope.aliyuncs.com/v1/chat/completions", auth: bearer, models: { named: ["qwen3.7-plus", "qwen3.6-plus", "kimi-k2.5", "glm-5", "MiniMax-M2.5", "qwen3.5-plus"] }, plan: { native: false, tools: "interactive" } },
  { id: "alibaba-token", docs: "https://www.alibabacloud.com/help/en/model-studio/more-tools", model: "qwen4-max", chat: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions", auth: bearer, models: { named: ["qwen4-max", "qwen3.8-max", "qwen3.8-flash", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-flash", "deepseek-v4-pro", "deepseek-v4.1-flash", "glm-5.3", "glm-5.2", "auto"] }, plan: { native: false, tools: "interactive" } },
  { id: "opencode-go", docs: "https://opencode.ai/docs/console/go/", model: "glm-5.3", chat: "https://opencode.ai/inference/go/openai/v1/chat/completions", auth: bearer, models: { named: ["glm-5.3", "kimi-k3.1-pro", "kimi-k3", "deepseek-v4-pro", "qwen3.8-max", "qwen4-max"] }, plan: { native: true, tools: "unattended", session: "x-opencode-session" } },
  { id: "mimo-token", docs: "https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/subscription", model: "mimo-v2.6-pro", chat: "https://token-plan-sgp.xiaomimimo.com/v1/chat/completions", auth: bearer, models: { named: ["mimo-v2.6-pro", "mimo-v2.6-flash"] }, plan: { native: false, tools: "unattended" } },
  { id: "minimax-mplan", docs: "https://platform.minimax.io/docs/m-plan/other-tools.md", model: "MiniMax-M3.1-Flash", chat: "https://api.minimax.io/v1/chat/completions", auth: bearer, models: { named: ["MiniMax-M3.1-Flash"] }, plan: { native: false, tools: "interactive" } },
  { id: "volcengine-coding", docs: "https://ark.volcengine.com/region:cn-beijing/docs/coding-plan-personal-get-started", model: "ark-code-latest", chat: "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions", auth: bearer, models: { named: ["ark-code-latest", "doubao-seed-2.1-pro", "doubao-seed-2.1-lite", "glm-5.3", "deepseek-v4-pro", "deepseek-v4.1-flash", "kimi-k3.1-pro"] }, plan: { native: false, tools: "unattended" } },
  { id: "byteplus-coding", docs: "https://docs.byteplus.com/docs/ModelArk/2277827", model: "ark-code-latest", chat: "https://ark.ap-southeast.bytepluses.com/api/coding/v3/chat/completions", auth: bearer, models: { named: ["ark-code-latest", "dola-seed-2.0-pro", "dola-seed-2.0-code", "dola-seed-2.0-lite", "glm-5.2", "deepseek-v4-pro", "deepseek-v4.1-flash"] }, plan: { native: false, tools: "unattended" } },
  { id: "stepfun-plan", docs: "https://platform.stepfun.ai/docs/en/step-plan/quick-start.md", model: "step-5-preview", chat: "https://api.stepfun.ai/step_plan/v1/chat/completions", auth: bearer, models: { named: ["step-5-preview", "step-3.7-flash", "step-3.5-flash"] }, plan: { native: false, tools: "unattended" } },
  { id: "tencent-coding", docs: "https://cloud.tencent.com/document/product/1823/130092", model: "tc-code-latest", chat: "https://api.lkeap.cloud.tencent.com/coding/v3/chat/completions", auth: bearer, models: { named: ["tc-code-latest"] }, plan: { native: false, tools: "interactive" } },
  { id: "qianfan-token", docs: "https://cloud.baidu.com/doc/qianfan/s/Dmrabu8b6", model: "qianfan-code-latest", chat: "https://qianfan.baidubce.com/v2/tokenplan/personal/chat/completions", auth: bearer, models: { named: ["qianfan-code-latest", "ernie-5.5-flash-preview", "deepseek-v4-pro", "deepseek-v4.1-flash", "glm-5.3"] }, plan: { native: false, tools: "interactive" } },
  { id: "nanogpt", docs: "https://docs.nano-gpt.com/api-reference/endpoint/models", model: "deepseek-v4-pro", chat: "https://api.nano-gpt.com/api/v1/chat/completions", auth: bearer, models: { asks: "https://api.nano-gpt.com/api/v1/models" } },
  { id: "synthetic", docs: "https://dev.synthetic.new/docs/api/overview", model: "hf:moonshotai/Kimi-K3.1-Pro", chat: "https://api.synthetic.new/openai/v1/chat/completions", auth: bearer, models: { asks: "https://api.synthetic.new/openai/v1/models" } },
  { id: "ollama-cloud", docs: "https://docs.ollama.com/api/authentication", model: "gemma4:31b", chat: "https://ollama.com/v1/chat/completions", auth: bearer, models: { asks: "https://ollama.com/v1/models" } },
  // The gateway's token goes in its own header and nothing goes as Authorization, so Cloudflare adds the key you stored with it.
  { id: "cloudflare-ai", docs: "https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/", base: GATEWAY, model: "deepseek/deepseek-chat", chat: `${GATEWAY}/chat/completions`, auth: (key) => ({ "cf-aig-authorization": `Bearer ${key}` }), models: { none: "cloudflare-ai doesn't list its models: name them yourself in the roster, as cloudflare-ai/<model>" } },
  { id: "verda", docs: "https://docs.verda.com/inference/openai-compatibility/", model: "kimi-k3-1-pro", chat: "https://inference.verda.com/v1/chat/completions", auth: bearer, models: { asks: "https://inference.verda.com/v1/models" } },
  { id: "ollama", docs: "https://docs.ollama.com/api/openai-compatibility", model: "qwen3:8b", chat: "http://127.0.0.1:11434/v1/chat/completions", auth: null, models: { asks: "http://127.0.0.1:11434/v1/models" } },
  { id: "llamacpp", docs: "https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md", model: "local", chat: "http://127.0.0.1:9931/v1/chat/completions", auth: null, models: { asks: "http://127.0.0.1:9931/v1/models" } },
];

/** What reached the fake: the address Galahad asked for, and the request as it arrived over HTTP. */
interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

const seen: Seen[] = [];
/** The fake's answer to the next requests: a provider at work, or one that refuses the key (and echoes it, as some do). */
let refusing = false;

const OPENAI_STREAM = ['{"choices":[{"delta":{"content":"aye"}}]}', '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1}}', "[DONE]"].map((d) => `data: ${d}\n\n`).join("");
const RESPONSES_STREAM = [
  { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "aye" },
  { type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 1 } } },
]
  .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
  .join("");
const ANTHROPIC_STREAM = [
  ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], model: "claude-opus-5-5", stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "aye" } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
  ["message_stop", { type: "message_stop" }],
]
  .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  .join("");

const fake = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const call = seen.at(-1)!;
    Object.assign(call, { method: req.method, headers: req.headers, body: await req.text() });
    const path = new URL(req.url).pathname;
    if (refusing) {
      const sent = req.headers.get("authorization") ?? req.headers.get("x-api-key") ?? req.headers.get("cf-aig-authorization");
      return Response.json({ type: "error", error: { type: "authentication_error", message: `invalid api key: ${sent}` } }, { status: 401 });
    }
    if (path.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "m-2", object: "model" }, { id: "m-1", object: "model" }] });
    if (path.endsWith("/v1/messages")) return new Response(ANTHROPIC_STREAM, { headers: { "content-type": "text/event-stream" } });
    if (path.endsWith("/chat/completions")) return new Response(OPENAI_STREAM, { headers: { "content-type": "text/event-stream" } });
    if (path.endsWith("/responses")) return new Response(RESPONSES_STREAM, { headers: { "content-type": "text/event-stream" } });
    return new Response("not found", { status: 404 });
  },
});
afterAll(() => fake.stop(true));

/** A fetch that goes to the fake whatever address it was given, keeping that address to look at. */
const routed = ((input: string | URL | Request, init?: RequestInit) => {
  const asked = new URL(input instanceof Request ? input.url : String(input));
  seen.push({ url: asked.href, method: "", headers: new Headers(), body: "" });
  return fetch(`http://127.0.0.1:${fake.port}${asked.pathname}${asked.search}`, init);
}) as typeof fetch;

/** (Fake, made here: no vendor's form, nothing a scanner could take for a real key.) */
const fakeKey = (id: string) => ["FAKE", id, "contract", crypto.randomUUID().slice(0, 8)].join("-");

/** A fleet with this provider configured the way `galahad key add` leaves it: its key sealed, pinned to its origin. */
function configured(row: Row) {
  const identity = newNodeIdentity();
  const store = new MindStore(":memory:");
  foundFleet(store, identity, { fleetName: "camelot", nodeName: "n" });
  const vault = new Vault(store, identity);
  const known = preset(row.id)!;
  const baseUrl = row.base ?? known.baseUrl;
  const key = row.auth ? fakeKey(row.id) : null;
  if (key) vault.set(row.id, key, { provider: row.id, origin: originOf(baseUrl)! });
  store.emit(identity, "provider.set", { id: row.id, kind: known.kind, baseUrl, ...(key ? { secret: row.id } : {}) });
  const tokens = new GatewayTokens(new Database(":memory:"));
  return { store, vault, key, baseUrl, tokens, ctx: { store, vault, fetch: routed } };
}

const answer = async (events: AsyncGenerator<ChatStreamEvent>) => {
  const out: ChatStreamEvent[] = [];
  for await (const event of events) if (event.type !== "usage") out.push(event);
  return out;
};
const hello = [{ role: "user" as const, content: "hello" }];

/** The headers whose values carry the key. */
const carrying = (headers: Headers, key: string) => [...headers.entries()].filter(([, value]) => value.includes(key)).map(([name]) => name).sort();

function expectAuth(call: Seen, row: Row, key: string | null, auth: ((key: string) => Record<string, string>) | null) {
  expect(call.url.includes(key ?? "\u0000")).toBe(false);
  if (!auth || !key) {
    expect(call.headers.has("authorization")).toBe(false);
    expect(call.headers.has("x-api-key")).toBe(false);
    return;
  }
  for (const [name, value] of Object.entries(auth(key))) expect([row.id, name, call.headers.get(name)]).toEqual([row.id, name, value]);
  // The key is in the header that carries it, and nowhere else: not the address, not another header, not the body.
  expect([row.id, carrying(call.headers, key)]).toEqual([row.id, Object.entries(auth(key)).filter(([, v]) => v.includes(key)).map(([n]) => n).sort()]);
  expect(call.body.includes(key)).toBe(false);
}

test("every preset has its row: a new one is checked against its vendor before it ships", () => {
  expect(ROWS.map((r) => r.id).sort()).toEqual(PRESETS.map((p) => p.id).sort());
  for (const row of ROWS) expect([row.id, row.docs.startsWith("https://")]).toEqual([row.id, true]);
});

for (const row of ROWS) {
  describe(row.id, () => {
    const known = preset(row.id)!;
    const asItself = !row.plan || row.plan.native;

    test(`its terms, as the code holds it to them${row.plan ? "" : " (none: it is a provider like any other)"}`, () => {
      expect(planOf(row.id)?.allows ?? null).toEqual(row.plan ? { native: row.plan.native, tools: row.plan.tools } : null);
      expect(planOf(row.id)?.session).toBe(row.plan?.session);
      expect(known.baseUrl).toBe(row.base ? "" : new URL(row.chat).href.replace(/\/(v1\/messages|chat\/completions|responses)$/, ""));
    });

    if (asItself) {
      test(`his own call reaches ${row.chat} ${row.auth ? "with the key in its header" : "with no key"}, and says what it should`, async () => {
        const { ctx, key } = configured(row);
        seen.length = 0;
        const events = await answer(chat(ctx, { model: `${row.id}/${row.model}`, messages: hello, ...(row.plan ? { coding: true } : {}) }));
        expect(events.map((e) => e.type)).toEqual(["model", "text", "done"]);
        expect(seen).toHaveLength(1);
        const call = seen[0]!;
        expect(call.method).toBe("POST");
        const at = new URL(call.url);
        expect(`${at.origin}${at.pathname}`).toBe(row.chat);
        expectAuth(call, row, key, row.auth);
        const body = JSON.parse(call.body);
        expect(body).toMatchObject({ model: row.model, stream: true });
        if (known.kind === "anthropic") {
          expect(body).toMatchObject({ max_tokens: expect.any(Number), thinking: { type: "adaptive" }, messages: hello });
          expect(call.headers.get("anthropic-version")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        } else if (row.chat.endsWith("/responses")) {
          expect(body).toMatchObject({ instructions: expect.any(String), input: hello, store: false });
          expect(body.tools).toBeUndefined();
          expect(call.headers.get("content-type")).toBe("application/json");
        } else {
          expect(body.messages[0]).toMatchObject({ role: "system", content: expect.any(String) });
          expect(body.messages.slice(1)).toEqual(hello);
          expect(body.tools).toBeUndefined();
          expect(call.headers.get("content-type")).toBe("application/json");
        }
        // To a coding plan he says who he is, and which conversation this is where it routes by one.
        if (row.plan) expect(call.headers.get("user-agent")).toBe(SELF);
        if (row.plan?.session) expect(call.headers.get(row.plan.session)).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
      });

      test("a call it refuses says which provider and why, and never the key", async () => {
        const { ctx, key } = configured(row);
        refusing = true;
        try {
          const events = await answer(chat(ctx, { model: `${row.id}/${row.model}`, messages: hello, ...(row.plan ? { coding: true } : {}) }));
          const error = events.find((e) => e.type === "error") as { error: string };
          expect(error.error).toContain(`${row.id}/${row.model}: `);
          expect(error.error).toContain("401");
          expect(error.error).toContain("invalid api key");
          if (key) expect(error.error).not.toContain(key);
        } finally {
          refusing = false;
        }
      });
    } else {
      test("his own coding calls never reach it: its terms forbid them, and he says so", async () => {
        const { ctx, key, store, vault } = configured(row);
        seen.length = 0;
        const events = await answer(chat(ctx, { model: `${row.id}/${row.model}`, messages: hello, coding: true }));
        expect(seen).toEqual([]);
        expect((events.find((e) => e.type === "error") as { error: string }).error).toContain(`${row.id} is a coding plan its vendor's terms allow`);
        expect(resolveProvider(store, vault, row.id, "coding")!.apiKey).toBeNull();
        expect(resolveProvider(store, vault, row.id, "tool")!.apiKey).toBe(key);
      });
    }

    if (row.plan) {
      test("he never answers you with it: a coding plan is for coding", async () => {
        const { ctx } = configured(row);
        seen.length = 0;
        const events = await answer(chat(ctx, { model: `${row.id}/${row.model}`, messages: hello }));
        expect(seen).toEqual([]);
        expect(events.map((e) => e.type)).toEqual(["error"]);
      });
    }

    test(`a tool's call through the gateway reaches it ${row.plan?.tools === "interactive" ? "only from one you run yourself" : "from a knight's VM"}, ${row.auth ? "with the key added" : "with no key to add"} and the tool's token kept back`, async () => {
      const { store, vault, key, tokens } = configured(row);
      // (A tool asks where its own protocol says: Codex asks OpenAI's Responses, as Galahad does there.)
      const path = known.kind === "anthropic" ? "v1/messages" : row.chat.endsWith("/responses") ? "responses" : "chat/completions";
      const body = JSON.stringify({ model: row.model, messages: hello, stream: false });
      const through = (label: string) => {
        const { token } = tokens.mint({ label, providers: [row.id], ttlMinutes: 10, maxRequests: 5 });
        return { token, response: handleGateway(new Request(`http://127.0.0.1:7777/gw/${row.id}/${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "opencode/2.2.7" }, body }), { store, vault, tokens, fetch: routed }) };
      };
      seen.length = 0;
      const knight = through("sandbox:0123456789");
      if (row.plan?.tools === "interactive") {
        expect((await knight.response).status).toBe(403);
        expect(seen).toEqual([]);
      }
      const yours = row.plan?.tools === "interactive" ? through("run:opencode") : knight;
      expect((await yours.response).status).toBe(200);
      expect(seen).toHaveLength(1);
      const call = seen[0]!;
      const at = new URL(call.url);
      expect(`${at.origin}${at.pathname}`).toBe(row.chat);
      // Anthropic's own header for its key through the gateway (keyHeaders); every other provider's as its row says.
      expectAuth(call, row, key, known.kind === "anthropic" ? (k) => ({ "x-api-key": k }) : row.auth);
      expect(call.body).toBe(body);
      expect(call.url.includes(yours.token) || [...call.headers.values()].some((v) => v.includes(yours.token))).toBe(false);
      // The tool calls as itself.
      expect(call.headers.get("user-agent")).toBe("opencode/2.2.7");
      if (row.plan?.session) expect(call.headers.get(row.plan.session)).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    });

    const models = row.models;
    test("asks" in models ? `its models are asked of ${models.asks}${row.auth ? ", with its key" : ""}` : "named" in models ? "its models are the ones its preset names, and it isn't asked" : "its models are yours to name, and it says so", async () => {
      const { store, vault, key } = configured(row);
      const resolved = resolveProvider(store, vault, row.id, "tool")!;
      seen.length = 0;
      if ("asks" in models) {
        expect(await offeredModels(resolved, routed)).toEqual(["m-1", "m-2"]);
        expect(seen.map((s) => [s.method, s.url])).toEqual([["GET", models.asks]]);
        expectAuth(seen[0]!, row, key, models.auth ?? row.auth);
      } else if ("named" in models) {
        expect(await offeredModels(resolved, routed)).toEqual(models.named);
        expect(seen).toEqual([]);
      } else {
        await expect(offeredModels(resolved, routed)).rejects.toThrow(models.none);
        expect(seen).toEqual([]);
      }
    });
  });
}
