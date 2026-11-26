import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ConversationSummary, type ConversationView, type FleetView, type RouteName, routes, SLACK_APP_MANIFEST, type SlackView } from "@galahad/core";
import { foundFleet, MindStore } from "@galahad/mind";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { fromSlack } from "../src/slack.ts";
import { freePort } from "./ports.ts";

/*
 * Slack, against a real daemon in a temp home, a stand-in for Slack (its Web API and a Socket Mode socket) and a
 * stand-in model: connecting checks both tokens and makes a device of its own (chat and mind:read), the node opens the
 * socket itself and says each envelope received, only your own account (linked by its code) is answered and only in
 * your direct messages, an answer's choices are buttons and a tap is your next message, `new` starts a new chat, a
 * connection Slack ends is made again, and disconnecting revokes the device.
 */

const caps: Capabilities = {
  os: "linux",
  arch: "x64",
  hostname: "slack-test",
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

// Obviously fake tokens in the shapes Slack gives, put together here so no scanner mistakes this file for a leak.
const APP_TOKEN = ["xapp", "1", "A0FAKEAPP01", "1234567890123", "f".repeat(64)].join("-");
const BOT_TOKEN = ["xoxb", "1234567890", "1234567890123", "FakeTokenForTestsOnly00"].join("-");
const OWNER = "U0OWNER001";
const STRANGER = "U0STRANGER";
const DM = "D0OWNERDM1";
const root = mkdtempSync(join(tmpdir(), "galahad-slack-"));
const home = new Home(join(root, "node"));
const port = freePort();
let daemon: Daemon;

/** What the stand-in model was asked, and what it answers. */
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

/** A stand-in for Slack: its Web API's calls, kept, and the sockets the node opened, to send envelopes down. */
const calls: { method: string; token: string; params: Record<string, string> }[] = [];
let sockets: ServerWebSocket<unknown>[] = [];
const acks: string[] = [];
/** A screenshot as Slack serves a shared file (a PNG's first bytes), and who asked for it. */
const SHOT = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode("stand-in screenshot")]);
const fileGets: string[] = [];
let nextTs = 1;
const slackApi = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req, server): Promise<Response | undefined> {
    const url = new URL(req.url);
    if (url.pathname === "/link") return server.upgrade(req) ? undefined : new Response("no", { status: 400 });
    if (url.pathname.startsWith("/files/")) {
      fileGets.push(req.headers.get("authorization") ?? "");
      return req.headers.get("authorization") === `Bearer ${BOT_TOKEN}` ? new Response(SHOT) : new Response("no", { status: 403 });
    }
    const method = url.pathname.replace(/^\/api\//, "");
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
    const params = Object.fromEntries(new URLSearchParams(await req.text()));
    calls.push({ method, token, params });
    if (method === "apps.connections.open") return Response.json(token === APP_TOKEN ? { ok: true, url: `ws://127.0.0.1:${server.port}/link` } : { ok: false, error: "invalid_auth" });
    if (token !== BOT_TOKEN) return Response.json({ ok: false, error: "invalid_auth" });
    if (method === "auth.test") return Response.json({ ok: true, team: "Camelot", team_id: "T0CAMELOT1", user: "galahad", user_id: "U0GALAHAD1", bot_id: "B0GALAHAD1" });
    if (method === "users.info") return Response.json({ ok: true, user: { name: "liege.real", profile: { display_name: "liege" } } });
    if (method === "chat.postMessage") return Response.json({ ok: true, channel: params.channel, ts: `1700000000.${String(nextTs++).padStart(6, "0")}` });
    return Response.json({ ok: true });
  },
  websocket: {
    open(ws) {
      sockets.push(ws);
      ws.send(JSON.stringify({ type: "hello", num_connections: 1 }));
    },
    message(_ws, data) {
      acks.push((JSON.parse(String(data)) as { envelope_id: string }).envelope_id);
    },
    close(ws) {
      sockets = sockets.filter((s) => s !== ws);
    },
  },
});

