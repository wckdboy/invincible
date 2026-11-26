import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectProvider as recognised, originOf, PRESETS, preset } from "@galahad/brain";
import { type RouteName, routes } from "@galahad/core";
import { foundFleet, MindStore } from "@galahad/mind";
import { detectProvider, providerSetup } from "../../../apps/web/src/lib/text.ts";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { keyAddCommand } from "../src/key-cli.ts";
import { freePort } from "./ports.ts";

/*
 * Providers through a real node (a temp home, the file keystore, loopback only): what the routes every surface
 * uses (the CLI, the app, the iPhone) do with a provider's key and its models. Every key here is fake, made here.
 */

const caps: Capabilities = {
  os: "linux",
  arch: "x64",
  hostname: "providers-test",
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

const fakeKey = (id: string) => ["FAKE", id, "key", "for", "tests", crypto.randomUUID().slice(0, 8)].join("-");

const root = mkdtempSync(join(tmpdir(), "galahad-providers-"));
const home = new Home(join(root, "node"));
const port = freePort();
let daemon: Daemon;

/** A stand-in provider that refuses every key, in the words a provider uses, and echoes the key it was sent. */
const refusing = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (req) => Response.json({ error: { message: `Invalid API key: ${req.headers.get("authorization")}` } }, { status: 401 }),
});

async function call(name: RouteName, input?: unknown): Promise<Response> {
  const route = routes[name];
  return fetch(`http://127.0.0.1:${port}${route.path}`, {
    method: route.method,
    headers: { authorization: `Bearer ${home.adminToken()}`, "content-type": "application/json" },
    body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined,
  });
}

async function ok<T = any>(name: RouteName, input?: unknown): Promise<T> {
  const response = await call(name, input);
  if (!response.ok) throw new Error(`${name} → ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

beforeAll(async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const store = new MindStore(home.mindPath);
  const fleet = foundFleet(store, identity, { fleetName: "camelot", nodeName: "providers-node" });
  store.close();
  home.writeConfig({ v: 1, name: "providers-node", fleet, port, keystore, advertise: "127.0.0.1" });
  daemon = await startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {} });
});

afterAll(async () => {
  await daemon?.stop();
  refusing.stop(true);
  rmSync(root, { recursive: true, force: true });
});

describe("a provider's models, listed through the node", () => {
  test("a provider that can't list them says which provider it was and why, in its own words, and never the key", async () => {
    const key = fakeKey("strict");
    const baseUrl = `http://127.0.0.1:${refusing.port}/v1`;
    await ok("setSecret", { name: "strict", value: key, provider: "strict", baseUrl });
    await ok("setProvider", { id: "strict", kind: "openai", baseUrl, secret: "strict" });
    const response = await call("providerModels", { id: "strict" });
    expect(response.status).toBe(502);
    const { error } = (await response.json()) as { error: string };
    expect(error).toContain("strict /models → 401");
    expect(error).toContain("Invalid API key");
    expect(error).not.toContain(key);
  });

  test("one that isn't running says which and why too", async () => {
    await ok("setProvider", { id: "stopped", kind: "openai", baseUrl: `http://127.0.0.1:${freePort()}/v1` });
    const response = await call("providerModels", { id: "stopped" });
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toStartWith("stopped /models: ");
  });

  test("a Cloudflare AI Gateway lists none: it says they are yours to name", async () => {
    const baseUrl = "https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/galahad/compat";
    await ok("setSecret", { name: "cloudflare-ai", value: fakeKey("cloudflare-ai"), provider: "cloudflare-ai", baseUrl });
    await ok("setProvider", { id: "cloudflare-ai", baseUrl, secret: "cloudflare-ai" });
    const response = await call("providerModels", { id: "cloudflare-ai" });
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toBe("cloudflare-ai doesn't list its models: name them yourself in the roster, as cloudflare-ai/<model>");
  });
});

/*
 * Every preset configured the way each surface does it, against the node's own routes: `galahad key add` (key-cli.ts),
 * and the app's add-key sheet with the iPhone's Keys page (both run lib/text.ts' providerSetup, the iPhone through the
 * shared vectors). Each ends with its key sealed for it, pinned to its address, and usable by its provider. A
 * Cloudflare AI Gateway has no address of its own: the one given with its key is where it goes.
 */
