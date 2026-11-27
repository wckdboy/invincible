import { describe, expect, test } from "bun:test";
import type { BuiltRequest, ConnectorManifest } from "@invincible/core";
import { CATALOG, type ConnectorResult } from "@invincible/models";
import { cloudflareNatives } from "../src/cloudflare.ts";
import type { NativeTool } from "../src/connectors.ts";
import { gmailNatives, outlookNatives } from "../src/mail.ts";

/*
 * A native's method is a label: what it does is its code (the re-review of 27 November 2026, R5). The catalog declares a
 * native GET only where it reads (packages/models/test/catalog-whose.test.ts READS); this runs each such native, every
 * way it goes, against a stand-in service, and holds it to sending GETs alone.
 */

const NATIVES: Record<string, NativeTool> = { ...gmailNatives, ...outlookNatives, ...cloudflareNatives };
const reading = Object.values(CATALOG).flatMap((entry) =>
  Object.entries(entry.manifest.tools)
    .filter(([, tool]) => "native" in tool && tool.native !== undefined && tool.method === "GET")
    .map(([name, tool]) => ({ name, native: (tool as { native: string }).native, manifest: { ...entry.manifest, origin: entry.manifest.origin ?? "https://home.example.test" } as ConnectorManifest })),
);

/** The service, answering as it would: a list of two, each one, a token no user owns but an account does. */
function service(): { sent: string[]; send: (request: BuiltRequest) => Promise<ConnectorResult> } {
  const sent: string[] = [];
  const answer = (status: number, json: unknown): ConnectorResult => ({ ok: status < 300, status, contentType: "application/json", body: JSON.stringify(json), truncated: false, durationMs: 1 });
  return {
    sent,
    send: async (request) => {
      const url = new URL(request.url);
      sent.push(`${request.method} ${url.pathname}`);
      if (url.pathname.endsWith("/user/tokens/verify")) return answer(401, { success: false, errors: [{ message: "not a user's token" }] });
      if (url.pathname.endsWith("/accounts")) return answer(200, { success: true, result: [{ id: "a".repeat(32), name: "Lin" }] });
      if (url.pathname.endsWith("/tokens/verify")) return answer(200, { success: true, result: { id: "t", status: "active" } });
      if (url.pathname.endsWith("/messages") || url.pathname.endsWith("/inbox/messages")) return answer(200, { messages: [{ id: "18f2a3b4c5d6" }, { id: "18f2a3b4c5d7" }], value: [{ id: "AAMkAGI2" }] });
      return answer(200, { id: "18f2a3b4c5d6", payload: { headers: [], mimeType: "text/plain", body: { data: "" } }, body: { contentType: "text", content: "" } });
    },
  };
}

describe("a native the catalog declares GET only reads", () => {
  test("each one the catalog declares GET is one this node carries out", () => {
    expect(reading.map((r) => r.native).sort()).toEqual(["cloudflare.verify", "gmail.read", "gmail.search", "outlook.read", "outlook.search"]);
    for (const r of reading) expect([r.native, typeof NATIVES[r.native]]).toEqual([r.native, "function"]);
  });

  test("each sends GETs alone, every way it goes: a search and its messages, one message, a token checked at each account", async () => {
    for (const r of reading) {
      const all: string[] = [];
      for (const args of [{}, { query: "from:lin", limit: 2 }, { id: "18f2a3b4c5d6" }] as Record<string, string | number>[]) {
        const { sent, send } = service();
        await NATIVES[r.native]!(r.manifest, args, send);
        all.push(...sent);
      }
      expect([r.native, all.length > 0, all.filter((line) => !line.startsWith("GET "))]).toEqual([r.native, true, []]);
    }
  });
});
