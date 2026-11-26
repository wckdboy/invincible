import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ActionView, APPROVAL_TTL_MS, b64u, type ConnectorView, decodeHlc, HlcClock, type LoopRunView, type LoopView, newNodeIdentity, type NoticeView, type OrderView, type RouteName, routes, MCP_LIBRARY } from "@galahad/core";
import { enrollDevice, foundFleet, MindStore, Vault } from "@galahad/mind";
import type { Capabilities } from "../src/capabilities.ts";
import { ConnectorService } from "../src/connectors.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { freePort } from "./ports.ts";

/*
 * Connectors, approvals and loops, end to end over real HTTP: a stand-in service,
 * a node, you (the admin token) and a coding agent (an arm token). Reads and
 * creates just happen; outward and delete wait for you and are sent exactly once.
 */

const caps: Capabilities = {
  os: "linux",
  arch: "x64",
  hostname: "connector-test",
  cores: 4,
  cpu: "test",
  memoryGb: 8,
  hasBattery: false,
  gpu: [],
  docker: false,
  vm: { kvm: false, tools: [] },
  tools: [],
  localModels: [],
  tailscale: null,
};

async function until<T>(check: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(40);
  }
}

const KEY = "forge_e2e_key_0123456789abcdef";
const root = mkdtempSync(join(tmpdir(), "galahad-connectors-"));
const home = new Home(join(root, "node"));
const port = freePort();
let daemon: Daemon;
let upstream: ReturnType<typeof Bun.serve>;
let origin: string;
let armToken: string;
const hits: { method: string; path: string; auth: string | null; body: string }[] = [];

function manifest(id = "forge") {
  return {
    id,
    label: "Forge",
    origin,
    auth: { secret: "forge", scheme: "bearer" },
    tools: {
      me: { description: "Who am I.", method: "GET", path: "/user", class: "read" },
      echo: { description: "Echo back.", method: "GET", path: "/echo", class: "read" },
      bounce: { description: "Redirects away.", method: "GET", path: "/bounce", class: "read" },
      post: { description: "Post publicly.", method: "POST", path: "/posts", params: { text: { type: "string", required: true } }, class: "outward" },
      "bucket.create": { description: "Create a bucket.", method: "POST", path: "/buckets", params: { name: { type: "string", required: true } }, class: "create" },
      "bucket.delete": { description: "Delete a bucket.", method: "DELETE", path: "/buckets/{name}", params: { name: { type: "string" } }, class: "delete" },
    },
  };
}

async function as<T = any>(token: string, name: RouteName, input?: unknown): Promise<{ status: number; body: T }> {
  const route = routes[name];
  const response = await fetch(`http://127.0.0.1:${port}${route.path}`, {
    method: route.method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined,
  });
  return { status: response.status, body: (await response.json()) as T };
}
const admin = <T = any>(name: RouteName, input?: unknown) => as<T>(home.adminToken(), name, input);
const arm = <T = any>(name: RouteName, input?: unknown) => as<T>(armToken, name, input);
const posts = () => hits.filter((h) => h.method === "POST" && h.path === "/posts");

beforeAll(async () => {
  upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      hits.push({ method: req.method, path: url.pathname, auth: req.headers.get("authorization"), body: await req.text() });
      if (url.pathname === "/bounce") return new Response(null, { status: 302, headers: { location: "https://evil.test/steal" } });
      if (url.pathname === "/echo") return Response.json({ youSent: req.headers.get("authorization") });
      if (req.method === "POST") return Response.json({ created: true }, { status: 201 });
      if (req.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({ login: "galahad" });
    },
  });
  origin = `http://127.0.0.1:${upstream.port}`;

  const { identity, keystore } = await home.createIdentity("file");
  const store = new MindStore(home.mindPath);
  const fleet = foundFleet(store, identity, { fleetName: "camelot", nodeName: "ultra" });
  store.close();
  home.writeConfig({ v: 1, name: "ultra", fleet, port, keystore, advertise: "127.0.0.1" });
  daemon = await startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {} });
  armToken = (await admin<{ token: string }>("mintArm", { label: "test-arm" })).body.token;
});

afterAll(async () => {
  await daemon?.stop();
  upstream?.stop(true);
  rmSync(root, { recursive: true, force: true });
});

