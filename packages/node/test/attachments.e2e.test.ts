import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AttachmentRef, type ConversationView, type RouteName, routes } from "@galahad/core";
import { foundFleet, MindStore } from "@galahad/mind";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { LocalClient } from "../src/loop-tasks.ts";
import { askCommand, type Io } from "../src/turn-cli.ts";
import { freePort } from "./ports.ts";

/*
 * Files you attach to a message in your chat, end to end: a real daemon over real HTTP and a stand-in model that sees
 * (it answers as Ollama's gemma3, whose pictures go as image parts). A picture and a log go up, then with a message:
 * the model is given the picture as the message's own and the log fenced after its words; the kept chat says what the
 * message carried, and the next turn gives the model the picture again; what a message carries is checked; and a chat
 * deleted takes its files with it.
 */

const caps: Capabilities = { os: "linux", arch: "x64", hostname: "attachments-test", cores: 4, cpu: "test", memoryGb: 8, hasBattery: false, gpu: [], docker: false, vm: { kvm: false, tools: [] }, tools: [], localModels: [], tailscale: null };

const root = mkdtempSync(join(tmpdir(), "galahad-attachments-"));
const home = new Home(join(root, "node"));
const port = freePort();
let daemon: Daemon;

const bodies: any[] = [];
const model = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (req) => {
    bodies.push(await req.json());
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "The test can't reach its database." } }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  },
});

const call = (name: RouteName, input?: unknown) => {
  const route = routes[name];
  return fetch(`http://127.0.0.1:${port}${route.path}`, {
    method: route.method,
    headers: { authorization: `Bearer ${home.adminToken()}`, "content-type": "application/json" },
    body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined,
  });
};
const json = async <T = any>(response: Promise<Response> | Response): Promise<T> => {
  const r = await response;
  const body = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(`${r.status} ${body.error ?? ""}`);
  return body;
};
/** A chat call, read to its end: the kept conversation it made or went on with. */
async function ask(input: object): Promise<string | null> {
  const response = await call("chat", input);
  if (!response.ok) throw new Error(`${response.status} ${((await response.json().catch(() => ({}))) as { error?: string }).error ?? ""}`);
  const text = await response.text();
  const kept = text.split("\n").find((l) => l.startsWith("data: ") && l.includes('"type":"conversation"'));
  return kept ? (JSON.parse(kept.slice(6)) as { id: string }).id : null;
}
const upload = async (name: string, type: string, bytes: Uint8Array) => (await json<{ attachment: AttachmentRef }>(call("uploadAttachment", { name, type, data: Buffer.from(bytes).toString("base64") }))).attachment;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
const LOG = new TextEncoder().encode("FAIL db.test.ts\n  connect ECONNREFUSED 127.0.0.1:5432\n");

beforeAll(async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const store = new MindStore(home.mindPath);
  const fleet = foundFleet(store, identity, { fleetName: "camelot", nodeName: "keep" });
  store.close();
  home.writeConfig({ v: 1, name: "keep", fleet, port, keystore, advertise: "127.0.0.1" });
  daemon = await startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {} });
  await json(call("setProvider", { id: "ollama", kind: "openai", baseUrl: `http://127.0.0.1:${model.port}/v1` }));
  await json(call("setRoster", { role: "planner", models: ["ollama/gemma3:4b"] }));
});

afterAll(async () => {
  await daemon?.stop();
  model.stop(true);
  rmSync(root, { recursive: true, force: true });
});

