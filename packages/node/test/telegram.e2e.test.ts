import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ConversationSummary, type ConversationView, type FleetView, type RouteName, routes, type TelegramView } from "@galahad/core";
import { foundFleet, MindStore } from "@galahad/mind";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { freePort } from "./ports.ts";

/*
 * Telegram, against a real daemon in a temp home, a stand-in for Telegram's Bot API and a stand-in model: connecting
 * makes a device of its own (chat and mind:read), only your own account (linked by its code) is answered, an answer's
 * choices are buttons and a tap is your next message, /new starts a new chat, and disconnecting revokes the device.
 */

const caps: Capabilities = {
  os: "linux",
  arch: "x64",
  hostname: "telegram-test",
  cores: 4,
  cpu: "test",
  memoryGb: 8,
  hasBattery: false,
  gpu: [],
  docker: false,
  vm: { kvm: false, tools: [] },
  tools: [],
  localModels: [{ runtime: "stand-in", models: ["m"] }],
  tailscale: null,
};

const TOKEN = "123456789:AAFakeTokenForTestsOnlyNotARealOne_xx";
const OWNER = { id: 1001, username: "liege", first_name: "Liege" };
const root = mkdtempSync(join(tmpdir(), "galahad-telegram-"));
const home = new Home(join(root, "node"));
const port = freePort();
let daemon: Daemon;

/** What the stand-in model was asked last, and what it answers. */
const asked: string[] = [];
const model = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const body = (await req.json()) as { messages: { role: string; content: unknown }[] };
    const last = body.messages.filter((m) => m.role === "user").at(-1);
    const words = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
    asked.push(words);
    const text = /2\+2/.test(words) ? 'It is **4**.\n\n```choices ["Again", "Thanks"]\n```' : `You said: ${words.slice(-40)}`;
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  },
});

/** A stand-in for Telegram: updates queued by the test, and what the bot sent. */
let nextUpdate = 1;
let nextMessage = 500;
const updates: Record<string, unknown>[] = [];
const sent: { method: string; params: Record<string, unknown> }[] = [];
/** A photo as Telegram keeps one (a JPEG's first bytes), and a PDF, by where it keeps them. */
const FILES: Record<string, Uint8Array<ArrayBuffer>> = { "photos/file_7.jpg": new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode("JFIF stand-in photo")]), "documents/report.pdf": new Uint8Array([...new TextEncoder().encode("%PDF-1.7\n%"), 0xe2, 0xe3, 0xcf, 0xd3, 0x0a, 0x00, 0x01]) };
const telegramApi = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const file = /^\/file\/bot([^/]+)\/(.+)$/.exec(new URL(req.url).pathname);
    if (file) return file[1] === TOKEN && FILES[file[2]!] ? new Response(FILES[file[2]!]) : new Response("not found", { status: 404 });
    const match = /^\/bot([^/]+)\/(\w+)$/.exec(new URL(req.url).pathname);
    if (!match || match[1] !== TOKEN) return Response.json({ ok: false, description: "Unauthorized" }, { status: 401 });
    const method = match[2]!;
    const params = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (method === "getMe") return Response.json({ ok: true, result: { id: 42, username: "galahad_test_bot", is_bot: true } });
    if (method === "getFile") return Response.json({ ok: true, result: { file_id: params.file_id, file_path: params.file_id === "big" ? "photos/file_7.jpg" : "documents/report.pdf" } });
    if (method === "getUpdates") {
      const offset = Number(params.offset ?? 0);
      for (let i = 0; i < 10; i++) {
        const ready = updates.filter((u) => (u.update_id as number) >= offset);
        if (ready.length) return Response.json({ ok: true, result: ready });
        await Bun.sleep(50);
      }
      return Response.json({ ok: true, result: [] });
    }
    sent.push({ method, params });
    return Response.json({ ok: true, result: method === "sendMessage" ? { message_id: nextMessage++ } : true });
  },
});

const from = (who: { id: number; username?: string; first_name?: string }, text: string) =>
  updates.push({ update_id: nextUpdate++, message: { message_id: nextUpdate, from: who, chat: { id: who.id, type: "private" }, text } });
const messages = () => sent.filter((s) => s.method === "sendMessage");
async function until<T>(what: string, check: () => T | undefined | null | false): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = check();
    if (value) return value;
    await Bun.sleep(25);
  }
  throw new Error(`never: ${what}`);
}

