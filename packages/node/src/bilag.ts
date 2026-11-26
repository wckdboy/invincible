import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { Transferred } from "@galahad/brain";

/*
 * Bilag to Google Drive (the owner's word, 18 November 2026: "Yes, automatically"). Each attachment of a mail that a
 * loop's mail wake found (Gmail or Outlook), and that is a bilag by its kind (a PDF, a picture, an XML e-invoice; not
 * a picture set in the mail's own words, not a logo's few kilobytes), is copied as it is into Google Drive:
 * Bilag/<year>/<month>/<date> <sender> – <its name>, the date the mail came, in the loop's time zone.
 *
 * It is the node's own work, and no model is in it. The bytes go from the mail's own API to Drive's, each under its own
 * sign-in and pinned to its own origin (ConnectorService.transfer), and each request is a line in the ledger. Nothing
 * is deleted, sent or moved in the mail. Galahad reads all of your Drive (drive.readonly, your word of 18 November) and
 * writes only files of its own there (drive.file), in folders it made and marked. A file copied once is never copied
 * again: its SHA-256 is kept here, in local.db.
 */

export type Mailbox = "gmail" | "outlook";

/** At most this many mails a run and attachments a mail; an attachment over `bytes` is left (Gmail's own limit is 25 MB). */
export const BILAG_LIMITS = { mails: 50, attachments: 20, bytes: 30 * 2 ** 20 } as const;
export const BILAG_FOLDER = "Bilag";
/** Drive takes this much in one request; more goes in two (a resumable upload). */
const ONE_REQUEST = 5 * 2 ** 20;
const FOLDER = "application/vnd.google-apps.folder";

/** The mail a bilag loop's wakes look for unless you say otherwise: the words of receipts and invoices, in Danish and English. */
export const BILAG_QUERY: Record<Mailbox, string> = {
  gmail: 'has:attachment -in:sent -in:chats (faktura OR kvittering OR bilag OR kreditnota OR ordrebekræftelse OR betalingsbekræftelse OR invoice OR receipt OR "credit note" OR "order confirmation")',
  outlook: "hasAttachments:true AND (faktura OR kvittering OR bilag OR kreditnota OR invoice OR receipt)",
};

/** The connectors' requests, as the node makes them (ConnectorService.transfer). */
export type Transfer = (
  connector: string,
  step: { method: "GET" | "POST" | "PUT" | "PATCH"; path: string; headers?: Record<string, string>; body?: Uint8Array | string; class: "read" | "create" | "modify"; why: string; max: number },
) => Promise<Transferred>;

export interface BilagDeps {
  transfer: Transfer;
  local: Database;
  /** Where a mail's date is read (the loop's time zone). */
  tz: string;
}

export interface BilagReport {
  copied: { name: string; folder: string; link: string | null }[];
  /** Copied before: the same mail's, or the same file another mail carried. */
  already: number;
  /** Attachments that aren't bilag by their kind. */
  skipped: number;
  /** A mail that couldn't be read or copied, and why. */
  failed: string[];
  /** Those mails, as `<mailbox>:<id>`: to be tried again (a loop gives them back; what was copied is never copied twice). */
  left: string[];
}

export interface Attached {
  id: string;
  name: string;
  type: string;
  size: number;
  inline: boolean;
}

const KINDS = new Set(["application/pdf", "application/x-pdf", "image/jpeg", "image/png", "image/heic", "image/heif", "image/webp", "image/tiff", "application/xml", "text/xml"]);
const EXTENSIONS = /\.(pdf|jpe?g|png|heic|heif|webp|tiff?|xml)$/i;

/** Whether an attachment is a bilag by its kind: a document, a picture of one, or an e-invoice; not set in the words, not a logo. */
export function isBilag(a: Attached): boolean {
  if (a.inline || a.size > BILAG_LIMITS.bytes) return false;
  const generic = !a.type || a.type === "application/octet-stream";
  if (!KINDS.has(a.type) && !(generic && EXTENSIONS.test(a.name))) return false;
  // A picture of a few kilobytes is a logo or a signature, not a receipt.
  return !((a.type.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif|tiff?)$/i.test(a.name)) && a.size < 10_000);
}

/** Text fit for a name in Drive: no slashes, quotes or controls, its spaces single, at most `max` characters. */
function clean(text: string, max: number): string {
  // (\u0000-\u001f and \u007f are controls; the rest are what file systems refuse.)
  const plain = text.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
  return plain.length > max ? plain.slice(0, max).trim() : plain;
}

