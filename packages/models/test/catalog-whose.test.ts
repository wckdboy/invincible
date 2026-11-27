import { describe, expect, test } from "bun:test";
import { CATALOG_FREE, CATALOG_WHOSE, decide, type GitHubFacts, MAIL_SENDS, orderCovers, orderProblems, ownApproval, type OwnCall, toolDigest } from "@invincible/core";
import { CATALOG } from "../src/connector-catalog.ts";

/*
 * Every action the connector catalog ships has its owner (your word, 27 November 2026): what is your own and can be undone
 * is your agent's to decide (policy.ts ownApproval says where), and what is money, legal, destructive or security stays
 * yours. An action is classed by what it does, not by the label its tool carries: one that reads is a GET; one that writes
 * is free only where policy.ts says why (CATALOG_FREE), and every other asks and says whose it is (CATALOG_WHOSE). An
 * action added without its place there fails here, and so does an entry for an action the catalog no longer has.
 */

// (A connector you give its address when you add it, Home Assistant's, is given a stand-in one here.)
const tools = Object.entries(CATALOG).flatMap(([id, entry]) => Object.entries(entry.manifest.tools).map(([tool, definition]) => ({ key: `${id}.${tool}`, id, tool, definition, manifest: { ...entry.manifest, origin: entry.manifest.origin ?? "https://home.example.test" } })));
const whose = (key: string) => (Object.hasOwn(CATALOG_WHOSE, key) ? CATALOG_WHOSE[key as keyof typeof CATALOG_WHOSE] : undefined);
const asking = tools.filter((t) => whose(t.key) !== undefined);
// One set of arguments for every call: a repository you gave an agent and also a private one of your own, from a branch
// of its own, as a review that only comments, on its own thread, changing code and no CI. Where a call goes is all
// ownApproval reads of them.
const ARGS = { owner: "lin-example", repo: "notes", head: "invincible/units", branch: "invincible/units", event: "COMMENT", number: 7, title: "Units", body: "Parse them.", artifact: "art_AAAAAAAAAAAAAAAAAAAAAA" };
const GIVEN = ["https://github.com/lin-example/notes"];
const PRIVATE: GitHubFacts = { user: { id: 501 }, repo: { name: "lin-example/notes", private: true, fork: false, ownerId: 501, ownerType: "User" }, thread: { number: 7, authorId: 501 } };
const asCall = (t: (typeof tools)[number], args: Record<string, unknown> = ARGS): OwnCall => ({
  class: t.definition.class,
  origin: t.manifest.origin,
  ...("native" in t.definition && t.definition.native ? { native: t.definition.native } : {}),
  method: "method" in t.definition ? t.definition.method : "POST",
  path: "path" in t.definition ? t.definition.path : "",
  args,
  by: "arm:primary",
  changes: ["src/units.ts"],
});

describe("every action the connector catalog ships is yours or your agent's to decide", () => {
  test("each is classed by what it does: a read is a GET; a write is free only where policy.ts says why; every other asks, and says whose it is", () => {
    for (const t of tools) {
      const method = "method" in t.definition ? t.definition.method : "POST";
      const label = t.definition.class;
      if (method === "GET") expect([t.key, label]).toEqual([t.key, "read"]);
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
    for (const t of asking.filter((t) => "yours" in whose(t.key)!)) expect([t.key, ownApproval(asCall(t), GIVEN, PRIVATE)]).toEqual([t.key, null]);
  });

  test("what is its is its exactly where policy.ts says (a repository you gave an agent, a private one of your own), and yours in anyone else's place", () => {
    const its = asking.filter((t) => "its" in whose(t.key)!);
    expect(its.length).toBeGreaterThan(0);
    for (const t of its) {
      const where = (whose(t.key) as { where: readonly string[] }).where;
      expect([t.key, ownApproval(asCall(t), GIVEN)]).toEqual([t.key, where.includes("given") ? expect.stringMatching(/ in lin-example\/notes, a repository you gave an agent$/) : null]);
      expect([t.key, ownApproval(asCall(t), [], PRIVATE)]).toEqual([t.key, where.includes("private") ? expect.stringMatching(/ in lin-example\/notes, a private repository of yours$/) : null]);
      expect([t.key, ownApproval(asCall(t, { ...ARGS, owner: "oven-sh", repo: "bun" }), GIVEN, PRIVATE)]).toEqual([t.key, null]);
    }
  });

  test("standing orders still move the line: one you sign may cover any action that is yours, pinned where it goes", () => {
    const now = Date.UTC(2026, 10, 27);
    for (const t of asking.filter((t) => "yours" in whose(t.key)!)) {
      const inPath = [...("path" in t.definition ? t.definition.path : "").matchAll(/\{([^}]*)\}/g)].map((m) => m[1]!);
      // (A send of mail goes where its recipients are: an order for one names them, MAIL_SENDS.)
      const sends = "native" in t.definition && t.definition.native !== undefined && MAIL_SENDS.has(t.definition.native);
      const pinned = { ...Object.fromEntries(inPath.map((name) => [name, "pinned"])), ...(sends ? { to: "someone@example.test" } : {}) };
      const terms = { connector: t.id, tool: t.tool, class: t.definition.class as "outward" | "delete", args: pinned, until: now + 30 * 86_400_000 };
      expect([t.key, orderProblems(terms, t.manifest, now)]).toEqual([t.key, []]);
      const digest = toolDigest(t.manifest, t.tool)!;
      expect([t.key, orderCovers({ ...terms, digest, label: "yours, in advance" }, { connector: t.id, tool: t.tool, class: t.definition.class, args: pinned, by: "arm:primary", digest }, now)]).toEqual([t.key, true]);
    }
  });
});
