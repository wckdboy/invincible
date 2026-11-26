import { describe, expect, test } from "bun:test";
import { argStrings, buildCall, buildRequest, ConnectorArgs, ConnectorError, ConnectorManifest, isPrivateHost, localToolName, proposedClass } from "../src/index.ts";

const base = {
  id: "forge",
  label: "Forge",
  origin: "https://api.forge.test",
  auth: { secret: "forge", scheme: "bearer" as const },
  tools: {
    repo: {
      description: "A repo.",
      method: "GET" as const,
      path: "/repos/{owner}/{repo}",
      params: { owner: { type: "string" as const, pattern: "[a-z0-9-]{1,40}" }, repo: { type: "string" as const } },
      class: "read" as const,
    },
    issues: {
      description: "Issues.",
      method: "GET" as const,
      path: "/issues",
      params: { state: { type: "string" as const, enum: ["open", "closed"] }, per_page: { type: "integer" as const } },
      class: "read" as const,
    },
    open: {
      description: "Open an issue.",
      method: "POST" as const,
      path: "/repos/{owner}/issues",
      params: { owner: { type: "string" as const }, title: { type: "string" as const, required: true }, draft: { type: "boolean" as const } },
      class: "outward" as const,
    },
  },
};
const forge = ConnectorManifest.parse(base);
const withTool = (tool: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ConnectorManifest.safeParse({ ...base, ...extra, tools: { t: { description: "t", ...tool } } });

describe("connector manifests", () => {
  test("the HTTP method bounds the oath class a tool may claim", () => {
    expect(withTool({ method: "GET", path: "/x", class: "read" }).success).toBe(true);
    expect(withTool({ method: "GET", path: "/x", class: "delete" }).success).toBe(false);
    expect(withTool({ method: "DELETE", path: "/x", class: "modify" }).success).toBe(false);
    expect(withTool({ method: "DELETE", path: "/x", class: "delete" }).success).toBe(true);
    expect(withTool({ method: "POST", path: "/x", class: "read" }).success).toBe(false);
    expect(withTool({ method: "POST", path: "/x", class: "create" }).success).toBe(true);
  });

  test("paths are plain templates: every placeholder declared, no dot segments", () => {
    expect(withTool({ method: "GET", path: "/a/{b}", class: "read" }).success).toBe(false);
    expect(withTool({ method: "GET", path: "/a/{b}", params: { b: { type: "string", in: "query" } }, class: "read" }).success).toBe(false);
    expect(withTool({ method: "GET", path: "/a/../b", class: "read" }).success).toBe(false);
    expect(withTool({ method: "GET", path: "//evil.test/b", class: "read" }).success).toBe(false);
    expect(withTool({ method: "GET", path: "/a/{b", class: "read" }).success).toBe(false);
    expect(withTool({ method: "GET", path: "relative", class: "read" }).success).toBe(false);
    expect(withTool({ method: "GET", path: "/a", params: { q: { type: "string", in: "body" } }, class: "read" }).success).toBe(false);
  });

  test("a manifest never carries credentials or steers routing", () => {
    for (const header of ["Authorization", "Cookie", "Host", "Proxy-Authorization"]) {
      expect(withTool({ method: "GET", path: "/x", class: "read" }, { headers: { [header]: "x" } }).success).toBe(false);
    }
    expect(withTool({ method: "GET", path: "/x", class: "read" }, { headers: { "x-token": "ghp_0123456789abcdefghijABCDEFGHIJ0123456789" } }).success).toBe(false);
    expect(withTool({ method: "GET", path: "/x", class: "read" }, { headers: { accept: "application/vnd.github+json" } }).success).toBe(true);
    expect(withTool({ method: "GET", path: "/x", class: "read" }, { auth: { secret: "forge", scheme: "header" } }).success).toBe(false);
  });

  test("origins are https, or plain http on this machine and private networks", () => {
    for (const origin of ["https://api.github.com", "http://127.0.0.1:8123", "http://homeassistant.local:8123", "http://192.168.1.20", "http://100.101.102.103:7777"]) {
      expect(withTool({ method: "GET", path: "/x", class: "read" }, { origin }).success).toBe(true);
    }
    for (const origin of ["http://api.github.com", "https://api.github.com/v3", "ftp://x.test", "https://a.test?x=1", "javascript:alert(1)"]) {
      expect(withTool({ method: "GET", path: "/x", class: "read" }, { origin }).success).toBe(false);
    }
    expect(isPrivateHost("172.20.0.1")).toBe(true);
    expect(isPrivateHost("172.32.0.1")).toBe(false);
    expect(isPrivateHost("8.8.8.8")).toBe(false);
  });
});

describe("building a request", () => {
  test("arguments fill the path, the query or the JSON body", () => {
    expect(buildRequest(forge, "repo", { owner: "amiriteorg", repo: "galahad" })).toMatchObject({
      method: "GET",
      url: "https://api.forge.test/repos/amiriteorg/galahad",
      class: "read",
      target: "GET /repos/amiriteorg/galahad",
    });
    expect(buildRequest(forge, "issues", { state: "open", per_page: 5 }).url).toBe("https://api.forge.test/issues?state=open&per_page=5");
    const open = buildRequest(forge, "open", { owner: "amiriteorg", title: "Hello", draft: true });
    expect(open).toMatchObject({ method: "POST", class: "outward", url: "https://api.forge.test/repos/amiriteorg/issues" });
    expect(JSON.parse(open.body!)).toEqual({ title: "Hello", draft: true });
  });

  test("hostile values stay inside their path segment and never leave the origin", () => {
    const sneaky = ConnectorManifest.parse({ ...base, tools: { t: { description: "t", method: "GET", path: "/{a}/x", params: { a: { type: "string" } }, class: "read" } } });
    for (const value of ["../admin", "@evil.test", "a/../../b", "%2e%2e", "x?y=1#z", "\\\\evil.test"]) {
      const built = buildRequest(sneaky, "t", { a: value });
      expect(new URL(built.url).origin).toBe("https://api.forge.test");
      expect(new URL(built.url).pathname.split("/")).toHaveLength(3);
    }
    expect(() => buildRequest(sneaky, "t", { a: ".." })).toThrow(ConnectorError);
    expect(() => buildRequest(sneaky, "t", { a: "." })).toThrow(ConnectorError);
    expect(() => buildRequest(sneaky, "t", { a: "" })).toThrow(ConnectorError);
  });

  test("arguments are checked against the tool's params", () => {
    expect(() => buildRequest(forge, "nope")).toThrow(/has no tool/);
    expect(() => buildRequest(forge, "repo", { owner: "a", repo: "b", extra: "x" })).toThrow(/takes no "extra"/);
    expect(() => buildRequest(forge, "repo", { owner: "a" })).toThrow(/needs repo/);
    expect(() => buildRequest(forge, "repo", { owner: "Not Allowed!", repo: "b" })).toThrow(/doesn't match/);
    expect(() => buildRequest(forge, "repo", { owner: "a\nb", repo: "b" })).toThrow(/doesn't match/);
    expect(() => buildRequest(forge, "issues", { state: "merged" })).toThrow(/one of/);
    expect(() => buildRequest(forge, "issues", { per_page: 1.5 })).toThrow(/whole number/);
    expect(() => buildRequest(forge, "open", { owner: "a" })).toThrow(/needs title/);
    expect(() => buildRequest(forge, "open", { owner: "a", title: "t", draft: "yes" })).toThrow(/true or false/);
    expect(() => buildRequest(forge, "toString")).toThrow(/has no tool/);
  });
});

describe("MCP connectors", () => {
  const tracker = ConnectorManifest.parse({
    id: "tracker",
    label: "Tracker",
    origin: "https://mcp.tracker.example",
    mcp: { path: "/mcp" },
    tools: {
      create_issue: {
        remote: "createIssue",
        description: "Open an issue.",
        params: { repo: { type: "string", required: true }, labels: { type: "array" }, priority: { type: "integer|null" } },
        class: "outward",
        schema: "abc",
      },
    },
  });

  test("an MCP manifest has a path and server tools only; none yet is fine", () => {
    expect(ConnectorManifest.safeParse({ ...tracker, tools: {} }).success).toBe(true);
    expect(ConnectorManifest.safeParse({ ...tracker, mcp: { path: "/mcp?key=1" } }).success).toBe(false);
    expect(ConnectorManifest.safeParse({ ...tracker, basePath: "/v1" }).success).toBe(false);
    const mixed = { ...tracker, tools: { ...tracker.tools, raw: { description: "x", method: "GET", path: "/x", class: "read" } } };
    expect(ConnectorManifest.safeParse(mixed).success).toBe(false);
    // ...and request templates can't carry server tools.
    const { mcp: _mcp, ...http } = tracker;
    expect(ConnectorManifest.safeParse(http).success).toBe(false);
  });

  test("a call is one tools/call with checked arguments; nested values are fine", () => {
    const call = buildCall(tracker, "create_issue", { repo: "amiriteorg/galahad", labels: ["a", "b"] });
    expect(call).toEqual({
      kind: "mcp",
      remote: "createIssue",
      args: { repo: "amiriteorg/galahad", labels: ["a", "b"] },
      class: "outward",
      target: 'mcp createIssue {"labels":["a","b"],"repo":"amiriteorg/galahad"}',
    });
    expect(() => buildCall(tracker, "create_issue", {})).toThrow(/needs repo/);
    expect(() => buildCall(tracker, "create_issue", { repo: "x", labels: "a" })).toThrow(/labels must be array/);
    expect(() => buildCall(tracker, "create_issue", { repo: "x", priority: 2 })).not.toThrow();
    expect(() => buildCall(tracker, "create_issue", { repo: "x", nope: 1 })).toThrow(/takes no "nope"/);
    expect(() => buildRequest(tracker, "create_issue", { repo: "x" })).toThrow(/MCP server/);
  });

  test("arguments: bounded in size, and every string is found for the secret scan", () => {
    expect(ConnectorArgs.safeParse({ text: "x".repeat(40_000) }).success).toBe(false);
    expect(argStrings({ a: "one", b: [{ c: "two" }, 3] })).toEqual(["a", "one", "b", "c", "two"]);
  });

  test("server names become safe local names; hints only propose a class", () => {
    const taken = new Set<string>();
    expect(localToolName("createIssue", taken)).toBe("create_issue");
    taken.add("create_issue");
    expect(localToolName("create-issue!", new Set())).toBe("create-issue_");
    expect(localToolName("createIssue", taken)).toBe("create_issue_2");
    expect(localToolName("42", new Set())).toBe("tool");
    expect(proposedClass({ readOnly: true })).toBe("read");
    expect(proposedClass({ destructive: true })).toBe("delete");
    expect(proposedClass({})).toBe("outward");
    expect(proposedClass(undefined)).toBe("outward");
  });
});

describe("native tools", () => {
  const ship = {
    description: "Ship a quest's changes as a pull request.",
    native: "github.ship" as const,
    method: "POST" as const,
    path: "/repos/{owner}/{repo}/pulls",
    params: {
      owner: { type: "string" as const, pattern: "[A-Za-z0-9_.-]{1,100}", required: true },
      repo: { type: "string" as const, pattern: "[A-Za-z0-9_.-]{1,100}", required: true },
      artifact: { type: "string" as const, pattern: "art_[A-Za-z0-9_-]{22}", required: true },
      branch: { type: "string" as const, pattern: "galahad/[A-Za-z0-9._-]{1,80}", required: true },
      title: { type: "string" as const, required: true },
    },
    class: "outward" as const,
  };
  const github = ConnectorManifest.parse({ ...base, id: "github", origin: "https://api.github.com", tools: { ship } });
  const args = { owner: "amiriteorg", repo: "galahad", artifact: "art_AAAAAAAAAAAAAAAAAAAAAA", branch: "galahad/units", title: "Units" };

  test("a manifest can name one, only on the origin it's bound to", () => {
    const elsewhere = ConnectorManifest.safeParse({ ...base, tools: { ship } });
    expect(elsewhere.success).toBe(false);
    expect(JSON.stringify(elsewhere.error?.issues)).toContain("github.ship only talks to https://api.github.com");
    expect(ConnectorManifest.safeParse({ ...base, id: "github", origin: "https://api.github.com", tools: { ship: { ...ship, native: "rm.everything" } } }).success).toBe(false);
  });

  test("its arguments are checked like any tool's; it's never a single request", () => {
    expect(buildCall(github, "ship", args)).toEqual({ kind: "native", native: "github.ship", args, class: "outward", target: "POST /repos/amiriteorg/galahad/pulls (ship)" });
    expect(() => buildCall(github, "ship", { ...args, branch: "main" })).toThrow(/branch doesn't match/);
    expect(() => buildCall(github, "ship", { ...args, force: true })).toThrow(/takes no "force"/);
    expect(() => buildRequest(github, "ship", args)).toThrow(/carried out by Galahad/);
  });
});
