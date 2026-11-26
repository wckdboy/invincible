import type { Database } from "bun:sqlite";
import { ATTACHMENT_LIMITS, type AttachmentRef, b64u, type ChatStreamEvent, clientIdentity, type ClientIdentity, fromB64u, newClientSecret, type Scope, signRequest } from "@galahad/core";
import { sseData } from "@galahad/brain";
import type { Vault } from "@galahad/mind";
import { cappedBytes, keepFile } from "./chat-files.ts";
import { telegramAnswer } from "./chat-format.ts";

/*
 * Telegram (PLAN #19): talk to Galahad from Telegram, through a bot of yours. The node you connect it on asks Telegram
 * for what was sent (long polling: nothing of yours is opened to the internet), and answers through its own API as a
 * device of its own, "Telegram", paired with chat and mind:read only and revoked like any device. The bot's token and
 * the device's key are sealed in the vault. Only your own Telegram account is answered: it is linked once, by a code
 * you send the bot from it; anyone else's messages are dropped unread and never answered. A chat there is a chat of
 * yours here (kept, and in the app); approvals stay in the app.
 */

export const TELEGRAM_API = "https://api.telegram.org";
export const TELEGRAM_TOKEN_SECRET = "telegram:bot";
export const TELEGRAM_DEVICE_SECRET = "telegram:device";
/** What the gateway's device may do: chat, and read what chat reads. Nothing that changes how he works, no keys. */
export const TELEGRAM_SCOPES: Scope[] = ["chat", "mind:read"];
export const TELEGRAM_LINK_MS = 15 * 60_000;
const POLL_SECONDS = 50;
const TYPING_EVERY_MS = 4500;
/** Unambiguous letters and digits for the link code (no 0/O, 1/I/L). */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export class TelegramError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface TelegramStatus {
  /** This node runs the bot. */
  connected: boolean;
  bot: string | null;
  /** Your Telegram account, once linked (its name, as Telegram gave it). */
  owner: string | null;
  /** Waiting for your code, until then. */
  linkExpires: number | null;
  /** The gateway's device id (a client of the fleet). */
  device: string | null;
  /** Why it isn't answering, when it isn't. */
  problem: string | null;
}

interface Update {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; username?: string; first_name?: string; is_bot?: boolean };
    chat: { id: number; type: string };
    text?: string;
    /** A photo, in the sizes Telegram keeps of it, smallest first; its words are its caption. */
    photo?: { file_id: string; file_size?: number }[];
    document?: { file_id: string; file_name?: string; file_size?: number };
    caption?: string;
  };
  callback_query?: { id: string; from: { id: number }; message?: { message_id: number; chat: { id: number } }; data?: string };
}

export interface TelegramOptions {
  local: Database;
  vault: Pick<Vault, "has" | "reveal" | "set" | "delete">;
  /** The node's own API, where the gateway's device sends what you wrote (loopback). */
  apiBase: string;
  fetch?: typeof fetch;
  telegramBase?: string;
  log: (message: string) => void;
  now?: () => number;
}

export class TelegramGateway {
  private readonly fetch: typeof fetch;
  private readonly base: string;
  private readonly now: () => number;
  private running: { stop: AbortController; done: Promise<void> } | null = null;
  private problem: string | null = null;

