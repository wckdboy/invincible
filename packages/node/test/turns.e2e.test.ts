import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChatStreamEvent, clientIdFromKey, type ConversationSummary, type ConversationView, type QueuedMessage, type RouteName, routes, type Scope, signRequest, type TurnLimits, type TurnView, type UnreadChat, utf8 } from "@galahad/core";
import { requestPairing, waitForApproval } from "@galahad/link";
import { foundFleet, MindStore } from "@galahad/mind";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { LocalClient } from "../src/loop-tasks.ts";
import { askCommand, type Io, queueCommand, turnsCommand } from "../src/turn-cli.ts";
import { freePort } from "./ports.ts";

/*
 * Turns the node owns, end to end: a real daemon over real HTTP, with a stand-in model
 * the test paces (so a turn can be caught mid-answer) and a stand-in service for a slow
 * tool. A turn outlives the connection that started it and another device attaches to
 * it; Stop is explicit; a queue survives a restart and is sent only when resumed; a
 * steer during a tool call waits for the tool; the limits are said plainly; and a
 * steered or queued message is checked like any other.
 */

const caps: Capabilities = { os: "linux", arch: "x64", hostname: "turns-test", cores: 4, cpu: "test", memoryGb: 8, hasBattery: false, gpu: [], docker: false, vm: { kvm: false, tools: [] }, tools: [], localModels: [], tailscale: null };

const root = mkdtempSync(join(tmpdir(), "galahad-turns-"));
const home = new Home(join(root, "node"));
const port = freePort();
let daemon: Daemon;
const startNode = () => startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {}, turnLimits: { maxTurns: 3 }, shutdownGraceMs: 150 });

/* ---------- the stand-in model: each request gets the next scripted reply; bodies are kept ---------- */

type Reply = (body: any) => Response;
const bodies: any[] = [];
let script: Reply[] = [];
const frame = (chunk: object) => `data: ${JSON.stringify(chunk)}\n\n`;
const sse = (...chunks: object[]): Reply => () => new Response(chunks.map(frame).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
const say = (text: string) => sse({ choices: [{ delta: { content: text } }] });
const callTools = (...calls: { id: string; name: string; args: object }[]) =>
  sse({ choices: [{ delta: { tool_calls: calls.map((c, index) => ({ index, id: c.id, function: { name: c.name, arguments: JSON.stringify(c.args) } })) } }] });
/** Says `first` at once, then waits to be let go before saying `rest` and ending. */
function paced(first: string, rest: string): { reply: Reply; go: () => void } {
  let go: () => void = () => {};
  const released = new Promise<void>((resolve) => (go = resolve));
  const encoder = new TextEncoder();
  const reply: Reply = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode(frame({ choices: [{ delta: { content: first } }] })));
          await released;
          try {
            controller.enqueue(encoder.encode(frame({ choices: [{ delta: { content: rest } }] }) + "data: [DONE]\n\n"));
            controller.close();
          } catch {
            /* the node gave up on this call (a stop, a steer) */
          }
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  return { reply, go };
}
const model = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  idleTimeout: 60,
  fetch: async (req) => {
    const body = await req.json();
    bodies.push(body);
    return (script.shift() ?? say("OK."))(body);
  },
});

/** Another service, for a connector's tools: /slow answers when the test lets it; everything that reached it is kept. */
const reached: string[] = [];
let slow: { started: Promise<void>; finish: () => void } = { started: Promise.resolve(), finish: () => {} };
function armSlow(): void {
  let started: () => void = () => {};
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => (finish = resolve));
  slow = { started: new Promise<void>((resolve) => (started = resolve)), finish };
  slowHandler = async () => {
    started();
    await done;
    return Response.json({ report: "ready" });
  };
}
let slowHandler: () => Promise<Response> = async () => Response.json({ report: "ready" });
const service = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  idleTimeout: 60,
  fetch: (req) => {
    const path = new URL(req.url).pathname;
    reached.push(`${req.method} ${path}`);
    return path === "/slow" ? slowHandler() : Response.json({ ok: true });
  },
});

/* ---------- callers: you at a terminal, and paired devices ---------- */

type Caller = (name: RouteName, input?: unknown, signal?: AbortSignal) => Promise<Response>;
const admin: Caller = (name, input, signal) => {
  const route = routes[name];
  return fetch(`http://127.0.0.1:${port}${route.path}`, {
    method: route.method,
    headers: { authorization: `Bearer ${home.adminToken()}`, "content-type": "application/json" },
    body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined,
    signal,
  });
};
const withToken =
  (token: string): Caller =>
  (name, input) => {
    const route = routes[name];
    return fetch(`http://127.0.0.1:${port}${route.path}`, { method: route.method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined });
  };
const json = async <T = any>(response: Promise<Response> | Response): Promise<T> => {
  const r = await response;
  const body = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(`${r.status} ${body.error ?? ""}`);
  return body;
};

/** A browser paired with the node (a WebCrypto key, signed requests), holding the scopes given. */
async function pairDevice(name: string, scopes: Scope[]): Promise<{ id: string; call: Caller }> {
  const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
  const id = clientIdFromKey(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)));
  const { invite } = await json<{ invite: string }>(admin("createInvite", { kind: "client", scopes }));
  const joining = await requestPairing(invite, { device: id, name, kind: "client" });
  const { pairings } = await json<{ pairings: { invite: string; device: string }[] }>(admin("pairings"));
  const mine = pairings.find((p) => p.device === id)!;
  await json(admin("approvePairing", { invite: mine.invite, device: mine.device }));
  await waitForApproval(joining, { intervalMs: 20 });
  const call: Caller = async (route, input, signal) => {
    const r = routes[route];
    const bytes = r.method === "POST" ? utf8(JSON.stringify(input ?? {})) : new Uint8Array();
    const headers = await signRequest(id, async (m) => new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, m)), r.method, r.path, bytes);
    return fetch(`http://127.0.0.1:${port}${r.path}`, { method: r.method, headers: { ...headers, "content-type": "application/json" }, body: r.method === "POST" ? bytes : undefined, signal });
  };
  return { id, call };
}