describe("connectors", () => {
  test("the catalog is listed, a manifest of your own installs, and an invalid one is refused with why", async () => {
    const before = (await admin<{ connectors: ConnectorView[] }>("connectors")).body.connectors;
    expect(before.filter((c) => c.kind === "http").map((c) => c.id)).toEqual(["cloudflare", "gdrive", "github", "gmail", "home-assistant", "outlook"]);
    // (And the library's hosted MCP servers, each one tap away.)
    expect(before.filter((c) => c.kind === "mcp").map((c) => c.id)).toEqual(MCP_LIBRARY.map((entry) => entry.id).sort());
    expect(before.every((c) => !c.installed)).toBe(true);

    const bad = await admin("setConnector", { id: "forge", manifest: { ...manifest(), tools: { x: { description: "x", method: "DELETE", path: "/x", class: "read" } } } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/DELETE can't be class read/);
    expect((await arm("setConnector", { id: "forge", manifest: manifest() })).status).toBe(403); // agents can't install

    const installed = await admin<{ connector: ConnectorView }>("setConnector", { id: "forge", manifest: manifest() });
    expect(installed.status).toBe(200);
    expect(installed.body.connector).toMatchObject({ installed: true, key: "missing", origin });
    expect(installed.body.connector.tools.find((t) => t.name === "post")).toMatchObject({ class: "outward", asks: true });
  });

  test("every connector Galahad ships installs, and so does one more GitHub owner: the vault name a manifest gives is a name, not a key", async () => {
    // Cloudflare and Home Assistant were refused as "a password assignment": the check for pasted keys read
    // "secret":"cloudflare" (the name of its vault entry) as one. GitHub only passed because its name is short.
    for (const [id, extra] of [["cloudflare", {}], ["home-assistant", { origin: "http://homeassistant.local:8123" }], ["gmail", {}], ["outlook", {}]] as const) {
      const installed = await admin("setConnector", { id, ...extra });
      expect([id, installed.status, installed.body.error]).toEqual([id, 200, undefined]);
      await admin("removeConnector", { id });
    }
    const github = (await admin<{ connectors: ConnectorView[] }>("connectors")).body.connectors.find((c) => c.id === "github")!;
    const another = { ...manifest("github-acme"), label: "GitHub (acme)", auth: { secret: "github-acme", scheme: "bearer" } };
    expect((await admin("setConnector", { id: "github-acme", manifest: another })).status).toBe(200);
    expect(github.installed).toBe(false);
    await admin("removeConnector", { id: "github-acme" });
    // A key pasted where the name goes is still a key, and refused.
    const pasted = await admin("setConnector", { id: "forge-two", manifest: { ...manifest("forge-two"), auth: { secret: "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB", scheme: "bearer" } } });
    expect(pasted.status).toBe(422);
  });

  test("one that's Galahad's alone (mail): another agent asks first; you allow it, it may; you stop it, it asks again", async () => {
    const mailbox = { ...manifest("mailbox"), label: "Mailbox", auth: { secret: "mailbox", scheme: "bearer" }, access: { only: "galahad", allowed: [] }, private: true };
    expect((await admin("setConnector", { id: "mailbox", manifest: mailbox })).status).toBe(200);
    const listed = (await admin<{ connectors: ConnectorView[] }>("connectors")).body.connectors.find((c) => c.id === "mailbox")!;
    expect(listed).toMatchObject({ access: { only: "galahad", allowed: [] }, private: true });
    const refused = await arm("callConnector", { connector: "mailbox", tool: "me" });
    expect([refused.status, refused.body.error]).toEqual([403, "Mailbox is Galahad's alone: ask your liege to let you use it (connector_request), and use it once they do"]);
    // It asks to use it: the request says so, and who.
    expect((await arm("requestConnector", { connector: "mailbox", why: "To read the invoice you forwarded." })).status).toBe(200);
    const asked = (await admin<{ requests: { connector: string; access: boolean; agent: string; id: string }[] }>("connectorRequests")).body.requests.find((r) => r.connector === "mailbox")!;
    expect(asked).toMatchObject({ access: true, agent: "test-arm" });
    // An agent can't let itself in.
    expect((await arm("setConnectorAccess", { id: "mailbox", agent: "test-arm", allow: true })).status).toBe(403);
    expect((await admin("setConnectorAccess", { id: "mailbox", agent: "test-arm", allow: true })).status).toBe(200);
    expect((await admin<{ requests: { connector: string }[] }>("connectorRequests")).body.requests.some((r) => r.connector === "mailbox")).toBe(false);
    // Allowed, it gets past who may: here only to its missing key (424), never to "Galahad's alone" (403).
    expect((await arm("callConnector", { connector: "mailbox", tool: "me" })).status).toBe(424);
    expect((await admin("setConnectorAccess", { id: "mailbox", agent: "test-arm", allow: false })).status).toBe(200);
    expect((await arm("callConnector", { connector: "mailbox", tool: "me" })).status).toBe(403);
    // You are never asked: a call of yours is yours.
    expect((await admin("callConnector", { connector: "mailbox", tool: "me" })).status).not.toBe(403);
    // Every agent may use one that isn't anybody's alone: nothing to allow.
    expect((await admin("setConnectorAccess", { id: "forge", agent: "test-arm", allow: true })).status).toBe(400);
    await admin("removeConnector", { id: "mailbox" });
  });

  test("without its key a call fails, sends nothing, and files a secret request", async () => {
    const response = await admin("callConnector", { connector: "forge", tool: "me" });
    expect(response.status).toBe(424);
    expect(hits).toHaveLength(0);
    const { requests } = (await admin<{ requests: { name: string; provider: string }[] }>("secretRequests")).body;
    expect(requests).toContainEqual(expect.objectContaining({ name: "forge", provider: "forge" }));
  });

  test("with its key, reads run at once with the key injected, and are ledgered", async () => {
    // Filling the request the connector filed pins the key to the connector's origin.
    expect((await admin("setSecret", { name: "forge", value: KEY, provider: "forge" })).status).toBe(200);
    expect((await admin<{ connectors: ConnectorView[] }>("connectors")).body.connectors.find((c) => c.id === "forge")!.key).toBe("ready");
    const me = await arm<{ status: string; result: { status: number; body: string } }>("callConnector", { connector: "forge", tool: "me" });
    expect(me.body.status).toBe("done");
    expect(JSON.parse(me.body.result.body)).toEqual({ login: "galahad" });
    expect(hits.at(-1)).toMatchObject({ method: "GET", path: "/user", auth: `Bearer ${KEY}` });
    const { entries } = (await admin<{ entries: { resource: string; verdict: string; class: string; detail: string }[] }>("ledger")).body;
    expect(entries[0]).toMatchObject({ resource: "connector.forge", class: "read", verdict: "allow" });
    expect(entries[0]!.detail).toContain("by arm:test-arm");
  });

  test("the key never comes back: echoed keys are redacted, redirects aren't followed", async () => {
    const echo = await arm<{ result: { body: string } }>("callConnector", { connector: "forge", tool: "echo" });
    expect(echo.body.result.body).not.toContain(KEY);
    const bounce = await arm<{ result: { status: number } }>("callConnector", { connector: "forge", tool: "bounce" });
    expect(bounce.body.result.status).toBe(302);
    expect(hits.filter((h) => h.path === "/steal")).toHaveLength(0);
  });

  test("an argument that looks like a key is refused before anything is sent", async () => {
    const response = await arm("callConnector", { connector: "forge", tool: "post", args: { text: "ghp_0123456789abcdefghijABCDEFGHIJ0123456789" } });
    expect(response.status).toBe(422);
  });

  test("a service's own ids aren't keys: a Drive file or folder by its id is asked for (here, before any sign-in, it can't be); a key still can't", async () => {
    expect((await admin("setConnector", { id: "gdrive" })).status).toBe(200);
    const id = "1wvUWlyaIe7610BS3JpoTY7JC7UIdxi1U";
    for (const [tool, args] of [["file", { id }], ["files", { q: `'${id}' in parents and trashed = false` }]] as const) {
      const asked = await admin("callConnector", { connector: "gdrive", tool, args });
      expect([tool, asked.status, asked.body.error]).toEqual([tool, 424, expect.stringContaining("needs the app you registered")]);
    }
    expect((await admin("callConnector", { connector: "gdrive", tool: "files", args: { q: "name contains 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'" } })).status).toBe(422);
    await admin("removeConnector", { id: "gdrive" });
  });

  test("creating is Galahad's to do: an agent's create runs at once", async () => {
    const created = await arm<{ status: string }>("callConnector", { connector: "forge", tool: "bucket.create", args: { name: "galahad-cache" } });
    expect(created.body.status).toBe("done");
    expect(hits.at(-1)).toMatchObject({ method: "POST", path: "/buckets", body: JSON.stringify({ name: "galahad-cache" }) });
  });

  test("outward: an agent's call waits for you, and is sent exactly once after you approve", async () => {
    const asked = await arm<{ status: string; action: string }>("callConnector", { connector: "forge", tool: "post", args: { text: "Hello, world" }, why: "announce the release" });
    expect(asked.body.status).toBe("asked");
    expect(posts()).toHaveLength(0);

    const waiting = (await admin<{ actions: ActionView[] }>("actions")).body.actions.find((a) => a.id === asked.body.action)!;
    expect(waiting).toMatchObject({ state: "waiting", class: "outward", by: "arm:test-arm", why: "announce the release", target: "POST /posts" });
    // The agent can't answer its own request.
    expect((await arm("decideAction", { id: asked.body.action, approve: true })).status).toBe(403);

    const decided = await admin<{ action: ActionView }>("decideAction", { id: asked.body.action, approve: true });
    expect(decided.status).toBe(200);
    await daemon.connectors.drain();
    const done = await until(async () => (await admin<{ actions: ActionView[] }>("actions")).body.actions.find((a) => a.id === asked.body.action && a.state === "done"));
    expect(done.receipt).toContain("201");
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(posts()[0]!.body)).toEqual({ text: "Hello, world" });

    // Answering again changes nothing, and draining again sends nothing.
    expect((await admin("decideAction", { id: asked.body.action, approve: true })).status).toBe(409);
    await daemon.connectors.drain();
    expect(posts()).toHaveLength(1);
  });

  test("delete: declined means never sent", async () => {
    const asked = await arm<{ status: string; action: string }>("callConnector", { connector: "forge", tool: "bucket.delete", args: { name: "galahad-cache" } });
    expect(asked.body.status).toBe("asked");
    await admin("decideAction", { id: asked.body.action, approve: false, note: "keep it" });
    await daemon.connectors.drain();
    expect(hits.filter((h) => h.method === "DELETE")).toHaveLength(0);
    expect((await admin<{ actions: ActionView[] }>("actions")).body.actions.find((a) => a.id === asked.body.action)!.state).toBe("denied");
  });

  test("you asking is the approval: your own outward call runs, ledgered as approved", async () => {
    const mine = await admin<{ status: string }>("callConnector", { connector: "forge", tool: "post", args: { text: "from me" } });
    expect(mine.body.status).toBe("done");
    expect(posts()).toHaveLength(2);
    const { entries } = (await admin<{ entries: { verdict: string; reason: string }[] }>("ledger")).body;
    expect(entries[0]).toMatchObject({ verdict: "approved", reason: "you asked for it" });
  });

  test("you may put your own words in it before you approve: your version is sent once, and the one it was asked as is declined, saying which it became", async () => {
    const asked = await arm<{ status: string; action: string }>("callConnector", { connector: "forge", tool: "post", args: { text: "Helo, wrold" }, why: "announce the release" });
    expect(asked.body.status).toBe("asked");
    const before = posts().length;
    // An edit goes with a yes, and only to text it already has.
    expect((await admin("decideAction", { id: asked.body.action, approve: false, edits: { text: "x" } })).status).toBe(400);
    expect((await admin("decideAction", { id: asked.body.action, approve: true, edits: { title: "new" } })).status).toBe(400);
    // A key typed into it is refused, as in any call, and nothing is decided. (A fake one, put together here so the
    // repository holds no token-shaped text for secret scanners to stop at.)
    const typedKey = ["ghp", "0123456789abcdefghijABCDEFGHIJ0123456789"].join("_");
    expect((await admin("decideAction", { id: asked.body.action, approve: true, edits: { text: typedKey } })).status).toBe(422);
    expect((await admin<{ actions: ActionView[] }>("actions")).body.actions.find((a) => a.id === asked.body.action)!.state).toBe("waiting");
    // The agent can't edit its own request into a yes.
    expect((await arm("decideAction", { id: asked.body.action, approve: true, edits: { text: "mine" } })).status).toBe(403);

    const decided = await admin<{ action: ActionView }>("decideAction", { id: asked.body.action, approve: true, edits: { text: "Hello, world" } });
    expect(decided.status).toBe(200);
    const yours = decided.body.action;
    expect(yours.id).not.toBe(asked.body.action);
    expect(yours).toMatchObject({ connector: "forge", tool: "post", args: { text: "Hello, world" }, class: "outward", by: "arm:test-arm" });
    expect(yours.why).toBe(`announce the release (edited by you from ${asked.body.action})`);
    await daemon.connectors.drain();
    await until(async () => (await admin<{ actions: ActionView[] }>("actions")).body.actions.find((a) => a.id === yours.id && a.state === "done"));
    expect(posts()).toHaveLength(before + 1);
    expect(JSON.parse(posts().at(-1)!.body)).toEqual({ text: "Hello, world" });
    const original = (await admin<{ actions: ActionView[] }>("actions")).body.actions.find((a) => a.id === asked.body.action)!;
    expect(original).toMatchObject({ state: "denied", note: `you edited it: sent as ${yours.id}` });
    // Neither is answered again, and nothing more is sent.
    expect((await admin("decideAction", { id: asked.body.action, approve: true })).status).toBe(409);
    await daemon.connectors.drain();
    expect(posts()).toHaveLength(before + 1);
  });
});

describe("while you were away (PLAN #37)", () => {
  test("the node says what happened since a time, and what waits for you now, to you alone", async () => {
    const since = Date.now() - 60_000;
    const away = await admin<{ since: number; lines: { text: string; tone: string }[] }>("away", { since });
    expect(away.status).toBe(200);
    expect(away.body.since).toBe(since);
    expect(Array.isArray(away.body.lines)).toBe(true);
    for (const line of away.body.lines) expect(["ok", "warn", "danger", "neutral"]).toContain(line.tone);
    // An agent never reads what you were told while you were away.
    expect((await arm("away", { since })).status).toBe(403);
  });
});

describe("standing orders", () => {
  test("only you sign them, and they must be narrow", async () => {
    expect((await arm("setOrder", { connector: "forge", tool: "post", args: {}, label: "anything" })).status).toBe(403);
    const wide = await admin("setOrder", { connector: "forge", tool: "bucket.delete", args: { name: "galahad-*" }, label: "scratch buckets" });
    expect(wide.status).toBe(400);
    expect(wide.body.error).toMatch(/names exactly one thing/);
    const reads = await admin("setOrder", { connector: "forge", tool: "me", args: {}, label: "reads" });
    expect(reads.body.error).toMatch(/needs no order/);
    const secret = await admin("setOrder", { connector: "forge", tool: "post", args: { text: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" }, label: "x" });
    expect(secret.status).toBe(422);
  });

  test("a call an order covers is sent at once, recorded as answered by that order; others still ask", async () => {
    const signed = await admin<{ order: OrderView }>("setOrder", {
      connector: "forge",
      tool: "post",
      args: { text: "Release notes: *" },
      callers: ["test-arm"],
      days: 7,
      label: "Post release notes",
    });
    expect(signed.status).toBe(200);
    expect(signed.body.order).toMatchObject({ state: "active", class: "outward", uses: 0, callers: ["test-arm"] });
    const before = posts().length;

    const covered = await arm<{ status: string; order: { label: string }; action: string; result: { status: number } }>("callConnector", {
      connector: "forge",
      tool: "post",
      args: { text: "Release notes: 0.3" },
    });
    expect(covered.body).toMatchObject({ status: "done", order: { label: "Post release notes" }, result: { status: 201 } });
    expect(posts()).toHaveLength(before + 1);
    const action = (await admin<{ actions: ActionView[] }>("actions")).body.actions.find((a) => a.id === covered.body.action)!;
    expect(action).toMatchObject({ state: "done", order: { id: signed.body.order.id, label: "Post release notes" } });
    const { entries } = (await admin<{ entries: { reason: string }[] }>("ledger")).body;
    expect(entries[0]!.reason).toBe('sent under your standing order "Post release notes"');
    expect((await admin<{ orders: OrderView[] }>("orders")).body.orders.find((o) => o.id === signed.body.order.id)).toMatchObject({ uses: 1 });

    // Off-pattern, or a caller the order doesn't name: still asks, nothing sent.
    const off = await arm<{ status: string }>("callConnector", { connector: "forge", tool: "post", args: { text: "Buy now!" } });
    expect(off.body.status).toBe("asked");
    const other = (await admin<{ token: string }>("mintArm", { label: "other-arm" })).body.token;
    expect((await as<{ status: string }>(other, "callConnector", { connector: "forge", tool: "post", args: { text: "Release notes: 0.4" } })).body.status).toBe("asked");
    expect(posts()).toHaveLength(before + 1);

    // Revoked: asks again.
    const revoked = await admin<{ order: OrderView }>("revokeOrder", { id: signed.body.order.id });
    expect(revoked.body.order.state).toBe("revoked");
    expect((await arm<{ status: string }>("callConnector", { connector: "forge", tool: "post", args: { text: "Release notes: 0.5" } })).body.status).toBe("asked");
    expect(posts()).toHaveLength(before + 1);
  });

  test("change the tool and the order goes stale: it no longer answers", async () => {
    const signed = await admin<{ order: OrderView }>("setOrder", { connector: "forge", tool: "post", args: {}, label: "Any post" });
    const changed = manifest();
    changed.tools.post = { ...changed.tools.post, path: "/posts/everyone" };
    await admin("setConnector", { id: "forge", manifest: changed });
    expect((await admin<{ orders: OrderView[] }>("orders")).body.orders.find((o) => o.id === signed.body.order.id)!.state).toBe("stale");
    expect((await arm<{ status: string }>("callConnector", { connector: "forge", tool: "post", args: { text: "hi" } })).body.status).toBe("asked");
    await admin("setConnector", { id: "forge", manifest: manifest() });
    expect((await admin<{ orders: OrderView[] }>("orders")).body.orders.find((o) => o.id === signed.body.order.id)!.state).toBe("active");
    await admin("revokeOrder", { id: signed.body.order.id });
  });

  test("approve and sign in one go: the waiting action is approved and sent, the order covers the next one", async () => {
    const asked = await arm<{ status: string; action: string }>("callConnector", { connector: "forge", tool: "bucket.delete", args: { name: "galahad-tmp" } });
    expect(asked.body.status).toBe("asked");
    const signed = await admin<{ order: OrderView; action: ActionView }>("setOrder", {
      connector: "forge",
      tool: "bucket.delete",
      args: { name: "galahad-tmp" },
      label: "Recreate galahad-tmp",
      approve: asked.body.action,
    });
    expect(signed.status).toBe(200);
    expect(signed.body.action.state).toBe("approved");
    await daemon.connectors.drain();
    const deletes = () => hits.filter((h) => h.method === "DELETE" && h.path === "/buckets/galahad-tmp");
    await until(() => deletes().length === 1);
    const again = await arm<{ status: string }>("callConnector", { connector: "forge", tool: "bucket.delete", args: { name: "galahad-tmp" } });
    expect(again.body.status).toBe("done");
    expect(deletes()).toHaveLength(2);
    // A different bucket isn't covered.
    expect((await arm<{ status: string }>("callConnector", { connector: "forge", tool: "bucket.delete", args: { name: "galahad-prod" } })).body.status).toBe("asked");
    await admin("revokeOrder", { id: signed.body.order.id });
  });
});

describe("bytes the node moves itself (bilag.ts)", () => {
  test("a read or a create on the connector's own origin, with its key, each one a line in the ledger; an address anywhere else goes nowhere", async () => {
    const identity = newNodeIdentity();
    const store = new MindStore(":memory:");
    foundFleet(store, identity, { fleetName: "camelot", nodeName: "solo" });
    const vault = new Vault(store, identity);
    vault.set("forge", KEY, { provider: "forge", origin });
    store.emit(identity, "connector.set", { id: "forge", manifest: manifest() });
    const asked: string[] = [];
    const fetch = (async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const ledgered: { class: string; target: string; detail?: string }[] = [];
    const service = new ConnectorService({ store, vault, identity, local: new Database(":memory:"), ledger: (e) => ledgered.push(e), log: () => {}, fetch });
    const moved = await service.transfer("forge", { method: "GET", path: "/files/1", class: "read", why: "copy a bilag: f.pdf", max: 1024 });
    expect([...moved.bytes]).toEqual([1, 2, 3]);
    expect(asked).toEqual([`${origin}/files/1`]);
    expect(ledgered).toEqual([expect.objectContaining({ class: "read", target: "GET /files/1", detail: "by the node: copy a bilag: f.pdf · 200, 3 bytes" })]);
    await expect(service.transfer("forge", { method: "PUT", path: "https://elsewhere.example/upload", class: "create", why: "x", max: 1024 })).rejects.toThrow(/off Forge's origin/);
    await expect(service.transfer("nothing-here", { method: "GET", path: "/x", class: "read", why: "x", max: 1024 })).rejects.toThrow(/no connector "nothing-here"/);
    expect(asked).toHaveLength(1);
  });
});

describe("the outbox survives a crash without sending twice", () => {
  test("a send that was in flight when the node died is reported, never retried", async () => {
    const identity = newNodeIdentity();
    const store = new MindStore(":memory:");
    foundFleet(store, identity, { fleetName: "camelot", nodeName: "solo" });
    const vault = new Vault(store, identity);
    vault.set("forge", KEY, { provider: "forge", origin });
    store.emit(identity, "connector.set", { id: "forge", manifest: manifest() });
    const local = new Database(":memory:");
    let sent = 0;
    const fetch = (async () => {
      sent += 1;
      return Response.json({}, { status: 201 });
    }) as unknown as typeof globalThis.fetch;
    const service = new ConnectorService({ store, vault, identity, local, ledger: () => {}, log: () => {}, fetch });
    const asked = await service.call({ connector: "forge", tool: "post", args: { text: "once" } }, { kind: "agent", by: "loop:x" });
    expect(asked.status).toBe("asked");
    const id = (asked as { action: string }).action;
    // Approve, but the "process" dies after marking the send and before the receipt.
    local.query("INSERT INTO outbox (id, state, at) VALUES (?, 'sending', 0)").run(id);
    service.decide(id, true, null);
    await service.drain();
    expect(sent).toBe(0);
    const action = service.actions().find((a) => a.id === id)!;
    expect(action.state).toBe("failed");
    expect(action.receipt).toMatch(/outcome unknown/);
  });
});

describe("an approval has a send deadline", () => {
  const HOUR = 60 * 60_000;

  /** Two nodes: F files the action and is the only one that sends it; you answer on G. Each has its own clock. */
  function twoNodes() {
    const clocks = { f: Date.UTC(2026, 10, 2, 9), g: Date.UTC(2026, 10, 2, 9) };
    const f = newNodeIdentity();
    const g = newNodeIdentity();
    const storeF = new MindStore(":memory:", new HlcClock(() => clocks.f));
    foundFleet(storeF, f, { fleetName: "camelot", nodeName: "filer" });
    enrollDevice(storeF, f, { device: g.id, name: "answerer", kind: "node", box: b64u(g.boxPublic) });
    const vault = new Vault(storeF, f);
    vault.set("forge", KEY, { provider: "forge", origin });
    storeF.emit(f, "connector.set", { id: "forge", manifest: manifest() });
    const storeG = new MindStore(":memory:", new HlcClock(() => clocks.g));
    storeG.expectFleet(storeF.fleet!);
    const sync = (from: MindStore, to: MindStore) => to.ingest(from.eventsSince(to.frontier(), 100_000).events);
    sync(storeF, storeG);
    let sent = 0;
    const fetch = (async () => {
      sent += 1;
      return Response.json({ created: true }, { status: 201 });
    }) as unknown as typeof globalThis.fetch;
    const ledgered: { verdict: string; reason?: string; detail?: string }[] = [];
    const service = (store: MindStore, identity: typeof f, now: () => number) =>
      new ConnectorService({ store, vault: new Vault(store, identity), identity, local: new Database(":memory:"), ledger: (e) => ledgered.push(e), log: () => {}, fetch, now });
    const filer = service(storeF, f, () => clocks.f);
    const answerer = service(storeG, g, () => clocks.g);
    return { clocks, g, storeF, storeG, sync, filer, answerer, ledgered, sent: () => sent };
  }

  async function approvedWhileAway(hoursAway: number) {
    const fleet = twoNodes();
    const asked = await fleet.filer.call({ connector: "forge", tool: "post", args: { text: "late" } }, { kind: "agent", by: "loop:x" });
    const id = (asked as { action: string }).action;
    fleet.sync(fleet.storeF, fleet.storeG);
    // F goes away; an hour later you approve on G.
    fleet.clocks.g += HOUR;
    const approved = fleet.answerer.decide(id, true, null);
    expect(approved.sendBy).toBe(fleet.clocks.g + APPROVAL_TTL_MS);
    // F comes back much later and hears of it only now.
    fleet.clocks.f = fleet.clocks.g + hoursAway * HOUR;
    fleet.clocks.g = fleet.clocks.f;
    fleet.sync(fleet.storeG, fleet.storeF);
    await fleet.filer.drain();
    return { ...fleet, id };
  }

  test("a node back within 72 hours of your approval sends it", async () => {
    const { filer, id, sent } = await approvedWhileAway(71);
    expect(sent()).toBe(1);
    expect(filer.actions().find((a) => a.id === id)!.state).toBe("done");
  });

  test("a node back after 72 hours never sends it: it's ledgered, and shown as lapsed everywhere", async () => {
    const { filer, answerer, storeF, storeG, sync, id, sent, ledgered } = await approvedWhileAway(73);
    expect(sent()).toBe(0);
    expect(filer.actions().find((a) => a.id === id)!.state).toBe("lapsed");
    const record = ledgered.filter((e) => e.detail?.includes(id));
    expect(record.at(-1)).toMatchObject({ verdict: "deny" });
    expect(record.at(-1)!.reason).toMatch(/expired/);
    // Draining again neither sends nor ledgers it twice.
    await filer.drain();
    expect(sent()).toBe(0);
    expect(ledgered.filter((e) => e.detail?.includes(id) && e.verdict === "deny")).toHaveLength(1);
    // Every device sees the same, from the approval's own recorded time.
    sync(storeF, storeG);
    expect(answerer.actions().find((a) => a.id === id)!.state).toBe("lapsed");
    // And you can't answer it again.
    expect(() => answerer.decide(id, true, null)).toThrow(/already lapsed/);
  });

  test("the deadline is the approval's recorded time, not when a node heard of it", async () => {
    const { filer, storeF, id } = await approvedWhileAway(71);
    const view = filer.actions().find((a) => a.id === id)!;
    const decision = storeF.lww(`action-decision:${id}`)!;
    expect(view.sendBy).toBe(decodeHlc(decision.hlc).ms + APPROVAL_TTL_MS);
  });

  test("an approval recorded after the request had expired is never sent", async () => {
    const fleet = twoNodes();
    const asked = await fleet.filer.call({ connector: "forge", tool: "post", args: { text: "too late" } }, { kind: "agent", by: "loop:x" });
    const id = (asked as { action: string }).action;
    fleet.sync(fleet.storeF, fleet.storeG);
    // A node whose clock let it answer after the day was up (decide() itself refuses that).
    fleet.clocks.g += 25 * HOUR;
    fleet.storeG.emit(fleet.g, "action.decided", { id, verdict: "approved" });
    fleet.clocks.f = fleet.clocks.g;
    fleet.sync(fleet.storeG, fleet.storeF);
    await fleet.filer.drain();
    expect(fleet.sent()).toBe(0);
    expect(fleet.filer.actions().find((a) => a.id === id)!.state).toBe("lapsed");
  });

  /** F heard of your approval, then its clock went back two days (a dead clock battery, a restored snapshot). */
  async function heardThenClockWentBack() {
    const fleet = twoNodes();
    const asked = await fleet.filer.call({ connector: "forge", tool: "post", args: { text: "sent by a clock gone back" } }, { kind: "agent", by: "loop:x" });
    const id = (asked as { action: string }).action;
    fleet.sync(fleet.storeF, fleet.storeG);
    fleet.clocks.g += HOUR;
    const { sendBy } = fleet.answerer.decide(id, true, null);
    fleet.clocks.f = fleet.clocks.g;
    fleet.sync(fleet.storeG, fleet.storeF);
    fleet.clocks.f -= 48 * HOUR;
    return { ...fleet, id, sendBy: sendBy! };
  }

  test("a node whose clock went back sends nothing, though its clock reads the deadline as still to come", async () => {
    const fleet = await heardThenClockWentBack();
    // In truth the deadline has passed; by F's clock it's two days off.
    fleet.clocks.g = fleet.sendBy + 28 * HOUR;
    expect(fleet.clocks.f).toBeLessThan(fleet.sendBy);
    const before = fleet.ledgered.length;
    await fleet.filer.drain();
    expect(fleet.sent()).toBe(0);
    expect(fleet.ledgered.length).toBe(before); // neither sent nor lapsed: not judged by that clock at all
    // Once its clock is right again, the approval lapses, as it would have.
    fleet.clocks.f = fleet.clocks.g;
    await fleet.filer.drain();
    expect(fleet.sent()).toBe(0);
    expect(fleet.filer.actions().find((a) => a.id === fleet.id)!.state).toBe("lapsed");
  });

  test("a clock gone back only holds the send: put right within the deadline, it's sent", async () => {
    const fleet = await heardThenClockWentBack();
    await fleet.filer.drain();
    expect(fleet.sent()).toBe(0);
    fleet.clocks.f = fleet.sendBy - HOUR;
    await fleet.filer.drain();
    expect(fleet.sent()).toBe(1);
    expect(fleet.filer.actions().find((a) => a.id === fleet.id)!.state).toBe("done");
  });

  test("a clock a few minutes behind another node's (skew, not a clock gone back) sends as usual", async () => {
    const fleet = await heardThenClockWentBack();
    // G's events lead F's clock by four minutes: within what any clock may lead (MAX_CLOCK_DRIFT_MS).
    fleet.clocks.f = fleet.clocks.g - 4 * 60_000;
    await fleet.filer.drain();
    expect(fleet.sent()).toBe(1);
  });
});

describe("loops over the API", () => {
  test("the founding node gives Galahad a heartbeat, on an always-on node", async () => {
    const { loops } = (await admin<{ loops: LoopView[] }>("loops")).body;
    const beat = loops.find((l) => l.name === "heartbeat")!;
    expect(beat).toMatchObject({ schedule: "every 30m", enabled: true, onName: "ultra", task: { kind: "heartbeat" }, running: false });
    expect(beat.next).toBeGreaterThan(Date.now() - 30 * 60_000);
  });

  test("a heartbeat run raises notices for what needs you; you can dismiss them", async () => {
    const check = await admin<{ findings: { key: string }[] }>("heartbeat", {});
    expect(check.body.findings.map((f) => f.key)).toContain("no-model:planner"); // no model keys in this test fleet
    expect((await admin<{ notices: NoticeView[] }>("notices")).body.notices).toHaveLength(0); // checking writes nothing

    expect((await admin("runLoop", { name: "heartbeat" })).status).toBe(200);
    const run = await until(async () => (await admin<{ runs: LoopRunView[] }>("loopRuns", { name: "heartbeat" })).body.runs[0]);
    expect(run).toMatchObject({ status: "attention", slot: null });
    expect(run.summary).toContain("No model can play planner");
    const { notices } = (await admin<{ notices: NoticeView[] }>("notices")).body;
    expect(notices.find((n) => n.key === "no-model:planner")).toMatchObject({ severity: "warn", source: "heartbeat", dismissed: false });

    expect((await admin("dismissNotice", { key: "no-model:planner" })).status).toBe(200);
    expect((await admin<{ notices: NoticeView[] }>("notices")).body.notices.find((n) => n.key === "no-model:planner")!.dismissed).toBe(true);
  });

  test("a VM's eyes on a coding plan its tools may use aren't a model he lacks; on one for a tool you run yourself, the heartbeat says why", async () => {
    // Two plans with their keys in the vault (fakes, made here), as `galahad key add` leaves them.
    for (const id of ["opencode-go", "kimi-coding"]) {
      expect((await admin("setSecret", { name: id, value: `FAKE-${id}-${"0".repeat(24)}`, provider: id })).status).toBe(200);
      expect((await admin("setProvider", { id, secret: id })).status).toBe(200);
    }
    try {
      await admin("setRoster", { role: "eyes", models: ["opencode-go/gpt-6-luna"] });
      expect((await admin<{ findings: { key: string }[] }>("heartbeat", {})).body.findings.map((f) => f.key)).not.toContain("no-model:eyes");
      // Kimi Code is for interactive use only: a tool you run yourself, which a VM's tools are not.
      await admin("setRoster", { role: "eyes", models: ["kimi-coding/k3"] });
      const blind = (await admin<{ findings: { key: string; body: string }[] }>("heartbeat", {})).body.findings.find((f) => f.key === "no-model:eyes");
      expect(blind?.body).toContain("on a coding plan");
      expect(blind?.body).not.toContain("has a key here");
    } finally {
      await admin("setRoster", { role: "eyes", models: [] });
      for (const id of ["opencode-go", "kimi-coding"]) {
        await admin("removeProvider", { id });
        await admin("deleteSecret", { name: id });
      }
    }
  });

  test("a coding plan whose key isn't here, on a role its terms let it play, is a key to add, not a model to hire", async () => {
    const before = (await admin<{ roster: Record<string, { models: string[] }> }>("roster")).body.roster;
    try {
      // OpenCode Go may do the engineer's coding and a VM's eyes: what it lacks here is only its key.
      for (const role of ["engineer", "eyes"]) {
        await admin("setRoster", { role, models: ["opencode-go/gpt-6-luna"] });
        const found = (await admin<{ findings: { key: string; body: string }[] }>("heartbeat", {})).body.findings.find((f) => f.key === `no-model:${role}`);
        expect(found?.body).toContain("has a key here");
        expect(found?.body).not.toContain("can't play");
      }
    } finally {
      for (const role of ["engineer", "eyes"]) await admin("setRoster", { role, models: before[role]?.models ?? [] });
    }
  });

  test("a role you made, played by a coding plan, is its knights' coding: the heartbeat finds no model missing, as the doctor says", async () => {
    // On the owner's node (22 November 2026) the heartbeat said every half hour that no model could play plan-coder, a
    // role made for a knight's OpenCode on the owner's plans, while the doctor said it was well.
    expect((await admin("setSecret", { name: "opencode-go", value: `FAKE-opencode-go-${"0".repeat(24)}`, provider: "opencode-go" })).status).toBe(200);
    expect((await admin("setProvider", { id: "opencode-go", secret: "opencode-go" })).status).toBe(200);
    try {
      await admin("setRoster", { role: "plan-coder", models: ["opencode-go/glm-5.3"] });
      expect((await admin<{ findings: { key: string }[] }>("heartbeat", {})).body.findings.map((f) => f.key)).not.toContain("no-model:plan-coder");
      // A chore's role is no knight's coding: on a plan alone it still can't be played (folding a long chat into its story).
      await admin("setRoster", { role: "fold", models: ["opencode-go/glm-5.3"] });
      const chore = (await admin<{ findings: { key: string; body: string }[] }>("heartbeat", {})).body.findings.find((f) => f.key === "no-model:fold");
      expect(chore?.body).toContain("can't play fold");
    } finally {
      for (const role of ["plan-coder", "fold"]) await admin("setRoster", { role, models: [] });
      await admin("removeProvider", { id: "opencode-go" });
      await admin("deleteSecret", { name: "opencode-go" });
    }
  });

  test("a loop that calls a connector: reads report back, outward calls wait for you", async () => {
    const set = await admin<{ loop: LoopView }>("setLoop", { name: "poll", schedule: "every 15m", task: { kind: "call", connector: "forge", tool: "me" } });
    expect(set.status).toBe(200);
    expect(set.body.loop).toMatchObject({ onName: "ultra", enabled: true, schedule: "every 15m", tz: "UTC" });
    await admin("runLoop", { name: "poll" });
    const run = await until(async () => (await admin<{ runs: LoopRunView[] }>("loopRuns", { name: "poll" })).body.runs[0]);
    expect(run.status).toBe("ok");
    expect(run.summary).toContain("forge.me → 200");

    const before = posts().length;
    await admin("setLoop", { name: "poster", schedule: "0 9 * * 1", tz: "Europe/Copenhagen", task: { kind: "call", connector: "forge", tool: "post", args: { text: "weekly" } } });
    await admin("runLoop", { name: "poster" });
    const asked = await until(async () => (await admin<{ runs: LoopRunView[] }>("loopRuns", { name: "poster" })).body.runs[0]);
    expect(asked.status).toBe("attention");
    expect(asked.summary).toContain("needs your approval");
    expect(posts()).toHaveLength(before);
    expect((await admin<{ actions: ActionView[] }>("actions")).body.actions.some((a) => a.by === "loop:poster" && a.state === "waiting")).toBe(true);
    // The loop that needs a look tells you; the one that ran fine doesn't.
    const { notices } = (await admin<{ notices: NoticeView[] }>("notices")).body;
    expect(notices.find((n) => n.key === "loop:poster")).toMatchObject({ title: "Loop poster needs a look", source: "loop:poster" });
    expect(notices.some((n) => n.key === "loop:poll")).toBe(false);
  });

  test("pause, resume and change a loop; what you leave out stays", async () => {
    await admin("setLoop", { name: "poll", enabled: false });
    let poll = (await admin<{ loops: LoopView[] }>("loops")).body.loops.find((l) => l.name === "poll")!;
    expect(poll).toMatchObject({ enabled: false, next: null, schedule: "every 15m", task: { kind: "call", tool: "me" } });
    await admin("setLoop", { name: "poll", enabled: true, schedule: "every 1h" });
    poll = (await admin<{ loops: LoopView[] }>("loops")).body.loops.find((l) => l.name === "poll")!;
    expect(poll).toMatchObject({ enabled: true, schedule: "every 1h", task: { kind: "call", tool: "me" } });
    expect((await admin("removeLoop", { name: "poll" })).status).toBe(200);
    expect((await admin<{ loops: LoopView[] }>("loops")).body.loops.some((l) => l.name === "poll")).toBe(false);
  });

  test("loops are checked before they're written", async () => {
    const quest = (goal: string) => ({ kind: "quest", goal, network: "isolated" });
    expect((await admin("setLoop", { name: "x", schedule: "every 5s", task: quest("hi") })).status).toBe(400);
    expect((await admin("setLoop", { name: "x", schedule: "0 0 31 2 *", task: quest("hi") })).body.error).toMatch(/never runs/);
    expect((await admin("setLoop", { name: "x", schedule: "@daily", tz: "Mars/Olympus", task: quest("hi") })).body.error).toMatch(/time zone/);
    expect((await admin("setLoop", { name: "x", schedule: "@daily" })).body.error).toMatch(/needs a schedule and a task/);
    expect((await admin("setLoop", { name: "x", schedule: "@daily", task: quest("use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123") })).status).toBe(422);
    expect((await admin("setLoop", { name: "Bad Name", schedule: "@daily", task: quest("hi") })).status).toBe(400);
    expect((await admin("runLoop", { name: "nope" })).status).toBe(404);
    // Agents can see loops but not define or run them.
    expect((await arm("loops")).status).toBe(200);
    expect((await arm("setLoop", { name: "x", schedule: "@daily", task: { kind: "heartbeat" } })).status).toBe(403);
    expect((await arm("runLoop", { name: "heartbeat" })).status).toBe(403);
  });
});