async function call(name: RouteName, input: unknown, token = home.adminToken()) {
  const route = routes[name];
  return fetch(`http://127.0.0.1:${port}${route.path}`, {
    method: route.method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined,
  });
}
const json = async <T,>(response: Response): Promise<T> => {
  expect(response.status).toBe(200);
  return (await response.json()) as T;
};

beforeAll(async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const store = new MindStore(home.mindPath);
  const fleet = foundFleet(store, identity, { fleetName: "camelot", nodeName: "tg-node" });
  store.close();
  home.writeConfig({ v: 1, name: "tg-node", fleet, port, keystore, advertise: "127.0.0.1" });
  daemon = await startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {}, loopIntervalMs: 60_000, wakeWatchMs: false, ciWatchMs: false, defaultHeartbeat: false, telegramBase: `http://127.0.0.1:${telegramApi.port}` });
  expect((await call("setProvider", { id: "stand-in", kind: "openai", baseUrl: `http://127.0.0.1:${model.port}/v1` })).status).toBe(200);
  for (const role of ["swift", "planner"]) expect((await call("setRoster", { role, models: ["stand-in/m"] })).status).toBe(200);
});

afterAll(async () => {
  await daemon?.stop();
  model.stop(true);
  telegramApi.stop(true);
  rmSync(root, { recursive: true, force: true });
});

