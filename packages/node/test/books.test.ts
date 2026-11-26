import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { ArgValue } from "@galahad/core";
import type { ConnectorResult, Transferred } from "@galahad/brain";
import { attachBilag, fileGuidOf, uploadBilag } from "../src/books.ts";
import type { Transfer } from "../src/bilag.ts";

/*
 * A bilag into Dinero, to the payment it documents (books.ts): its bytes from Drive handed to Dinero as they are, with
 * their length and SHA-256, and the attaching of it asked of you; with stand-ins for Drive, the hand-over and the ask.
 */

const CARD = "c7c91612-5f4c-4516-ad98-4f7dc61396d4";
const GUID = "0b9f2c1e-7a44-4c1d-9e0a-5f3b2d8c6a71";
const pdf = new TextEncoder().encode(`%PDF-1.7 ${"an invoice's bytes ".repeat(3000)}`);

function rig(over: { upload?: ConnectorResult; drive?: Partial<Transferred> } = {}) {
  const handed: { connector: string; tool: string; args: Record<string, ArgValue>; why: string }[] = [];
  const asked: { connector: string; tool: string; args: Record<string, ArgValue>; why: string }[] = [];
  const read: string[] = [];
  const transfer: Transfer = async (connector, step) => {
    read.push(`${connector} ${step.method} ${step.path} ${step.class}`);
    if (step.path.includes("alt=media")) return { ok: true, status: 200, contentType: "application/pdf", location: null, bytes: pdf, ...over.drive };
    return { ok: true, status: 200, contentType: "application/json", location: null, bytes: new TextEncoder().encode(JSON.stringify({ name: "2026-11-12 Topaz Labs Team – TS-13398360.pdf", mimeType: "application/pdf", size: String(pdf.length) })) };
  };
  const deps = {
    transfer,
    handFile: async (connector: string, tool: string, args: Record<string, ArgValue>, why: string) => {
      handed.push({ connector, tool, args, why });
      return over.upload ?? { ok: true, status: 200, contentType: "text/plain", body: JSON.stringify({ fileGuid: GUID, fileName: args.fileName }), truncated: false, durationMs: 1, mcp: true };
    },
    ask: async (call: { connector: string; tool: string; args: Record<string, ArgValue>; why: string }) => {
      asked.push(call);
      return { status: "asked", action: "a_AAAAAAAAAAAAAAAA" };
    },
  };
  return { deps, handed, asked, read };
}

