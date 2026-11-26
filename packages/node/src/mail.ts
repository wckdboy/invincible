import type { ArgValue, BuiltRequest, ConnectorManifest } from "@galahad/core";
import type { ConnectorResult } from "@galahad/brain";
import type { NativeTool } from "./connectors.ts";

/*
 * Mail, as Galahad's own tools (natives): Gmail through Google's Gmail API, Outlook through Microsoft Graph, signed in
 * as you (brain oauth.ts) and Galahad's alone, its reads private as the bank's are (the catalog's gmail and outlook).
 * A tool here may make several requests (a search then each message's headers; a reply's draft needs the message it
 * answers), so it is carried out by the node rather than as one request template, and what it answers is compact:
 * the headers that matter and the words of a message, never its raw MIME. Mail is someone else's words: it reaches
 * the model as data, and nothing in it is taken for an instruction.
 *
 *   search, read: read, run freely (and private). draft: create. archive: modify (back to the inbox any time).
 *   send: outward, asks you first. trash: delete, asks you first (Gmail and Outlook keep it for 30 days).
 */

const json = (status: number, value: unknown, started: number): ConnectorResult => ({
  ok: status >= 200 && status < 300,
  status,
  contentType: "application/json",
  body: JSON.stringify(value),
  truncated: false,
  durationMs: Math.round(performance.now() - started),
});

export class MailError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** One request to the connector's own origin, its answer read as JSON (null when it isn't). */
type Call = (method: BuiltRequest["method"], path: string, body: unknown, cls: BuiltRequest["class"], headers?: Record<string, string>) => Promise<{ status: number; json: any }>;