/** A turn's stream, read as it comes. */
function watch(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: ChatStreamEvent[] = [];
  let buffer = "";
  let ended = false;
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut: number;
        while ((cut = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          // What each call cost is usage.test.ts's to check: these read the answer's own flow.
          for (const line of block.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const event = JSON.parse(line.slice(6)) as ChatStreamEvent;
            if (event.type !== "usage") events.push(event);
          }
        }
      }
    } catch {
      /* the connection was dropped */
    }
    ended = true;
  })();
  return {
    events,
    types: () => events.map((e) => e.type),
    text: () => events.flatMap((e) => (e.type === "text" ? [e.text] : [])).join(""),
    turn: () => events.find((e) => e.type === "turn") as Extract<ChatStreamEvent, { type: "turn" }>,
    /** Until the stream has shown an event of this type (or `n` of them). */
    async seen(type: ChatStreamEvent["type"], n = 1): Promise<void> {
      await until(() => events.filter((e) => e.type === type).length >= n || ended);
      if (events.filter((e) => e.type === type).length < n) throw new Error(`the stream ended before ${type}: ${events.map((e) => e.type).join(", ")}`);
    },
    done: pump,
  };
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error("condition not met in time");
}

const ask = async (caller: Caller, content: string, extra: object = {}, signal?: AbortSignal) => {
  const response = await caller("chat", { messages: [{ role: "user", content }], ...extra }, signal);
  if (!response.ok) throw new Error(`${response.status} ${((await response.json().catch(() => ({}))) as { error?: string }).error ?? ""}`);
  return watch(response);
};
const chatOf = async (id: string, caller: Caller = admin) => (await json<{ conversation: ConversationView }>(caller("conversation", { id }))).conversation;
const listed = async (caller: Caller = admin) => json<{ turns: TurnView[]; limits: TurnLimits; chats: string; unread: UnreadChat[] }>(caller("turns"));
const summaries = async (caller: Caller = admin) => (await json<{ conversations: ConversationSummary[] }>(caller("conversations"))).conversations;
const idle = () => until(async () => (await listed()).turns.length === 0);

let phone: { id: string; call: Caller };

beforeAll(async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const store = new MindStore(home.mindPath);
  const fleet = foundFleet(store, identity, { fleetName: "camelot", nodeName: "keep" });
  store.close();
  home.writeConfig({ v: 1, name: "keep", fleet, port, keystore, advertise: "127.0.0.1" });
  daemon = await startNode();
  await json(admin("setProvider", { id: "stand-in", kind: "openai", baseUrl: `http://127.0.0.1:${model.port}/v1` }));
  await json(admin("setRoster", { role: "planner", models: ["stand-in/m"] }));
  // A connector with a slow read, a quick read and an outward tool.
  const manifest = {
    id: "forge",
    label: "Forge",
    origin: `http://127.0.0.1:${service.port}`,
    auth: { secret: "forge", scheme: "bearer", optional: true },
    tools: {
      slow: { description: "A slow report.", method: "GET", path: "/slow", params: {}, class: "read" },
      quick: { description: "A quick look.", method: "GET", path: "/quick", params: {}, class: "read" },
      post: { description: "Post.", method: "POST", path: "/posts", params: { text: { type: "string", required: true } }, class: "outward" },
    },
  };
  await json(admin("setConnector", { id: "forge", manifest }));
  // A phone that may chat and read the mind, but not the bank.
  phone = await pairDevice("phone", ["mind:read", "chat"]);
});

afterAll(async () => {
  await daemon?.stop();
  model.stop(true);
  service.stop(true);
  rmSync(root, { recursive: true, force: true });
});

describe("a turn outlives the connection that started it", () => {
  test("started by one client, its connection dropped, attached to by a second, seen from its start to its end, and kept", async () => {
    const pace = paced("Once upon a time, ", "the end.");
    script = [pace.reply];
    const dropped = new AbortController();
    const first = await ask(admin, "Tell me a story.", { save: true }, dropped.signal);
    await first.seen("text");
    const turn = first.turn();
    expect(first.types()).toEqual(["turn", "conversation", "model", "text"]);
    expect(turn).toMatchObject({ type: "turn", replay: false, role: "planner" });
    expect(turn.deadline - turn.startedAt).toBe(30 * 60_000);
    // The page goes away mid-answer (a locked phone, a lost signal).
    dropped.abort();
    await first.done;
    // He's still working: nobody is watching, and it says so.
    await until(async () => (await listed()).turns[0]?.watchers === 0);
    const running = (await listed()).turns;
    expect(running).toMatchObject([{ id: turn.id, conversation: turn.conversation, state: "running", watchers: 0, step: "Answering", watchable: true, title: "Tell me a story." }]);
    expect((await summaries())[0]).toMatchObject({ id: turn.conversation, state: "working" });
    // The kept chat says a turn is under way in it, so a reloaded page knows to attach.
    const mid = await chatOf(turn.conversation!);
    expect(mid.turn).toMatchObject({ id: turn.id, state: "running" });
    expect(mid.messages.map((m) => [m.role, m.status])).toEqual([
      ["user", "done"],
      ["assistant", "streaming"],
    ]);
    expect(mid.messages[1]!.id).toBe(turn.answer!);

    // Another device attaches: what was said before it came, then the rest, live.
    const tablet = await pairDevice("tablet", ["mind:read", "chat", "bank:read"]);
    const second = watch(await tablet.call("attachTurn", { turn: turn.id }));
    await second.seen("text");
    expect(second.turn()).toMatchObject({ id: turn.id, replay: true, answer: turn.answer });
    expect(second.text()).toBe("Once upon a time, ");
    expect((await listed()).turns[0]!.watchers).toBe(1);
    pace.go();
    await second.done;
    expect(second.types()).toEqual(["turn", "conversation", "model", "text", "text", "done"]);
    expect(second.text()).toBe("Once upon a time, the end.");

    const kept = await chatOf(turn.conversation!);
    expect(kept.turn).toBeNull();
    expect(kept.messages.map((m) => [m.role, m.content, m.status])).toEqual([
      ["user", "Tell me a story.", "done"],
      ["assistant", "Once upon a time, the end.", "done"],
    ]);
    expect(kept.state).toBe("done");
    // A page that comes back just after still sees how it went.
    const late = watch(await admin("attachTurn", { turn: turn.id }));
    await late.done;
    expect(late.types().at(-1)).toBe("done");
    expect((await listed()).turns).toEqual([]);
  });

  test("Stop is explicit: a dropped connection stops nothing, stopTurn does, and the answer so far is kept as stopped", async () => {
    const pace = paced("Chapter one. ", "never said");
    script = [pace.reply];
    const dropped = new AbortController();
    const first = await ask(admin, "Write a long report.", { save: true }, dropped.signal);
    await first.seen("text");
    const turn = first.turn();
    dropped.abort();
    await Bun.sleep(60);
    expect((await listed()).turns.map((t) => t.state)).toEqual(["running"]);
    const watching = watch(await admin("attachTurn", { turn: turn.id }));
    expect(await json(admin("stopTurn", { turn: turn.id }))).toMatchObject({ stopped: true });
    await watching.done;
    expect(watching.events.at(-1)).toEqual({ type: "stopped", reason: "you" });
    expect(watching.types()).not.toContain("error");
    const kept = await chatOf(turn.conversation!);
    expect(kept.messages[1]).toMatchObject({ content: "Chapter one. ", status: "stopped", error: null });
    expect(kept.state).toBe("stopped");
    expect(await json(admin("stopTurn", { turn: turn.id }))).toMatchObject({ stopped: false, state: "stopped" });
    pace.go();
    // Only one model call was ever made for it: nothing is retried.
    expect(bodies.filter((b) => b.messages.at(-1)?.content === "Write a long report.")).toHaveLength(1);
  });
});

