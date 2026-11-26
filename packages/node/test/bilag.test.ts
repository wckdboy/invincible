import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { LoopWake } from "@galahad/core";
import type { Transferred } from "@galahad/brain";
import { BILAG_QUERY, bilagPlace, bilagSummary, copyBilag, findMail, forwardedFrom, isBilag, renameForwarded, senderOf, type Transfer } from "../src/bilag.ts";
import { loopExecutor, type LoopTaskDeps } from "../src/loop-tasks.ts";
import type { RunnableLoop } from "../src/loops.ts";

/*
 * Bilag to Google Drive (bilag.ts): what counts as one, where it goes and under what name, and the copying itself,
 * from Gmail and Outlook into Drive, once, with a stand-in for all three services at the node's transfer.
 */

const ok = (value: unknown, extra: Partial<Transferred> = {}): Transferred => ({ ok: true, status: 200, contentType: "application/json", location: null, bytes: new TextEncoder().encode(JSON.stringify(value)), ...extra });
const raw = (bytes: Uint8Array): Transferred => ({ ok: true, status: 200, contentType: "application/pdf", location: null, bytes });
const pdf = (text: string) => new TextEncoder().encode(`%PDF-1.7 ${text}`);
// 18 November 2026, 23:30 UTC: 19 November in Copenhagen.
const LATE = Date.UTC(2026, 10, 18, 23, 30);