describe("every preset is configured, on every surface", () => {
  const GATEWAY = "https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/camelot/compat";
  const addressOf = (id: string) => preset(id)!.baseUrl || GATEWAY;

  async function usable() {
    const [{ providers }, { secrets }] = await Promise.all([ok<{ providers: { id: string; baseUrl: string; hasKey: boolean }[] }>("providers"), ok<{ secrets: { name: string; provider: string | null; origin: string | null }[] }>("secrets")]);
    return PRESETS.map((p) => ({
      id: p.id,
      baseUrl: providers.find((r) => r.id === p.id)?.baseUrl,
      hasKey: providers.find((r) => r.id === p.id)?.hasKey,
      pinned: secrets.find((s) => s.name === p.id && s.provider === p.id)?.origin,
    }));
  }
  const expected = () => PRESETS.map((p) => ({ id: p.id, baseUrl: addressOf(p.id), hasKey: true, pinned: originOf(addressOf(p.id)) }));
  async function forget() {
    for (const p of PRESETS) {
      await ok("deleteSecret", { name: p.id });
      await ok("removeProvider", { id: p.id });
    }
  }

  test("with galahad key add: --provider for each, and --base-url for the one with no address of its own", async () => {
    for (const p of PRESETS) {
      const lines: string[] = [];
      await keyAddCommand({ call: (name, input) => ok(name, input) }, fakeKey(p.id), { provider: p.id, ...(p.baseUrl ? {} : { "base-url": GATEWAY }) }, (line) => lines.push(line));
      expect([p.id, lines.join("\n")]).toEqual([p.id, expect.stringContaining(`provider "${p.id}" configured`)]);
    }
    expect(await usable()).toEqual(expected());
    await forget();
  });

  test("in the app and on the iPhone: the key sealed, then the provider set up as their providerSetup says", async () => {
    for (const p of PRESETS) {
      const baseUrl = p.baseUrl ? undefined : GATEWAY;
      await ok("setSecret", { name: p.id, value: fakeKey(p.id), provider: p.id, ...(baseUrl ? { baseUrl } : {}) });
      const { request } = providerSetup(await ok("providers"), p.id, p.id, true, baseUrl);
      expect([p.id, request]).toEqual([p.id, expect.objectContaining({ id: p.id, secret: p.id })]);
      await ok("setProvider", request);
    }
    expect(await usable()).toEqual(expected());
  });

  test("a key whose form says whose it is is recognised as such by the node, the CLI and the app; one that doesn't is chosen", () => {
    for (const p of PRESETS) {
      for (const prefix of p.keyPrefixes ?? []) {
        const key = `${prefix}${fakeKey(p.id)}`;
        expect([key, recognised(key), detectProvider(key, PRESETS)]).toEqual([key, p.id, p.id]);
      }
    }
    // (Those with no form of their own are chosen: in the app's and the iPhone's lists, and with --provider.)
    expect(PRESETS.filter((p) => !p.keyPrefixes?.length).length).toBeGreaterThan(0);
  });

  test("the models the roster is offered for a provider its vendor says lists none, through the node, without asking it", async () => {
    // (On the providers the test above configured.)
    for (const p of PRESETS.filter((q) => q.plan || q.models?.length)) {
      const { models } = await ok<{ models: string[] }>("providerModels", { id: p.id });
      expect([p.id, models]).toEqual([p.id, p.plan?.models ?? p.models ?? []]);
    }
  });
});

/*
 * A provider pointed at another region than its key was added for (Xiaomi's Token Plan answers at one of three, by
 * region). The key doesn't follow it (SECURITY.md, 2), and the node says so: which address the key was for. Added again
 * with the region's address next to it, as the app's and the iPhone's key sheets and `galahad key add --base-url` do,
 * it is pinned there and the provider set up there.
 */
describe("a provider pointed at another region", () => {
  const SGP = preset("mimo-token")!.baseUrl;
  const AMS = "https://token-plan-ams.xiaomimimo.com/v1";
  type View = { id: string; baseUrl: string; hasKey: boolean; keyElsewhere?: string };
  const mimo = async () => (await ok<{ providers: View[] }>("providers")).providers.find((p) => p.id === "mimo-token");

  test("says which address its key was added for, and has no key there", async () => {
    await ok("deleteSecret", { name: "mimo-token" });
    await ok("removeProvider", { id: "mimo-token" });
    await ok("setSecret", { name: "mimo-token", value: fakeKey("mimo-token"), provider: "mimo-token" });
    await ok("setProvider", providerSetup(await ok("providers"), "mimo-token", "mimo-token", true).request);
    expect(await mimo()).toMatchObject({ baseUrl: SGP, hasKey: true });
    expect(await mimo()).not.toHaveProperty("keyElsewhere");

    const { providers } = await ok<{ providers: View[] }>("setProvider", { id: "mimo-token", baseUrl: AMS, secret: "mimo-token" });
    expect(providers.find((p) => p.id === "mimo-token")).toMatchObject({ baseUrl: AMS, hasKey: false, keyElsewhere: originOf(SGP)! });
  });

  test("added again with the region's address next to it, the key is pinned there and the provider set up there", async () => {
    await ok("setSecret", { name: "mimo-token", value: fakeKey("mimo-token"), provider: "mimo-token", baseUrl: AMS });
    const { request } = providerSetup(await ok("providers"), "mimo-token", "mimo-token", true, AMS);
    if (request) await ok("setProvider", request);
    expect(await mimo()).toMatchObject({ baseUrl: AMS, hasKey: true });
    expect(await mimo()).not.toHaveProperty("keyElsewhere");
  });

  test("and a fresh one, keyed for the region from the start, is set up there", async () => {
    await ok("deleteSecret", { name: "mimo-token" });
    await ok("removeProvider", { id: "mimo-token" });
    await ok("setSecret", { name: "mimo-token", value: fakeKey("mimo-token"), provider: "mimo-token", baseUrl: AMS });
    await ok("setProvider", providerSetup(await ok("providers"), "mimo-token", "mimo-token", true, AMS).request);
    expect(await mimo()).toMatchObject({ baseUrl: AMS, hasKey: true });
  });
});
