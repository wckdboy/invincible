import type { Database } from "bun:sqlite";
import { ATTACHMENT_LIMITS, type AttachmentRef, b64u, type ChatStreamEvent, clientIdentity, type ClientIdentity, fromB64u, newClientSecret, type Scope, signRequest } from "@galahad/core";
import { sseData } from "@galahad/brain";
import type { Vault } from "@galahad/mind";
import { cappedBytes, keepFile } from "./chat-files.ts";
import { slackAnswer } from "./chat-format.ts";

/*
 * Slack (PLAN #19): talk to Galahad from Slack, through an app of yours in your workspace. The node you connect it on
 * opens the app's Socket Mode connection itself (outbound: nothing of yours is opened to the internet), and answers
 * through its own API as a device of its own, "Slack", paired with chat and mind:read only and revoked like any device.
 * The app's two tokens and the device's key are sealed in the vault. Only your own Slack account is answered, and only
 * in your direct messages with the app: it is linked once, by a code you send the app from it; anyone else's messages
 * are dropped unread and never answered, and so is anything in a channel. A chat there is a chat of yours here;
 * approvals stay in the app.
 */

export const SLACK_API = "https://slack.com/api";
export const SLACK_APP_SECRET = "slack:app";
export const SLACK_BOT_SECRET = "slack:bot";
export const SLACK_DEVICE_SECRET = "slack:device";
/** What the gateway's device may do: chat, and read what chat reads. Nothing that changes how he works, no keys. */
export const SLACK_SCOPES: Scope[] = ["chat", "mind:read"];
export const SLACK_LINK_MS = 15 * 60_000;
/** Unambiguous letters and digits for the link code (no 0/O, 1/I/L). */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
/** Slack's words for a token it no longer takes. */
const REFUSED = new Set(["invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive", "not_allowed_token_type"]);
/** A connection that hears nothing (a message, or the answer to a ping) for this long is a dead one: made again. */
const QUIET_MS = 75_000;
const PING_EVERY_MS = 30_000;

export class SlackError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface SlackStatus {
  /** This node runs the app. */
  connected: boolean;
  /** The workspace it is in, and its bot, by name. */
  workspace: string | null;
  bot: string | null;
  /** Your Slack account, once linked (its name, as Slack gave it). */
  owner: string | null;
  /** Waiting for your code, until then. */
  linkExpires: number | null;
  /** The gateway's device id (a client of the fleet). */
  device: string | null;
  /** Why it isn't answering, when it isn't. */
  problem: string | null;
}

interface SlackBot {
  userId: string;
  name: string;
  team: string;
  teamId: string;
}

type Blocks = { type: string; [key: string]: unknown }[];
interface Envelope {
  type: string;
  envelope_id?: string;
  reason?: string;
  payload?: {
    type?: string;
    event_id?: string;
    team_id?: string;
    event?: {
      type?: string;
      subtype?: string;
      channel?: string;
      channel_type?: string;
      user?: string;
      bot_id?: string;
      text?: string;
      ts?: string;
      thread_ts?: string;
      /** What you shared with the message (files:read): each one's name, size and where Slack serves it. */
      files?: { name?: string; size?: number; url_private_download?: string }[];
    };
    // A button tapped (block_actions).
    user?: { id?: string };
    channel?: { id?: string };
    message?: { ts?: string; thread_ts?: string; text?: string; blocks?: Blocks };
    actions?: { action_id?: string }[];
  };
}

export interface SlackOptions {
  local: Database;
  vault: Pick<Vault, "has" | "reveal" | "set" | "delete">;
  /** The node's own API, where the gateway's device sends what you wrote (loopback). */
  apiBase: string;
  fetch?: typeof fetch;
  /** Where Slack's Web API is (tests: a stand-in, whose sockets may then be ws:). */
  slackBase?: string;
  log: (message: string) => void;
  now?: () => number;
}