function caller(manifest: ConnectorManifest, send: (request: BuiltRequest) => Promise<ConnectorResult>): Call {
  const origin = new URL(manifest.origin).origin;
  return async (method, path, body, cls, headers = {}) => {
    const url = new URL(`${manifest.basePath ?? ""}${path}`, origin);
    if (url.origin !== origin) throw new MailError(400, "refusing a request off the connector's origin");
    const answer = await send({
      kind: "http",
      method,
      url: url.toString(),
      headers: { ...(manifest.headers ?? {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      class: cls,
      target: `${method} ${url.pathname}`,
    });
    let parsed: any = null;
    try {
      parsed = JSON.parse(answer.body);
    } catch {
      /* not JSON: the status says enough */
    }
    if (!answer.ok) {
      const said = parsed?.error?.message ?? parsed?.error_description ?? (typeof parsed?.error === "string" ? parsed.error : null);
      throw new MailError(answer.status, `${manifest.label} answered ${answer.status}${said ? `: ${String(said).slice(0, 300)}` : ""}`);
    }
    return { status: answer.status, json: parsed };
  };
}

/** A tool's checked arguments (the manifest's params) as what it needs. */
const text = (args: Record<string, ArgValue>, name: string): string | undefined => (typeof args[name] === "string" ? (args[name] as string) : undefined);
const count = (args: Record<string, ArgValue>, name: string, fallback: number, max: number): number => {
  const n = args[name];
  return typeof n === "number" && Number.isInteger(n) ? Math.min(Math.max(n, 1), max) : fallback;
};

/** Addresses as you wrote them, comma-separated: each one an address, and nothing that could start a new header. */
export function addresses(list: string | undefined, what: string): string[] {
  if (!list?.trim()) return [];
  const each = list.split(",").map((a) => a.trim()).filter(Boolean);
  for (const address of each) {
    if (!/^[^\s@<>(),;:"\\[\]]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/.test(address)) throw new MailError(400, `${what}: "${address.slice(0, 80)}" isn't an email address`);
  }
  if (each.length > 50) throw new MailError(400, `${what}: at most 50 addresses`);
  return each;
}

/** A subject on one line, its words encoded where they aren't plain ASCII (RFC 2047). */
export function subjectLine(subject: string): string {
  const one = subject.replace(/[\r\n]+/g, " ").trim().slice(0, 500);
  return /^[\x20-\x7e]*$/.test(one) ? one : `=?UTF-8?B?${Buffer.from(one, "utf8").toString("base64")}?=`;
}

/** A plain-text message as Gmail takes it: RFC 2822, its body base64, the whole base64url. */
export function rawMessage(m: { to: string[]; cc: string[]; subject: string; body: string; inReplyTo?: string; references?: string }): string {
  const lines = [
    `To: ${m.to.join(", ")}`,
    ...(m.cc.length ? [`Cc: ${m.cc.join(", ")}`] : []),
    `Subject: ${subjectLine(m.subject)}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`, `References: ${[m.references, m.inReplyTo].filter(Boolean).join(" ")}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    (Buffer.from(m.body, "utf8").toString("base64").match(/.{1,76}/g) ?? []).join("\r\n"),
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

/** A message id that's only an id: in a path it can't become another path. */
const messageId = (args: Record<string, ArgValue>): string => {
  const id = text(args, "id");
  if (!id || !/^[A-Za-z0-9=_+/-]{6,512}$/.test(id)) throw new MailError(400, "give the message's id, as search gives it");
  return encodeURIComponent(id);
};

/** HTML as its words: what a person reads, without markup, scripts or styles. */
export function wordsOf(html: string): string {
  return html
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

/** As much of a message's words as an answer carries. */
const BODY_CHARS = 20_000;
const cut = (words: string): string => (words.length > BODY_CHARS ? `${words.slice(0, BODY_CHARS)}\n… (cut: the message goes on)` : words);

// ---------- Gmail ----------

const GMAIL = "/gmail/v1/users/me";
type GmailPart = { mimeType?: string; filename?: string; headers?: { name: string; value: string }[]; body?: { data?: string; size?: number; attachmentId?: string }; parts?: GmailPart[] };

const header = (headers: { name: string; value: string }[] | undefined, name: string): string | null =>
  headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;

/** A message's words: its plain text, or its HTML's words when it has none; and what it has attached. */
export function gmailWords(payload: GmailPart): { body: string; attachments: { name: string; size: number }[] } {
  let plain: string | null = null;
  let html: string | null = null;
  const attachments: { name: string; size: number }[] = [];
  const walk = (part: GmailPart): void => {
    if (part.filename) attachments.push({ name: part.filename, size: part.body?.size ?? 0 });
    else if (part.body?.data && part.mimeType === "text/plain" && plain === null) plain = Buffer.from(part.body.data, "base64url").toString("utf8");
    else if (part.body?.data && part.mimeType === "text/html" && html === null) html = Buffer.from(part.body.data, "base64url").toString("utf8");
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  return { body: cut((plain ?? (html ? wordsOf(html) : "")).trim()), attachments };
}

const gmailSummary = (m: any) => {
  const h = m?.payload?.headers as { name: string; value: string }[] | undefined;
  return {
    id: String(m?.id ?? ""),
    thread: String(m?.threadId ?? ""),
    from: header(h, "From"),
    to: header(h, "To"),
    subject: header(h, "Subject"),
    date: header(h, "Date"),
    unread: Array.isArray(m?.labelIds) ? m.labelIds.includes("UNREAD") : null,
    snippet: typeof m?.snippet === "string" ? m.snippet : "",
  };
};

/** The message a reply answers: its thread, and the ids that tie the reply to it. */
async function gmailReplyTo(call: Call, id: string): Promise<{ threadId: string; inReplyTo?: string; references?: string; subject: string }> {
  const { json: m } = await call("GET", `${GMAIL}/messages/${id}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Subject`, undefined, "read");
  const h = m?.payload?.headers;
  return { threadId: String(m?.threadId ?? ""), ...(header(h, "Message-ID") ? { inReplyTo: header(h, "Message-ID")! } : {}), ...(header(h, "References") ? { references: header(h, "References")! } : {}), subject: header(h, "Subject") ?? "" };
}

async function gmailCompose(call: Call, args: Record<string, ArgValue>): Promise<{ raw: string; threadId?: string }> {
  const to = addresses(text(args, "to"), "to");
  const cc = addresses(text(args, "cc"), "cc");
  const reply = text(args, "replyTo") ? await gmailReplyTo(call, messageId({ id: text(args, "replyTo")! })) : null;
  if (!to.length) throw new MailError(400, "who it goes to: give to");
  const subject = text(args, "subject") ?? (reply ? (/^re:/i.test(reply.subject) ? reply.subject : `Re: ${reply.subject}`) : "");
  const body = text(args, "body") ?? "";
  return {
    raw: rawMessage({ to, cc, subject, body, ...(reply?.inReplyTo ? { inReplyTo: reply.inReplyTo } : {}), ...(reply?.references ? { references: reply.references } : {}) }),
    ...(reply?.threadId ? { threadId: reply.threadId } : {}),
  };
}

const run =
  (work: (call: Call, args: Record<string, ArgValue>) => Promise<{ status: number; value: unknown }>): NativeTool =>
  async (manifest, args, send) => {
    const started = performance.now();
    try {
      const { status, value } = await work(caller(manifest, send), args);
      return json(status, value, started);
    } catch (error) {
      if (error instanceof MailError) return json(error.status, { error: error.message }, started);
      throw error;
    }
  };

export const gmailNatives: Record<"gmail.search" | "gmail.read" | "gmail.draft" | "gmail.send" | "gmail.archive" | "gmail.trash", NativeTool> = {
  "gmail.search": run(async (call, args) => {
    const q = text(args, "query") ?? "in:inbox";
    const limit = count(args, "limit", 10, 25);
    const { json: list } = await call("GET", `${GMAIL}/messages?q=${encodeURIComponent(q)}&maxResults=${limit}`, undefined, "read");
    const ids = (Array.isArray(list?.messages) ? list.messages : []).map((m: any) => encodeURIComponent(String(m.id))).slice(0, limit);
    const messages = await Promise.all(
      ids.map(async (id: string) => gmailSummary((await call("GET", `${GMAIL}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`, undefined, "read")).json)),
    );
    return { status: 200, value: { query: q, messages, more: Boolean(list?.nextPageToken) } };
  }),
  "gmail.read": run(async (call, args) => {
    const { json: m } = await call("GET", `${GMAIL}/messages/${messageId(args)}?format=full`, undefined, "read");
    const { body, attachments } = gmailWords(m?.payload ?? {});
    const h = m?.payload?.headers;
    return { status: 200, value: { ...gmailSummary(m), cc: header(h, "Cc"), body, attachments } };
  }),
  "gmail.draft": run(async (call, args) => {
    const message = await gmailCompose(call, args);
    const { json: draft } = await call("POST", `${GMAIL}/drafts`, { message }, "create");
    return { status: 200, value: { draft: String(draft?.id ?? ""), message: String(draft?.message?.id ?? ""), saved: "in your Drafts, unsent" } };
  }),
  "gmail.send": run(async (call, args) => {
    const message = await gmailCompose(call, args);
    const { json: sent } = await call("POST", `${GMAIL}/messages/send`, message, "outward");
    return { status: 200, value: { sent: String(sent?.id ?? ""), thread: String(sent?.threadId ?? "") } };
  }),
  "gmail.archive": run(async (call, args) => {
    await call("POST", `${GMAIL}/messages/${messageId(args)}/modify`, { removeLabelIds: ["INBOX"] }, "modify");
    return { status: 200, value: { archived: text(args, "id"), back: "it's in All Mail; moving it to the inbox brings it back" } };
  }),
  "gmail.trash": run(async (call, args) => {
    await call("POST", `${GMAIL}/messages/${messageId(args)}/trash`, {}, "delete");
    return { status: 200, value: { trashed: text(args, "id"), back: "Gmail keeps it in Trash for 30 days" } };
  }),
};

// ---------- Outlook (Microsoft Graph) ----------

const GRAPH = "/v1.0/me";
const SUMMARY_FIELDS = "id,conversationId,subject,from,toRecipients,receivedDateTime,isRead,bodyPreview";
const person = (r: any): string | null => {
  const e = r?.emailAddress;
  if (!e?.address) return null;
  return e.name && e.name !== e.address ? `${e.name} <${e.address}>` : String(e.address);
};
const people = (list: any): string | null => (Array.isArray(list) && list.length ? list.map(person).filter(Boolean).join(", ") : null);

const outlookSummary = (m: any) => ({
  id: String(m?.id ?? ""),
  thread: String(m?.conversationId ?? ""),
  from: person(m?.from),
  to: people(m?.toRecipients),
  subject: typeof m?.subject === "string" ? m.subject : null,
  date: typeof m?.receivedDateTime === "string" ? m.receivedDateTime : null,
  unread: typeof m?.isRead === "boolean" ? !m.isRead : null,
  snippet: typeof m?.bodyPreview === "string" ? m.bodyPreview : "",
});

const recipients = (list: string[]) => list.map((address) => ({ emailAddress: { address } }));

/** A message as Graph takes it, plain text; a reply goes through createReply, so it stays in its conversation. */
async function outlookCompose(call: Call, args: Record<string, ArgValue>): Promise<{ id: string; draft: boolean }> {
  const to = addresses(text(args, "to"), "to");
  const cc = addresses(text(args, "cc"), "cc");
  if (!to.length) throw new MailError(400, "who it goes to: give to");
  const fields = {
    toRecipients: recipients(to),
    ...(cc.length ? { ccRecipients: recipients(cc) } : {}),
    ...(text(args, "subject") !== undefined ? { subject: text(args, "subject")!.replace(/[\r\n]+/g, " ").slice(0, 500) } : {}),
    body: { contentType: "Text", content: text(args, "body") ?? "" },
  };
  if (text(args, "replyTo")) {
    const { json: reply } = await call("POST", `${GRAPH}/messages/${messageId({ id: text(args, "replyTo")! })}/createReply`, {}, "create");
    const id = encodeURIComponent(String(reply?.id ?? ""));
    await call("PATCH", `${GRAPH}/messages/${id}`, fields, "create");
    return { id, draft: true };
  }
  const { json: draft } = await call("POST", `${GRAPH}/messages`, fields, "create");
  return { id: encodeURIComponent(String(draft?.id ?? "")), draft: true };
}

export const outlookNatives: Record<"outlook.search" | "outlook.read" | "outlook.draft" | "outlook.send" | "outlook.archive" | "outlook.trash", NativeTool> = {
  "outlook.search": run(async (call, args) => {
    const query = text(args, "query");
    const limit = count(args, "limit", 10, 25);
    // Graph's search takes the words quoted; without words, the inbox's latest.
    const path = query
      ? `${GRAPH}/messages?$search=${encodeURIComponent(`"${query.replace(/"/g, "")}"`)}&$top=${limit}&$select=${SUMMARY_FIELDS}`
      : `${GRAPH}/mailFolders/inbox/messages?$top=${limit}&$select=${SUMMARY_FIELDS}&$orderby=receivedDateTime desc`.replace(/ /g, "%20");
    const { json: list } = await call("GET", path, undefined, "read");
    const messages = (Array.isArray(list?.value) ? list.value : []).slice(0, limit).map(outlookSummary);
    return { status: 200, value: { query: query ?? "inbox", messages, more: Boolean(list?.["@odata.nextLink"]) } };
  }),
  "outlook.read": run(async (call, args) => {
    const { json: m } = await call("GET", `${GRAPH}/messages/${messageId(args)}?$select=${SUMMARY_FIELDS},ccRecipients,body,hasAttachments`, undefined, "read", { prefer: 'outlook.body-content-type="text"' });
    const content = typeof m?.body?.content === "string" ? m.body.content : "";
    return { status: 200, value: { ...outlookSummary(m), cc: people(m?.ccRecipients), body: cut(m?.body?.contentType === "html" ? wordsOf(content) : content.trim()), attachments: Boolean(m?.hasAttachments) } };
  }),
  "outlook.draft": run(async (call, args) => {
    const { id } = await outlookCompose(call, args);
    return { status: 200, value: { draft: decodeURIComponent(id), saved: "in your Drafts, unsent" } };
  }),
  "outlook.send": run(async (call, args) => {
    const { id } = await outlookCompose(call, args);
    await call("POST", `${GRAPH}/messages/${id}/send`, {}, "outward");
    return { status: 200, value: { sent: decodeURIComponent(id) } };
  }),
  "outlook.archive": run(async (call, args) => {
    await call("POST", `${GRAPH}/messages/${messageId(args)}/move`, { destinationId: "archive" }, "modify");
    return { status: 200, value: { archived: text(args, "id"), back: "it's in Archive; moving it to the inbox brings it back" } };
  }),
  "outlook.trash": run(async (call, args) => {
    await call("POST", `${GRAPH}/messages/${messageId(args)}/move`, { destinationId: "deleteditems" }, "delete");
    return { status: 200, value: { trashed: text(args, "id"), back: "Outlook keeps it in Deleted Items until that's emptied" } };
  }),
};