let nextEnvelope = 1;
/** An envelope down the newest socket, as Slack sends one; its id. */
function envelope(type: string, payload: Record<string, unknown>): string {
  const id = `env-${nextEnvelope++}`;
  sockets.at(-1)!.send(JSON.stringify({ envelope_id: id, type, payload, accepts_response_payload: type === "interactive", retry_attempt: 0 }));
  return id;
}
const message = (user: string, text: string, event: Record<string, unknown> = {}) =>
  envelope("events_api", {
    type: "event_callback",
    team_id: "T0CAMELOT1",
    event_id: `Ev${nextEnvelope}`,
    event: { type: "message", channel: user === OWNER ? DM : "D0STRANGER", channel_type: "im", user, text, ts: `1699999999.${String(nextEnvelope).padStart(6, "0")}`, ...event },
  });
const posts = () => calls.filter((c) => c.method === "chat.postMessage");
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
  const fleet = foundFleet(store, identity, { fleetName: "camelot", nodeName: "slack-node" });
  store.close();
  home.writeConfig({ v: 1, name: "slack-node", fleet, port, keystore, advertise: "127.0.0.1" });
  daemon = await startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {}, loopIntervalMs: 60_000, wakeWatchMs: false, ciWatchMs: false, defaultHeartbeat: false, slackBase: `http://127.0.0.1:${slackApi.port}/api` });
  expect((await call("setProvider", { id: "stand-in", kind: "openai", baseUrl: `http://127.0.0.1:${model.port}/v1` })).status).toBe(200);
  for (const role of ["swift", "planner"]) expect((await call("setRoster", { role, models: ["stand-in/m"] })).status).toBe(200);
});

afterAll(async () => {
  await daemon?.stop();
  model.stop(true);
  slackApi.stop(true);
  rmSync(root, { recursive: true, force: true });
});

