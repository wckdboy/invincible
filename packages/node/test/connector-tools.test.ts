import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ConnectorView, type RouteName, routes, toolDigest } from "@invincible/core";
import { foundFleet, LedgerStore } from "@invincible/ledger";
import { CATALOG, installedConnector } from "@invincible/models";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { freePort } from "./ports.ts";

/*
 * A tool the catalog has added since a connector of it was installed is offered, never added by itself (your word, 27
 * November 2026): adding one widens what the connector does, so you add it, per connector and per tool, and only its
 * definition is added. The connector's other tools stay exactly as they were, so their digests, and the standing orders
 * signed over them, stand.
 */

describe("a tool the catalog has added since you installed a connector", () => {
  const caps: Capabilities = { os: "linux", arch: "x64", hostname: "tools", cores: 4, cpu: "t", memoryGb: 8, hasBattery: false, gpu: [], docker: false, vm: { kvm: false, tools: [] }, tools: [], localModels: [], tailscale: null };
  const root = mkdtempSync(join(tmpdir(), "invincible-connector-tools-"));
  const home = new Home(join(root, "node"));
  const port = freePort();
  const TOKEN = "github_pat_FAKEFAKEFAKEFAKE0000_tools";
  const posted: string[] = [];
  let daemon: Daemon;
  let armToken: string;
  const send = (token: string, name: RouteName, input?: unknown) =>
    fetch(`http://127.0.0.1:${port}${routes[name].path}`, {
      method: routes[name].method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: routes[name].method === "POST" ? JSON.stringify(input ?? {}) : undefined,
    }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
  // GitHub as an older install of it has it: the catalog's manifest before it had a review tool.
  const { "pull.review": _review, ...older } = CATALOG.github!.manifest.tools;
  const installed = () => installedConnector(daemon.store, "github")!;
  const digests = () => Object.fromEntries(Object.keys(older).map((tool) => [tool, toolDigest(installed(), tool)]));

  beforeAll(async () => {
    const { identity, keystore } = await home.createIdentity("file");
    const store = new LedgerStore(home.ledgerPath);
    const fleet = foundFleet(store, identity, { fleetName: "homelab", nodeName: "tools" });
    store.close();
    home.writeConfig({ v: 1, name: "tools", fleet, port, keystore, advertise: "127.0.0.1" });
    const github = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin !== "https://api.github.com") return fetch(input, init);
      if ((init?.method ?? "GET") !== "GET") posted.push(`${init?.method} ${url.pathname}`);
      return Response.json({ number: 7, html_url: "https://github.com/amiriteorg/shipyard/pull/7" }, { status: 201 });
    }) as unknown as typeof fetch;
    daemon = await startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {}, fetch: github });
    armToken = (await send(home.adminToken(), "mintArm", { label: "coder" })).body.token;
    expect((await send(home.adminToken(), "setConnector", { id: "github", manifest: { ...CATALOG.github!.manifest, tools: older } })).status).toBe(200);
    expect((await send(home.adminToken(), "setSecret", { name: "github", value: TOKEN, provider: "github" })).status).toBe(200);
  });
  afterAll(async () => {
    await daemon?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  test("it is offered: listed as new, and in Needs you in words that say how to add it; never added by itself", async () => {
    const github = ((await send(home.adminToken(), "connectors")).body.connectors as ConnectorView[]).find((c) => c.id === "github")!;
    expect(github.newTools).toEqual(["pull.review"]);
    expect(github.tools.map((t) => t.name)).not.toContain("pull.review");
    expect(Object.keys(installed().tools)).not.toContain("pull.review");
    expect(daemon.store.lww<{ title: string; body: string; source: string }>("notice:connector-tool:github:pull.review")?.value).toMatchObject({
      title: "GitHub has a new tool: pull.review",
      body: expect.stringContaining("Add it, and only it: invincible connector tools github --add pull.review"),
      source: "connectors",
    });
  });

  test("you add it, and only it: the connector's other tools stay as they were, so their digests and your orders over them stand", async () => {
    const before = digests();
    const order = await send(home.adminToken(), "setOrder", { connector: "github", tool: "pr.create", args: { owner: "amiriteorg", repo: "shipyard" }, label: "pull requests on the shipyard" });
    expect(order.status).toBe(200);
    const added = await send(home.adminToken(), "addConnectorTools", { id: "github", tools: ["pull.review"] });
    expect(added.status).toBe(200);
    expect(added.body.added).toEqual(["pull.review"]);
    // Exactly the catalog's definition of it, and nothing else changed.
    expect(installed().tools["pull.review"]).toEqual(CATALOG.github!.manifest.tools["pull.review"]!);
    expect(digests()).toEqual(before);
    // Your order still answers a call it covers.
    const opened = await daemon.connectors.call({ connector: "github", tool: "pr.create", args: { owner: "amiriteorg", repo: "shipyard", head: "feat/units", base: "main", title: "Units" } }, { kind: "agent", by: "arm:coder" });
    expect(opened.status === "done" && opened.order?.label).toBe("pull requests on the shipyard");
    expect(posted).toEqual(["POST /repos/amiriteorg/shipyard/pulls"]);
    // Offered no more, and out of Needs you.
    const github = ((await send(home.adminToken(), "connectors")).body.connectors as ConnectorView[]).find((c) => c.id === "github")!;
    expect(github.newTools).toEqual([]);
    expect(daemon.store.lww("notice:connector-tool:github:pull.review")?.value ?? null).toBeNull();
  });

  test("only yours to add, only a tool the catalog has for that connector, and once", async () => {
    expect((await send(armToken, "addConnectorTools", { id: "github", tools: ["pull.review"] })).status).toBe(403);
    expect((await send(home.adminToken(), "addConnectorTools", { id: "github", tools: ["pull.review"] })).status).toBe(409);
    expect((await send(home.adminToken(), "addConnectorTools", { id: "github", tools: ["repo.delete"] })).status).toBe(404);
    expect((await send(home.adminToken(), "addConnectorTools", { id: "cloudflare", tools: ["zones"] })).status).toBe(404);
    // A connector of your own manifest has its own tools: none of them are the catalog's to add.
    const own = { id: "forge", label: "Forge", origin: "https://forge.example.test", tools: { ping: { description: "Ping.", method: "GET", path: "/ping", class: "read" } } };
    expect((await send(home.adminToken(), "setConnector", { id: "forge", manifest: own })).status).toBe(200);
    expect((await send(home.adminToken(), "addConnectorTools", { id: "forge", tools: ["issue.create"] })).status).toBe(404);
    // Nor is one that takes a catalog's name at another address: offered nothing, and given nothing of it.
    const elsewhere = { id: "cloudflare", label: "Cloudflare", origin: "https://cloudflare.example.test", tools: { ping: { description: "Ping.", method: "GET", path: "/ping", class: "read" } } };
    expect((await send(home.adminToken(), "setConnector", { id: "cloudflare", manifest: elsewhere })).status).toBe(200);
    const listed = ((await send(home.adminToken(), "connectors")).body.connectors as ConnectorView[]).find((c) => c.id === "cloudflare")!;
    expect(listed.newTools).toBeUndefined();
    expect(daemon.store.lwwPrefix("notice:connector-tool:cloudflare:")).toEqual([]);
    expect((await send(home.adminToken(), "addConnectorTools", { id: "cloudflare", tools: ["zones"] })).status).toBe(404);
  });
});