/** Who sent it, in a few words: the name it gives, else its address's domain (faktura@telia.dk → telia.dk). */
export function senderOf(from: string): string {
  const named = /^\s*"?([^"<]*?)"?\s*<([^>]*)>\s*$/.exec(from);
  const name = named?.[1]?.trim();
  if (name) return clean(name, 60);
  const address = (named?.[2] ?? from).trim();
  const domain = /@([^@\s>]+)$/.exec(address)?.[1];
  return clean(domain ?? address, 60) || "unknown";
}

// A mail forwarded, by its subject (Fwd:, Fw:, VS: …) or by the words above the mail it carries. ("Original Message"
// heads a reply's quote as well as a forward, so it is not one of them: a supplier's reply quoting you stays theirs.)
const FORWARDED_SUBJECT = /^\s*(?:fwd?|vs|wg|tr|rv|vb|vidaresend|videresendt)\s*:/i;
const FORWARDED_MARK = /-{2,}\s*(?:forwarded message|videresendt (?:meddelelse|besked|mail)|weitergeleitete nachricht|vidarebefordrat meddelande)\s*-{2,}|^\s*(?:begin forwarded message|start på videresendt (?:besked|meddelelse)|anfang der weitergeleiteten nachricht)\s*:/im;
const FROM_LINE = /^[>\s*]*(?:from|fra|von|från)\s*:\s*\**\s*(.+?)\s*$/gim;

/**
 * Who first sent a mail that was forwarded (you, forwarding a supplier's invoice to yourself): the From line of the mail
 * it carries, as its words show it. Null when it wasn't forwarded, or its words name no address.
 */
export function forwardedFrom(subject: string, text: string): string | null {
  const mark = FORWARDED_MARK.exec(text);
  if (!mark && !FORWARDED_SUBJECT.test(subject)) return null;
  for (const match of (mark ? text.slice(mark.index) : text).matchAll(FROM_LINE)) {
    // (Outlook writes "Name <a@b.dk<mailto:a@b.dk>>" or "Name [mailto:a@b.dk]".)
    const line = match[1]!.replace(/<mailto:[^>]*>/gi, "").replace(/\[mailto:([^\]]+)\]/i, "<$1>").replace(/\*+/g, "").trim();
    if (line.includes("@")) return line;
  }
  return null;
}

/** Where a bilag goes in Drive: its year's and month's folders, and its name (the day it came, who sent it, its own name). */
export function bilagPlace(at: number, tz: string, from: string, name: string): { year: string; month: string; file: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(at)).map((p) => [p.type, p.value]));
  const own = clean(name, 120) || "bilag";
  return { year: parts.year!, month: parts.month!, file: `${parts.year}-${parts.month}-${parts.day} ${senderOf(from)} – ${own}` };
}

const enc = encodeURIComponent;

/** One JSON answer from a connector (refused unless it is a 2xx). */
async function json(deps: BilagDeps, connector: string, path: string, why: string, max = 8 * 2 ** 20, headers?: Record<string, string>): Promise<any> {
  const got = await deps.transfer(connector, { method: "GET", path, class: "read", why, max, ...(headers ? { headers } : {}) });
  return answer(got, connector);
}

function answer(got: Transferred, connector: string): any {
  let parsed: any = null;
  try {
    parsed = JSON.parse(new TextDecoder().decode(got.bytes));
  } catch {
    /* not JSON: the status says enough */
  }
  if (!got.ok) throw new Error(`${connector} answered ${got.status}${parsed?.error?.message ? `: ${String(parsed.error.message).slice(0, 200)}` : ""}`);
  return parsed;
}

interface Mail {
  /** Who sent it, or who first did, when it was forwarded. */
  from: string;
  forwarded: boolean;
  at: number;
  attached: Attached[];
}

type GmailPart = { filename?: string; mimeType?: string; headers?: { name: string; value: string }[]; body?: { attachmentId?: string; size?: number; data?: string }; parts?: GmailPart[] };

/** A Gmail message's own words: its first plain text part, else its HTML's text. */
function gmailText(part: GmailPart | undefined): string {
  let html = "";
  const walk = (p: GmailPart | undefined): string | null => {
    if (!p) return null;
    if (!p.filename && p.body?.data && p.mimeType === "text/plain") return Buffer.from(p.body.data, "base64url").toString("utf8");
    if (!p.filename && p.body?.data && p.mimeType === "text/html" && !html) html = Buffer.from(p.body.data, "base64url").toString("utf8");
    for (const child of p.parts ?? []) {
      const found = walk(child);
      if (found !== null) return found;
    }
    return null;
  };
  return walk(part) ?? htmlText(html);
}

