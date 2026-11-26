import { describe, expect, test } from "bun:test";
import type { ChatMessage, ChatStreamEvent } from "@galahad/core";
import { ACP_VERSION, acpAgent, type Delivery, promptText } from "../src/acp-agent.ts";

/*
 * Galahad as an ACP agent, as a harness that runs ACP agents drives him (Buzz's buzz-acp, an editor): JSON-RPC a line
 * at a time. The node's answer is a stand-in stream.
 */

function client(answer: (messages: ChatMessage[], signal: AbortSignal) => AsyncIterable<ChatStreamEvent>, delivery?: Delivery) {
  const out: any[] = [];
  const asked: ChatMessage[][] = [];
  const agent = acpAgent({
    ask: (messages, signal) => {
      asked.push(messages.map((m) => ({ ...m })));
      return answer(messages, signal);
    },
    write: (line) => out.push(JSON.parse(line)),
    ...(delivery ? { delivery } : {}),
  });
  let next = 0;
  const call = async (method: string, params: object = {}) => {
    const id = ++next;
    await agent.receive(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return out.find((m) => m.id === id);
  };
  const notify = (method: string, params: object) => agent.receive(JSON.stringify({ jsonrpc: "2.0", method, params }));
  return { agent, out, asked, call, notify };
}

const says = (...events: ChatStreamEvent[]) => async function* () { yield* events; };

describe("Galahad as an ACP agent", () => {
  test("initialize says what he is and that he asks the client for nothing; a session opens", async () => {
    const c = client(says());
    const init = await c.call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true } } });
    expect(init.result).toMatchObject({ protocolVersion: ACP_VERSION, agentCapabilities: { loadSession: false }, authMethods: [], agentInfo: { name: "galahad" } });
    const opened = await c.call("session/new", { cwd: "/tmp", mcpServers: [] });
    expect(opened.result.sessionId).toMatch(/^gal-/);
    // What he doesn't offer is said so, and a notification of it changes nothing.
    expect((await c.call("session/load", { sessionId: "x" })).error).toMatchObject({ code: -32601 });
  });

  test("a prompt is answered by Galahad on the node: his words stream as chunks, his tools as tool calls, and it ends", async () => {
    const c = client(says(
      { type: "tool", id: "t1", name: "recall", title: "Recall", input: "deploy" },
      { type: "tool_result", id: "t1", name: "recall", ok: true, summary: "3 memories" },
      { type: "text", text: "It deploys " },
      { type: "text", text: "with scripts/deploy.sh." },
      { type: "done", ref: "p/m" },
    ));
    const { result: { sessionId } } = await c.call("session/new", { cwd: "/", mcpServers: [] });
    const answered = await c.call("session/prompt", { sessionId, prompt: [{ type: "text", text: "@galahad how do we deploy?" }] });
    expect(answered.result).toEqual({ stopReason: "end_turn" });
    const updates = c.out.filter((m) => m.method === "session/update").map((m) => m.params.update);
    expect(updates.map((u) => u.sessionUpdate)).toEqual(["tool_call", "tool_call_update", "agent_message_chunk", "agent_message_chunk"]);
    expect(updates[1]).toMatchObject({ toolCallId: "t1", status: "completed" });
    expect(updates.filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content.text).join("")).toBe("It deploys with scripts/deploy.sh.");
    expect(c.asked[0]).toEqual([{ role: "user", content: "@galahad how do we deploy?" }]);
  });

  test("a session keeps its exchange: a follow-up is asked with what came before", async () => {
    const c = client(says({ type: "text", text: "Yes." }, { type: "done", ref: "p/m" }));
    const { result: { sessionId } } = await c.call("session/new", { cwd: "/", mcpServers: [] });
    await c.call("session/prompt", { sessionId, prompt: [{ type: "text", text: "Is CI green?" }] });
    await c.call("session/prompt", { sessionId, prompt: [{ type: "text", text: "And main?" }] });
    expect(c.asked[1]).toEqual([{ role: "user", content: "Is CI green?" }, { role: "assistant", content: "Yes." }, { role: "user", content: "And main?" }]);
  });

  test("a cancel ends the prompt under way as cancelled", async () => {
    const c = client(async function* (_m, signal) {
      yield { type: "text", text: "Working" } as ChatStreamEvent;
      await new Promise((_, no) => signal.addEventListener("abort", () => no(new Error("aborted")), { once: true }));
    });
    const { result: { sessionId } } = await c.call("session/new", { cwd: "/", mcpServers: [] });
    const answering = c.call("session/prompt", { sessionId, prompt: [{ type: "text", text: "Go" }] });
    await Bun.sleep(5);
    await c.notify("session/cancel", { sessionId });
    expect((await answering).result).toEqual({ stopReason: "cancelled" });
  });

  test("when he can't answer, the reason is said where you asked, a line, with no key in it", async () => {
    const c = client(says({ type: "error", error: `provider said 401: key ${["sk", "ant", "api03", "FAKEfakeFAKEfakeFAKEfake0123"].join("-")} refused\nstack…` }));
    const { result: { sessionId } } = await c.call("session/new", { cwd: "/", mcpServers: [] });
    expect((await c.call("session/prompt", { sessionId, prompt: [{ type: "text", text: "Hi" }] })).result).toEqual({ stopReason: "end_turn" });
    const said = c.out.filter((m) => m.method === "session/update").map((m) => m.params.update.content.text).join("");
    expect(said).toStartWith("Galahad couldn't answer: provider said 401");
    expect(said).not.toContain("sk-ant-api03");
    expect(said).not.toContain("stack");
  });

  test("what a prompt carries is read as words: text, a resource's text, the rest named", () => {
    expect(promptText([{ type: "text", text: "Look at this" }, { type: "resource", resource: { uri: "buzz://channel/eng", text: "a: hi\nb: ho" } }, { type: "image", data: "…" }])).toBe("Look at this\n\nbuzz://channel/eng:\na: hi\nb: ho\n\n(a image was attached, which Galahad can't read here)");
  });

  test("with a delivery (Buzz's), he is asked in its framing, and what he said is delivered before the turn ends: never a cancelled one's", async () => {
    const delivered: { answer: { text: string; failed: boolean }; turn: string; answeredYet: boolean }[] = [];
    let c: ReturnType<typeof client>;
    const delivery: Delivery = {
      frame: (turn) => `Where you are.\n\n${turn}`,
      deliver: async (answer, turn) => void delivered.push({ answer, turn, answeredYet: c.out.some((m) => m.result?.stopReason) }),
    };
    let answer: (m: ChatMessage[], signal: AbortSignal) => AsyncIterable<ChatStreamEvent> = says({ type: "text", text: "It deploys " }, { type: "text", text: "with scripts/deploy.sh." }, { type: "done", ref: "p/m" });
    c = client((m, signal) => answer(m, signal), delivery);
    const { result: { sessionId } } = await c.call("session/new", { cwd: "/", mcpServers: [] });
    expect((await c.call("session/prompt", { sessionId, prompt: [{ type: "text", text: "<context>…</context> how do we deploy?" }] })).result).toEqual({ stopReason: "end_turn" });
    expect(c.asked[0]).toEqual([{ role: "user", content: "Where you are.\n\n<context>…</context> how do we deploy?" }]);
    expect(delivered).toEqual([{ answer: { text: "It deploys with scripts/deploy.sh.", failed: false }, turn: "<context>…</context> how do we deploy?", answeredYet: false }]);
    // He couldn't answer: what is delivered is that, never the provider's words.
    answer = says({ type: "error", error: "provider said 500" });
    await c.call("session/prompt", { sessionId, prompt: [{ type: "text", text: "Again?" }] });
    expect(delivered.at(-1)!.answer).toEqual({ text: "", failed: true });
    // Cancelled: nothing is delivered.
    answer = async function* (_m, signal) {
      yield { type: "text", text: "Half" } as ChatStreamEvent;
      await new Promise((_, no) => signal.addEventListener("abort", () => no(new Error("aborted")), { once: true }));
    };
    const answering = c.call("session/prompt", { sessionId, prompt: [{ type: "text", text: "Go" }] });
    await Bun.sleep(5);
    await c.notify("session/cancel", { sessionId });
    expect((await answering).result).toEqual({ stopReason: "cancelled" });
    expect(delivered.length).toBe(2);
  });

  test("a prompt too long to send whole keeps its beginning and its end, and a long exchange its newest messages", async () => {
    const c = client(says({ type: "text", text: "Read it." }, { type: "done", ref: "p/m" }));
    const { result: { sessionId } } = await c.call("session/new", { cwd: "/", mcpServers: [] });
    const long = `BEGIN${"x".repeat(150_000)}END`;
    await c.call("session/prompt", { sessionId, prompt: [{ type: "text", text: long }] });
    const sent = c.asked[0]![0]!.content;
    expect(sent.length).toBeLessThan(70_000);
    expect(sent).toStartWith("BEGIN");
    expect(sent).toEndWith("END");
    expect(sent).toContain("characters cut");
    for (let i = 0; i < 4; i++) await c.call("session/prompt", { sessionId, prompt: [{ type: "text", text: long }] });
    // Five turns of 64,000 characters are more than goes with one: the newest go, beginning with one of yours.
    const last = c.asked.at(-1)!;
    expect(last.length).toBeLessThan(10);
    expect(last[0]!.role).toBe("user");
    expect(last.reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(200_000);
  });

  test("a prompt to no session, an empty one, or a second while one is under way is refused, and garbage is answered", async () => {
    const c = client(async function* (_m, signal) {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    });
    expect((await c.call("session/prompt", { sessionId: "nope", prompt: [{ type: "text", text: "x" }] })).error).toMatchObject({ code: -32602 });
    const { result: { sessionId } } = await c.call("session/new", { cwd: "/", mcpServers: [] });
    expect((await c.call("session/prompt", { sessionId, prompt: [] })).error).toMatchObject({ code: -32602 });
    const first = c.call("session/prompt", { sessionId, prompt: [{ type: "text", text: "one" }] });
    expect((await c.call("session/prompt", { sessionId, prompt: [{ type: "text", text: "two" }] })).error).toMatchObject({ code: -32600 });
    await c.notify("session/cancel", { sessionId });
    await first;
    await c.agent.receive("{not json");
    expect(c.out.at(-1)).toMatchObject({ error: { code: -32700 } });
  });
});
