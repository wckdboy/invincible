import { expect, spyOn, test } from "bun:test";
import type { ConnectorRequestView, ConnectorView, RouteName } from "@invincible/core";
import { connectorCommand } from "../src/loop-cli.ts";

/* `invincible connector requests` and `connector dismiss` at a terminal, against what the node would answer. */

const github: ConnectorRequestView = { id: "cr_AAAAAAAAAAAAAAAAAAAAAA", connector: "github", access: false, agent: "team.0a1b2c3d4e.noa", label: "GitHub", why: "To read the failing checks on your pull request.", by: "Noa", at: 1, expires: 2 };
const slack: ConnectorRequestView = { id: "cr_BBBBBBBBBBBBBBBBBBBBBB", connector: "slack", access: false, agent: "primary", label: null, why: "To post the release notes.", by: "Your agent", at: 1, expires: 2 };
const gmail: ConnectorRequestView = { id: "cr_CCCCCCCCCCCCCCCCCCCCCC", connector: "gmail", access: true, agent: "team.0a1b2c3d4e.noa", label: "Gmail", why: "To find the invoice you forwarded.", by: "Noa", at: 1, expires: 2 };

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

test("what agents asked you to connect: who asked, which and why, and how to add each (one your agent ships, or as an MCP server)", async () => {
  const { api, asked } = node();
  const text = (await printed(() => connectorCommand(api, "requests", [], {}))).join("\n");
  expect(text).toContain("cr_AAAAAAAAAAAAAAAAAAAAAA  GitHub, asked by Noa");
  expect(text).toContain("why: To read the failing checks on your pull request.");
  expect(text).toContain("add it: invincible connector add github");
  expect(text).toContain("cr_BBBBBBBBBBBBBBBBBBBBBB  slack, asked by your agent");
  expect(text).toContain("invincible connector add slack --mcp <url>");
  expect(text).toContain("invincible connector dismiss <id>");
  expect(asked.map((a) => a.name)).toEqual(["connectorRequests"]);
});

test("with none asked it says so; dismissing one sends its id and adds nothing", async () => {
  const { api, asked } = node([]);
  expect((await printed(() => connectorCommand(api, "requests", [], {}))).join("\n")).toContain("No agent is asking for a connector");
  expect((await printed(() => connectorCommand(api, "dismiss", [github.id], {}))).join("\n")).toContain("Nothing was added");
  expect(asked.at(-1)).toEqual({ name: "dismissConnectorRequest", input: { id: github.id } });
  await expect(connectorCommand(api, "dismiss", [], {})).rejects.toThrow(/usage: invincible connector dismiss <request id>/);
});

test("an agent asking to use one that's your agent's alone: who, which and why, and the line that lets them", async () => {
  const { api, asked } = node([gmail]);
  const text = (await printed(() => connectorCommand(api, "requests", [], {}))).join("\n");
  expect(text).toContain("cr_CCCCCCCCCCCCCCCCCCCCCC  Gmail, Noa asks to use it");
  expect(text).toContain("let them: invincible connector allow gmail team.0a1b2c3d4e.noa");
  await printed(() => connectorCommand({ ...api, call: async <T,>(name: RouteName, input?: unknown) => (asked.push({ name, input }), { connector: { label: "Gmail" } } as T) }, "allow", ["gmail", "team.0a1b2c3d4e.noa"], {}));
  expect(asked.at(-1)).toEqual({ name: "setConnectorAccess", input: { id: "gmail", agent: "team.0a1b2c3d4e.noa", allow: true } });
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
  expect(added).toContain("invincible connector signin linear --redirect");
  expect(added).not.toContain("connector app");
  const listed = (await printed(() => connectorCommand(api, "ls", [], {}))).join("\n");
  expect(listed).toContain("not signed in: invincible connector signin linear");
  expect(listed).not.toContain("needs your app");
  const out = (await printed(() => connectorCommand(api, "signout", ["linear"], {}))).join("\n");
  expect(out).toContain("Signed out of Linear");
  expect(out).not.toContain("app you registered");
});