/*
 * The review of 27 November, N8 (G24, G25, B30, B31): GitHub installed as f805030's catalog had it (branch.create labelled
 * "create", no merge tool), with an order you signed over its old branch.create. Merge is added alone, on your word; every
 * other tool, its digest and your order stand; and what it is held to is said and ordered as heldClass holds it, whatever
 * its old label says.
 */
describe("a connector installed before the catalog added its merge tool", () => {
  const caps: Capabilities = { os: "linux", arch: "x64", hostname: "offer", cores: 4, cpu: "t", memoryGb: 8, hasBattery: false, gpu: [], docker: false, vm: { kvm: false, tools: [] }, tools: [], localModels: [], tailscale: null };
  const root = mkdtempSync(join(tmpdir(), "invincible-connector-old-"));
  const home = new Home(join(root, "node"));
  const port = freePort();
  const sent: string[] = [];
  let daemon: Daemon;
  const send = (token: string, name: RouteName, input?: unknown) =>
    fetch(`http://127.0.0.1:${port}${routes[name].path}`, {
      method: routes[name].method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: routes[name].method === "POST" ? JSON.stringify(input ?? {}) : undefined,
    }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
  // f805030's GitHub: the catalog's differences since are branch.create's words and class, and the merge tool.
  const { merge: _merge, ...rest } = CATALOG.github!.manifest.tools;
  const OLD = { ...CATALOG.github!.manifest, tools: { ...rest, "branch.create": { ...rest["branch.create"]!, description: "Create a branch at a commit (ref is refs/heads/<name>).", class: "create" as const } } };
  const installed = (id = "github") => installedConnector(daemon.store, id)!;
  const digests = () => Object.fromEntries(Object.keys(OLD.tools).map((tool) => [tool, toolDigest(installed(), tool)]));

  beforeAll(async () => {
    const { identity, keystore } = await home.createIdentity("file");
    const store = new LedgerStore(home.ledgerPath);
    const fleet = foundFleet(store, identity, { fleetName: "homelab", nodeName: "offer" });
    store.close();
    home.writeConfig({ v: 1, name: "offer", fleet, port, keystore, advertise: "127.0.0.1" });
    const github = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin !== "https://api.github.com") return fetch(input, init);
      sent.push(`${init?.method ?? "GET"} ${url.pathname}`);
      return Response.json({ ref: "refs/heads/feat", object: { sha: "c".repeat(40) } }, { status: 201 });
    }) as unknown as typeof fetch;
    daemon = await startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {}, fetch: github });
    expect((await send(home.adminToken(), "setConnector", { id: "github", manifest: OLD })).status).toBe(200);
    expect((await send(home.adminToken(), "setSecret", { name: "github", value: "github_pat_FAKEFAKEFAKEFAKE0000_offer", provider: "github" })).status).toBe(200);
  });
  afterAll(async () => {
    await daemon?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  test("its old branch.create is said and ordered as what it is held to: it asks, so an order may cover it", async () => {
    expect(await daemon.connectors.describe({ connector: "github", tool: "branch.create" }, { kind: "owner", device: "test" })).toMatchObject({ class: "outward", asks: true });
    const order = await send(home.adminToken(), "setOrder", { connector: "github", tool: "branch.create", args: { owner: "amiriteorg", repo: "shipyard" }, label: "branches on the shipyard" });
    expect(order.status).toBe(200);
  });

  test("merge is added alone on your word: every other tool, its digest and your order stand; an arm is refused, and so is another origin", async () => {
    const arm = (await send(home.adminToken(), "mintArm", { label: "coder" })).body.token as string;
    const before = digests();
    expect((await send(arm, "addConnectorTools", { id: "github", tools: ["merge"] })).status).toBe(403);
    expect(Object.keys(installed().tools)).not.toContain("merge");
    const added = await send(home.adminToken(), "addConnectorTools", { id: "github", tools: ["merge"] });
    expect([added.status, added.body.added]).toEqual([200, ["merge"]]);
    expect(installed().tools.merge).toEqual(CATALOG.github!.manifest.tools.merge!);
    expect(digests()).toEqual(before);
    // Its old definition stands (heldClass makes it ask).
    expect(installed().tools["branch.create"]).toEqual(OLD.tools["branch.create"]);
    // Your order still answers the call it covers; without it, it asks.
    const covered = await daemon.connectors.call({ connector: "github", tool: "branch.create", args: { owner: "amiriteorg", repo: "shipyard", ref: "refs/heads/feat", sha: "c".repeat(40) } }, { kind: "agent", by: "arm:coder" });
    expect(covered.status === "done" && covered.order?.label).toBe("branches on the shipyard");
    const elsewhere = await daemon.connectors.call({ connector: "github", tool: "branch.create", args: { owner: "amiriteorg", repo: "other", ref: "refs/heads/feat", sha: "c".repeat(40) } }, { kind: "agent", by: "team.0123456789.ada" });
    expect(elsewhere.status).toBe("asked");
    // Another origin under GitHub's catalog name (an Enterprise server) isn't the catalog's: offered and given nothing.
    // (Its natives are pinned to api.github.com, so such a manifest carries the templates alone.)
    const ghe = { ...OLD, id: "github-lin", label: "GitHub Enterprise", origin: "https://ghe.example.test", tools: Object.fromEntries(Object.entries(OLD.tools).filter(([, t]) => !("native" in t))) };
    expect((await send(home.adminToken(), "setConnector", { id: "github-lin", manifest: ghe })).status).toBe(200);
    expect((await send(home.adminToken(), "addConnectorTools", { id: "github-lin", tools: ["merge"] })).status).toBe(404);
    expect(sent).toEqual(["POST /repos/amiriteorg/shipyard/git/refs"]);
  });

  test("of two tools the catalog has added since, the one you add is added, and the other is still only offered", async () => {
    // GitHub for one more owner, installed earlier still: before the catalog had its review tool, too.
    const older = Object.fromEntries(Object.entries(OLD.tools).filter(([tool]) => tool !== "pull.review"));
    expect((await send(home.adminToken(), "setConnector", { id: "github-amiriteorg", manifest: { ...OLD, id: "github-amiriteorg", label: "GitHub (amiriteorg)", tools: older } })).status).toBe(200);
    const listed = async () => ((await send(home.adminToken(), "connectors")).body.connectors as ConnectorView[]).find((c) => c.id === "github-amiriteorg")!;
    expect((await listed()).newTools?.toSorted()).toEqual(["merge", "pull.review"]);
    const added = await send(home.adminToken(), "addConnectorTools", { id: "github-amiriteorg", tools: ["merge"] });
    expect([added.status, added.body.added]).toEqual([200, ["merge"]]);
    expect(Object.keys(installed("github-amiriteorg").tools).toSorted()).toEqual([...Object.keys(older), "merge"].toSorted());
    expect((await listed()).newTools).toEqual(["pull.review"]);
  });
});
