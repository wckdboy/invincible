import { describe, expect, test } from "bun:test";
import {
  type ArgRow,
  callerName,
  defaultLabel,
  deleteName,
  modesFor,
  orderSentence,
  parseCallers,
  pathArgs,
  patternShape,
  patternWords,
  rowsForTool,
  rowsFromCall,
  rowsToArgs,
  splitOrders,
  whoWords,
} from "./orders.ts";

const pr = {
  class: "outward",
  connector: "github",
  tool: "pr.create",
  target: "POST /repos/amiriteorg/galahad/pulls",
  args: { owner: "amiriteorg", repo: "galahad", head: "feat/orders", base: "main", title: "Standing orders", draft: false },
};
const remove = { class: "delete", connector: "forge", tool: "bucket.delete", target: "DELETE /buckets/galahad-scratch", args: { name: "galahad-scratch" } };
const row = (name: string, mode: ArgRow["mode"], value: string, inPath = false, always = inPath, pinnable = true): ArgRow => ({ name, mode, value, inPath, always, pinnable });
const issue = {
  class: "outward",
  connector: "tracker",
  tool: "create_issue",
  target: 'mcp createIssue {"labels":["sandbox"],"repo":"amiriteorg/galahad","title":"Disk quotas"}',
  args: { labels: ["sandbox"], repo: "amiriteorg/galahad", title: "Disk quotas" },
};

describe("standing orders: where a call went", () => {
  test("path arguments are read back from the target, decoded, never from the query", () => {
    expect(pathArgs(pr.target, pr.args)).toEqual(["owner", "repo"]);
    expect(pathArgs("POST /repos/a/b/issues/42/comments", { owner: "a", repo: "b", number: 42, body: "hi" })).toEqual(["owner", "repo", "number"]);
    expect(pathArgs("POST /api/services/light/turn_on", { domain: "light", service: "turn_on", entity_id: "light.desk" })).toEqual(["domain", "service"]);
    expect(pathArgs("DELETE /buckets/my%20bucket", { name: "my bucket" })).toEqual(["name"]);
    expect(pathArgs("GET /search?q=galahad", { q: "galahad" })).toEqual([]);
  });

  test("a call's rows: where it went comes first and starts exact, the rest free; a delete pins everything", () => {
    // The node stores arguments sorted, so the path's order has to be read back from the target.
    const sorted = { ...pr, args: { base: "main", draft: false, head: "feat/orders", owner: "amiriteorg", repo: "galahad", title: "Standing orders" } };
    expect(rowsFromCall(sorted).map((r) => [r.name, r.mode, r.value])).toEqual([
      ["owner", "exact", "amiriteorg"],
      ["repo", "exact", "galahad"],
      ["base", "any", "main"],
      ["draft", "any", "false"],
      ["head", "any", "feat/orders"],
      ["title", "any", "Standing orders"],
    ]);
    expect(pathArgs("POST /repos/a/b/issues/7/comments", { number: 7, repo: "b", owner: "a" })).toEqual(["owner", "repo", "number"]);
    expect(rowsFromCall(remove)).toEqual([{ name: "name", mode: "exact", value: "galahad-scratch", inPath: true, always: true, pinnable: true }]);
  });

  test("an MCP call has no path: nothing is read from its target, and lists stay free", () => {
    expect(pathArgs(issue.target, { ...issue.args, title: "galahad\"}" })).toEqual([]);
    expect(rowsFromCall(issue).map((r) => [r.name, r.mode, r.pinnable])).toEqual([
      ["labels", "any", false],
      ["repo", "any", true],
      ["title", "any", true],
    ]);
    // A delete pins what it can.
    expect(rowsFromCall({ ...issue, class: "delete" }).map((r) => [r.name, r.mode])).toEqual([
      ["labels", "any"],
      ["repo", "exact"],
      ["title", "exact"],
    ]);
    expect(modesFor({ always: false, pinnable: false }, "outward")).toEqual(["any"]);
  });

  test("what a delete names, for typing it before approving", () => {
    expect(deleteName(remove)).toBe("galahad-scratch");
    expect(deleteName({ ...remove, target: "DELETE /buckets/my%20bucket" })).toBe("my bucket");
    expect(deleteName({ connector: "tracker", tool: "delete_repo", target: 'mcp delete_repo {"repo":"amiriteorg/old"}', args: { repo: "amiriteorg/old" } })).toBe("amiriteorg/old");
    expect(deleteName(issue)).toBe("tracker.create_issue");
  });

  test("a tool's rows: the path's parameters first and pinned when the path is known; else all a call always carries", () => {
    const params = { body: { required: false }, head: { required: true }, owner: { required: true }, repo: { required: true } };
    expect(rowsForTool(params, "outward", "/repos/{owner}/{repo}/pulls").map((r) => [r.name, r.mode, r.inPath, r.always])).toEqual([
      ["owner", "exact", true, true],
      ["repo", "exact", true, true],
      ["head", "any", false, true],
      ["body", "any", false, false],
    ]);
    // An MCP tool (no path): everything a call always carries starts pinned.
    expect(rowsForTool(params, "outward", null).map((r) => [r.name, r.mode])).toEqual([
      ["head", "exact"],
      ["owner", "exact"],
      ["repo", "exact"],
      ["body", "any"],
    ]);
    expect(rowsForTool({ force: { required: false }, name: { required: true } }, "delete", "/buckets/{name}").map((r) => [r.name, r.mode])).toEqual([
      ["name", "exact"],
      ["force", "any"],
    ]);
    expect(rowsForTool({ labels: { required: true, type: "array" }, repo: { required: true, type: "string" } }, "outward", null).map((r) => [r.name, r.mode, r.pinnable])).toEqual([
      ["labels", "any", false],
      ["repo", "exact", true],
    ]);
  });

  test("a delete has no patterns, and what it always carries stays exact", () => {
    expect(modesFor({ always: true, pinnable: true }, "delete")).toEqual(["exact"]);
    expect(modesFor({ always: false, pinnable: true }, "delete")).toEqual(["exact", "any"]);
    expect(modesFor({ always: false, pinnable: true }, "outward")).toEqual(["exact", "pattern", "any"]);
  });
});