describe("the same chats on every device", () => {
  test("a chat kept from one device is the same from another, and the turns list says when anything kept changed: a turn that ended unseen, a rename", async () => {
    await idle();
    script = [say("Noted: Friday.")];
    const before = (await listed()).chats;
    expect(before).toMatch(/^[0-9a-z]+\.\d+$/);
    // The phone asks, and the answer ends while this device isn't looking.
    const asked = await ask(phone.call, "Remember Friday.", { save: true });
    await asked.done;
    const id = asked.turn().conversation!;
    const after = (await listed()).chats;
    expect(after).not.toBe(before);
    // This device sees the chat, and all of it.
    expect((await summaries()).some((c) => c.id === id)).toBe(true);
    expect((await chatOf(id)).messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "Remember Friday."],
      ["assistant", "Noted: Friday."],
    ]);
    // Renamed here, with no turn at all: the phone can tell too.
    await json(admin("updateConversation", { id, title: "Friday" }));
    const renamed = (await listed(phone.call)).chats;
    expect(renamed).not.toBe(after);
    // Reading changes nothing.
    await chatOf(id);
    await summaries();
    expect((await listed()).chats).toBe(renamed);
  });

  test("an answer that ended with nobody watching is new on every device until it is read on one", async () => {
    await idle();
    const pace = paced("Done: ", "the plan.");
    script = [pace.reply];
    const dropped = new AbortController();
    const asked = await ask(phone.call, "Plan Friday.", { save: true }, dropped.signal);
    await asked.seen("text");
    const id = asked.turn().conversation!;
    // The phone is put away before he finishes.
    dropped.abort();
    await asked.done;
    await until(async () => (await listed()).turns[0]?.watchers === 0);
    pace.go();
    await idle();
    // New on this device and on the phone alike (his ring is green while it is).
    expect((await listed()).unread).toEqual([expect.objectContaining({ id, title: "Plan Friday." })]);
    expect((await listed(phone.call)).unread.map((c) => c.id)).toEqual([id]);
    expect((await summaries()).find((c) => c.id === id)?.unread).toBe(true);
    expect((await chatOf(id)).unread).toBe(true);
    // Read on the phone is read everywhere, and the other devices can tell something changed.
    const before = (await listed()).chats;
    expect(await json(phone.call("seeConversation", { id }))).toEqual({ seen: true });
    expect((await listed()).unread).toEqual([]);
    expect((await summaries()).find((c) => c.id === id)?.unread).toBe(false);
    const after = (await listed()).chats;
    expect(after).not.toBe(before);
    // Read again: nothing changes, so no device reads the chats again for it.
    expect(await json(admin("seeConversation", { id }))).toEqual({ seen: false });
    expect((await listed()).chats).toBe(after);
    // A chat that isn't kept here.
    expect((await phone.call("seeConversation", { id: `cv_${"A".repeat(22)}` })).status).toBe(404);
    // An answer watched to its end was read where it was watched.
    script = [say("Noted.")];
    const watched = await ask(phone.call, "Note it.", { conversation: id });
    await watched.done;
    await idle();
    expect((await listed()).unread).toEqual([]);
  });
});

describe("limits, said plainly", () => {
  test("one turn a chat (and what you can do instead), so many on the node, and nothing of a refused one is written", async () => {
    const paces = [paced("a", "."), paced("b", "."), paced("c", ".")];
    script = paces.map((p) => p.reply);
    const a = await ask(admin, "First.", { save: true });
    await a.seen("text");
    const id = a.turn().conversation!;
    const busy = await admin("chat", { conversation: id, messages: [{ role: "user", content: "Second, at once." }] });
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { error: string }).error).toBe("He's still working in this chat. Steer him (your message reaches him now), queue it (it's sent when he finishes), or stop him first.");
    expect((await chatOf(id)).messages).toHaveLength(2);
    const b = await ask(admin, "Second.", { save: true });
    const c = await ask(admin, "Third.");
    await b.seen("text");
    await c.seen("text");
    const before = (await summaries()).length;
    const full = await admin("chat", { save: true, messages: [{ role: "user", content: "Fourth." }] });
    expect(full.status).toBe(429);
    expect(((await full.json()) as { error: string }).error).toBe("This node is already working on 3 turns, its limit. Wait for one to end or stop one; a message queued behind a chat is sent when there's room.");
    expect((await summaries()).length).toBe(before);
    const { turns, limits } = await listed();
    expect(limits).toEqual({ maxTurns: 3, maxMinutes: 30, maxQueued: 20 });
    expect(turns).toHaveLength(3);
    for (const p of paces) p.go();
    await Promise.all([a.done, b.done, c.done]);
    await idle();
  });
});