describe("files you attach to a message", () => {
  let shot: AttachmentRef;
  let log: AttachmentRef;
  let chat: string;

  test("go up once each, kept by their SHA-256, and come back as what their bytes are, never run", async () => {
    shot = await upload("shot.png", "image/png", PNG);
    log = await upload("test.log", "text/plain", LOG);
    expect(shot).toMatchObject({ name: "shot.png", type: "image/png", bytes: PNG.length });
    expect(shot.id).toBe(new Bun.CryptoHasher("sha256").update(PNG).digest("hex"));
    const back = await call("attachmentFile", { id: shot.id });
    expect(back.status).toBe(200);
    expect(back.headers.get("content-type")).toBe("image/png");
    expect(back.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(new Uint8Array(await back.arrayBuffer())).toEqual(PNG);
    expect((await call("attachmentFile", { id: log.id })).headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });

  test("go to the model with their message: the picture as the message's own, the log fenced after its words", async () => {
    bodies.length = 0;
    chat = (await ask({ save: true, messages: [{ role: "user", content: "Why does this fail?", attachments: [shot, log] }] }))!;
    expect(chat).toStartWith("cv_");
    const asked = bodies.at(-1).messages.at(-1);
    expect(asked.role).toBe("user");
    expect(asked.content.at(-1)).toEqual({ type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from(PNG).toString("base64")}` } });
    const words = asked.content[0].text as string;
    expect(words).toStartWith("Why does this fail?\n\nYour liege attached a file to this message: test.log.");
    expect(words).toContain(`<file-${log.id.slice(0, 16)}>\nFAIL db.test.ts\n  connect ECONNREFUSED 127.0.0.1:5432\n\n</file-${log.id.slice(0, 16)}>`);
  });

  test("go with a call of yours without tools as well (a quest you run), which lives with its request", async () => {
    bodies.length = 0;
    await ask({ tools: false, messages: [{ role: "user", content: "What is in it?", attachments: [shot] }] });
    expect(bodies.at(-1).messages.at(-1).content).toEqual([
      { type: "text", text: "What is in it?" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from(PNG).toString("base64")}` } },
    ]);
  });

  test("are kept with the message, and the next turn gives the model the picture again", async () => {
    const kept = (await json<{ conversation: ConversationView }>(call("conversation", { id: chat }))).conversation;
    expect(kept.messages[0]).toMatchObject({ role: "user", content: "Why does this fail?", attachments: [shot, log] });
    expect(kept.title).toBe("Why does this fail?");
    bodies.length = 0;
    await ask({ conversation: chat, messages: [{ role: "user", content: "And how do I fix it?" }] });
    const [, first, , last] = bodies.at(-1).messages;
    expect(first.content.at(-1).image_url.url).toStartWith("data:image/png;base64,");
    expect(last).toEqual({ role: "user", content: "And how do I fix it?" });
  });

  test("a message of pictures alone is titled by what it carries, and is given the model with words that say so", async () => {
    bodies.length = 0;
    const alone = (await ask({ save: true, messages: [{ role: "user", content: "", attachments: [shot] }] }))!;
    expect((await json<{ conversation: ConversationView }>(call("conversation", { id: alone }))).conversation.title).toBe("shot.png");
    expect(bodies.at(-1).messages.at(-1).content[0]).toEqual({ type: "text", text: "(No words with it: only what is attached.)" });
    await json(call("deleteConversation", { id: alone }));
  });

  test("are yours alone: an agent, even one that may chat, neither attaches, reads nor sends one", async () => {
    const { token } = await json<{ token: string }>(call("mintArm", { label: "helper", scopes: ["chat"] }));
    const as = (name: RouteName, input: unknown) => fetch(`http://127.0.0.1:${port}${routes[name].path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(input) });
    const refused = async (r: Promise<Response>) => {
      const response = await r;
      return [response.status, ((await response.json()) as { error: string }).error];
    };
    expect(await refused(as("uploadAttachment", { name: "x.txt", type: "text/plain", data: Buffer.from("hello").toString("base64") }))).toEqual([403, "chats are yours alone"]);
    expect(await refused(as("attachmentFile", { id: shot.id }))).toEqual([403, "chats are yours alone"]);
    expect(await refused(as("chat", { tools: false, messages: [{ role: "user", content: "Look", attachments: [shot] }] }))).toEqual([403, "only you attach files to a message"]);
  });

  test("what a message carries is checked: kept on this node, and no secret in a text", async () => {
    const stranger: AttachmentRef = { id: "f".repeat(64), name: "elsewhere.png", type: "image/png", bytes: 10 };
    const refused = await call("chat", { messages: [{ role: "user", content: "Look", attachments: [stranger] }] });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe("elsewhere.png isn't on this node: attach it again");
    const secret = await call("uploadAttachment", { name: "env.txt", type: "text/plain", data: Buffer.from("ANTHROPIC_API_KEY=sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE-FAKEFAKE-AAAAAAAA").toString("base64") });
    expect(secret.status).toBe(422);
    const lies = await call("uploadAttachment", { name: "shot.jpg", type: "image/jpeg", data: Buffer.from(PNG).toString("base64") });
    expect(lies.status).toBe(415);
  });

  test("galahad ask --attach: each file sent up as what its bytes are, then with the message; anything else refused", async () => {
    const files = mkdtempSync(join(root, "files-"));
    writeFileSync(join(files, "screen.png"), PNG);
    writeFileSync(join(files, "notes.md"), "# Notes\nThe database starts after the tests.\n");
    writeFileSync(join(files, "core.dump"), new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2]));
    const err: string[] = [];
    const io: Io = { out: () => {}, err: (text) => void err.push(text), tty: false };
    const cli = new LocalClient(`http://127.0.0.1:${port}`, home.adminToken());
    bodies.length = 0;
    expect(await askCommand(cli, "Read these.", { temp: true, attach: [join(files, "screen.png"), join(files, "notes.md")] }, io)).toBe(0);
    expect(err[0]).toBe(`[attached: screen.png (1 KB), notes.md (1 KB)]\n`);
    const asked = bodies.at(-1).messages.at(-1);
    expect(asked.content[0].text).toContain("Your liege attached a file to this message: notes.md.");
    expect(asked.content.at(-1).type).toBe("image_url");
    await expect(askCommand(cli, "And this?", { temp: true, attach: [join(files, "core.dump")] }, io)).rejects.toThrow("core.dump is neither a picture (PNG, JPEG, WebP, GIF) nor text: only those go with a message");
    await expect(askCommand(cli, "x", { chat: "cv_xxxxxxxxxxxxxxxxxxxxxx", steer: true, attach: [join(files, "notes.md")] }, io)).rejects.toThrow("--attach goes with a message of yours");
  });

  test("a chat deleted takes what its messages carried with it", async () => {
    await json(call("deleteConversation", { id: chat }));
    expect((await call("attachmentFile", { id: shot.id })).status).toBe(404);
    expect((await call("attachmentFile", { id: log.id })).status).toBe(404);
  });
});