describe("standing orders: rows into terms", () => {
  test("exact and pattern rows become args; free rows are omitted, or named * when every call carries them", () => {
    const read = rowsToArgs([row("owner", "exact", "amiriteorg", true), row("repo", "any", "galahad", true), row("head", "pattern", "feat/*"), row("title", "any", "x", false, true), row("body", "any", "")], "outward");
    expect(read).toEqual({ args: { owner: "amiriteorg", repo: "*", head: "feat/*", title: "*" }, free: ["repo", "title", "body"] });
  });

  test("where it goes: at least one path argument stays exact", () => {
    const read = rowsToArgs([row("owner", "pattern", "amirite*", true), row("repo", "any", "galahad", true)], "outward");
    expect(read).toMatchObject({ row: "owner" });
    expect("problem" in read && read.problem).toContain("at least one of owner or repo");
    expect(rowsToArgs([row("name", "any", "", true)], "outward")).toMatchObject({ problem: expect.stringContaining("Pin name") });
    // A tool with nothing in its path has nothing to pin.
    expect(rowsToArgs([row("text", "any", "")], "outward")).toEqual({ args: {}, free: ["text"] });
  });

  test("empty, too long, and a * in an exact value are caught before the node sees them", () => {
    expect(rowsToArgs([row("owner", "exact", "  ", true)], "outward")).toMatchObject({ problem: "Give owner a value, or choose Any.", row: "owner" });
    expect(rowsToArgs([row("head", "pattern", "")], "outward")).toMatchObject({ problem: "Give head a pattern, or choose Any." });
    expect(rowsToArgs([row("text", "exact", "x".repeat(201))], "outward")).toMatchObject({ problem: expect.stringContaining("too long") });
    expect(rowsToArgs([row("head", "exact", "feat/*")], "outward")).toMatchObject({ problem: expect.stringContaining("Choose Pattern") });
  });

  test("a delete names exactly one thing", () => {
    expect(rowsToArgs([row("name", "exact", "galahad-scratch", true)], "delete")).toEqual({ args: { name: "galahad-scratch" }, free: [] });
    expect(rowsToArgs([row("name", "pattern", "galahad-*", true)], "delete")).toMatchObject({ problem: expect.stringContaining("can't have a *") });
    expect(rowsToArgs([row("name", "any", "", true)], "delete")).toMatchObject({ problem: expect.stringContaining("exact value") });
    expect(rowsToArgs([row("name", "exact", "a", true), row("force", "any", "")], "delete")).toEqual({ args: { name: "a" }, free: ["force"] });
    expect(rowsToArgs([row("labels", "any", "", false, true, false)], "delete")).toMatchObject({ problem: expect.stringContaining("can't pin") });
  });

  test("a list or an object is never named, not even as *: an order would then never match", () => {
    expect(rowsToArgs([row("repo", "pattern", "amiriteorg/*"), row("labels", "any", "", false, true, false)], "outward")).toEqual({ args: { repo: "amiriteorg/*" }, free: ["labels"] });
  });

  test("callers: names separated by commas or spaces, deduplicated; empty means any of Galahad's agents", () => {
    expect(parseCallers("")).toEqual({ callers: null });
    expect(parseCallers(" claude-code, loop:release  claude-code ")).toEqual({ callers: ["claude-code", "loop:release"] });
    expect(parseCallers(Array.from({ length: 17 }, (_, i) => `a${i}`).join(","))).toMatchObject({ problem: expect.stringContaining("at most 16") });
    expect(callerName("arm:claude-code")).toBe("claude-code");
    // As the node matches them: a loop is loop.<name>, however it called.
    expect(callerName("loop:morning")).toBe("loop.morning");
    expect(callerName("arm:loop.morning")).toBe("loop.morning");
    expect(callerName("node:ultra")).toBe("node:ultra");
  });
});

