import { describe, expect, test } from "bun:test";
import { ConnectorManifest, globMatch, mailAddresses, orderCovers, orderProblems, type OrderTerms, SENDS_NAME_RECIPIENTS_FROM, sendCovered, toolDigest } from "../src/index.ts";

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
  args: { owner: "amiriteorg", repo: "invincible", head: "feat/orders", base: "main", title: "Standing orders" },
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
    const del = { ...order, tool: "branch.delete", class: "delete" as const, args: { owner: "amiriteorg", repo: "invincible", branch: "scratch/*" } };
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
  test("a loop is named loop.<name> whichever way it calls: as a run's arm or directly", () => {
    expect(orderCovers(order, { ...call, by: "loop:release" }, NOW)).toBe(true);
    expect(orderCovers(order, { ...call, by: "loop:other" }, NOW)).toBe(false);
  });

  test("without callers, any of your agent's agents may use it", () => {
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
  test("shipping pull requests can be pre-approved for one repository's invincible/* branches", () => {
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
    const terms = { connector: "github", tool: "ship", class: "outward" as const, args: { owner: "amiriteorg", repo: "invincible", branch: "invincible/*" }, until: NOW + 86_400_000 };
    expect(orderProblems(terms, manifest, NOW)).toEqual([]);
    expect(orderProblems({ ...terms, args: { branch: "invincible/*" } }, manifest, NOW).join(" ")).toMatch(/owner|repo/);
  });
});

// The lead's word of 27 November 2026: an order for gmail.send or outlook.send must pin its recipients. Before, a send
// has no path to pin, so one order with no arguments answered every send, to anyone (orders.ts said "it names where").
describe("an order to send mail names whom it may send to", () => {
  const compose = { to: { type: "string", required: true }, cc: { type: "string" }, subject: { type: "string" }, body: { type: "string", required: true }, replyTo: { type: "string" } } as const;
  const gmail = ConnectorManifest.parse({
    id: "gmail",
    label: "Gmail",
    origin: "https://gmail.googleapis.com",
    tools: { send: { description: "Send.", native: "gmail.send", method: "POST", path: "/gmail/v1/users/me/messages/send", params: compose, class: "outward" } },
  });
  const sendDigest = toolDigest(gmail, "send")!;
  const terms = (args: Record<string, string>) => ({ connector: "gmail", tool: "send", class: "outward" as const, args, until: NOW + 30 * DAY, digest: sendDigest, label: "Replies to Anna" });
  const send = (args: Record<string, unknown>) => ({ connector: "gmail", tool: "send", class: "outward", args: { body: "Thanks.", ...args }, by: "primary", digest: sendDigest, native: "gmail.send" });

  test("its recipients are named in full: to, and cc if it may copy anyone; never a pattern, never left free", () => {
    expect(orderProblems(terms({}), gmail, NOW)).toEqual(["an order to send mail names whom it may send to: pin to (and cc, if it may copy anyone), each address in full"]);
    for (const to of ["*@example.test", "anna@*", "*", "Anna <anna@example.test>", "anna"]) expect([to, orderProblems(terms({ to }), gmail, NOW)]).toEqual([to, ["to: name each address in full, comma-separated, with no *"]]);
    expect(orderProblems(terms({ to: "anna@example.test", cc: "*@example.test" }), gmail, NOW)).toEqual(["cc: name each address in full, comma-separated, with no *"]);
    expect(orderProblems(terms({ to: "anna@example.test" }), gmail, NOW)).toEqual([]);
    expect(orderProblems(terms({ to: "anna@example.test, Bob@Example.test", cc: "carl@example.test", subject: "Re: *" }), gmail, NOW)).toEqual([]);
  });

  test("it answers a send only to whom it names: every address in to and in cc, whatever their case and order", () => {
    const order = terms({ to: "anna@example.test, bob@example.test", cc: "carl@example.test" }) as OrderTerms;
    for (const args of [{ to: "anna@example.test" }, { to: "Bob@Example.test, anna@example.test" }, { to: "anna@example.test", cc: "carl@example.test" }, { to: "carl@example.test", cc: "bob@example.test" }]) {
      expect([args, orderCovers(order, send(args), NOW)]).toEqual([args, true]);
    }
    // Anyone else, in to or in cc, asks; and so does a recipient that isn't an address.
    for (const args of [{ to: "eve@example.test" }, { to: "anna@example.test, eve@example.test" }, { to: "anna@example.test", cc: "eve@example.test" }, { to: "Anna <anna@example.test>" }, { to: "" }]) {
      expect([args, orderCovers(order, send(args), NOW)]).toEqual([args, false]);
    }
    // Without cc it may copy nobody; and one that names nobody (signed before this) answers no send.
    const toAnna = terms({ to: "anna@example.test" }) as OrderTerms;
    expect([orderCovers(toAnna, send({ to: "anna@example.test" }), NOW), orderCovers(toAnna, send({ to: "anna@example.test", cc: "anna@example.test" }), NOW), orderCovers(toAnna, send({ to: "anna@example.test", cc: "bob@example.test" }), NOW)]).toEqual([true, true, false]);
    expect(orderCovers(terms({}) as OrderTerms, send({ to: "anna@example.test" }), NOW)).toBe(false);
    // Its other arguments are patterns as ever.
    expect(orderCovers(terms({ to: "anna@example.test", subject: "Re: *" }) as OrderTerms, send({ to: "anna@example.test", subject: "Hello" }), NOW)).toBe(false);
  });

  test("applied before 28 November 2026, it replays as it always did: each argument a pattern, the rest free", () => {
    const before = SENDS_NAME_RECIPIENTS_FROM - DAY;
    const old = { ...terms({ to: "anna@example.test" }), until: SENDS_NAME_RECIPIENTS_FROM + DAY } as OrderTerms;
    expect(orderCovers(old, send({ to: "anna@example.test", cc: "eve@example.test" }), before)).toBe(true);
    expect(orderCovers(old, send({ to: "anna@example.test", cc: "eve@example.test" }), SENDS_NAME_RECIPIENTS_FROM)).toBe(false);
    // The node holds what it applies now to both, so a replica reading it by either date agrees.
    expect(sendCovered(old, { to: "anna@example.test", cc: "eve@example.test" })).toBe(false);
    expect(mailAddresses("Anna@Example.test, bob@example.test")).toEqual(["anna@example.test", "bob@example.test"]);
    expect([mailAddresses("anna@*"), mailAddresses("Anna <anna@example.test>")]).toEqual([null, null]);
  });
});