describe("a bilag into Dinero", () => {
  test("its bytes go to Dinero as they are, with their length and SHA-256; attaching it to the payment's card is asked of you, with why", async () => {
    const r = rig();
    const done = await attachBilag(r.deps, { organizationId: 517264, card: CARD, file: "1OkWvpScarizjR3P3b0h_GUhYHoubXY2D", why: "Topaz Labs' invoice TS-13398360, $69.00 on 12 Nov: the 467.81 kr paid on 13 Nov" });
    const sha256 = createHash("sha256").update(pdf).digest("hex");
    expect(done).toEqual({ name: "2026-11-12 Topaz Labs Team – TS-13398360.pdf", bytes: pdf.length, sha256, fileGuid: GUID, action: "a_AAAAAAAAAAAAAAAA" });
    // Drive is only read: what the file is, then its bytes.
    expect(r.read.every((line) => line.startsWith("gdrive GET ") && line.endsWith(" read"))).toBe(true);
    expect(r.read[1]).toContain("/drive/v3/files/1OkWvpScarizjR3P3b0h_GUhYHoubXY2D?alt=media");
    const [up] = r.handed;
    expect(up).toMatchObject({ connector: "dinero", tool: "upload_file", args: { organizationId: 517264, fileName: "2026-11-12 Topaz Labs Team – TS-13398360.pdf", contentType: "application/pdf", expectedByteLength: pdf.length, sha256 } });
    expect(Buffer.from(String(up!.args.base64Content), "base64").equals(Buffer.from(pdf))).toBe(true);
    expect(r.asked).toEqual([{ connector: "dinero", tool: "attach_file_to_voucher_card", args: { organizationId: 517264, voucherGuid: CARD, fileGuid: GUID }, why: "Topaz Labs' invoice TS-13398360, $69.00 on 12 Nov: the 467.81 kr paid on 13 Nov" }]);
  });

  test("a bilag into Dinero's archive alone, for a voucher drafted with it: its fileGuid, and nothing asked", async () => {
    const r = rig();
    const up = await uploadBilag(r.deps, { organizationId: 517264, file: "1OkWvpScarizjR3P3b0h_GUhYHoubXY2D" });
    expect(up).toEqual({ name: "2026-11-12 Topaz Labs Team – TS-13398360.pdf", bytes: pdf.length, sha256: createHash("sha256").update(pdf).digest("hex"), fileGuid: GUID });
    expect(Buffer.from(String(r.handed[0]!.args.base64Content), "base64").equals(Buffer.from(pdf))).toBe(true);
    expect(r.asked).toEqual([]);
  });

  test("a file already in Dinero's archive is attached as it is: nothing is read from Drive or uploaded again", async () => {
    const r = rig();
    const done = await attachBilag(r.deps, { organizationId: 517264, card: CARD, dineroFile: "vnobcolxk7d4cvdavcycz80mlzzxh1rl", why: "Topaz Labs' invoice, already in Dinero" });
    expect(done).toEqual({ name: null, bytes: null, sha256: null, fileGuid: "vnobcolxk7d4cvdavcycz80mlzzxh1rl", action: "a_AAAAAAAAAAAAAAAA" });
    expect([r.read, r.handed]).toEqual([[], []]);
    expect(r.asked[0]!.args).toEqual({ organizationId: 517264, voucherGuid: CARD, fileGuid: "vnobcolxk7d4cvdavcycz80mlzzxh1rl" });
    await expect(attachBilag(r.deps, { organizationId: 1, card: CARD, why: "x" })).rejects.toThrow(/one of them/);
  });

  test("nothing is asked of you when Dinero didn't take the file, or named no file for it; a file Drive won't give isn't handed on", async () => {
    const refused = rig({ upload: { ok: false, status: 200, contentType: "text/plain", body: "sha256 mismatch", truncated: false, durationMs: 1, mcp: true } });
    await expect(attachBilag(refused.deps, { organizationId: 1, card: CARD, file: "1OkWvpScarizjR3P3b0h_GUhYHoubXY2D", why: "x" })).rejects.toThrow(/Dinero didn't take .*sha256 mismatch/);
    expect(refused.asked).toEqual([]);
    const nameless = rig({ upload: { ok: true, status: 200, contentType: "text/plain", body: "Uploaded.", truncated: false, durationMs: 1, mcp: true } });
    await expect(attachBilag(nameless.deps, { organizationId: 1, card: CARD, file: "1OkWvpScarizjR3P3b0h_GUhYHoubXY2D", why: "x" })).rejects.toThrow(/named no fileGuid/);
    expect(nameless.asked).toEqual([]);
    const gone = rig({ drive: { ok: false, status: 404 } });
    await expect(attachBilag(gone.deps, { organizationId: 1, card: CARD, file: "1OkWvpScarizjR3P3b0h_GUhYHoubXY2D", why: "x" })).rejects.toThrow(/gdrive answered 404/);
    expect(gone.handed).toEqual([]);
  });

  test("the file Dinero names: its JSON's fileGuid, the one its words name, or the only Guid in them", () => {
    // What Dinero answered on 19 November 2026: its file ids aren't Guids.
    expect(fileGuidOf('{"fileGuid":"vnobcolxk7d4cvdavcycz80mlzzxh1rl","uploadedByteCount":32942}')).toBe("vnobcolxk7d4cvdavcycz80mlzzxh1rl");
    expect(fileGuidOf("Uploaded. fileGuid: vnobcolxk7d4cvdavcycz80mlzzxh1rl")).toBe("vnobcolxk7d4cvdavcycz80mlzzxh1rl");
    expect(fileGuidOf(JSON.stringify({ result: { file: { fileGuid: GUID } } }))).toBe(GUID);
    expect(fileGuidOf(`Uploaded. fileGuid: ${GUID}`)).toBe(GUID);
    expect(fileGuidOf(`Stored as ${GUID} (${GUID}).`)).toBe(GUID);
    expect(fileGuidOf(`${GUID} or ${CARD}`)).toBeNull();
    expect(fileGuidOf("no file")).toBeNull();
  });
});
