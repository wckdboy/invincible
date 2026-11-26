import { describe, expect, test } from "bun:test";
import { ConnectorManifest, globMatch, orderCovers, orderProblems, type OrderTerms, toolDigest } from "../src/index.ts";

/*
 * Standing orders as pure rules: what can be signed, and exactly which calls an
 * order answers. Replicas re-check orderCovers on replay, so it must be deterministic.
 */

const github = ConnectorManifest.parse({
  id: "github",
  label: "GitHub",
  origin: "https://api.github.com",
  tools: {
    repo: { description: "A repo.", method: "GET", path: "/repos/{owner}/{repo}", params: { owner: { type: "string" }, repo: { type: "string" } }, class: "read" },
    "pr.create": {
      description: "Open a pull request.",
      method: "POST",
      path: "/repos/{owner}/{repo}/pulls",
      params: {
        owner: { type: "string" },
        repo: { type: "string" },
        head: { type: "string", required: true },
        base: { type: "string", required: true },
        title: { type: "string", required: true },
        draft: { type: "boolean" },
      },
      class: "outward",
    },
    "branch.delete": {
      description: "Delete a branch.",
      method: "DELETE",
      path: "/repos/{owner}/{repo}/git/refs/heads/{branch}",
      params: { owner: { type: "string" }, repo: { type: "string" }, branch: { type: "string" } },
      class: "delete",
    },
  },
});

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60_000;
const digest = toolDigest(github, "pr.create")!;
const order: OrderTerms = {
  connector: "github",
  tool: "pr.create",
  class: "outward",
  args: { owner: "amiriteorg", repo: "*", head: "feat/*" },
  callers: ["loop.release", "claude-*"],
  until: NOW + 30 * DAY,
  digest,
  label: "PRs from feature branches",
};
const call = {
  connector: "github",
  tool: "pr.create",
  class: "outward",
  args: { owner: "amiriteorg", repo: "galahad", head: "feat/orders", base: "main", title: "Standing orders" },
  by: "arm:loop.release",
  digest,
};

describe("patterns", () => {
  test("* is any run of characters; everything else is literal", () => {
    expect(globMatch("feat/*", "feat/x")).toBe(true);
    expect(globMatch("feat/*", "feat/x/y")).toBe(true);
    expect(globMatch("feat/*", "main")).toBe(false);
    expect(globMatch("feat/*", "xfeat/x")).toBe(false);
    expect(globMatch("a.b", "aXb")).toBe(false); // . is a dot, not "any"
    expect(globMatch("(x)", "(x)")).toBe(true);
    expect(globMatch("v1.?", "v1.2")).toBe(false);
  });
});

describe("what you can sign", () => {
  const terms = (patch: Partial<OrderTerms>) => ({ ...order, ...patch });
  test("a narrow outward order is fine", () => {
    expect(orderProblems(order, github, NOW)).toEqual([]);
  });
  test("tools that don't ask need no order; unknown tools and params are refused", () => {
    expect(orderProblems(terms({ tool: "repo" }), github, NOW)[0]).toMatch(/without asking/);
    expect(orderProblems(terms({ tool: "nope" }), github, NOW)[0]).toMatch(/no tool/);
    expect(orderProblems(terms({ args: { ...order.args, labels: "x" } }), github, NOW).join()).toMatch(/takes no "labels"/);
  });
  test("an order says where: every path parameter is named, at least one without *", () => {
    expect(orderProblems(terms({ args: { owner: "amiriteorg", head: "feat/*" } }), github, NOW).join()).toMatch(/name where it goes: repo/);
    expect(orderProblems(terms({ args: { owner: "*", repo: "*" } }), github, NOW).join()).toMatch(/pin at least one/);
    expect(orderProblems(terms({ args: { owner: "amiri*", repo: "*" } }), github, NOW).join()).toMatch(/pin at least one/);
  });
  test("a delete names exactly one thing", () => {
    const del = { ...order, tool: "branch.delete", class: "delete" as const, args: { owner: "amiriteorg", repo: "galahad", branch: "scratch/*" } };
    expect(orderProblems(del, github, NOW).join()).toMatch(/no \* \(in branch\)/);
    expect(orderProblems({ ...del, args: { ...del.args, branch: "scratch/old" } }, github, NOW)).toEqual([]);
  });
  test("it expires, within a year", () => {
    expect(orderProblems(terms({ until: NOW }), github, NOW).join()).toMatch(/already have expired/);
    expect(orderProblems(terms({ until: NOW + 400 * DAY }), github, NOW).join()).toMatch(/at most 365 days/);
    expect(orderProblems(terms({ class: "delete" }), github, NOW).join()).toMatch(/is outward, not delete/);
  });
});