/** Your words as Slack sent them, back to plain text: its links and mentions read, its three escapes undone. */
export function fromSlack(text: string): string {
  return text
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, (_m, url: string, label: string) => (label === url ? url : `${label} (${url})`))
    .replace(/<(https?:\/\/[^|>]+)>/g, "$1")
    .replace(/<mailto:[^|>]+\|([^>]+)>/g, "$1")
    .replace(/<[@#!][^|>]+\|([^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** A wait that ends early when stopped. */
const pause = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

export class SlackGateway {
  private readonly fetch: typeof fetch;
  private readonly base: string;
  private readonly now: () => number;
  private running: { stop: AbortController; done: Promise<void> } | null = null;
  private problem: string | null = null;
  /** What was taken already (Slack sends one again it thinks went unheard), and what waits its turn. */
  private readonly seen = new Set<string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly o: SlackOptions) {
    this.fetch = o.fetch ?? fetch;
    this.base = o.slackBase ?? SLACK_API;
    this.now = o.now ?? Date.now;
    o.local.exec("CREATE TABLE IF NOT EXISTS slack (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  }

  private get<T>(key: string): T | null {
    const row = this.o.local.query<{ v: string }, [string]>("SELECT v FROM slack WHERE k = ?").get(key);
    return row ? (JSON.parse(row.v) as T) : null;
  }

  private put(key: string, value: unknown): void {
    if (value === null) this.o.local.query("DELETE FROM slack WHERE k = ?").run(key);
    else this.o.local.query("INSERT INTO slack (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").run(key, JSON.stringify(value));
  }

  /** The device the gateway answers as (its key sealed in the vault), or null before it's connected. */
  device(): ClientIdentity | null {
    if (!this.o.vault.has(SLACK_DEVICE_SECRET)) return null;
    return clientIdentity(fromB64u(this.o.vault.reveal(SLACK_DEVICE_SECRET)));
  }

  status(): SlackStatus {
    const bot = this.get<SlackBot>("bot");
    const owner = this.get<{ name: string }>("owner");
    const link = this.get<{ expires: number }>("link");
    return {
      connected: Boolean(bot && this.o.vault.has(SLACK_APP_SECRET) && this.o.vault.has(SLACK_BOT_SECRET)),
      workspace: bot?.team ?? null,
      bot: bot ? `@${bot.name}` : null,
      owner: owner?.name ?? null,
      linkExpires: link && link.expires > this.now() ? link.expires : null,
      device: this.get<string>("device"),
      problem: this.problem,
    };
  }

  /**
   * Check both tokens with Slack, keep them sealed, make the gateway's device (the caller enrolls it) and a code that
   * links your account. Connecting again keeps the device; another app or workspace forgets the account and its chats.
   */
  async connect(appToken: string, botToken: string, keep: (device: string) => boolean = () => true): Promise<{ bot: string; workspace: string; device: string; code: string; expires: number; fresh: boolean }> {
    const app = appToken.trim();
    const token = botToken.trim();
    if (!/^xapp-[A-Za-z0-9-]{16,300}$/.test(app)) throw new SlackError(400, "that isn't an app-level token (Basic Information → App-Level Tokens makes one like xapp-1-…, with connections:write)");
    if (!/^xoxb-[A-Za-z0-9-]{16,300}$/.test(token)) throw new SlackError(400, "that isn't a bot token (OAuth & Permissions gives one like xoxb-… once the app is installed)");
    const refused = (which: string) => (error: unknown) => {
      throw new SlackError(400, `Slack didn't take the ${which}: ${(error as Error).message}`);
    };
    const me = await this.call<{ team: string; team_id: string; user: string; user_id: string }>("auth.test", {}, token).catch(refused("bot token"));
    // The app-level token, by asking for a connection with it (Socket Mode must be on); it's left unopened.
    await this.call<{ url: string }>("apps.connections.open", {}, app).catch(refused("app-level token"));
    await this.stop();
    const before = this.get<SlackBot>("bot");
    if (before && (before.userId !== me.user_id || before.teamId !== me.team_id)) for (const key of this.keys()) this.put(key, null);
    this.o.vault.set(SLACK_APP_SECRET, app, { label: `Slack app @${me.user} in ${me.team} (Socket Mode)` });
    this.o.vault.set(SLACK_BOT_SECRET, token, { label: `Slack app @${me.user} in ${me.team}` });
    const current = this.device();
    const fresh = !current || !keep(current.id);
    if (fresh) this.o.vault.set(SLACK_DEVICE_SECRET, b64u(newClientSecret()), { label: "The Slack gateway's device key" });
    const device = this.device()!.id;
    this.put("bot", { userId: me.user_id, name: me.user, team: me.team, teamId: me.team_id } satisfies SlackBot);
    this.put("device", device);
    const code = Array.from(crypto.getRandomValues(new Uint8Array(8)), (n) => CODE_ALPHABET[n % CODE_ALPHABET.length]).join("");
    const expires = this.now() + SLACK_LINK_MS;
    this.put("link", { code, expires });
    this.problem = null;
    this.start();
    return { bot: `@${me.user}`, workspace: me.team, device, code, expires, fresh };
  }

  /** Stop, and forget the app, your account's link and the chats it had; the caller revokes the device. */
  async disconnect(): Promise<string | null> {
    await this.stop();
    const device = this.get<string>("device");
    for (const key of this.keys()) this.put(key, null);
    for (const name of [SLACK_APP_SECRET, SLACK_BOT_SECRET, SLACK_DEVICE_SECRET]) if (this.o.vault.has(name)) this.o.vault.delete(name);
    return device;
  }

  private keys(): string[] {
    return this.o.local.query<{ k: string }, []>("SELECT k FROM slack").all().map((row) => row.k);
  }

  /** Keep a connection to Slack open, a new one each time it ends, until stopped. */
  start(): void {
    if (this.running || !this.status().connected) return;
    const stop = new AbortController();
    const done = this.run(stop.signal).finally(() => {
      if (this.running?.stop === stop) this.running = null;
    });
    this.running = { stop, done };
  }

  async stop(): Promise<void> {
    const running = this.running;
    if (!running) return;
    running.stop.abort();
    await running.done;
    await this.queue;
    this.running = null;
  }

  private async run(signal: AbortSignal): Promise<void> {
    let backoff = 2_000;
    while (!signal.aborted) {
      try {
        const began = this.now();
        const ended = await this.session(signal);
        if (ended === "stopped") return;
        if (ended === "disabled") {
          this.problem = "Socket Mode was turned off for the app in Slack: turn it on again (Settings → Socket Mode).";
          this.o.log(`slack: ${this.problem}`);
          return;
        }
        // Slack asked for a fresh connection: another at once. One that died: another soon, slower if they keep dying young.
        if (ended === "lost") {
          if (this.now() - began > 60_000) backoff = 2_000;
          await pause(backoff, signal);
          backoff = Math.min(backoff * 2, 60_000);
        } else backoff = 2_000;
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof SlackError && error.status === 401) {
          this.problem = "Slack no longer takes the app's tokens (revoked, or the app removed?): connect it again.";
          this.o.log(`slack: ${this.problem}`);
          return;
        }
        this.o.log(`slack: ${(error as Error).message}`);
        await pause(backoff, signal);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  /** One Socket Mode connection, until Slack ends it (asking for another, or for none), it dies, or it is stopped. */
  private async session(signal: AbortSignal): Promise<"refresh" | "lost" | "disabled" | "stopped"> {
    const { url } = await this.call<{ url: string }>("apps.connections.open", {}, this.o.vault.reveal(SLACK_APP_SECRET), signal);
    // Slack's own socket, over TLS (a stand-in's may be ws:): never somewhere else an answer names.
    if (!/^wss:\/\//.test(url) && !(this.o.slackBase && /^ws:\/\/127\.0\.0\.1[:/]/.test(url))) throw new SlackError(502, "Slack gave a connection that isn't wss");
    const ws = new WebSocket(url);
    return await new Promise((resolve) => {
      let heard = this.now();
      let settled = false;
      const end = (how: "refresh" | "lost" | "disabled" | "stopped") => {
        if (settled) return;
        settled = true;
        clearInterval(watch);
        signal.removeEventListener("abort", aborted);
        try {
          ws.close();
        } catch {
          /* closed already */
        }
        resolve(how);
      };
      const aborted = () => end("stopped");
      signal.addEventListener("abort", aborted, { once: true });
      // Slack's pings come and go unseen: ours, answered, say it's still there.
      const watch = setInterval(() => {
        if (this.now() - heard > QUIET_MS) return end("lost");
        try {
          (ws as WebSocket & { ping?: () => void }).ping?.();
        } catch {
          end("lost");
        }
      }, PING_EVERY_MS);
      ws.addEventListener("pong", () => (heard = this.now()));
      ws.addEventListener("message", (event) => {
        heard = this.now();
        const how = this.envelope(ws, String(event.data));
        if (how) end(how);
      });
      ws.addEventListener("close", () => end("lost"));
      ws.addEventListener("error", () => end("lost"));
    });
  }

  /** One thing Slack sent: said received at once, then taken in turn. */
  private envelope(ws: WebSocket, data: string): "refresh" | "disabled" | null {
    let envelope: Envelope;
    try {
      envelope = JSON.parse(data) as Envelope;
    } catch {
      return null;
    }
    // Acknowledged at once: Slack sends an envelope again after three seconds without it.
    if (envelope.envelope_id) {
      try {
        ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
      } catch {
        /* closing: Slack sends it again on the next connection */
      }
    }
    if (envelope.type === "disconnect") return envelope.reason === "link_disabled" ? "disabled" : "refresh";
    if (envelope.type !== "events_api" && envelope.type !== "interactive") return null;
    // Once each (Slack may send one again), and one at a time, in the order they came.
    const id = envelope.payload?.event_id ?? envelope.envelope_id;
    if (id) {
      if (this.seen.has(id)) return null;
      this.seen.add(id);
      if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value!);
    }
    this.queue = this.queue.then(() => this.handle(envelope)).catch((error: unknown) => this.o.log(`slack: ${(error as Error).message}`));
    return null;
  }

  private async handle(envelope: Envelope): Promise<void> {
    const bot = this.get<SlackBot>("bot");
    const owner = this.get<{ id: string; name: string }>("owner");
    const payload = envelope.payload;
    if (!bot || !payload) return;
    if (envelope.type === "interactive") {
      if (payload.type !== "block_actions" || !owner || payload.user?.id !== owner.id) return;
      const channel = payload.channel?.id;
      const ts = payload.message?.ts;
      if (!channel || !ts) return;
      const offered = this.get<string[]>(`choices:${channel}:${ts}`);
      const chosen = offered?.[Number(/^c:(\d{1,2})$/.exec(payload.actions?.[0]?.action_id ?? "")?.[1] ?? -1)];
      if (!chosen) return;
      this.put(`choices:${channel}:${ts}`, null);
      // Its buttons go and its words stay; what you chose is your next message.
      const blocks = (payload.message?.blocks ?? []).filter((block) => block.type !== "actions");
      await this.call("chat.update", { channel, ts, text: payload.message?.text ?? "", blocks }).catch(() => {});
      await this.ask(channel, chosen, payload.message?.thread_ts);
      return;
    }
    const event = payload.event;
    if (payload.type !== "event_callback" || event?.type !== "message" || !event.channel) return;
    // Your direct messages with the app alone: never a channel, an edit, a join, or a bot's words (its own among them).
    if (event.channel_type !== "im" || (event.subtype && event.subtype !== "file_share") || event.bot_id || !event.user || event.user === bot.userId) return;
    if (payload.team_id && payload.team_id !== bot.teamId) return;
    const text = fromSlack(event.text ?? "").trim();
    if (!owner) {
      // Linking: the code from `galahad slack connect`, from your own account, before it expires. Anything else, unanswered.
      const link = this.get<{ code: string; expires: number }>("link");
      const sent = /^(?:link\s+)?([A-Za-z0-9]{8})$/i.exec(text)?.[1]?.toUpperCase();
      if (!link || !sent || link.expires <= this.now() || sent !== link.code) return;
      this.put("owner", { id: event.user, name: await this.nameOf(event.user) });
      this.put("link", null);
      await this.send(event.channel, "Linked: you talk to Galahad here now, as a device of yours that may chat (revoke it in the app's devices). *new* on its own starts a new chat.");
      return;
    }
    if (event.user !== owner.id) return;
    if (/^\/?new( chat)?[.!]?$/i.test(text)) {
      this.put(`chat:${event.channel}`, null);
      await this.send(event.channel, "A new chat. What's next?", event.thread_ts);
      return;
    }
    // What you shared with it (a screenshot, a log), its words the message's.
    const files = (event.files ?? []).slice(0, ATTACHMENT_LIMITS.perMessage);
    if (files.length) {
      const kept: AttachmentRef[] = [];
      const left: string[] = [];
      for (const file of files) {
        const got = await this.file(file);
        if ("attachment" in got) kept.push(got.attachment);
        else left.push(`${file.name ?? "a file"}: ${got.refused}`);
      }
      if (left.length) await this.send(event.channel, `Not sent with your message (${left.join("; ")}).`, event.thread_ts);
      if (kept.length || text) await this.ask(event.channel, text, event.thread_ts, event.ts, kept);
      return;
    }
    if (!text) {
      await this.send(event.channel, "Words, a picture or a text file: anything else stays here.", event.thread_ts);
      return;
    }
    await this.ask(event.channel, text, event.thread_ts, event.ts);
  }

  /** A file you shared, fetched from Slack's own file host with the app's token (never anywhere else) and kept on your node. */
  private async file(file: { name?: string; size?: number; url_private_download?: string }): Promise<{ attachment: AttachmentRef } | { refused: string }> {
    const device = this.device();
    if (!device) return { refused: "this conversation has no device on your node" };
    if ((file.size ?? 0) > ATTACHMENT_LIMITS.imageBytes) return { refused: "it's over 5 MB" };
    let from: URL;
    try {
      from = new URL(file.url_private_download ?? "");
    } catch {
      return { refused: "Slack didn't say where it is" };
    }
    // The app's token goes to Slack's file host alone (a stand-in's, in tests).
    const host = this.o.slackBase ? new URL(this.o.slackBase).origin : null;
    if (!(from.protocol === "https:" && from.hostname === "files.slack.com") && from.origin !== host) return { refused: "it isn't on Slack's own file host" };
    try {
      const response = await this.fetch(from, { headers: { authorization: `Bearer ${this.o.vault.reveal(SLACK_BOT_SECRET)}` }, redirect: "manual" });
      if (!response.ok) return { refused: response.status === 403 ? "the app can't read files (give it files:read, then install it again)" : `Slack answered ${response.status}` };
      const bytes = await cappedBytes(response, ATTACHMENT_LIMITS.imageBytes);
      if (!bytes) return { refused: "it's over 5 MB" };
      return await keepFile({ apiBase: this.o.apiBase, fetch: this.fetch, device }, file.name ?? "file", bytes);
    } catch (error) {
      return { refused: (error as Error).message.slice(0, 200) };
    }
  }

  /** Your name as Slack shows it (users:read), or your id when it can't be read. */
  private async nameOf(user: string): Promise<string> {
    try {
      const found = await this.call<{ user: { name?: string; real_name?: string; profile?: { display_name?: string } } }>("users.info", { user });
      const name = found.user.profile?.display_name || found.user.name || found.user.real_name;
      return name ? `@${name}` : user;
    } catch {
      return user;
    }
  }

  /** Your words to Galahad, as the gateway's device, in this conversation's chat of yours; his answer back. */
  private async ask(channel: string, text: string, thread?: string, yours?: string, attachments: AttachmentRef[] = []): Promise<void> {
    const device = this.device();
    if (!device) return;
    // While he works, 👀 on your message (it stands still), taken off when he answers.
    if (yours) await this.call("reactions.add", { channel, timestamp: yours, name: "eyes" }).catch(() => {});
    let answer = "";
    let failed: string | null = null;
    try {
      const conversation = this.get<string>(`chat:${channel}`);
      const path = "/api/chat";
      const body = new TextEncoder().encode(JSON.stringify({ messages: [{ role: "user", content: text, ...(attachments.length ? { attachments } : {}) }], save: true, ...(conversation ? { conversation } : {}) }));
      const headers = await signRequest(device.id, (m) => device.sign(m), "POST", path, body);
      const response = await this.fetch(`${this.o.apiBase}${path}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body });
      if (response.status === 401) {
        this.problem = "The node no longer takes the gateway's device (revoked?): connect Slack again.";
        failed = "This conversation's device was revoked on your node: connect Slack again from the app or a terminal.";
      } else if (!response.ok || !response.body) {
        failed = ((await response.json().catch(() => ({}))) as { error?: string }).error ?? `the node answered ${response.status}`;
      } else {
        for await (const data of sseData(response.body)) {
          const event = JSON.parse(data) as ChatStreamEvent;
          if (event.type === "conversation") this.put(`chat:${channel}`, event.id);
          else if (event.type === "turn" && event.conversation) this.put(`chat:${channel}`, event.conversation);
          else if (event.type === "text") answer += event.text;
          else if (event.type === "error") failed = event.error;
        }
      }
    } catch (error) {
      failed = (error as Error).message;
    } finally {
      if (yours) await this.call("reactions.remove", { channel, timestamp: yours, name: "eyes" }).catch(() => {});
    }
    if (!answer.trim()) {
      await this.send(channel, failed ? `He couldn't answer: ${failed}` : "He had nothing to say to that.", thread);
      return;
    }
    const { chunks, choices } = slackAnswer(answer);
    for (const [at, chunk] of chunks.entries()) {
      const last = at === chunks.length - 1;
      const sent = await this.send(channel, chunk, thread, last ? choices : []);
      if (last && choices.length && sent) this.put(`choices:${channel}:${sent}`, choices);
    }
    if (failed) await this.send(channel, `(It stopped there: ${failed})`, thread);
  }

  /** One message, in Slack's mrkdwn, with your choices as buttons under it; its ts, or null if it wasn't sent. */
  private async send(channel: string, text: string, thread?: string, choices: string[] = []): Promise<string | null> {
    const buttons = { type: "actions", elements: choices.slice(0, 25).map((choice, at) => ({ type: "button", action_id: `c:${at}`, text: { type: "plain_text", text: choice.slice(0, 75), emoji: true }, value: String(at) })) };
    const blocks: Blocks | null = choices.length ? [...(text.trim() ? [{ type: "section", text: { type: "mrkdwn", text } }] : []), buttons] : null;
    try {
      const sent = await this.call<{ ts: string }>("chat.postMessage", { channel, text: text.trim() ? text : choices.join(" · "), unfurl_links: false, unfurl_media: false, ...(thread ? { thread_ts: thread } : {}), ...(blocks ? { blocks } : {}) });
      return sent.ts;
    } catch (error) {
      this.o.log(`slack: not sent: ${(error as Error).message}`);
      return null;
    }
  }

  /** One Web API method. A token is only ever in its header, which is never logged. */
  private async call<T>(method: string, params: Record<string, unknown>, token?: string, signal?: AbortSignal): Promise<T> {
    const key = token ?? this.o.vault.reveal(SLACK_BOT_SECRET);
    const form = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) form.set(name, typeof value === "string" ? value : JSON.stringify(value));
    const response = await this.fetch(`${this.base}/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded" },
      body: form,
      redirect: "manual",
      ...(signal ? { signal } : {}),
    });
    if (response.status === 429) throw new SlackError(429, `${method}: Slack asks to wait (${response.headers.get("retry-after") ?? "a while"} s)`);
    const body = (await response.json().catch(() => null)) as ({ ok?: boolean; error?: string; needed?: string } & T) | null;
    if (!response.ok || !body?.ok) {
      const error = body?.error ?? String(response.status);
      throw new SlackError(REFUSED.has(error) ? 401 : response.ok ? 400 : response.status, `${method}: ${error.slice(0, 100)}${body?.needed ? ` (the app needs the ${body.needed.slice(0, 100)} scope)` : ""}`);
    }
    return body as T;
  }
}