function services() {
  const calls: { connector: string; method: string; path: string; class: string; body?: Uint8Array | string; headers?: Record<string, string> }[] = [];
  const files: { name: string; parents: string[]; bytes: number }[] = [];
  const folders = new Map<string, string>();
  const marks: unknown[] = [];
  // Your own folders, by where they are: Galahad reads them (drive.readonly) and may write in none (drive.file).
  const yours = new Map<string, string>();
  const notYours = (id: string) => ({ ...ok({ error: { message: `The user has not granted the app 123 write access to the file ${id}.` } }), ok: false, status: 403 });
  let next = 0;
  let goneFolders = false;
  const renames: { file: string; name: string }[] = [];
  const gmail: Record<string, { from: string; at: number; subject?: string; text?: string; parts: { name: string; type: string; size: number; data?: Uint8Array; inline?: boolean }[] }> = {};
  const outlook: Record<string, { from: { name: string; address: string }; at: string; subject?: string; text?: string; attachments: { id: string; name: string; type: string; size: number; data?: Uint8Array; inline?: boolean; item?: boolean }[] }> = {};
  const transfer: Transfer = async (connector, step) => {
    calls.push({ connector, method: step.method, path: step.path, class: step.class, ...(step.body === undefined ? {} : { body: step.body }), ...(step.headers ? { headers: step.headers } : {}) });
    const url = new URL(step.path, "https://example.test");
    if (connector === "gmail") {
      const m = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)(?:\/attachments\/(.+))?$/.exec(url.pathname);
      if (url.pathname === "/gmail/v1/users/me/messages") return ok(url.searchParams.get("pageToken") ? { messages: [{ id: "g3" }] } : { messages: [{ id: "g1" }, { id: "g2" }], nextPageToken: "p2" });
      const mail = gmail[decodeURIComponent(m?.[1] ?? "")];
      if (!mail) return { ...ok({ error: { message: "Requested entity was not found." } }), ok: false, status: 404 };
      if (m?.[2]) {
        const part = mail.parts.find((p) => `att-${p.name}` === decodeURIComponent(m[2]!));
        return ok({ size: part!.size, data: Buffer.from(part!.data ?? new Uint8Array(part!.size)).toString("base64url") });
      }
      return ok({
        internalDate: String(mail.at),
        payload: {
          headers: [{ name: "From", value: mail.from }, ...(mail.subject ? [{ name: "Subject", value: mail.subject }] : [])],
          parts: [
            { mimeType: "text/plain", body: { size: 40, ...(mail.text ? { data: Buffer.from(mail.text).toString("base64url") } : {}) } },
            ...mail.parts.map((p) => ({ filename: p.name, mimeType: p.type, headers: p.inline ? [{ name: "Content-Disposition", value: "inline" }, { name: "Content-ID", value: "<logo>" }] : [{ name: "Content-Disposition", value: `attachment; filename="${p.name}"` }], body: { attachmentId: `att-${p.name}`, size: p.size } })),
          ],
        },
      });
    }
    if (connector === "outlook") {
      if (url.pathname === "/v1.0/me/messages") return ok({ value: [{ id: "o1" }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=2" });
      const m = /^\/v1\.0\/me\/messages\/([^/]+)(\/attachments)?(?:\/([^/]+)\/\$value)?$/.exec(url.pathname);
      const mail = outlook[decodeURIComponent(m?.[1] ?? "")]!;
      if (m?.[3]) return raw(mail.attachments.find((a) => a.id === decodeURIComponent(m[3]!))!.data!);
      if (m?.[2]) return ok({ value: mail.attachments.map((a) => ({ "@odata.type": a.item ? "#microsoft.graph.itemAttachment" : "#microsoft.graph.fileAttachment", id: a.id, name: a.name, contentType: a.type, size: a.size, isInline: a.inline === true })) });
      return ok({ from: { emailAddress: mail.from }, receivedDateTime: mail.at, ...(mail.subject ? { subject: mail.subject } : {}), ...(mail.text ? { body: { contentType: "text", content: mail.text } } : {}) });
    }
    // Drive: all of it to read, yours as well as Galahad's own; only a folder it made carries its mark.
    if (url.pathname === "/drive/v3/files" && step.method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      const name = /name = '([^']*)'/.exec(q)?.[1];
      const parent = /'([^']*)' in parents/.exec(q)?.[1];
      const own = q.includes("appProperties has { key='galahad' and value='bilag' }");
      const id = own ? folders.get(`${parent}/${name}`) : (yours.get(`${parent}/${name}`) ?? folders.get(`${parent}/${name}`));
      return ok({ files: id ? [{ id }] : [] });
    }
    if (url.pathname === "/drive/v3/files" && step.method === "POST") {
      const meta = JSON.parse(String(step.body)) as { name: string; parents: string[]; appProperties?: unknown };
      if (meta.parents[0]?.startsWith("yours-")) return notYours(meta.parents[0]);
      marks.push(meta.appProperties);
      const id = `folder-${++next}`;
      folders.set(`${meta.parents[0]}/${meta.name}`, id);
      return ok({ id });
    }
    if (url.pathname.startsWith("/drive/v3/files/") && step.method === "PATCH") {
      const name = (JSON.parse(String(step.body)) as { name: string }).name;
      renames.push({ file: decodeURIComponent(url.pathname.slice("/drive/v3/files/".length)), name });
      return ok({ id: "renamed", name });
    }
    if (url.pathname === "/upload/drive/v3/files" && url.searchParams.get("uploadType") === "resumable") return ok({}, { location: "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=u1" });
    if (url.pathname === "/upload/drive/v3/files") {
      if (goneFolders) {
        goneFolders = false;
        folders.clear();
        return { ...ok({ error: { message: "File not found: folder-1." } }), ok: false, status: 404 };
      }
      const body = step.body instanceof Uint8Array ? new TextDecoder().decode(step.body) : String(step.body);
      const meta = step.method === "PUT" ? { name: "(resumed)", parents: ["?"] } : (JSON.parse(/\r\n\r\n(\{.*?\})\r\n--/s.exec(body)![1]!) as { name: string; parents: string[] });
      if (meta.parents[0]?.startsWith("yours-")) return notYours(meta.parents[0]);
      files.push({ name: meta.name, parents: meta.parents, bytes: step.body instanceof Uint8Array ? step.body.length : body.length });
      return ok({ id: `file-${++next}`, webViewLink: `https://drive.google.com/file/d/file-${next}/view` });
    }
    throw new Error(`no stand-in for ${connector} ${step.method} ${step.path}`);
  };
  const deps = { transfer, local: new Database(":memory:"), tz: "Europe/Copenhagen" };
  return { deps, calls, files, folders, marks, yours, renames, gmail, outlook, loseFolders: () => void (goneFolders = true) };
}