describe("Slack", () => {
  let code = "";

  test("connecting checks both tokens with Slack and makes a device of its own that may only chat and read; the node opens the socket", async () => {
    expect((await call("slackConnect", { appToken: APP_TOKEN, botToken: BOT_TOKEN.replace("Fake", "Wrng") })).status).toBe(400);
    expect((await call("slackConnect", { appToken: APP_TOKEN.replace("A0FAKE", "A0WRNG"), botToken: BOT_TOKEN })).status).toBe(400);
    expect((await call("slackConnect", { appToken: "not an app token, clearly", botToken: BOT_TOKEN })).status).toBe(400);
    expect(sockets).toHaveLength(0);
    const connected = await json<{ bot: string; workspace: string; code: string; device: string }>(await call("slackConnect", { appToken: APP_TOKEN, botToken: BOT_TOKEN }));
    expect(connected).toMatchObject({ bot: "@galahad", workspace: "Camelot" });
    expect(connected.code).toMatch(/^[A-Z2-9]{8}$/);
    code = connected.code;
    const { devices } = await json<FleetView>(await call("fleet", undefined));
    expect(devices.find((d) => d.id === connected.device)).toMatchObject({ name: "Slack (@galahad in Camelot)", kind: "client", scopes: ["chat", "mind:read"] });
    const { slack, manifest } = await json<{ slack: SlackView; manifest: typeof SLACK_APP_MANIFEST }>(await call("slack", undefined));
    expect(slack).toMatchObject({ connected: true, bot: "@galahad", workspace: "Camelot", owner: null, node: "slack-node" });
    // The app to make comes with it (the PWA shows it from here): Socket Mode, your direct messages alone.
    expect(manifest).toEqual(SLACK_APP_MANIFEST);
    expect([manifest.settings.socket_mode_enabled, manifest.settings.event_subscriptions.bot_events]).toEqual([true, ["message.im"]]);
    // The app-level token opens the socket; the bot token does everything else, and neither goes anywhere else.
    await until("the socket", () => sockets.length === 1);
    expect(calls.filter((c) => c.method === "apps.connections.open").every((c) => c.token !== BOT_TOKEN)).toBe(true);
    // Connecting is yours alone: an agent may not.
    const arm = (await json<{ token: string }>(await call("mintArm", { label: "busybody" }))).token;
    expect((await call("slackConnect", { appToken: APP_TOKEN, botToken: BOT_TOKEN }, arm)).status).toBe(403);
  });

  test("only your account, linked by its code in a direct message, is answered; a stranger, a channel or a wrong code gets nothing back", async () => {
    const said = [message(STRANGER, "hello?"), message(STRANGER, "WRONGCOD"), message(OWNER, code, { channel_type: "channel", channel: "C0GENERAL1" }), message(OWNER, code)];
    await until("linked", () => posts().find((p) => /^Linked/.test(p.params.text ?? "")));
    // Every envelope was said received, answered or not.
    await until("acknowledged", () => said.every((id) => acks.includes(id)));
    expect(posts().every((p) => p.params.channel === DM)).toBe(true);
    const { slack } = await json<{ slack: SlackView }>(await call("slack", undefined));
    expect(slack).toMatchObject({ owner: "@liege", linkExpires: null });
    // The code is spent: someone else sending it later is still a stranger.
    message(STRANGER, code);
    message(STRANGER, "What's in the vault?");
    await Bun.sleep(300);
    expect(posts().every((p) => p.params.channel === DM)).toBe(true);
    expect(asked.some((a) => /vault/.test(a))).toBe(false);
  });

  test("your message is answered in your chat, its choices as buttons, with 👀 on it while he works; a tap is your next message there", async () => {
    message(OWNER, "What's 2+2?");
    const answer = await until("the answer", () => posts().find((p) => (p.params.text ?? "").includes("*4*")));
    expect(answer.params).toMatchObject({ channel: DM, text: "It is *4*.", unfurl_links: "false" });
    const blocks = JSON.parse(answer.params.blocks!) as { type: string; elements?: { action_id: string; text: { text: string } }[] }[];
    expect(blocks.map((b) => b.type)).toEqual(["section", "actions"]);
    expect(blocks[1]!.elements!.map((e) => [e.action_id, e.text.text])).toEqual([["c:0", "Again"], ["c:1", "Thanks"]]);
    expect(calls.find((c) => c.method === "reactions.add")?.params).toMatchObject({ channel: DM, name: "eyes" });
    await until("the eyes taken off", () => calls.some((c) => c.method === "reactions.remove"));
    const { conversations } = await json<{ conversations: ConversationSummary[] }>(await call("conversations", undefined));
    expect(conversations).toHaveLength(1);

    const ts = `1700000000.${String(posts().indexOf(answer) + 1).padStart(6, "0")}`;
    const tap = (user: string, action: string) => envelope("interactive", { type: "block_actions", user: { id: user }, channel: { id: DM }, message: { ts, text: "It is *4*.", blocks }, actions: [{ action_id: action }] });
    // Someone else tapping does nothing.
    tap(STRANGER, "c:0");
    tap(OWNER, "c:1");
    await until("the tap answered", () => posts().find((p) => p.params.text === "You said: Thanks"));
    const update = calls.find((c) => c.method === "chat.update");
    expect(update?.params.ts).toBe(ts);
    expect((JSON.parse(update!.params.blocks!) as { type: string }[]).map((b) => b.type)).toEqual(["section"]);
    expect(asked.filter((a) => a === "Again")).toHaveLength(0);
    const after = await json<{ conversations: ConversationSummary[] }>(await call("conversations", undefined));
    expect(after.conversations.map((c) => c.id)).toEqual(conversations.map((c) => c.id));
  });

  test("new starts a new chat; an envelope Slack sends again is taken once", async () => {
    message(OWNER, "new");
    await until("new", () => posts().find((p) => p.params.text === "A new chat. What's next?"));
    const event = { type: "event_callback", team_id: "T0CAMELOT1", event_id: "EvTwice", event: { type: "message", channel: DM, channel_type: "im", user: OWNER, text: "Something else", ts: "1699999999.999999" } };
    envelope("events_api", event);
    envelope("events_api", event);
    await until("answered", () => posts().find((p) => p.params.text === "You said: Something else"));
    await Bun.sleep(200);
    expect(posts().filter((p) => p.params.text === "You said: Something else")).toHaveLength(1);
    const { conversations } = await json<{ conversations: ConversationSummary[] }>(await call("conversations", undefined));
    expect(conversations).toHaveLength(2);
  });

  test("a file you share goes with your message, fetched with the app's token from Slack's own file host and nowhere else", async () => {
    const before = posts().length;
    message(OWNER, "Look at this", {
      subtype: "file_share",
      files: [
        { name: "shot.png", size: SHOT.byteLength, url_private_download: `http://127.0.0.1:${slackApi.port}/files/T0/shot.png` },
        { name: "elsewhere.png", size: 10, url_private_download: "https://files.example.com/elsewhere.png" },
      ],
    });
    await until("answered", () => posts().slice(before).find((p) => (p.params.text ?? "").startsWith("You said:")));
    expect(posts().slice(before).map((p) => p.params.text)).toContain("Not sent with your message (elsewhere.png: it isn't on Slack's own file host).");
    // The app's token went to Slack's file host once, and nowhere else.
    expect(fileGets).toEqual([`Bearer ${BOT_TOKEN}`]);
    const { conversations } = await json<{ conversations: ConversationSummary[] }>(await call("conversations", undefined));
    const latest = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)[0]!;
    const { conversation } = await json<{ conversation: ConversationView }>(await call("conversation", { id: latest.id }));
    const mine = conversation.messages.filter((m) => m.role === "user").at(-1)!;
    expect(mine.content).toBe("Look at this");
    expect(mine.attachments).toEqual([expect.objectContaining({ name: "shot.png", type: "image/png", bytes: SHOT.byteLength })]);
  });

  test("a connection Slack ends is made again, and answers as before", async () => {
    const opened = calls.filter((c) => c.method === "apps.connections.open").length;
    sockets.at(-1)!.send(JSON.stringify({ type: "disconnect", reason: "refresh_requested" }));
    await until("a new connection", () => calls.filter((c) => c.method === "apps.connections.open").length > opened && sockets.length === 1);
    message(OWNER, "Still there?");
    await until("answered", () => posts().find((p) => p.params.text === "You said: Still there?"));
  });

  test("disconnecting revokes its device and deletes its tokens; its chats stay yours", async () => {
    const before = await json<{ slack: SlackView }>(await call("slack", undefined));
    await json(await call("slackDisconnect", {}));
    await until("the socket closed", () => sockets.length === 0);
    const { devices } = await json<FleetView>(await call("fleet", undefined));
    expect(devices.find((d) => d.id === before.slack.device)?.revokedAt).toBeTruthy();
    const { slack } = await json<{ slack: SlackView }>(await call("slack", undefined));
    expect(slack).toMatchObject({ connected: false, bot: null, owner: null });
    const { secrets } = await json<{ secrets: { name: string }[] }>(await call("secrets", undefined));
    expect(secrets.map((s) => s.name).filter((n) => n.startsWith("slack:"))).toEqual([]);
    const { conversations } = await json<{ conversations: ConversationSummary[] }>(await call("conversations", undefined));
    expect(conversations).toHaveLength(2);
    // Connected again, a revoked device never comes back: it gets a new one.
    const again = await json<{ device: string }>(await call("slackConnect", { appToken: APP_TOKEN, botToken: BOT_TOKEN }));
    expect(again.device).not.toBe(before.slack.device);
  });
});

describe("your words as Slack sends them", () => {
  test("its links and mentions are read and its escapes undone", () => {
    expect(fromSlack("see <https://x.test/a?b=1&amp;c=2|the run> and <https://x.test/> &lt;tag&gt; <@U0OWNER001|liege> in <#C0GENERAL1|general>")).toBe(
      "see the run (https://x.test/a?b=1&c=2) and https://x.test/ <tag> liege in general",
    );
  });
});