describe("the queue", () => {
  test("queued while he works: visible, editable, removable, sent in order when the turn ends; Send now steers", async () => {
    const pace = paced("Working on one", ".");
    script = [pace.reply, say("Two is done."), say("Four is done.")];
    const first = await ask(admin, "Do one.", { save: true });
    await first.seen("text");
    const id = first.turn().conversation!;
    const q1 = await json<{ queue: QueuedMessage[]; held: null; started: null }>(admin("queueMessage", { conversation: id, text: "Do two." }));
    expect(q1).toMatchObject({ queue: [{ text: "Do two.", by: "a terminal on keep", role: null }], held: null, started: null });
    await json(phone.call("queueMessage", { conversation: id, text: "Do three." }));
    const q3 = await json<{ queue: QueuedMessage[] }>(admin("queueMessage", { conversation: id, text: "Do for." }));
    expect(q3.queue.map((q) => [q.text, q.by])).toEqual([
      ["Do two.", "a terminal on keep"],
      ["Do three.", "phone"],
      ["Do for.", "a terminal on keep"],
    ]);
    // Edited and removed while he works; any of your devices sees the same queue.
    const edited = await json<{ queue: QueuedMessage[] }>(admin("editQueued", { conversation: id, id: q3.queue[2]!.id, text: "Do four." }));
    expect(edited.queue[2]!.text).toBe("Do four.");
    const removed = await json<{ queue: QueuedMessage[] }>(phone.call("removeQueued", { conversation: id, id: q3.queue[1]!.id }));
    expect(removed.queue.map((q) => q.text)).toEqual(["Do two.", "Do four."]);
    expect((await chatOf(id, phone.call)).queue.map((q) => q.text)).toEqual(["Do two.", "Do four."]);
    expect((await summaries()).find((c) => c.id === id)).toMatchObject({ state: "working", queued: 2, held: null });
    expect(((await (await admin("editQueued", { conversation: id, id: 987_654, text: "x" })).json()) as { error: string }).error).toMatch(/no longer queued/);

    // He finishes: each queued message becomes the next turn, in order, with nobody attached.
    pace.go();
    await first.done;
    await until(async () => (await chatOf(id)).messages.length === 6 && (await chatOf(id)).turn === null);
    const kept = await chatOf(id);
    expect(kept.messages.map((m) => m.content)).toEqual(["Do one.", "Working on one.", "Do two.", "Two is done.", "Do four.", "Four is done."]);
    expect(kept.queue).toEqual([]);
    expect(kept.state).toBe("done");
    // What each model call saw: the kept history, then the queued message, like any message.
    expect(bodies.at(-1).messages.filter((m: any) => m.role !== "system").map((m: any) => m.content)).toEqual(["Do one.", "Working on one.", "Do two.", "Two is done.", "Do four."]);
  });

  test("Send now on a queued message steers the turn under way", async () => {
    const pace = paced("Thinking about one", " (never said)");
    script = [pace.reply, say("Understood: two first.")];
    const first = await ask(admin, "Do one.", { save: true });
    await first.seen("text");
    const id = first.turn().conversation!;
    const { queue } = await json<{ queue: QueuedMessage[] }>(admin("queueMessage", { conversation: id, text: "Two first, please." }));
    const sent = await json<{ how: string; queue: QueuedMessage[]; turn: TurnView }>(admin("sendQueued", { conversation: id, id: queue[0]!.id }));
    expect(sent).toMatchObject({ how: "steered", queue: [], turn: { id: first.turn().id } });
    await first.done;
    expect(first.types()).toEqual(["turn", "conversation", "model", "text", "steer", "text", "done"]);
    expect((await chatOf(id)).messages.map((m) => [m.role, m.content, m.status])).toEqual([
      ["user", "Do one.", "done"],
      ["assistant", "Thinking about one", "steered"],
      ["user", "Two first, please.", "done"],
      ["assistant", "Understood: two first.", "done"],
    ]);
    pace.go();
  });

  test("queued, the node restarted mid-turn: the message is still there, held, sent only when you resume", async () => {
    const pace = paced("Half an ans", "wer never finished");
    script = [pace.reply];
    const first = await ask(admin, "A long question.", { save: true });
    await first.seen("text");
    const id = first.turn().conversation!;
    await json(admin("queueMessage", { conversation: id, text: "And then this." }));
    await json(phone.call("queueMessage", { conversation: id, text: "And this, from the phone." }));

    // The node goes down with the turn under way and nobody able to finish it.
    await daemon.stop();
    await first.done;
    expect(first.events.at(-1)).toEqual({ type: "stopped", reason: "node" });
    pace.go();
    const asked = bodies.length;

    daemon = await startNode();
    const back = await chatOf(id);
    expect(back.messages.map((m) => [m.role, m.content, m.status])).toEqual([
      ["user", "A long question.", "done"],
      ["assistant", "Half an ans", "stopped"],
    ]);
    expect(back.queue.map((q) => [q.text, q.by])).toEqual([
      ["And then this.", "a terminal on keep"],
      ["And this, from the phone.", "phone"],
    ]);
    expect(back).toMatchObject({ state: "queued", queued: 2, held: "restart", turn: null });
    // Nothing was sent just because the node came back.
    await Bun.sleep(100);
    expect(bodies.length).toBe(asked);
    expect((await listed()).turns).toEqual([]);

    // You resume: the queue goes on, in order, each as its own turn.
    script = [say("This is done."), say("And the phone's.")];
    const resumed = await json<{ queue: QueuedMessage[]; held: null; turn: TurnView | null }>(admin("resumeQueue", { conversation: id }));
    expect(resumed.held).toBeNull();
    expect(resumed.turn).toMatchObject({ state: "running", conversation: id });
    await until(async () => (await chatOf(id)).messages.length === 6 && (await chatOf(id)).turn === null);
    expect((await chatOf(id)).messages.slice(2).map((m) => m.content)).toEqual(["And then this.", "This is done.", "And this, from the phone.", "And the phone's."]);
    expect((await chatOf(id)).queue).toEqual([]);
  });

  test("after a Stop the queue is held until you resume or discard it", async () => {
    const pace = paced("Starting", "…");
    script = [pace.reply];
    const first = await ask(admin, "Do one.", { save: true });
    await first.seen("text");
    const id = first.turn().conversation!;
    await json(admin("queueMessage", { conversation: id, text: "Do two." }));
    await json(admin("stopTurn", { turn: first.turn().id }));
    await first.done;
    pace.go();
    const asked = bodies.length;
    expect(await chatOf(id)).toMatchObject({ state: "queued", queued: 1, held: "stopped", turn: null });
    await Bun.sleep(80);
    expect(bodies.length).toBe(asked);
    // Discarded: nothing is ever sent.
    expect(await json(admin("removeQueued", { conversation: id }))).toEqual({ queue: [], held: null });
    expect(await chatOf(id)).toMatchObject({ state: "stopped", queued: 0, held: null });
    expect(bodies.length).toBe(asked);
  });

  test("a queued message whose device was revoked is never sent: the queue is held and says why", async () => {
    const visitor = await pairDevice("visitor", ["mind:read", "chat"]);
    const pace = paced("One", ".");
    script = [pace.reply];
    const first = await ask(admin, "Do one.", { save: true });
    await first.seen("text");
    const id = first.turn().conversation!;
    await json(visitor.call("queueMessage", { conversation: id, text: "Do the visitor's bidding." }));
    await json(admin("revokeDevice", { device: visitor.id, reason: "test" }));
    const asked = bodies.length;
    pace.go();
    await first.done;
    await until(async () => (await chatOf(id)).held === "device");
    expect(await chatOf(id)).toMatchObject({ queued: 1, held: "device", turn: null });
    expect(bodies.length).toBe(asked);
    // You may still send it yourself, as yourself.
    script = [say("As you say.")];
    const { queue } = await chatOf(id);
    const sent = await json<{ how: string }>(admin("sendQueued", { conversation: id, id: queue[0]!.id }));
    expect(sent.how).toBe("started");
    await until(async () => (await chatOf(id)).turn === null && (await chatOf(id)).messages.length === 4);
    expect((await chatOf(id)).messages.at(-1)!.content).toBe("As you say.");
  });
});