describe("what is a bilag, and where it goes", () => {
  const a = (name: string, type: string, size: number, inline = false) => ({ id: "x", name, type, size, inline });

  test("a document, a picture of one or an e-invoice; not a picture set in the mail, nor a logo's few kilobytes, nor a file too big", () => {
    expect(isBilag(a("Faktura 2026-118.pdf", "application/pdf", 80_000))).toBe(true);
    expect(isBilag(a("kvittering.jpg", "image/jpeg", 900_000))).toBe(true);
    expect(isBilag(a("invoice.xml", "application/xml", 12_000))).toBe(true);
    expect(isBilag(a("scan.pdf", "application/octet-stream", 50_000))).toBe(true);
    expect(isBilag(a("logo.png", "image/png", 3_000))).toBe(false);
    expect(isBilag(a("banner.png", "image/png", 200_000, true))).toBe(false);
    expect(isBilag(a("contract.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", 40_000))).toBe(false);
    expect(isBilag(a("huge.pdf", "application/pdf", 31 * 2 ** 20))).toBe(false);
  });

  test("its folder by the year and month it came, in your time zone; its name the day, who sent it and its own name, made safe for a name", () => {
    expect(senderOf('"Telia Danmark" <faktura@telia.dk>')).toBe("Telia Danmark");
    expect(senderOf("faktura@telia.dk")).toBe("telia.dk");
    expect(senderOf("<no-reply@billing.example>")).toBe("billing.example");
    expect(bilagPlace(LATE, "Europe/Copenhagen", "Telia <faktura@telia.dk>", "Faktura 11/2026.pdf")).toEqual({ year: "2026", month: "11", file: "2026-11-19 Telia – Faktura 11 2026.pdf" });
    expect(bilagPlace(LATE, "UTC", "faktura@telia.dk", "f.pdf").file).toBe("2026-11-18 telia.dk – f.pdf");
  });

  test("who first sent a forwarded mail: its From line, in Gmail's, Outlook's and Apple's words, English or Danish; none when it wasn't forwarded", () => {
    expect(forwardedFrom("Fwd: Faktura", "---------- Forwarded message ---------\nFrom: Telenor <faktura@telenor.dk>\nDate: Mon")).toBe("Telenor <faktura@telenor.dk>");
    expect(forwardedFrom("Faktura", "Se her.\n---------- Videresendt meddelelse ---------\nFra: Telenor <faktura@telenor.dk>\n")).toBe("Telenor <faktura@telenor.dk>");
    expect(forwardedFrom("VS: Faktura", "________________________________\nFra: Hetzner <billing@hetzner.com<mailto:billing@hetzner.com>>\nSendt: 17. nov")).toBe("Hetzner <billing@hetzner.com>");
    expect(forwardedFrom("FW: Invoice", "From: Stripe [mailto:receipts@stripe.com]\nSent: Monday")).toBe("Stripe <receipts@stripe.com>");
    expect(forwardedFrom("Faktura", "Begin forwarded message:\n\nFrom: *Topaz Labs* <billing@topazlabs.com>\n")).toBe("Topaz Labs <billing@topazlabs.com>");
    // Not forwarded: a From line in the words is just words, and a reply's quote of yours leaves it the sender's.
    expect(forwardedFrom("Din regning", "From: someone@else.dk wrote about it")).toBeNull();
    expect(forwardedFrom("RE: Faktura", "Her er fakturaen.\n\n-----Original Message-----\nFrom: Kim <kim@example.com>\nSent: Monday")).toBeNull();
    expect(forwardedFrom("FW: Faktura", "-----Original Message-----\nFrom: Telenor <faktura@telenor.dk>\nSent: Monday")).toBe("Telenor <faktura@telenor.dk>");
    // Forwarded, but naming no one with an address: who sent it stands.
    expect(forwardedFrom("Fwd: kvittering", "From: the shop\n")).toBeNull();
  });

  test("the words a bilag loop wakes on fit a mail wake, for both mailboxes", () => {
    for (const connector of ["gmail", "outlook"] as const) expect(LoopWake.safeParse({ kind: "mail", connector, query: BILAG_QUERY[connector] }).success).toBe(true);
  });
});

