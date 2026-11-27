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