describe("steering", () => {
  test("a steer that arrives during a tool call: the tool finishes and is reported, the next isn't run, then he's told", async () => {
    armSlow();
    reached.length = 0;
    script = [
      callTools({ id: "call_slow", name: "connector_call", args: { connector: "forge", tool: "slow", args: {} } }, { id: "call_quick", name: "connector_call", args: { connector: "forge", tool: "quick", args: {} } }),
      say("I stopped after the report, as you asked."),
    ];
    const first = await ask(admin, "Fetch the report, then take a quick look.", { save: true });
    await slow.started;
    await first.seen("tool");
    const turn = first.turn();
    // Mid-tool: your message is accepted, and nothing about the tool is reported yet.
    expect(await json(admin("steerTurn", { turn: turn.id, text: "Only the report: skip the look." }))).toEqual({ steered: true, waiting: 1 });
    expect(first.types()).toEqual(["turn", "conversation", "model", "tool"]);
    expect((await listed()).turns[0]).toMatchObject({ steering: 1, tools: 1 });
    slow.finish();
    await first.done;

    expect(first.types()).toEqual(["turn", "conversation", "model", "tool", "tool_result", "tool", "tool_result", "steer", "text", "done"]);
    const results = first.events.filter((e) => e.type === "tool_result") as Extract<ChatStreamEvent, { type: "tool_result" }>[];
    expect(results[0]).toMatchObject({ id: "call_slow", ok: true });
    expect(results[1]).toMatchObject({ id: "call_quick", ok: false, summary: "not run: your new message came first" });
    // The quick look never reached the service.
    expect(reached).toEqual(["GET /slow"]);
    // The model saw: both calls answered (one for real, one "not run"), his own pause, then your message.
    const sent = bodies.at(-1).messages;
    expect(sent.slice(-4)).toEqual([
      { role: "tool", tool_call_id: "call_slow", content: expect.stringContaining('"report":"ready"') },
      { role: "tool", tool_call_id: "call_quick", content: expect.stringContaining("Error: Not run: a new message from your liege arrived before this call started") },
      { role: "assistant", content: "(I paused here: my liege sent a new message.)" },
      { role: "user", content: "Only the report: skip the look." },
    ]);
    // And it's in the kept chat where it reached him.
    const kept = await chatOf(turn.conversation!);
    expect(kept.messages.map((m) => [m.role, m.status])).toEqual([
      ["user", "done"],
      ["assistant", "steered"],
      ["user", "done"],
      ["assistant", "done"],
    ]);
    expect(kept.messages[1]!.steps.filter((s) => s.kind === "tool").map((s) => (s.kind === "tool" ? [s.id, s.ok] : null))).toEqual([
      ["call_slow", true],
      ["call_quick", false],
    ]);
    expect(kept.messages[2]!.content).toBe("Only the report: skip the look.");
  });

  test("once he has finished, a steer is refused: it's a new message", async () => {
    script = [say("Done.")];
    const first = await ask(admin, "Quick one.", { save: true });
    await first.done;
    const late = await admin("steerTurn", { turn: first.turn().id, text: "One more thing." });
    expect(late.status).toBe(409);
    expect(((await late.json()) as { error: string }).error).toBe("He has finished that turn. Send it as a new message.");
  });
});

