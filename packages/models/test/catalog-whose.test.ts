import { describe, expect, test } from "bun:test";
import { CATALOG_FREE, CATALOG_WHOSE, decide, heldClass, MAIL_SENDS, orderCovers, orderProblems, ownApproval, type OwnCall, supposedFacts, toolDigest } from "@invincible/core";
import { CATALOG } from "../src/connector-catalog.ts";

/*
 * Every action the connector catalog ships has its owner (your word, 27 November 2026): what is your own and can be undone
 * is your agent's to decide (policy.ts ownApproval says where), and what is money, legal, destructive or security stays
 * yours. An action is classed by what it does, not by the label its tool carries: a template that reads is a GET; a
 * native (the node's own code) declared GET is one READS names, at the path it reads; one that writes is free only where
 * policy.ts says why (CATALOG_FREE), and every other asks and says whose it is (CATALOG_WHOSE). An action added without
 * its place there fails here, and so does an entry for an action the catalog no longer has. What this proves is the
 * catalog's: a manifest you install yourself is held to its own labels (SECURITY.md says so).
 */

/** The natives that only read, each at the one path the catalog may declare it GET at: what the node's code for it sends
 * is GETs alone (packages/node/test/natives-read.test.ts runs each and holds it to that). */
const READS: Readonly<Record<string, string>> = {
  "gmail.search": "/gmail/v1/users/me/messages",
  "gmail.read": "/gmail/v1/users/me/messages/{id}",
  "outlook.search": "/v1.0/me/messages",
  "outlook.read": "/v1.0/me/messages/{id}",
  "cloudflare.verify": "/user/tokens/verify",
};

// (A connector you give its address when you add it, Home Assistant's, is given a stand-in one here.)
const tools = Object.entries(CATALOG).flatMap(([id, entry]) => Object.entries(entry.manifest.tools).map(([tool, definition]) => ({ key: `${id}.${tool}`, id, tool, definition, manifest: { ...entry.manifest, origin: entry.manifest.origin ?? "https://home.example.test" } })));
const whose = (key: string) => (Object.hasOwn(CATALOG_WHOSE, key) ? CATALOG_WHOSE[key as keyof typeof CATALOG_WHOSE] : undefined);
const asking = tools.filter((t) => whose(t.key) !== undefined);
// One set of arguments for every call: a repository you gave an agent and also a private one of your own, from a branch
// it shipped into the default one, as a review that only comments, on its own thread, changing code and no CI, built on
// where the branch it is judged on stands; and GitHub saying all it could (supposedFacts). Where a call goes is all
// ownApproval reads of them.
const ARGS = { owner: "lin-example", repo: "notes", head: "invincible/units", branch: "invincible/units", base: "main", event: "COMMENT", number: 7, title: "Units", body: "Parse them.", artifact: "art_AAAAAAAAAAAAAAAAAAAAAA" };
const GIVEN = ["https://github.com/lin-example/notes"];
const SHA = "c".repeat(40);
const asCall = (t: (typeof tools)[number], args: Record<string, unknown> = ARGS): OwnCall => ({
  class: t.definition.class,
  origin: t.manifest.origin,
  ...("native" in t.definition && t.definition.native ? { native: t.definition.native } : {}),
  method: "method" in t.definition ? t.definition.method : "POST",
  path: "path" in t.definition ? t.definition.path : "",
  args,
  // The node's own call for the primary: the caller of what only it files (a merge of proven work) as of all else.
  by: "primary",
  changes: ["src/units.ts"],
  base: SHA,
  pushed: SHA.slice(0, 12),
});
const said = (call: OwnCall) => supposedFacts(call);