describe("copying them", () => {
  test("from Gmail: each bilag as it is into Bilag/<year>/<month>, its folders made once; the mail's words and its logo stay; nothing else is asked of the mail", async () => {
    const s = services();
    s.gmail.g1 = { from: '"Telia" <faktura@telia.dk>', at: LATE, parts: [{ name: "Faktura.pdf", type: "application/pdf", size: 40_000, data: pdf("telia") }, { name: "logo.png", type: "image/png", size: 2_000 }, { name: "banner.png", type: "image/png", size: 90_000, inline: true }] };
    const report = await copyBilag(s.deps, [{ mailbox: "gmail", id: "g1" }]);
    expect(report).toMatchObject({ already: 0, skipped: 2, failed: [] });
    expect(report.copied).toEqual([{ name: "2026-11-19 Telia – Faktura.pdf", folder: "Bilag/2026/11", link: "https://drive.google.com/file/d/file-4/view" }]);
    expect(s.files).toEqual([{ name: "2026-11-19 Telia – Faktura.pdf", parents: ["folder-3"], bytes: expect.any(Number) }]);
    expect([...s.folders.keys()]).toEqual(["root/Bilag", "folder-1/2026", "folder-2/11"]);
    // Of the mail, only reads; of Drive, only reads and new files.
    expect(s.calls.filter((c) => c.connector === "gmail").every((c) => c.method === "GET" && c.class === "read")).toBe(true);
    expect(s.calls.filter((c) => c.connector === "gdrive" && c.method !== "GET").every((c) => c.class === "create")).toBe(true);
    // What went to Drive is the file as it came, its SHA-256 on it.
    const upload = s.calls.find((c) => c.path.startsWith("/upload/"))!;
    expect(new TextDecoder().decode(upload.body as Uint8Array)).toContain("%PDF-1.7 telia");
    expect(new TextDecoder().decode(upload.body as Uint8Array)).toContain('"appProperties":{"galahad":"bilag","sha256":"');
    expect(bilagSummary(report)).toBe("Copied 1 bilag to Drive: Bilag/2026/11/2026-11-19 Telia – Faktura.pdf. 2 attachments aren't bilag by their kind.");
  });

  test("once: the same mail again reads nothing more, and the same file in another mail goes nowhere twice", async () => {
    const s = services();
    const bytes = pdf("same invoice");
    s.gmail.g1 = { from: "a@shop.dk", at: LATE, parts: [{ name: "inv.pdf", type: "application/pdf", size: bytes.length, data: bytes }] };
    s.gmail.g2 = { from: "b@shop.dk", at: LATE, parts: [{ name: "copy.pdf", type: "application/pdf", size: bytes.length, data: bytes }] };
    await copyBilag(s.deps, [{ mailbox: "gmail", id: "g1" }]);
    const before = s.calls.length;
    const again = await copyBilag(s.deps, [{ mailbox: "gmail", id: "g1" }, { mailbox: "gmail", id: "g2" }]);
    expect(again).toMatchObject({ copied: [], already: 2 });
    expect(s.files).toHaveLength(1);
    // The first mail: its list read again, its bytes not; the second's bytes read once, to know them.
    expect(s.calls.slice(before).filter((c) => c.path.includes("/attachments/")).map((c) => c.path)).toEqual(["/gmail/v1/users/me/messages/g2/attachments/att-copy.pdf"]);
  });

  test("from Outlook: its file attachments, read as they are; an attached mail or a picture in the words stays", async () => {
    const s = services();
    s.outlook["AAMk=1"] = { from: { name: "Danske Bank", address: "noreply@danskebank.dk" }, at: "2026-11-18T09:00:00Z", attachments: [{ id: "a1", name: "Kontoudtog.pdf", type: "application/pdf", size: 30_000, data: pdf("statement") }, { id: "a2", name: "fwd", type: "message/rfc822", size: 5_000, item: true }, { id: "a3", name: "sig.png", type: "image/png", size: 50_000, inline: true }] };
    const report = await copyBilag(s.deps, [{ mailbox: "outlook", id: "AAMk=1" }]);
    expect(report.copied.map((c) => c.name)).toEqual(["2026-11-18 Danske Bank – Kontoudtog.pdf"]);
    expect(report.skipped).toBe(1);
    expect(s.calls.find((c) => c.path.endsWith("/$value"))!.path).toBe("/v1.0/me/messages/AAMk%3D1/attachments/a1/$value");
  });

  test("a file over 5 MB goes in a resumable upload, at the address Drive gives; a folder you removed is made again, once", async () => {
    const s = services();
    s.gmail.big = { from: "scan@office.dk", at: LATE, parts: [{ name: "scan.pdf", type: "application/pdf", size: 6 * 2 ** 20 }] };
    s.gmail.small = { from: "x@y.dk", at: LATE, parts: [{ name: "r.pdf", type: "application/pdf", size: 20_000, data: pdf("r") }] };
    await copyBilag(s.deps, [{ mailbox: "gmail", id: "big" }]);
    const put = s.calls.find((c) => c.method === "PUT")!;
    expect(put.path).toBe("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=u1");
    expect((put.body as Uint8Array).length).toBe(6 * 2 ** 20);
    s.loseFolders();
    const report = await copyBilag(s.deps, [{ mailbox: "gmail", id: "small" }]);
    expect(report.copied).toHaveLength(1);
    expect(report.failed).toEqual([]);
  });

  test("a Bilag folder of your own is left as it is: Galahad reads all of your Drive, but writes only in folders it made, known by its mark", async () => {
    const s = services();
    s.yours.set("root/Bilag", "yours-1");
    s.yours.set("yours-1/2026", "yours-2");
    s.gmail.g1 = { from: '"Telia" <faktura@telia.dk>', at: LATE, parts: [{ name: "Faktura.pdf", type: "application/pdf", size: 40_000, data: pdf("telia") }] };
    const report = await copyBilag(s.deps, [{ mailbox: "gmail", id: "g1" }]);
    expect(report.failed).toEqual([]);
    expect(report.copied.map((c) => c.folder)).toEqual(["Bilag/2026/11"]);
    expect(s.files.map((f) => f.parents)).toEqual([["folder-3"]]);
    expect([...s.folders.keys()]).toEqual(["root/Bilag", "folder-1/2026", "folder-2/11"]);
    expect(s.marks).toEqual([{ galahad: "bilag" }, { galahad: "bilag" }, { galahad: "bilag" }]);
  });

  test("a mail you forwarded is named for who first sent it, from Gmail or Outlook; one you didn't, for who sent it", async () => {
    const s = services();
    s.gmail.g1 = { from: "Kim <kim@example.com>", at: LATE, subject: "Fwd: Din faktura", text: "Til bogføring.\n\n---------- Forwarded message ---------\nFrom: Telenor <faktura@telenor.dk>\nDate: Wed, Nov 18, 2026\nSubject: Din faktura\n", parts: [{ name: "Faktura.pdf", type: "application/pdf", size: 40_000, data: pdf("telenor") }] };
    s.outlook.o1 = { from: { name: "Kim", address: "kim@example.com" }, at: "2026-11-18T09:00:00Z", subject: "VS: Kvittering", text: "________________________________\nFra: Hetzner Online GmbH <billing@hetzner.com>\nSendt: 17. november 2026\nEmne: Kvittering\n", attachments: [{ id: "a1", name: "Invoice.pdf", type: "application/pdf", size: 30_000, data: pdf("hetzner") }] };
    s.gmail.g2 = { from: '"Telia" <faktura@telia.dk>', at: LATE, subject: "Din regning", text: "From: someone@else.dk wrote about it", parts: [{ name: "Regning.pdf", type: "application/pdf", size: 40_000, data: pdf("telia") }] };
    const report = await copyBilag(s.deps, [{ mailbox: "gmail", id: "g1" }, { mailbox: "outlook", id: "o1" }, { mailbox: "gmail", id: "g2" }]);
    expect(report.copied.map((c) => c.name)).toEqual(["2026-11-19 Telenor – Faktura.pdf", "2026-11-18 Hetzner Online GmbH – Invoice.pdf", "2026-11-19 Telia – Regning.pdf"]);
    // Outlook's words are asked for as text.
    expect(s.calls.find((c) => c.connector === "outlook" && c.path.includes("$select=from"))!.headers).toEqual({ prefer: 'outlook.body-content-type="text"' });
  });

  test("copies made before are renamed for who first sent their forwarded mail: their day and own name as they were, the rest left alone", async () => {
    const s = services();
    s.gmail.g1 = { from: "Kim <kim@example.com>", at: LATE, subject: "Fwd: Din faktura", text: "---------- Videresendt meddelelse ---------\nFra: Telenor <faktura@telenor.dk>\nDato: 18. nov. 2026\n", parts: [{ name: "Faktura.pdf", type: "application/pdf", size: 40_000 }] };
    s.gmail.g2 = { from: '"Telia" <faktura@telia.dk>', at: LATE, parts: [{ name: "Regning.pdf", type: "application/pdf", size: 40_000 }] };
    const local = s.deps.local;
    await copyBilag(s.deps, []);
    local.query("INSERT INTO bilag_copied (sha256, file, name, link, at) VALUES (?, ?, ?, ?, ?)").run("aa", "file-a", "2026-11-19 Kim – Faktura.pdf", null, 1);
    local.query("INSERT INTO bilag_copied (sha256, file, name, link, at) VALUES (?, ?, ?, ?, ?)").run("bb", "file-b", "2026-11-19 Telia – Regning.pdf", null, 2);
    local.query("INSERT INTO bilag_seen (part, sha256, at) VALUES (?, ?, ?)").run("gmail:g1:Faktura.pdf:40000", "aa", 1);
    local.query("INSERT INTO bilag_seen (part, sha256, at) VALUES (?, ?, ?)").run("gmail:g2:Regning.pdf:40000", "bb", 2);
    const done = await renameForwarded(s.deps);
    expect(done).toEqual({ renamed: [{ from: "2026-11-19 Kim – Faktura.pdf", to: "2026-11-19 Telenor – Faktura.pdf" }], failed: [] });
    expect(s.renames).toEqual([{ file: "file-a", name: "2026-11-19 Telenor – Faktura.pdf" }]);
    expect(s.calls.filter((c) => c.method === "PATCH").every((c) => c.connector === "gdrive" && c.class === "modify")).toBe(true);
    expect(local.query<{ name: string }, []>("SELECT name FROM bilag_copied ORDER BY at").all().map((r) => r.name)).toEqual(["2026-11-19 Telenor – Faktura.pdf", "2026-11-19 Telia – Regning.pdf"]);
    // Again, nothing is left to rename.
    expect((await renameForwarded(s.deps)).renamed).toEqual([]);
  });

  test("a mail that can't be read is said, and the rest are copied", async () => {
    const s = services();
    s.gmail.g1 = { from: "a@b.dk", at: LATE, parts: [{ name: "a.pdf", type: "application/pdf", size: 20_000, data: pdf("a") }] };
    const report = await copyBilag(s.deps, [{ mailbox: "gmail", id: "gone" }, { mailbox: "gmail", id: "g1" }]);
    expect(report.copied).toHaveLength(1);
    expect(report.failed).toEqual(["gmail gone…: gmail answered 404: Requested entity was not found."]);
  });

  test("a loop's run gives back the mail it couldn't copy, to be tried again; what it copied, or had before, it keeps", async () => {
    const s = services();
    s.gmail.g1 = { from: "a@b.dk", at: LATE, parts: [{ name: "a.pdf", type: "application/pdf", size: 20_000, data: pdf("a") }] };
    const run = loopExecutor({ local: s.deps.local, connectors: { transfer: s.deps.transfer } } as unknown as LoopTaskDeps);
    const loop = { name: "bilag", tz: "Europe/Copenhagen", task: { kind: "bilag" } } as unknown as RunnableLoop;
    const woken = (id: string) => ({ id, source: "mail" as const, at: LATE, text: `new Gmail mail ${id}` });
    const result = await run(loop, { run: "w1", slot: null, signal: new AbortController().signal, woken: [woken("mail:gmail:gone"), woken("mail:gmail:g1")] });
    expect(result).toMatchObject({ status: "attention", giveBack: ["mail:gmail:gone"] });
    expect(result.summary).toStartWith("Copied 1 bilag to Drive");
    // Copied, it is given back no more: the next run reads nothing more of it.
    const again = await run(loop, { run: "w2", slot: null, signal: new AbortController().signal, woken: [woken("mail:gmail:g1")] });
    expect(again).toEqual({ status: "ok", summary: "1 copied before." });
  });

  test("what came before: a search's mail, a batch at a time, and where it goes on", async () => {
    const s = services();
    expect(await findMail(s.deps, "gmail", "has:attachment", 50)).toEqual({ ids: ["g1", "g2"], next: "p2" });
    expect(await findMail(s.deps, "gmail", "has:attachment", 50, "p2")).toEqual({ ids: ["g3"], next: null });
    expect(await findMail(s.deps, "outlook", 'say "hi"', 50)).toEqual({ ids: ["o1"], next: "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=2" });
    expect(s.calls.at(-1)!.path).toBe(`/v1.0/me/messages?$search=${encodeURIComponent('"say hi"')}&$top=50&$select=id`);
  });
});