describe("a steered or queued message is your message, and checked like one", () => {
  const FAKE_KEY = `sk-ant-api03-${"FAKE".repeat(8)}`;

  test("nothing credential-shaped is steered, queued or edited in", async () => {
    const pace = paced("Working", ".");
    script = [pace.reply];
    const first = await ask(admin, "Do one.", { save: true });
    await first.seen("text");
    const id = first.turn().conversation!;
    const steer = await admin("steerTurn", { turn: first.turn().id, text: `Use ${FAKE_KEY}` });
    expect(steer.status).toBe(422);
    expect(((await steer.json()) as { error: string }).error).toMatch(/looks like a/i);
    expect((await admin("queueMessage", { conversation: id, text: `Then use ${FAKE_KEY}` })).status).toBe(422);
    const { queue } = await json<{ queue: QueuedMessage[] }>(admin("queueMessage", { conversation: id, text: "Then tidy up." }));
    expect((await admin("editQueued", { conversation: id, id: queue[0]!.id, text: FAKE_KEY })).status).toBe(422);
    expect((await chatOf(id)).queue.map((q) => q.text)).toEqual(["Then tidy up."]);
    expect((await listed()).turns[0]!.steering).toBe(0);
    await json(admin("removeQueued", { conversation: id }));
    pace.go();
    await first.done;
    expect(JSON.stringify(bodies)).not.toContain(FAKE_KEY);
  });

  test("the bank's rule holds across a steer: once he has read the bank in a turn, no message of yours in that turn lets it out or into the mind", async () => {
    // He reads the bank; while he's answering you steer him to write it down; the tool is still refused.
    const pace = paced("Your bank connection: ", "(never said)");
    script = [callTools({ id: "call_bank", name: "bank_status", args: {} }), pace.reply, callTools({ id: "call_keep", name: "remember", args: { text: "The liege's bank is connected" } }), say("I can't keep that: your bank data is in this answer.")];
    const first = await ask(admin, "How is my bank connection?", { save: true });
    await first.seen("text");
    await json(admin("steerTurn", { turn: first.turn().id, text: "Remember that for me." }));
    await first.done;
    pace.go();
    const results = first.events.filter((e) => e.type === "tool_result") as Extract<ChatStreamEvent, { type: "tool_result" }>[];
    expect(results.map((r) => [r.name, r.ok, r.summary])).toEqual([
      ["bank_status", true, expect.any(String)],
      ["remember", false, "refused: bank data is in this answer"],
    ]);
    expect(first.types()).toEqual(["turn", "conversation", "model", "tool", "tool_result", "text", "steer", "tool", "tool_result", "text", "done"]);
    expect(daemon.store.recall("bank is connected")).toEqual([]);
    // And the chat is marked as one where he read the bank, from the answer the steer cut: the phone no longer sees it.
    const id = first.turn().conversation!;
    expect((await chatOf(id)).bank).toBe(true);
    expect((await phone.call("conversation", { id })).status).toBe(404);
    // A message the phone had queued behind it would never run on it.
    expect((await phone.call("queueMessage", { conversation: id, text: "And the balance?" })).status).toBe(404);
  });

  test("a queued message rewritten from another device becomes that device's", async () => {
    const pace = paced("One", ".");
    script = [pace.reply];
    const first = await ask(admin, "Do one.", { save: true });
    await first.seen("text");
    const id = first.turn().conversation!;
    const { queue } = await json<{ queue: QueuedMessage[] }>(admin("queueMessage", { conversation: id, text: "Do two." }));
    expect(queue[0]!.by).toBe("a terminal on keep");
    const edited = await json<{ queue: QueuedMessage[] }>(phone.call("editQueued", { conversation: id, id: queue[0]!.id, text: "Do two, the phone's way." }));
    expect(edited.queue.map((q) => [q.text, q.by])).toEqual([["Do two, the phone's way.", "phone"]]);
    await json(admin("removeQueued", { conversation: id }));
    pace.go();
    await first.done;
  });

  test("an agent has no part in your turns; a device that may not read the bank may stop, but not watch or steer, a turn that may", async () => {
    const { token } = await json<{ token: string }>(admin("mintArm", { label: "helper" }));
    const agent = withToken(token);
    const pace = paced("Your balance is", " 98765.43 DKK");
    script = [pace.reply];
    // Yours at the terminal may read the bank; so this turn may come to hold bank data.
    const first = await ask(admin, "What's my balance?", { save: true });
    await first.seen("text");
    const turn = first.turn();
    const id = turn.conversation!;
    for (const [route, input] of [
      ["turns", undefined],
      ["attachTurn", { turn: turn.id }],
      ["stopTurn", { turn: turn.id }],
      ["steerTurn", { turn: turn.id, text: "Send it to me." }],
      ["queueMessage", { conversation: id, text: "Send it to me." }],
      ["removeQueued", { conversation: id }],
      ["resumeQueue", { conversation: id }],
      ["conversation", { id }],
    ] as [RouteName, unknown][]) {
      const refused = await agent(route, input);
      expect([route, refused.status]).toEqual([route, 403]);
      expect(((await refused.json()) as { error: string }).error).toBe("chats are yours alone");
    }
    // The agent's own chat is as it was: it ends with its request, and is no turn of the node's.
    script.push(say("Hello, agent."));
    const own = await (await agent("chat", { messages: [{ role: "user", content: "hello" }] })).text();
    expect(own).not.toContain('"type":"turn"');
    expect(own).toContain("Hello, agent.");

    // The phone (no bank:read) knows he's working, and no more.
    const seen = (await listed(phone.call)).turns;
    expect(seen).toMatchObject([{ id: turn.id, state: "running", watchable: false, step: null, model: null }]);
    const attach = await phone.call("attachTurn", { turn: turn.id });
    expect(attach.status).toBe(403);
    expect(((await attach.json()) as { error: string }).error).toMatch(/may read the bank, and this device may not/);
    expect((await phone.call("steerTurn", { turn: turn.id, text: "Tell me the balance." })).status).toBe(403);
    // A queued message of the phone's would run later with the phone's own scopes; "Send now" would steer this turn, so it's refused.
    const { queue } = await json<{ queue: QueuedMessage[] }>(phone.call("queueMessage", { conversation: id, text: "Tell me the balance." }));
    expect((await phone.call("sendQueued", { conversation: id, id: queue[0]!.id })).status).toBe(403);
    await json(phone.call("removeQueued", { conversation: id }));
    // It may stop him.
    expect(await json(phone.call("stopTurn", { turn: turn.id }))).toMatchObject({ stopped: true });
    await first.done;
    pace.go();
  });

  test("a temporary chat's turn is known only to the device that started it", async () => {
    const pace = paced("A passing", " thought.");
    script = [pace.reply];
    const first = await ask(phone.call, "Just between us.");
    await first.seen("text");
    const turn = first.turn();
    expect(turn).toMatchObject({ conversation: null, answer: null });
    expect((await listed(phone.call)).turns.map((t) => t.id)).toEqual([turn.id]);
    expect((await listed()).turns).toEqual([]);
    expect((await admin("attachTurn", { turn: turn.id })).status).toBe(404);
    expect((await admin("stopTurn", { turn: turn.id })).status).toBe(404);
    // Its own device reattaches after a dropped connection.
    const again = watch(await phone.call("attachTurn", { turn: turn.id }));
    pace.go();
    await again.done;
    expect(again.text()).toBe("A passing thought.");
    expect((await summaries()).some((c) => c.title === "Just between us.")).toBe(false);
  });
});