describe("every action the connector catalog ships is yours or your agent's to decide", () => {
  test("each is classed by what it does: a read is a GET; a write is free only where policy.ts says why; every other asks, and says whose it is", () => {
    for (const t of tools) {
      const method = "method" in t.definition ? t.definition.method : "POST";
      // What it is held to (core's heldClass: a write to GitHub's refs asks whatever its label says).
      const label = "method" in t.definition ? heldClass(t.manifest, t.definition) : t.definition.class;
      if (method === "GET") {
        expect([t.key, label]).toEqual([t.key, "read"]);
        // A native's method is a label: its code does what it does. Declared GET, it is one that reads, where it reads.
        const native = "native" in t.definition ? t.definition.native : undefined;
        if (native !== undefined) expect([t.key, native, Object.hasOwn(READS, native) ? READS[native] : null]).toEqual([t.key, native, "path" in t.definition ? t.definition.path : ""]);
      }
      else if (Object.hasOwn(CATALOG_FREE, t.key)) expect([t.key, ["create", "modify"].includes(label)]).toEqual([t.key, true]);
      else expect([t.key, whose(t.key) !== undefined && ["outward", "delete"].includes(label)]).toEqual([t.key, true]);
    }
    // No entry for what the catalog no longer has, nor one in both places.
    const keys = new Set(tools.map((t) => t.key));
    for (const key of [...Object.keys(CATALOG_WHOSE), ...Object.keys(CATALOG_FREE)]) expect([key, keys.has(key)]).toEqual([key, true]);
    for (const key of Object.keys(CATALOG_FREE)) expect([key, whose(key)]).toEqual([key, undefined]);
    // Each that asks is yours as one part of the boundary, or its somewhere ownApproval names.
    for (const t of asking) {
      const w = whose(t.key)!;
      expect([t.key, "its" in w ? w.where.length > 0 && w.where.every((where) => where === "given" || where === "private") : ["money", "legal", "destructive", "security"].includes(w.yours)]).toEqual([t.key, true]);
    }
  });

  test("each that doesn't ask is free, and logged: reading, creating, changing", () => {
    const free = tools.filter((t) => !asking.includes(t));
    expect(free.length).toBeGreaterThan(0);
    for (const t of free) expect([t.key, decide({ class: t.definition.class, resource: `connector.${t.id}`, target: t.key }).verdict]).toEqual([t.key, "allow"]);
  });

  test("what is yours stays yours wherever it goes: never its to approve, in a repository you gave an agent or a private one of your own", () => {
    for (const t of asking.filter((t) => "yours" in whose(t.key)!)) {
      expect([t.key, ownApproval(asCall(t), GIVEN, said(asCall(t)))]).toEqual([t.key, null]);
      expect([t.key, ownApproval(asCall(t), [], said(asCall(t)))]).toEqual([t.key, null]);
    }
  });

  test("what is its is its exactly where policy.ts says (a repository you gave an agent, a private one of your own), and yours in anyone else's place", () => {
    const its = asking.filter((t) => "its" in whose(t.key)!);
    expect(its.length).toBeGreaterThan(0);
    for (const t of its) {
      const where = (whose(t.key) as { where: readonly string[] }).where;
      expect([t.key, ownApproval(asCall(t), GIVEN, said(asCall(t)))]).toEqual([t.key, where.includes("given") ? expect.stringMatching(/ in lin-example\/notes, a repository you gave an agent$/) : null]);
      expect([t.key, ownApproval(asCall(t), [], said(asCall(t)))]).toEqual([t.key, where.includes("private") ? expect.stringMatching(/ in lin-example\/notes, a private repository of yours$/) : null]);
      const elsewhere = asCall(t, { ...ARGS, owner: "oven-sh", repo: "bun" });
      expect([t.key, ownApproval(elsewhere, GIVEN, said(asCall(t)))]).toEqual([t.key, null]);
    }
  });

  test("standing orders still move the line: one you sign may cover any action that is yours, pinned where it goes", () => {
    const now = Date.UTC(2026, 10, 27);
    for (const t of asking.filter((t) => "yours" in whose(t.key)!)) {
      const inPath = [...("path" in t.definition ? t.definition.path : "").matchAll(/\{([^}]*)\}/g)].map((m) => m[1]!);
      // (A send of mail goes where its recipients are: an order for one names them, MAIL_SENDS.)
      const sends = "native" in t.definition && t.definition.native !== undefined && MAIL_SENDS.has(t.definition.native);
      const pinned = { ...Object.fromEntries(inPath.map((name) => [name, "pinned"])), ...(sends ? { to: "someone@example.test" } : {}) };
      const held = "method" in t.definition ? heldClass(t.manifest, t.definition) : t.definition.class;
      const terms = { connector: t.id, tool: t.tool, class: held as "outward" | "delete", args: pinned, until: now + 30 * 86_400_000 };
      expect([t.key, orderProblems(terms, t.manifest, now)]).toEqual([t.key, []]);
      const digest = toolDigest(t.manifest, t.tool)!;
      expect([t.key, orderCovers({ ...terms, digest, label: "yours, in advance" }, { connector: t.id, tool: t.tool, class: held, args: pinned, by: "arm:primary", digest }, now)]).toEqual([t.key, true]);
    }
  });
});
