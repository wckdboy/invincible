import { expect, spyOn, test } from "bun:test";
import type { ConnectorLibraryView, ConnectorRequestView, ConnectorView, RouteName } from "@galahad/core";
import { connectorCommand } from "../src/loop-cli.ts";

/* `galahad connector requests` and `connector dismiss` at a terminal, against what the node would answer. */

const github: ConnectorRequestView = { id: "cr_AAAAAAAAAAAAAAAAAAAAAA", connector: "github", access: false, agent: "team.0a1b2c3d4e.kay", label: "GitHub", why: "To read the failing checks on your pull request.", by: "Kay", at: 1, expires: 2 };
const slack: ConnectorRequestView = { id: "cr_BBBBBBBBBBBBBBBBBBBBBB", connector: "slack", access: false, agent: "galahad", label: null, why: "To post the release notes.", by: "Galahad", at: 1, expires: 2 };
const gmail: ConnectorRequestView = { id: "cr_CCCCCCCCCCCCCCCCCCCCCC", connector: "gmail", access: true, agent: "team.0a1b2c3d4e.kay", label: "Gmail", why: "To find the invoice you forwarded.", by: "Kay", at: 1, expires: 2 };

function node(requests: ConnectorRequestView[] = [github, slack]) {
  const asked: { name: RouteName; input: unknown }[] = [];
  const api = {
    async call<T>(name: RouteName, input?: unknown): Promise<T> {
      asked.push({ name, input });
      if (name === "connectorRequests") return { requests } as T;
      return { ok: true } as T;
    },
  };
  return { api, asked };
}

async function printed(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...parts: unknown[]) => void lines.push(parts.join(" ")));
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

test("what agents asked you to connect: who asked, which and why, and how to add each (one Galahad ships, or as an MCP server)", async () => {
  const { api, asked } = node();
  const text = (await printed(() => connectorCommand(api, "requests", [], {}))).join("\n");
  expect(text).toContain("cr_AAAAAAAAAAAAAAAAAAAAAA  GitHub, asked by Kay");
  expect(text).toContain("why: To read the failing checks on your pull request.");
  expect(text).toContain("add it: galahad connector add github");
  expect(text).toContain("cr_BBBBBBBBBBBBBBBBBBBBBB  slack, asked by Galahad");
  expect(text).toContain("galahad connector add slack --mcp <url>");
  expect(text).toContain("galahad connector dismiss <id>");
  expect(asked.map((a) => a.name)).toEqual(["connectorRequests"]);
});

test("with none asked it says so; dismissing one sends its id and adds nothing", async () => {
  const { api, asked } = node([]);
  expect((await printed(() => connectorCommand(api, "requests", [], {}))).join("\n")).toContain("No agent is asking for a connector");
  expect((await printed(() => connectorCommand(api, "dismiss", [github.id], {}))).join("\n")).toContain("Nothing was added");
  expect(asked.at(-1)).toEqual({ name: "dismissConnectorRequest", input: { id: github.id } });
  await expect(connectorCommand(api, "dismiss", [], {})).rejects.toThrow(/usage: galahad connector dismiss <request id>/);
});

test("an agent asking to use one that's Galahad's alone: who, which and why, and the line that lets them", async () => {
  const { api, asked } = node([gmail]);
  const text = (await printed(() => connectorCommand(api, "requests", [], {}))).join("\n");
  expect(text).toContain("cr_CCCCCCCCCCCCCCCCCCCCCC  Gmail, Kay asks to use it");
  expect(text).toContain("let them: galahad connector allow gmail team.0a1b2c3d4e.kay");
  await printed(() => connectorCommand({ ...api, call: async <T,>(name: RouteName, input?: unknown) => (asked.push({ name, input }), { connector: { label: "Gmail" } } as T) }, "allow", ["gmail", "team.0a1b2c3d4e.kay"], {}));
  expect(asked.at(-1)).toEqual({ name: "setConnectorAccess", input: { id: "gmail", agent: "team.0a1b2c3d4e.kay", allow: true } });
});