const htmlText = (html: string): string =>
  html.replace(/<(br|\/p|\/div|\/tr)\b[^>]*>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ");
const header = (headers: { name: string; value: string }[] | undefined, name: string): string | null => headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;

/** A Gmail message's sender, when it came, and what it carries: every part with a name and an attachment's id. */
export function gmailAttached(message: { internalDate?: string; payload?: GmailPart }): Mail {
  const attached: Attached[] = [];
  const walk = (part: GmailPart | undefined): void => {
    if (!part) return;
    if (part.filename && part.body?.attachmentId) {
      const disposition = header(part.headers, "Content-Disposition") ?? "";
      const type = (part.mimeType ?? "").toLowerCase();
      // A picture set in the mail's words has a Content-ID and no "attachment" of its own.
      const inline = /^\s*inline/i.test(disposition) || (!!header(part.headers, "Content-ID") && type.startsWith("image/") && !/^\s*attachment/i.test(disposition));
      attached.push({ id: part.body.attachmentId, name: part.filename, type, size: part.body.size ?? 0, inline });
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(message.payload);
  const first = forwardedFrom(header(message.payload?.headers, "Subject") ?? "", gmailText(message.payload));
  return { from: first ?? header(message.payload?.headers, "From") ?? "", forwarded: first !== null, at: Number(message.internalDate) || 0, attached };
}

/** An Outlook message's sender, when it came, and its file attachments (an item or a link attached is no file). */
export function outlookAttached(message: { from?: { emailAddress?: { name?: string; address?: string } }; receivedDateTime?: string; subject?: string; body?: { contentType?: string; content?: string } }, list: { value?: Record<string, unknown>[] }): Mail {
  const who = message.from?.emailAddress;
  const sender = who?.name && who.address ? `${who.name} <${who.address}>` : (who?.address ?? who?.name ?? "");
  const words = message.body?.contentType === "html" ? htmlText(message.body.content ?? "") : (message.body?.content ?? "");
  const first = forwardedFrom(message.subject ?? "", words);
  const attached = (list.value ?? [])
    .filter((a) => a["@odata.type"] === "#microsoft.graph.fileAttachment" && typeof a.id === "string" && typeof a.name === "string")
    .map((a) => ({ id: a.id as string, name: a.name as string, type: String(a.contentType ?? "").toLowerCase(), size: Number(a.size) || 0, inline: a.isInline === true }));
  return { from: first ?? sender, forwarded: first !== null, at: Date.parse(message.receivedDateTime ?? "") || 0, attached };
}

async function readMail(deps: BilagDeps, mailbox: Mailbox, id: string): Promise<Mail> {
  if (mailbox === "gmail") return gmailAttached(await json(deps, "gmail", `/gmail/v1/users/me/messages/${enc(id)}?format=full`, "read what a mail carries (bilag)"));
  // (Its words as text, to know who first sent a mail that was forwarded.)
  const message = await json(deps, "outlook", `/v1.0/me/messages/${enc(id)}?$select=from,receivedDateTime,subject,body`, "read who sent a mail (bilag)", 8 * 2 ** 20, { prefer: 'outlook.body-content-type="text"' });
  const list = await json(deps, "outlook", `/v1.0/me/messages/${enc(id)}/attachments?$select=id,name,contentType,size,isInline`, "read what a mail carries (bilag)");
  return outlookAttached(message, list);
}

async function bytesOf(deps: BilagDeps, mailbox: Mailbox, message: string, a: Attached): Promise<Uint8Array> {
  if (mailbox === "gmail") {
    // (Gmail answers with JSON: the bytes in base64url, a third more than the file.)
    const got = await json(deps, "gmail", `/gmail/v1/users/me/messages/${enc(message)}/attachments/${enc(a.id)}`, `copy a bilag: ${a.name}`, Math.ceil(BILAG_LIMITS.bytes * 1.4) + 4096);
    return new Uint8Array(Buffer.from(String(got?.data ?? ""), "base64url"));
  }
  const got = await deps.transfer("outlook", { method: "GET", path: `/v1.0/me/messages/${enc(message)}/attachments/${enc(a.id)}/$value`, class: "read", why: `copy a bilag: ${a.name}`, max: BILAG_LIMITS.bytes });
  if (!got.ok) throw new Error(`outlook answered ${got.status}`);
  return got.bytes;
}

function tables(local: Database): void {
  local.exec("CREATE TABLE IF NOT EXISTS bilag_copied (sha256 TEXT PRIMARY KEY, file TEXT NOT NULL, name TEXT NOT NULL, link TEXT, at INTEGER NOT NULL)");
  // A mail's attachment read before (by its mail, name and size: Gmail's attachment ids change from one read to the next).
  local.exec("CREATE TABLE IF NOT EXISTS bilag_seen (part TEXT PRIMARY KEY, sha256 TEXT NOT NULL, at INTEGER NOT NULL)");
  local.exec("CREATE TABLE IF NOT EXISTS bilag_folders (path TEXT PRIMARY KEY, id TEXT NOT NULL)");
}

/** A folder of Galahad's own in Drive, by its path from My Drive (made where it isn't there yet), as Drive names it. */
async function folderOf(deps: BilagDeps, path: string[]): Promise<string> {
  let parent = "root";
  let at = "";
  for (const name of path) {
    at = at ? `${at}/${name}` : name;
    const known = deps.local.query<{ id: string }, [string]>("SELECT id FROM bilag_folders WHERE path = ?").get(at)?.id;
    if (known) {
      parent = known;
      continue;
    }
    // (Found again if a node was set up again. Galahad reads all of your Drive but writes only in what it made, so a
    // folder is its own by the mark it put on it, which only it can see: a folder of yours of the same name is left alone.)
    const q = `name = '${name.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' and mimeType = '${FOLDER}' and '${parent}' in parents and appProperties has { key='galahad' and value='bilag' } and trashed = false`;
    const found = await json(deps, "gdrive", `/drive/v3/files?q=${enc(q)}&fields=${enc("files(id)")}&pageSize=1&spaces=drive`, "find the bilag folder", 1 << 20);
    let id: unknown = found?.files?.[0]?.id;
    if (typeof id !== "string") {
      const made = await deps.transfer("gdrive", { method: "POST", path: "/drive/v3/files?fields=id", headers: { "content-type": "application/json; charset=UTF-8" }, body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent], appProperties: { galahad: "bilag" } }), class: "create", why: `make the bilag folder ${at}`, max: 1 << 20 });
      id = answer(made, "gdrive")?.id;
    }
    if (typeof id !== "string" || !id) throw new Error(`gdrive gave no folder for ${at}`);
    deps.local.query("INSERT OR REPLACE INTO bilag_folders (path, id) VALUES (?, ?)").run(at, id);
    parent = id;
  }
  return parent;
}