describe("which calls an order answers", () => {
  test("a matching call by a named caller, before it expires", () => {
    expect(orderCovers(order, call, NOW)).toBe(true);
    expect(orderCovers(order, { ...call, by: "arm:claude-code" }, NOW)).toBe(true);
  });
  test("not after it expires, not for others, not off-pattern", () => {
    expect(orderCovers(order, call, order.until)).toBe(false);
    expect(orderCovers(order, { ...call, by: "arm:loop.other" }, NOW)).toBe(false);
    expect(orderCovers(order, { ...call, args: { ...call.args, head: "main" } }, NOW)).toBe(false);
    expect(orderCovers(order, { ...call, args: { ...call.args, owner: "someone-else" } }, NOW)).toBe(false);
    expect(orderCovers(order, { ...call, tool: "issue.create" }, NOW)).toBe(false);
    expect(orderCovers(order, { ...call, class: "delete" }, NOW)).toBe(false);
  });
  test("a constrained parameter must be there; unconstrained ones are free", () => {
    const { head: _head, ...noHead } = call.args;
    expect(orderCovers(order, { ...call, args: noHead }, NOW)).toBe(false);
    expect(orderCovers(order, { ...call, args: { ...call.args, title: "anything at all", draft: true } }, NOW)).toBe(true);
    expect(orderCovers(order, { ...call, args: { ...call.args, head: { nested: "feat/x" } } }, NOW)).toBe(false);
  });
  test("a loop is named loop.<name> whichever way it calls: as a quest's arm or directly", () => {
    expect(orderCovers(order, { ...call, by: "loop:release" }, NOW)).toBe(true);
    expect(orderCovers(order, { ...call, by: "loop:other" }, NOW)).toBe(false);
  });

  test("without callers, any of Galahad's agents may use it", () => {
    const { callers: _callers, ...anyone } = order;
    expect(orderCovers(anyone, { ...call, by: "arm:whoever" }, NOW)).toBe(true);
  });
  test("pinned to the tool as signed: change its path, origin or params and the order stops applying", () => {
    const moved = ConnectorManifest.parse({
      ...github,
      tools: { ...github.tools, "pr.create": { ...github.tools["pr.create"]!, path: "/repos/{owner}/{repo}/pulls/1/merge" } },
    });
    const elsewhere = ConnectorManifest.parse({ ...github, origin: "https://api.github.example" });
    expect(toolDigest(moved, "pr.create")).not.toBe(digest);
    expect(toolDigest(elsewhere, "pr.create")).not.toBe(digest);
    expect(toolDigest(ConnectorManifest.parse({ ...github, label: "Renamed" }), "pr.create")).toBe(digest);
    expect(orderCovers(order, { ...call, digest: toolDigest(moved, "pr.create") }, NOW)).toBe(false);
    expect(orderCovers(order, { ...call, digest: null }, NOW)).toBe(false);
  });
});

describe("standing orders for a native tool", () => {
  test("shipping pull requests can be pre-approved for one repository's galahad/* branches", () => {
    const manifest = ConnectorManifest.parse({
      id: "github",
      label: "GitHub",
      origin: "https://api.github.com",
      tools: {
        ship: {
          description: "Ship.",
          native: "github.ship",
          method: "POST",
          path: "/repos/{owner}/{repo}/pulls",
          params: { owner: { type: "string", required: true }, repo: { type: "string", required: true }, branch: { type: "string", required: true } },
          class: "outward",
        },
      },
    });
    const terms = { connector: "github", tool: "ship", class: "outward" as const, args: { owner: "amiriteorg", repo: "galahad", branch: "galahad/*" }, until: NOW + 86_400_000 };
    expect(orderProblems(terms, manifest, NOW)).toEqual([]);
    expect(orderProblems({ ...terms, args: { branch: "galahad/*" } }, manifest, NOW).join(" ")).toMatch(/owner|repo/);
  });
});