test("signing in at a terminal: the app's secret is asked for hidden, never a flag; the page or the code is shown, and it waits till you're in", async () => {
  const states = ["signed-out", "signed-out", "ready"];
  const asked: { name: RouteName; input: unknown }[] = [];
  const view = (key: string) => ({ id: "gmail", label: "Gmail", installed: true, key, oauth: { provider: "google", account: key === "ready" ? "you@example.com" : null } });
  const api = {
    async call<T>(name: RouteName, input?: unknown): Promise<T> {
      asked.push({ name, input });
      if (name === "connectors") return { connectors: [view(states.length > 1 ? states.shift()! : states[0]!)] } as T;
      if (name === "oauthStart") return { flow: "code", url: "https://accounts.example.test/auth?state=abc" } as T;
      return { connector: view("signed-out") } as T;
    },
  };
  const hidden: string[] = [];
  const app = await printed(() => connectorCommand(api, "app", ["gmail"], { "client-id": "client-id.apps.example" }, async (prompt) => (hidden.push(prompt), "test-secret-FAKE")));
  expect(hidden).toEqual(["Its client secret (hidden): "]);
  expect(asked.find((a) => a.name === "setOAuthApp")?.input).toEqual({ connector: "gmail", client: "client-id.apps.example", secret: "test-secret-FAKE" });
  expect(app.join("\n")).not.toContain("test-secret-FAKE");
  const signin = await printed(() => connectorCommand(api, "signin", ["gmail"], { redirect: "https://keep.example.test/oauth/callback" }, undefined, async () => {}));
  expect(signin.join("\n")).toContain("https://accounts.example.test/auth?state=abc");
  expect(signin.at(-1)).toBe("Signed in as you@example.com.");
  expect(asked.find((a) => a.name === "oauthStart")?.input).toEqual({ connector: "gmail", redirect: "https://keep.example.test/oauth/callback" });
  const out = await printed(() => connectorCommand(api, "signout", ["gmail"], {}));
  expect(out.join("\n")).toContain("Signed out of Gmail");
});

test("a hosted MCP server from the library at a terminal: added by its id, its sign-in next with no app of yours, and ls and signout say so", async () => {
  const linear = { id: "linear", label: "Linear", kind: "mcp", url: "https://mcp.linear.app/mcp", origin: "https://mcp.linear.app", installed: true, key: "missing", secret: "linear", oauth: { provider: "mcp", account: null }, tools: [], problem: null } as unknown as ConnectorView;
  const asked: { name: RouteName; input: unknown }[] = [];
  const api = {
    async call<T>(name: RouteName, input?: unknown): Promise<T> {
      asked.push({ name, input });
      if (name === "setConnector") return { connector: linear, discovered: { server: null, tools: 0, needsKey: false, needsSignIn: true, added: [], changed: [], removed: [], skipped: 0 } } as T;
      if (name === "connectors") return { connectors: [linear] } as T;
      if (name === "connectorRequests") return { requests: [] } as T;
      if (name === "oauthSignOut") return { connector: { ...linear, key: "signed-out" } } as T;
      return { ok: true } as T;
    },
  };
  const added = (await printed(() => connectorCommand(api, "add", ["linear"], {}))).join("\n");
  expect(asked[0]).toEqual({ name: "setConnector", input: { id: "linear" } });
  expect(added).toContain("galahad connector signin linear --redirect");
  expect(added).not.toContain("connector app");
  const listed = (await printed(() => connectorCommand(api, "ls", [], {}))).join("\n");
  expect(listed).toContain("not signed in: galahad connector signin linear");
  expect(listed).not.toContain("needs your app");
  const out = (await printed(() => connectorCommand(api, "signout", ["linear"], {}))).join("\n");
  expect(out).toContain("Signed out of Linear");
  expect(out).not.toContain("app you registered");
});

test("the library at a terminal: words, the kind (sign-in, key, open) and a shelf asked of the node; each server with how it lets Galahad in", async () => {
  const asked: { name: RouteName; input: unknown }[] = [];
  const page: ConnectorLibraryView = {
    entries: [
      { id: "stripe", label: "Stripe", description: "Customers, payments, subscriptions and invoices.", url: "https://mcp.stripe.com", site: "stripe.com", category: "Commerce & payments", auth: "oauth", rank: 214, registry: "", updated: "", reviewed: true, installed: false },
      { id: "acme-builds", label: "Acme Builds", description: "Builds.", url: "https://mcp.acme.example/mcp", site: "acme.example", category: "Developer tools", auth: "key", header: "X-API-Key", rank: 900, registry: "example.acme/mcp", updated: "", installed: true },
    ],
    total: 2,
    categories: [],
    index: { url: "https://mcp.galahad.sh/v1/library.json", fetched: 1, count: 1540, problem: null },
  };
  const api = { call: async <T,>(name: RouteName, input?: unknown) => (asked.push({ name, input }), page as T) };
  const text = (await printed(() => connectorCommand(api, "library", ["pay", "ments"], { auth: "sign-in", category: "Commerce & payments", sort: "name" }))).join("\n");
  expect(asked[0]).toEqual({ name: "connectorLibrary", input: { q: "pay ments", auth: "oauth", category: "Commerce & payments", sort: "name", limit: 30 } });
  expect(text).toContain("stripe");
  expect(text).toContain("sign in");
  expect(text).toContain("reviewed");
  expect(text).toContain("a key");
  expect(text).toContain("installed");
  expect(text).toContain("galahad connector add <id>");
  await expect(connectorCommand(api, "library", [], { auth: "maybe" })).rejects.toThrow("--auth is sign-in, key or open");
});