describe("Telegram", () => {
  let code = "";

  test("connecting checks the token with Telegram and makes a device of its own that may only chat and read", async () => {
    expect((await call("telegramConnect", { token: "987654321:AAWrongTokenWrongTokenWrongTokenWrong" })).status).toBe(400);
    expect((await call("telegramConnect", { token: "not a token at all, clearly not one" })).status).toBe(400);
    const connected = await json<{ bot: string; code: string; device: string }>(await call("telegramConnect", { token: TOKEN }));
    expect(connected.bot).toBe("@galahad_test_bot");
    expect(connected.code).toMatch(/^[A-Z2-9]{8}$/);
    code = connected.code;
    const { devices } = await json<FleetView>(await call("fleet", undefined));
    expect(devices.find((d) => d.id === connected.device)).toMatchObject({ name: "Telegram (@galahad_test_bot)", kind: "client", scopes: ["chat", "mind:read"] });
    const { telegram } = await json<{ telegram: TelegramView }>(await call("telegram", undefined));
    expect(telegram).toMatchObject({ connected: true, bot: "@galahad_test_bot", owner: null, node: "tg-node" });
    expect(telegram.linkExpires).toBeGreaterThan(Date.now());
    // Connecting is yours alone: an agent may not.
    const arm = (await json<{ token: string }>(await call("mintArm", { label: "busybody" }))).token;
    expect((await call("telegramConnect", { token: TOKEN }, arm)).status).toBe(403);
  });

  test("only your account, linked by its code, is answered; a stranger, or a wrong code, gets nothing back", async () => {
    const stranger = { id: 666, username: "stranger" };
    from(stranger, "hello?");
    from(stranger, "/start WRONGCOD");
    from(OWNER, `/start ${code}`);
    await until("linked", () => messages().find((m) => /^Linked/.test(String(m.params.text))));
    expect(messages().every((m) => m.params.chat_id === OWNER.id)).toBe(true);
    // The code is spent: someone else sending it later is still a stranger.
    from(stranger, `/start ${code}`);
    from(stranger, "What's in the vault?");
    const { telegram } = await json<{ telegram: TelegramView }>(await call("telegram", undefined));
    expect(telegram).toMatchObject({ owner: "@liege", linkExpires: null });
    await Bun.sleep(300);
    expect(messages().every((m) => m.params.chat_id === OWNER.id)).toBe(true);
    expect(asked.some((a) => /vault/.test(a))).toBe(false);
  });

  test("your message is answered in your chat, its choices as buttons; a tap is your next message there", async () => {
    from(OWNER, "What's 2+2?");
    const answer = await until("the answer", () => messages().find((m) => String(m.params.text).includes("<b>4</b>")));
    expect(answer.params).toMatchObject({ chat_id: OWNER.id, text: "It is <b>4</b>.", parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Again", callback_data: "c:0" }], [{ text: "Thanks", callback_data: "c:1" }]] } });
    expect(sent.some((s) => s.method === "sendChatAction" && s.params.action === "typing")).toBe(true);
    // Kept as a chat of yours, in the app.
    const { conversations } = await json<{ conversations: ConversationSummary[] }>(await call("conversations", undefined));
    expect(conversations).toHaveLength(1);
    const id = conversations[0]!.id;

    const answerId = 500 + messages().indexOf(answer);
    updates.push({ update_id: nextUpdate++, callback_query: { id: "tap-1", from: { id: OWNER.id }, message: { message_id: answerId, chat: { id: OWNER.id } }, data: "c:1" } });
    await until("the tap answered", () => messages().find((m) => m.params.text === "You said: Thanks"));
    expect(sent.some((s) => s.method === "answerCallbackQuery")).toBe(true);
    expect(sent.some((s) => s.method === "editMessageReplyMarkup" && s.params.message_id === answerId)).toBe(true);
    const after = await json<{ conversations: ConversationSummary[] }>(await call("conversations", undefined));
    expect(after.conversations.map((c) => c.id)).toEqual([id]);
    // Someone else tapping the button does nothing.
    updates.push({ update_id: nextUpdate++, callback_query: { id: "tap-2", from: { id: 666 }, message: { message_id: answerId, chat: { id: OWNER.id } }, data: "c:0" } });
    await Bun.sleep(300);
    expect(asked.filter((a) => a === "Again")).toHaveLength(0);
  });

  test("/new starts a new chat", async () => {
    from(OWNER, "/new");
    await until("new", () => messages().find((m) => m.params.text === "A new chat. What's next?"));
    from(OWNER, "Something else");
    await until("answered", () => messages().find((m) => m.params.text === "You said: Something else"));
    const { conversations } = await json<{ conversations: ConversationSummary[] }>(await call("conversations", undefined));
    expect(conversations).toHaveLength(2);
  });

  test("a photo you send goes with your message, its caption your words; a file it can't carry is said, and stays where it is", async () => {
    const before = messages().length;
    updates.push({ update_id: nextUpdate++, message: { message_id: 901, from: OWNER, chat: { id: OWNER.id, type: "private" }, photo: [{ file_id: "small", file_size: 90 }, { file_id: "big", file_size: 23 }], caption: "What's in this photo?" } });
    await until("answered", () => messages().slice(before).find((m) => String(m.params.text).startsWith("You said:")));
    const { conversations } = await json<{ conversations: ConversationSummary[] }>(await call("conversations", undefined));
    const latest = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)[0]!;
    const { conversation } = await json<{ conversation: ConversationView }>(await call("conversation", { id: latest.id }));
    const mine = conversation.messages.filter((m) => m.role === "user").at(-1)!;
    expect(mine.content).toBe("What's in this photo?");
    expect(mine.attachments).toEqual([expect.objectContaining({ name: "photo.jpg", type: "image/jpeg", bytes: FILES["photos/file_7.jpg"]!.byteLength })]);
    // A PDF isn't one a model is shown: said, and nothing asked of him.
    const asking = asked.length;
    updates.push({ update_id: nextUpdate++, message: { message_id: 902, from: OWNER, chat: { id: OWNER.id, type: "private" }, document: { file_id: "pdf", file_name: "report.pdf", file_size: 17 } } });
    await until("said", () => messages().find((m) => String(m.params.text).startsWith("Not sent with your message (report.pdf: it isn't a picture")));
    await Bun.sleep(200);
    expect(asked.length).toBe(asking);
  });

  test("disconnecting revokes its device and deletes its token; its chats stay yours", async () => {
    const before = await json<{ telegram: TelegramView }>(await call("telegram", undefined));
    await json(await call("telegramDisconnect", {}));
    const { devices } = await json<FleetView>(await call("fleet", undefined));
    expect(devices.find((d) => d.id === before.telegram.device)?.revokedAt).toBeTruthy();
    const { telegram } = await json<{ telegram: TelegramView }>(await call("telegram", undefined));
    expect(telegram).toMatchObject({ connected: false, bot: null, owner: null });
    const { secrets } = await json<{ secrets: { name: string }[] }>(await call("secrets", undefined));
    expect(secrets.map((s) => s.name)).not.toContain("telegram:bot");
    const { conversations } = await json<{ conversations: ConversationSummary[] }>(await call("conversations", undefined));
    expect(conversations).toHaveLength(2);
    // Connected again, a revoked device never comes back: it gets a new one.
    const again = await json<{ device: string }>(await call("telegramConnect", { token: TOKEN }));
    expect(again.device).not.toBe(before.telegram.device);
  });
});