/** One file into a folder of Drive's: in one request up to 5 MB, else a resumable upload's two. Its id and link. */
async function upload(deps: BilagDeps, parent: string, name: string, type: string, bytes: Uint8Array, sha: string): Promise<{ id: string; link: string | null }> {
  const meta = JSON.stringify({ name, parents: [parent], appProperties: { galahad: "bilag", sha256: sha } });
  const kind = type || "application/octet-stream";
  let got: Transferred;
  if (bytes.length <= ONE_REQUEST) {
    const boundary = `galahad-${sha.slice(0, 32)}`;
    const body = Buffer.concat([Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\ncontent-type: ${kind}\r\n\r\n`), Buffer.from(bytes), Buffer.from(`\r\n--${boundary}--\r\n`)]);
    got = await deps.transfer("gdrive", { method: "POST", path: "/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink", headers: { "content-type": `multipart/related; boundary=${boundary}` }, body: new Uint8Array(body), class: "create", why: `copy a bilag: ${name}`, max: 1 << 20 });
  } else {
    const opened = await deps.transfer("gdrive", { method: "POST", path: "/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink", headers: { "content-type": "application/json; charset=UTF-8", "x-upload-content-type": kind, "x-upload-content-length": String(bytes.length) }, body: meta, class: "create", why: `copy a bilag: ${name} (where its bytes go)`, max: 1 << 20 });
    if (!opened.ok || !opened.location) throw new Error(`gdrive answered ${opened.status} and gave no address for the bytes`);
    // (The address is Drive's own, on the same origin, or transfer refuses it.)
    got = await deps.transfer("gdrive", { method: "PUT", path: opened.location, headers: { "content-type": kind }, body: bytes, class: "create", why: `copy a bilag: ${name}`, max: 1 << 20 });
  }
  const made = answer(got, "gdrive");
  if (typeof made?.id !== "string") throw new Error("gdrive gave no file");
  return { id: made.id, link: typeof made.webViewLink === "string" ? made.webViewLink : null };
}

/** The bilag of these mails, copied to Drive; what came of each said. A mail that fails doesn't stop the rest. */
export async function copyBilag(deps: BilagDeps, mails: readonly { mailbox: Mailbox; id: string }[], folder = BILAG_FOLDER): Promise<BilagReport> {
  tables(deps.local);
  const report: BilagReport = { copied: [], already: 0, skipped: 0, failed: [], left: [] };
  const seen = deps.local.query<{ sha256: string }, [string]>("SELECT sha256 FROM bilag_seen WHERE part = ?");
  const copied = deps.local.query<{ file: string }, [string]>("SELECT file FROM bilag_copied WHERE sha256 = ?");
  const mark = deps.local.query("INSERT OR REPLACE INTO bilag_seen (part, sha256, at) VALUES (?, ?, ?)");
  for (const mail of mails.slice(0, BILAG_LIMITS.mails)) {
    try {
      const read = await readMail(deps, mail.mailbox, mail.id);
      for (const a of read.attached.slice(0, BILAG_LIMITS.attachments)) {
        if (!isBilag(a)) {
          report.skipped += 1;
          continue;
        }
        const part = `${mail.mailbox}:${mail.id}:${a.name}:${a.size}`;
        if (seen.get(part)) {
          report.already += 1;
          continue;
        }
        const bytes = await bytesOf(deps, mail.mailbox, mail.id, a);
        const sha = createHash("sha256").update(bytes).digest("hex");
        if (copied.get(sha)) {
          mark.run(part, sha, Date.now());
          report.already += 1;
          continue;
        }
        const place = bilagPlace(read.at || Date.now(), deps.tz, read.from, a.name);
        const path = [folder, place.year, place.month];
        let made: { id: string; link: string | null };
        try {
          made = await upload(deps, await folderOf(deps, path), place.file, a.type, bytes, sha);
        } catch (error) {
          // A folder you removed from Drive: made again, once.
          if (!/answered 404/.test((error as Error).message)) throw error;
          deps.local.query("DELETE FROM bilag_folders WHERE path LIKE ?").run(`${folder}%`);
          made = await upload(deps, await folderOf(deps, path), place.file, a.type, bytes, sha);
        }
        deps.local.query("INSERT OR REPLACE INTO bilag_copied (sha256, file, name, link, at) VALUES (?, ?, ?, ?, ?)").run(sha, made.id, place.file, made.link, Date.now());
        mark.run(part, sha, Date.now());
        report.copied.push({ name: place.file, folder: path.join("/"), link: made.link });
      }
    } catch (error) {
      report.failed.push(`${mail.mailbox} ${mail.id.slice(0, 12)}…: ${String((error as Error).message ?? error).slice(0, 200)}`);
      report.left.push(`${mail.mailbox}:${mail.id}`);
    }
  }
  return report;
}

/**
 * The mail a search finds, for copying what came before a loop's wakes (`galahad bilag copy`): up to `limit` ids, newest
 * first, and where the search goes on (`next`, for the next call; none when it's done).
 */
export async function findMail(deps: BilagDeps, mailbox: Mailbox, query: string, limit: number, page?: string): Promise<{ ids: string[]; next: string | null }> {
  if (mailbox === "gmail") {
    const got = await json(deps, "gmail", `/gmail/v1/users/me/messages?q=${enc(query)}&maxResults=${Math.min(100, limit)}${page ? `&pageToken=${enc(page)}` : ""}`, "find mail with bilag");
    const ids = (got?.messages ?? []).flatMap((m: { id?: unknown }) => (typeof m?.id === "string" ? [m.id] : []));
    return { ids, next: typeof got?.nextPageToken === "string" && got.nextPageToken ? got.nextPageToken : null };
  }
  // (Graph's next page is a whole address on its own origin; transfer refuses one anywhere else.)
  const at = page ?? `/v1.0/me/messages?$search=${enc(`"${query.replace(/"/g, "")}"`)}&$top=${Math.min(50, limit)}&$select=id`;
  const got = await json(deps, "outlook", at, "find mail with bilag");
  const ids = (got?.value ?? []).flatMap((m: { id?: unknown }) => (typeof m?.id === "string" ? [m.id] : []));
  return { ids, next: typeof got?.["@odata.nextLink"] === "string" ? got["@odata.nextLink"] : null };
}

/**
 * Copies made before a forwarded mail was named for who first sent it: each one's mail read again and, where it was
 * forwarded, the copy given that sender's name in Drive, its day and its own name as they were. Only Galahad's own
 * files are renamed, and nothing else about them changes.
 */
export async function renameForwarded(deps: BilagDeps): Promise<{ renamed: { from: string; to: string }[]; failed: string[] }> {
  tables(deps.local);
  const rows = deps.local.query<{ sha256: string; file: string; name: string }, []>("SELECT sha256, file, name FROM bilag_copied ORDER BY at").all();
  const partOf = deps.local.query<{ part: string }, [string]>("SELECT part FROM bilag_seen WHERE sha256 = ? ORDER BY at LIMIT 1");
  const mails = new Map<string, Promise<Mail>>();
  const done = { renamed: [] as { from: string; to: string }[], failed: [] as string[] };
  for (const row of rows) {
    const at = /^(gmail|outlook):([^:]+):/.exec(partOf.get(row.sha256)?.part ?? "");
    const split = row.name.indexOf(" – ");
    if (!at || split < 11) continue;
    try {
      const key = `${at[1]}:${at[2]}`;
      if (!mails.has(key)) mails.set(key, readMail(deps, at[1] as Mailbox, at[2]!));
      const mail = await mails.get(key)!;
      if (!mail.forwarded) continue;
      const name = `${row.name.slice(0, 10)} ${senderOf(mail.from)}${row.name.slice(split)}`;
      if (name === row.name) continue;
      answer(await deps.transfer("gdrive", { method: "PATCH", path: `/drive/v3/files/${enc(row.file)}?fields=id,name`, headers: { "content-type": "application/json; charset=UTF-8" }, body: JSON.stringify({ name }), class: "modify", why: `name a bilag for who first sent it: ${name}`, max: 1 << 20 }), "gdrive");
      deps.local.query("UPDATE bilag_copied SET name = ? WHERE sha256 = ?").run(name, row.sha256);
      done.renamed.push({ from: row.name, to: name });
    } catch (error) {
      done.failed.push(`${row.name}: ${String((error as Error).message ?? error).slice(0, 200)}`);
    }
  }
  return done;
}

/** Bilag from a mailbox's mail as a search finds it, a batch a call, and what has been copied: the CLI's `galahad bilag`. */
export class BilagService {
  constructor(private readonly d: { transfer: Transfer; local: Database; tz: () => string }) {}

  async copy(input: { from: Mailbox; query?: string | undefined; limit?: number | undefined; page?: string | undefined; folder?: string | undefined }): Promise<BilagReport & { found: number; next: string | null }> {
    const deps = { transfer: this.d.transfer, local: this.d.local, tz: this.d.tz() };
    const found = await findMail(deps, input.from, input.query ?? BILAG_QUERY[input.from], Math.min(input.limit ?? 50, BILAG_LIMITS.mails), input.page);
    const report = await copyBilag(deps, found.ids.map((id) => ({ mailbox: input.from, id })), input.folder);
    return { ...report, found: found.ids.length, next: found.next };
  }

  /** Copies of forwarded mail named for who first sent it (renameForwarded). */
  names(): Promise<{ renamed: { from: string; to: string }[]; failed: string[] }> {
    return renameForwarded({ transfer: this.d.transfer, local: this.d.local, tz: this.d.tz() });
  }

  status(limit = 10): { copied: number; latest: { name: string; link: string | null; at: number }[] } {
    tables(this.d.local);
    const copied = this.d.local.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM bilag_copied").get()!.n;
    const latest = this.d.local.query<{ name: string; link: string | null; at: number }, [number]>("SELECT name, link, at FROM bilag_copied ORDER BY at DESC LIMIT ?").all(limit);
    return { copied, latest };
  }
}

/** A run's report in a sentence or two, for its record. */
export function bilagSummary(report: BilagReport): string {
  const said: string[] = [];
  if (report.copied.length) said.push(`Copied ${report.copied.length} bilag to Drive: ${report.copied.slice(0, 5).map((c) => `${c.folder}/${c.name}`).join("; ")}${report.copied.length > 5 ? `; and ${report.copied.length - 5} more` : ""}.`);
  if (report.already) said.push(`${report.already} copied before.`);
  if (report.skipped) said.push(`${report.skipped} attachment${report.skipped === 1 ? " isn't a bilag" : "s aren't bilag"} by their kind.`);
  if (report.failed.length) said.push(`Couldn't copy ${report.failed.length === 1 ? "one mail's" : `${report.failed.length} mails'`}: ${report.failed.slice(0, 3).join("; ")}.`);
  return (said.join(" ") || "No bilag in this mail.").slice(0, 2000);
}