describe("standing orders in plain words", () => {
  test("patterns: any, exact, starts with, ends with, contains, or a pattern of its own", () => {
    expect(patternShape("*")).toEqual({ kind: "any" });
    expect(patternShape("**")).toEqual({ kind: "any" });
    expect(patternWords("amiriteorg")).toBe("amiriteorg");
    expect(patternWords("feat/*")).toBe("starts with feat/");
    expect(patternWords("*-tmp")).toBe("ends with -tmp");
    expect(patternWords("*rc*")).toBe("contains rc");
    expect(patternWords("v*-rc*")).toBe("matches v*-rc*");
    expect(patternWords("Galahad *")).toBe("starts with “Galahad ”");
  });

  test("the preview sentence says who, what, how narrow and until when", () => {
    expect(
      orderSentence({ connector: "github", tool: "pr.create", args: { owner: "amiriteorg", repo: "*", head: "feat/*" }, free: ["repo", "base", "title"], callers: ["claude-code"], until: "Dec 10" }),
    ).toBe(
      "Only claude-code may use github.pr.create without asking you for owner amiriteorg and head starting with feat/, with any repo, base and title, until Dec 10. Each call still shows up in your inbox.",
    );
    expect(orderSentence({ connector: "forge", tool: "bucket.delete", args: { name: "galahad-scratch" }, callers: null, until: "Nov 17" })).toBe(
      "Any of Galahad's agents may use forge.bucket.delete without asking you for name galahad-scratch, until Nov 17. Each call still shows up in your inbox.",
    );
    expect(orderSentence({ connector: "forge", tool: "post", args: {}, free: ["text"], callers: ["a", "b"], until: "Feb 8" })).toBe(
      "Only a or b may use forge.post without asking you, with any text, until Feb 8. Each call still shows up in your inbox.",
    );
    expect(whoWords([])).toBe("Any of Galahad's agents");
  });

  test("a label to start from names the tool and where the call went", () => {
    expect(defaultLabel(pr)).toBe("github.pr.create on amiriteorg/galahad");
    expect(defaultLabel(remove)).toBe("forge.bucket.delete on galahad-scratch");
    expect(defaultLabel({ connector: "forge", tool: "post", target: "POST /posts", args: { text: "hi" } })).toBe("forge.post");
    expect(defaultLabel({ connector: "x", tool: "y", target: `POST /${"a".repeat(200)}`, args: { p: "a".repeat(200) } })).toHaveLength(128);
  });

  test("orders split into the ones meant to apply (stale first) and the old ones, newest first", () => {
    const o = (id: string, state: string, signedAt: number) => ({ id, state, signedAt });
    const { current, old } = splitOrders([o("a", "active", 1), o("b", "expired", 2), o("c", "stale", 0), o("d", "active", 3), o("e", "revoked", 4)]);
    expect(current.map((x) => x.id)).toEqual(["c", "d", "a"]);
    expect(old.map((x) => x.id)).toEqual(["e", "b"]);
  });
});