  constructor(private readonly o: TelegramOptions) {
    this.fetch = o.fetch ?? fetch;
    this.base = o.telegramBase ?? TELEGRAM_API;
    this.now = o.now ?? Date.now;
    o.local.exec("CREATE TABLE IF NOT EXISTS telegram (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  }

  private get<T>(key: string): T | null {
    const row = this.o.local.query<{ v: string }, [string]>("SELECT v FROM telegram WHERE k = ?").get(key);
    return row ? (JSON.parse(row.v) as T) : null;
  }

  private put(key: string, value: unknown): void {
    if (value === null) this.o.local.query("DELETE FROM telegram WHERE k = ?").run(key);
    else this.o.local.query("INSERT INTO telegram (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").run(key, JSON.stringify(value));
  }

  /** The device the gateway answers as (its key sealed in the vault), or null before it's connected. */
  device(): ClientIdentity | null {
    if (!this.o.vault.has(TELEGRAM_DEVICE_SECRET)) return null;
    return clientIdentity(fromB64u(this.o.vault.reveal(TELEGRAM_DEVICE_SECRET)));
  }

  status(): TelegramStatus {
    const bot = this.get<{ username: string }>("bot");
    const owner = this.get<{ name: string }>("owner");
    const link = this.get<{ expires: number }>("link");
    return {
      connected: Boolean(bot && this.o.vault.has(TELEGRAM_TOKEN_SECRET)),
      bot: bot ? `@${bot.username}` : null,
      owner: owner?.name ?? null,
      linkExpires: link && link.expires > this.now() ? link.expires : null,
      device: this.get<string>("device"),
      problem: this.problem,
    };
  }

  /**
   * Check the token with Telegram, keep it sealed, make the gateway's device (the caller enrolls it) and a code that
   * links your account. Connecting again keeps the device; another bot forgets the account and the chats it had.
   */
  async connect(token: string, keep: (device: string) => boolean = () => true): Promise<{ bot: string; device: string; code: string; expires: number; fresh: boolean }> {
    if (!/^\d{5,16}:[A-Za-z0-9_-]{30,60}$/.test(token.trim())) throw new TelegramError(400, "that isn't a bot token (BotFather gives one like 123456789:AA…)");
    const me = await this.call<{ id: number; username: string; is_bot: boolean }>("getMe", {}, token.trim()).catch((error: unknown) => {
      throw new TelegramError(400, `Telegram didn't take that token: ${(error as Error).message}`);
    });
    await this.stop();
    const before = this.get<{ id: number }>("bot");
    if (before && before.id !== me.id) for (const key of this.keys()) this.put(key, null);
    this.o.vault.set(TELEGRAM_TOKEN_SECRET, token.trim(), { label: `Telegram bot @${me.username}` });
    const current = this.device();
    const fresh = !current || !keep(current.id);
    if (fresh) this.o.vault.set(TELEGRAM_DEVICE_SECRET, b64u(newClientSecret()), { label: "The Telegram gateway's device key" });
    const device = this.device()!.id;
    this.put("bot", { id: me.id, username: me.username });
    this.put("device", device);
    const code = Array.from(crypto.getRandomValues(new Uint8Array(8)), (n) => CODE_ALPHABET[n % CODE_ALPHABET.length]).join("");
    const expires = this.now() + TELEGRAM_LINK_MS;
    this.put("link", { code, expires });
    this.problem = null;
    this.start();
    return { bot: `@${me.username}`, device, code, expires, fresh };
  }

  /** Stop, and forget the bot, your account's link and the chats it had; the caller revokes the device. */
  async disconnect(): Promise<string | null> {
    await this.stop();
    const device = this.get<string>("device");
    for (const key of this.keys()) this.put(key, null);
    for (const name of [TELEGRAM_TOKEN_SECRET, TELEGRAM_DEVICE_SECRET]) if (this.o.vault.has(name)) this.o.vault.delete(name);
    return device;
  }

  private keys(): string[] {
    return this.o.local.query<{ k: string }, []>("SELECT k FROM telegram").all().map((row) => row.k);
  }

  /** Ask Telegram for what was sent, from where it left off, until stopped. */
  start(): void {
    if (this.running || !this.status().connected) return;
    const stop = new AbortController();
    const done = this.poll(stop.signal).finally(() => {
      if (this.running?.stop === stop) this.running = null;
    });
    this.running = { stop, done };
  }

  async stop(): Promise<void> {
    const running = this.running;
    if (!running) return;
    running.stop.abort();
    await running.done;
    this.running = null;
  }

  private async poll(signal: AbortSignal): Promise<void> {
    let backoff = 2_000;
    while (!signal.aborted) {
      try {
        const offset = this.get<number>("offset");
        const updates = await this.call<Update[]>("getUpdates", { timeout: POLL_SECONDS, allowed_updates: ["message", "callback_query"], ...(offset ? { offset } : {}) }, undefined, signal);
        backoff = 2_000;
        for (const update of updates) {
          // Kept before it's handled: an update is never handled twice, even if handling it fails.
          this.put("offset", update.update_id + 1);
          await this.handle(update).catch((error: unknown) => this.o.log(`telegram: ${(error as Error).message}`));
        }
      } catch (error) {
        if (signal.aborted) return;
        const message = (error as Error).message;
        if (error instanceof TelegramError && error.status === 401) {
          this.problem = "Telegram no longer takes the bot's token (revoked in BotFather?): connect it again.";
          this.o.log(`telegram: ${this.problem}`);
          return;
        }
        this.o.log(`telegram: ${message}`);
        await Bun.sleep(backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  private async handle(update: Update): Promise<void> {
    const owner = this.get<{ id: number; name: string }>("owner");
    if (update.callback_query) {
      const tap = update.callback_query;
      if (!owner || tap.from.id !== owner.id || !tap.message) return;
      await this.call("answerCallbackQuery", { callback_query_id: tap.id }).catch(() => {});
      const offered = this.get<string[]>(`choices:${tap.message.chat.id}:${tap.message.message_id}`);
      const chosen = offered?.[Number(/^c:(\d)$/.exec(tap.data ?? "")?.[1] ?? -1)];
      if (!chosen) return;
      this.put(`choices:${tap.message.chat.id}:${tap.message.message_id}`, null);
      await this.call("editMessageReplyMarkup", { chat_id: tap.message.chat.id, message_id: tap.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      await this.ask(tap.message.chat.id, chosen);
      return;
    }
    const message = update.message;
    if (!message || message.chat.type !== "private" || !message.from || message.from.is_bot) return;
    const text = message.text?.trim() ?? "";
    if (!owner) {
      // Linking: the code from `galahad telegram connect`, from your own account, before it expires. Anything else, unanswered.
      const link = this.get<{ code: string; expires: number }>("link");
      const sent = /^\/start(?:@\w+)?\s+([A-Za-z0-9]{8})$/.exec(text)?.[1]?.toUpperCase();
      if (!link || !sent || link.expires <= this.now() || sent !== link.code) return;
      const name = message.from.username ? `@${message.from.username}` : (message.from.first_name ?? String(message.from.id));
      this.put("owner", { id: message.from.id, name });
      this.put("link", null);
      await this.send(message.chat.id, "Linked: this chat talks to Galahad now, as a device of yours that may chat (revoke it in the app's devices). /new starts a new chat.");
      return;
    }
    if (message.from.id !== owner.id) return;
    if (/^\/new(@\w+)?$/.test(text)) {
      this.put(`chat:${message.chat.id}`, null);
      await this.send(message.chat.id, "A new chat. What's next?");
      return;
    }
    if (/^\/start(@\w+)?(\s|$)/.test(text)) {
      await this.send(message.chat.id, "Galahad here. Write to me as you would in the app. /new starts a new chat.");
      return;
    }
    // A photo (its largest size a message may carry) or a file, its caption the words with it.
    const photo = message.photo?.length ? (message.photo.filter((size) => (size.file_size ?? 0) <= ATTACHMENT_LIMITS.imageBytes).at(-1) ?? message.photo[0]!) : null;
    const files = photo ? [{ id: photo.file_id, name: "photo.jpg", size: photo.file_size }] : message.document ? [{ id: message.document.file_id, name: message.document.file_name ?? "file", size: message.document.file_size }] : [];
    if (files.length) {
      const words = message.caption?.trim() ?? "";
      const kept: AttachmentRef[] = [];
      const left: string[] = [];
      for (const file of files) {
        const got = await this.file(file);
        if ("attachment" in got) kept.push(got.attachment);
        else left.push(`${file.name}: ${got.refused}`);
      }
      if (left.length) await this.send(message.chat.id, `Not sent with your message (${left.join("; ")}).`);
      if (kept.length || words) await this.ask(message.chat.id, words, kept);
      return;
    }
    if (!text) {
      await this.send(message.chat.id, "Words, a photo or a text file: anything else stays here.");
      return;
    }
    await this.ask(message.chat.id, text);
  }

  /** A file you sent, fetched from Telegram (never past what a message may carry) and kept on your node, or why not. */
  private async file(file: { id: string; name: string; size?: number | undefined }): Promise<{ attachment: AttachmentRef } | { refused: string }> {
    const device = this.device();
    if (!device) return { refused: "this chat has no device on your node" };
    if ((file.size ?? 0) > ATTACHMENT_LIMITS.imageBytes) return { refused: "it's over 5 MB" };
    try {
      const found = await this.call<{ file_path?: string }>("getFile", { file_id: file.id });
      // (Where Telegram keeps it, as it said: a path of its own, never one that climbs.)
      if (!found.file_path || !/^[\w./-]{1,300}$/.test(found.file_path) || found.file_path.includes("..")) return { refused: "Telegram didn't hand it over" };
      const response = await this.fetch(`${this.base}/file/bot${this.o.vault.reveal(TELEGRAM_TOKEN_SECRET)}/${found.file_path}`, { redirect: "manual" });
      if (!response.ok) return { refused: `Telegram answered ${response.status}` };
      const bytes = await cappedBytes(response, ATTACHMENT_LIMITS.imageBytes);
      if (!bytes) return { refused: "it's over 5 MB" };
      return await keepFile({ apiBase: this.o.apiBase, fetch: this.fetch, device }, file.name, bytes);
    } catch (error) {
      return { refused: (error as Error).message.slice(0, 200) };
    }
  }

  /** Your words to Galahad, as the gateway's device, in this Telegram chat's chat of yours; his answer back. */
  private async ask(chatId: number, text: string, attachments: AttachmentRef[] = []): Promise<void> {
    const device = this.device();
    if (!device) return;
    const typing = setInterval(() => void this.call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {}), TYPING_EVERY_MS);
    void this.call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
    let answer = "";
    let failed: string | null = null;
    try {
      const conversation = this.get<string>(`chat:${chatId}`);
      const path = "/api/chat";
      const body = new TextEncoder().encode(JSON.stringify({ messages: [{ role: "user", content: text, ...(attachments.length ? { attachments } : {}) }], save: true, ...(conversation ? { conversation } : {}) }));
      const headers = await signRequest(device.id, (m) => device.sign(m), "POST", path, body);
      const response = await this.fetch(`${this.o.apiBase}${path}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body });
      if (response.status === 401) {
        this.problem = "The node no longer takes the gateway's device (revoked?): connect Telegram again.";
        failed = "This chat's device was revoked on your node: connect Telegram again from the app or a terminal.";
      } else if (!response.ok || !response.body) {
        failed = ((await response.json().catch(() => ({}))) as { error?: string }).error ?? `the node answered ${response.status}`;
      } else {
        for await (const data of sseData(response.body)) {
          const event = JSON.parse(data) as ChatStreamEvent;
          if (event.type === "conversation") this.put(`chat:${chatId}`, event.id);
          else if (event.type === "turn" && event.conversation) this.put(`chat:${chatId}`, event.conversation);
          else if (event.type === "text") answer += event.text;
          else if (event.type === "error") failed = event.error;
        }
      }
    } catch (error) {
      failed = (error as Error).message;
    } finally {
      clearInterval(typing);
    }
    if (!answer.trim()) {
      await this.send(chatId, failed ? `He couldn't answer: ${failed}` : "He had nothing to say to that.");
      return;
    }
    const { chunks, choices } = telegramAnswer(answer);
    for (const [at, chunk] of chunks.entries()) {
      const last = at === chunks.length - 1;
      const sent = await this.send(chatId, chunk, true, last && choices.length ? choices : []);
      if (last && choices.length && sent) this.put(`choices:${chatId}:${sent}`, choices);
    }
    if (failed) await this.send(chatId, `(It stopped there: ${failed})`);
  }

  /** One message, as HTML or plain text, with your choices as buttons under it; its id, or null if it wasn't sent. */
  private async send(chatId: number, text: string, html = false, choices: string[] = []): Promise<number | null> {
    const keyboard = choices.length ? { reply_markup: { inline_keyboard: choices.map((choice, at) => [{ text: choice.slice(0, 64), callback_data: `c:${at}` }]) } } : {};
    try {
      const sent = await this.call<{ message_id: number }>("sendMessage", { chat_id: chatId, text, ...(html ? { parse_mode: "HTML" } : {}), link_preview_options: { is_disabled: true }, ...keyboard });
      return sent.message_id;
    } catch (error) {
      // Markup Telegram refuses goes again as plain words.
      if (html) return this.send(chatId, text.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"), false, choices);
      this.o.log(`telegram: not sent: ${(error as Error).message}`);
      return null;
    }
  }

  /** One Bot API method. The token is only ever in the address, which is never logged. */
  private async call<T>(method: string, params: Record<string, unknown>, token?: string, signal?: AbortSignal): Promise<T> {
    const key = token ?? this.o.vault.reveal(TELEGRAM_TOKEN_SECRET);
    const response = await this.fetch(`${this.base}/bot${key}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      ...(signal ? { signal } : {}),
    });
    const body = (await response.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string } | null;
    if (!response.ok || !body?.ok) throw new TelegramError(response.status, `${method}: ${body?.description?.slice(0, 200) ?? response.status}`);
    return body.result as T;
  }
}