describe("a side question", () => {
  const asideOf = (w: ReturnType<typeof watch>) => (w.events.find((e) => e.type === "aside") as Extract<ChatStreamEvent, { type: "aside" }>).id;

  test("answered from the work in hand without changing its course, apart from the turn; brought back, it steers him", async () => {
    armSlow();
    reached.length = 0;
    script = [callTools({ id: "call_slow", name: "connector_call", args: { connector: "forge", tool: "slow", args: {} } })];
    const first = await ask(admin, "Fetch the report and summarise it.", { save: true });
    await slow.started;
    await first.seen("tool");
    const turn = first.turn();
    const id = turn.conversation!;
    const before = first.events.length;

    // The aside: its own model call, with no tools, from the same context.
    script = [say("He is fetching the report from the forge; it hasn't come back yet.")];
    const aside = watch(await admin("askAside", { conversation: id, question: "What is he waiting on?" }));
    await aside.done;
    expect(aside.types()).toEqual(["aside", "model", "text", "done"]);
    expect(aside.text()).toBe("He is fetching the report from the forge; it hasn't come back yet.");
    const sideCall = bodies.at(-1);
    expect(sideCall.tools).toBeUndefined();
    const sideMessages = sideCall.messages.filter((m: any) => m.role !== "system");
    expect(sideMessages.map((m: any) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(sideMessages[0].content).toBe("Fetch the report and summarise it.");
    expect(sideMessages[2].content).toContain('- Call a connector tool {"connector":"forge","tool":"slow","args":{}}');
    expect(sideMessages[2].content).toContain("The aside: What is he waiting on?");
    // The working turn saw none of it: nothing new in its stream, nothing in the kept chat, nothing waiting to steer.
    expect(first.events.length).toBe(before);
    expect((await chatOf(id)).messages).toHaveLength(2);
    expect((await listed()).turns[0]).toMatchObject({ steering: 0 });

    // Bring back: now it's your message to him, and reaches him at the next safe point.
    expect(await json(admin("bringBack", { aside: asideOf(aside) }))).toEqual({ how: "steered" });
    expect((await admin("bringBack", { aside: asideOf(aside) })).status).toBe(404);
    script = [say("Summary: the report is ready.")];
    slow.finish();
    await first.done;
    expect(first.types()).toEqual(["turn", "conversation", "model", "tool", "tool_result", "steer", "text", "done"]);
    const steer = first.events.find((e) => e.type === "steer") as Extract<ChatStreamEvent, { type: "steer" }>;
    expect(steer.text).toContain("My aside: What is he waiting on?");
    expect(steer.text).toContain("Your answer: He is fetching the report from the forge");
    expect((await chatOf(id)).messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  test("with nothing running it's about the chat, added to nothing; brought back, it joins the chat as an exchange", async () => {
    script = [say("Dry and cold.")];
    const first = await ask(admin, "What's the weather?", { save: true });
    await first.done;
    const id = first.turn().conversation!;
    script = [say("In Copenhagen.")];
    const aside = watch(await admin("askAside", { conversation: id, question: "Where?" }));
    await aside.done;
    expect(bodies.at(-1).messages.filter((m: any) => m.role !== "system").map((m: any) => m.role)).toEqual(["user", "assistant", "user"]);
    expect((await chatOf(id)).messages).toHaveLength(2);
    // Another device can't bring back what it didn't ask.
    expect((await phone.call("bringBack", { aside: asideOf(aside) })).status).toBe(404);
    expect(await json(admin("bringBack", { aside: asideOf(aside) }))).toEqual({ how: "kept" });
    expect((await chatOf(id)).messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "What's the weather?"],
      ["assistant", "Dry and cold."],
      ["user", "Where?"],
      ["assistant", "In Copenhagen."],
    ]);
  });

  test("checked like any message, yours alone, and bounded", async () => {
    script = [say("Hello.")];
    const first = await ask(admin, "Hello.", { save: true });
    await first.done;
    const id = first.turn().conversation!;
    const secret = await admin("askAside", { conversation: id, question: `Is sk-ant-api03-${"FAKE".repeat(8)} a good key?` });
    expect(secret.status).toBe(422);
    expect((await admin("askAside", { question: "About what?" })).status).toBe(400);
    const { token } = await json<{ token: string }>(admin("mintArm", { label: "nosy" }));
    expect((await withToken(token)("askAside", { conversation: id, question: "What did they say?" })).status).toBe(403);
    // A turn that may read the bank: its work in hand isn't told to a device that may not read the bank.
    const pace = paced("Your balance is", " 1 DKK");
    script = [pace.reply];
    const bank = await ask(admin, "What's my balance?", { save: true });
    await bank.seen("text");
    expect((await phone.call("askAside", { conversation: bank.turn().conversation!, question: "What did he find?" })).status).toBe(403);
    // Two at once on the node, the third says so.
    const a = paced("One", ".");
    const b = paced("Two", ".");
    script = [a.reply, b.reply];
    const one = watch(await admin("askAside", { conversation: id, question: "One?" }));
    const two = watch(await admin("askAside", { conversation: id, question: "Two?" }));
    await one.seen("text");
    await two.seen("text");
    const third = await admin("askAside", { conversation: id, question: "Three?" });
    expect(third.status).toBe(429);
    expect(((await third.json()) as { error: string }).error).toBe("This node is already answering 2 side questions, its limit. Ask again when one is done.");
    a.go();
    b.go();
    pace.go();
    await Promise.all([one.done, two.done, bank.done]);
  });
});

describe("from a terminal (galahad ask, turns, queue)", () => {
  const cli = () => new LocalClient(`http://127.0.0.1:${port}`, home.adminToken());
  /** What the command printed, and a Ctrl-C the test can press. */
  function terminal() {
    const out: string[] = [];
    const err: string[] = [];
    let press: () => void = () => {};
    const io: Io = { out: (text) => void out.push(text), err: (text) => void err.push(text), tty: false };
    const onInterrupt = (stop: () => void) => {
      press = stop;
      return () => {};
    };
    return { io, onInterrupt, out: () => out.join(""), err: () => err.join(""), ctrlC: () => press() };
  }

  test("ask watches a turn the node owns: his words, which turn it is, and that it outlives the terminal", async () => {
    script = [say("Dry and cold.")];
    const t = terminal();
    expect(await askCommand(cli(), "How's the weather?", {}, t.io, t.onInterrupt)).toBe(0);
    expect(t.out()).toBe("Dry and cold.\n");
    expect(t.err()).toMatch(/\[turn tn_[A-Za-z0-9_-]{22} · he goes on working if this terminal goes away; Ctrl-C stops him\]/);
    expect(t.err()).toMatch(/\[chat cv_/);
  });

  test("Ctrl-C is the terminal's Stop, said to the node: the answer so far is kept as stopped", async () => {
    const pace = paced("Chapter one. ", "never");
    script = [pace.reply];
    const t = terminal();
    const asking = askCommand(cli(), "A long report, please.", {}, t.io, t.onInterrupt);
    await until(() => t.out().includes("Chapter one."));
    t.ctrlC();
    expect(await asking).toBe(130);
    expect(t.err()).toContain("[stopped by you]");
    const id = /\[chat (cv_[A-Za-z0-9_-]{22})/.exec(t.err())![1]!;
    expect((await chatOf(id)).messages[1]).toMatchObject({ content: "Chapter one. ", status: "stopped" });
    pace.go();
  });

  test("--detach starts it and leaves; he works on, and the answer is in the chat", async () => {
    const pace = paced("Working ", "alone.");
    script = [pace.reply];
    const t = terminal();
    expect(await askCommand(cli(), "Do this while I'm away.", { detach: true }, t.io, t.onInterrupt)).toBe(0);
    expect(t.out()).toBe("");
    const [, turn, id] = /(tn_[A-Za-z0-9_-]{22}) in chat (cv_[A-Za-z0-9_-]{22})/.exec(t.err())!;
    expect(t.err()).toContain(`galahad turn watch ${turn}`);
    await until(async () => (await listed()).turns.some((x) => x.id === turn && x.watchers === 0));
    // From another terminal: what he's on, then watching it to its end.
    const list = terminal();
    await turnsCommand(cli(), undefined, [], list.io);
    expect(list.out()).toContain(`● ${turn} · Do this while I'm away. (${id}) · planner`);
    expect(list.out()).toContain("nobody watching");
    expect(list.out()).toContain("At most 3 turns at once on this node, 30 minutes each");
    const watching = terminal();
    const watched = turnsCommand(cli(), "watch", [id!], watching.io);
    await until(() => watching.out().includes("Working"));
    pace.go();
    expect(await watched).toBe(0);
    expect(watching.out()).toBe("Working alone.\n");
    expect((await chatOf(id!)).messages[1]).toMatchObject({ content: "Working alone.", status: "done" });
  });

  test("while he works in a chat: a plain ask says what you can do; --queue keeps it; --steer tells him now and follows to the end", async () => {
    const pace = paced("On the first thing", " (never said)");
    script = [pace.reply, say("The second thing instead."), say("And the queued one.")];
    const started = terminal();
    await askCommand(cli(), "Do the first thing.", { detach: true }, started.io, started.onInterrupt);
    const id = /in chat (cv_[A-Za-z0-9_-]{22})/.exec(started.err())![1]!;
    await until(async () => (await chatOf(id)).turn?.step === "Answering");

    await expect(askCommand(cli(), "And another.", { chat: id }, terminal().io)).rejects.toThrow(/still working in this chat\. Steer him .* queue it .* or stop him first/);
    await expect(askCommand(cli(), "x", { steer: true }, terminal().io)).rejects.toThrow(/go with --chat/);
    await expect(askCommand(cli(), "x", { chat: id, steer: true, queue: true }, terminal().io)).rejects.toThrow(/one of --steer, --queue or --aside/);

    const queued = terminal();
    expect(await askCommand(cli(), "Then the queued thing.", { chat: id, queue: true }, queued.io)).toBe(0);
    expect(queued.err()).toContain("1 queued: each is sent as the next turn when the one before it ends well.");
    expect(queued.err()).toContain("1. Then the queued thing.  (from a terminal on keep)");
    const shown = terminal();
    await queueCommand(cli(), id, undefined, [], shown.io);
    expect(shown.out()).toContain("1. Then the queued thing.");

    const steered = terminal();
    expect(await askCommand(cli(), "The second thing instead, please.", { chat: id, steer: true }, steered.io, steered.onInterrupt)).toBe(0);
    expect(steered.err()).toContain("[told him: it reaches him at his next safe point");
    expect(steered.err()).toContain("↳ your message reached him: The second thing instead, please.");
    expect(steered.out()).toBe("On the first thingThe second thing instead.\n");
    // The queued one went by itself once that turn ended.
    await until(async () => (await chatOf(id)).messages.length === 6 && (await chatOf(id)).turn === null);
    expect((await chatOf(id)).messages.map((m) => m.content)).toEqual(["Do the first thing.", "On the first thing", "The second thing instead, please.", "The second thing instead.", "Then the queued thing.", "And the queued one."]);
    pace.go();
  });

  test("a queue held after a stop is shown as held, and resumed from the terminal", async () => {
    const pace = paced("Starting", "…");
    script = [pace.reply, say("Second, done.")];
    const started = terminal();
    await askCommand(cli(), "First.", { detach: true }, started.io, started.onInterrupt);
    const id = /in chat (cv_[A-Za-z0-9_-]{22})/.exec(started.err())![1]!;
    await askCommand(cli(), "Second.", { chat: id, queue: true }, terminal().io);
    const stopped = terminal();
    await turnsCommand(cli(), "stop", [id], stopped.io);
    expect(stopped.out()).toContain("Stopped. What he'd said is kept; anything queued behind it is held until you resume.");
    pace.go();
    await until(async () => (await chatOf(id)).held === "stopped");
    const held = terminal();
    await queueCommand(cli(), id, undefined, [], held.io);
    expect(held.out()).toContain("1 queued, held: you stopped him. Nothing is sent until you resume (or send one now).");
    const all = terminal();
    await turnsCommand(cli(), undefined, [], all.io);
    expect(all.out()).toContain(`First. (${id}): 1 queued, held (you stopped him)`);
    const resumed = terminal();
    await queueCommand(cli(), id, "resume", [], resumed.io);
    expect(resumed.out()).toMatch(/Resumed: he's on the next one \(tn_/);
    await until(async () => (await chatOf(id)).turn === null && (await chatOf(id)).messages.length === 4);
    expect((await chatOf(id)).messages.at(-1)!.content).toBe("Second, done.");
    await expect(queueCommand(cli(), id, "rm", ["3"], terminal().io)).rejects.toThrow(/no message 3 in that queue/);
  });

  test("--aside asks on the side and adds nothing; --bring hands it to him", async () => {
    script = [say("Dry and cold."), say("In Copenhagen.")];
    const first = terminal();
    await askCommand(cli(), "The weather?", {}, first.io, first.onInterrupt);
    const id = /\[chat (cv_[A-Za-z0-9_-]{22})/.exec(first.err())![1]!;
    const aside = terminal();
    expect(await askCommand(cli(), "Where?", { chat: id, aside: true, bring: true }, aside.io)).toBe(0);
    expect(aside.out()).toBe("In Copenhagen.\n");
    expect(aside.err()).toContain("a side question · stand-in/m · no tools, added to nothing");
    expect(aside.err()).toContain("[brought back: it's in the chat now]");
    expect((await chatOf(id)).messages.map((m) => m.content)).toEqual(["The weather?", "Dry and cold.", "Where?", "In Copenhagen."]);
  });
});

describe("where he is, at a glance", () => {
  test("waiting on you: an approval he filed in the chat, until you answer it; and an answer that ends by asking", async () => {
    script = [callTools({ id: "call_post", name: "connector_call", args: { connector: "forge", tool: "post", args: { text: "hello" }, why: "you asked" } }), say("I've filed it for your approval.")];
    const first = await ask(admin, "Post hello on the forge.", { save: true });
    await first.done;
    const id = first.turn().conversation!;
    // Nobody approved it for him because nobody was there: it waits in the outbox.
    expect(reached.filter((r) => r.startsWith("POST"))).toEqual([]);
    expect((await summaries()).find((c) => c.id === id)).toMatchObject({ state: "waiting", needs: { approvals: 1, keys: 0, question: false } });
    const { actions } = await json<{ actions: { id: string; state: string; by: string }[] }>(admin("actions"));
    const filed = actions.find((a) => a.state === "waiting")!;
    expect(filed.by).toBe("arm:galahad");
    await json(admin("decideAction", { id: filed.id, approve: false }));
    expect((await summaries()).find((c) => c.id === id)).toMatchObject({ state: "done", needs: null });

    script = [say("There are two reports. Which one shall I send?")];
    const second = await ask(admin, "Send the report.", { save: true });
    await second.done;
    expect((await summaries()).find((c) => c.id === second.turn().conversation)).toMatchObject({ state: "waiting", needs: { approvals: 0, keys: 0, question: true } });
  });
});
