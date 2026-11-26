import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { newNodeIdentity } from "@galahad/core";
import { CATALOG, GatewayTokens } from "@galahad/brain";
import { foundFleet, MindStore, Vault } from "@galahad/mind";
import type { LedgerEntryInput } from "@galahad/sandbox";
import { gitScope, handleGitGateway } from "../src/git-gateway.ts";

/*
 * The git read gateway: a sandbox clones one repository, private ones included,
 * without ever holding the key. Fetch only, one repository per token, the key added
 * by the node on the way to github.com and nowhere else.
 */

const KEY = "github_pat_FAKEFAKEFAKEFAKE0000_fakefakefakefakefakefakefakefakefakefakefakefake";

function setup() {
  const identity = newNodeIdentity();
  const store = new MindStore(":memory:");
  foundFleet(store, identity, { fleetName: "camelot", nodeName: "ultra" });
  const vault = new Vault(store, identity);
  const manifest = { ...structuredClone(CATALOG.github!.manifest), id: "github-amiriteorg", auth: { secret: "github-amiriteorg", scheme: "bearer" as const } };
  store.emit(identity, "connector.set", { id: "github-amiriteorg", manifest });
  vault.set("github-amiriteorg", KEY, { provider: "github-amiriteorg", origin: "https://api.github.com" });
  const tokens = new GatewayTokens(new Database(":memory:"));
  const { token } = tokens.mint({ label: "git:q-test", providers: [gitScope("github-amiriteorg", "amiriteorg", "galahad")], ttlMinutes: 60, maxRequests: 10 });
  const seen: { url: string; method: string; auth: string | null; body: string }[] = [];
  const ledger: LedgerEntryInput[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input as string, init);
    seen.push({ url: req.url, method: req.method, auth: req.headers.get("authorization"), body: await req.text() });
    if (req.url.includes("/info/refs")) return new Response("001e# service=git-upload-pack\n0000", { headers: { "content-type": "application/x-git-upload-pack-advertisement" } });
    return new Response("PACK…", { headers: { "content-type": "application/x-git-upload-pack-result" } });
  }) as typeof globalThis.fetch;
  const call = (path: string, init: RequestInit & { token?: string } = {}) =>
    handleGitGateway(new Request(`http://172.31.250.1:7779${path}`, { ...init, headers: { authorization: `Bearer ${init.token ?? token}`, ...(init.headers ?? {}) } }), { store, vault, tokens, ledger: (e) => ledger.push(e), fetch });
  return { call, seen, ledger, tokens };
}

const REFS = "/git/github-amiriteorg/amiriteorg/galahad.git/info/refs?service=git-upload-pack";

describe("the git read gateway", () => {
  test("a clone goes to github.com with the connector's key, and comes back as git sent it", async () => {
    const { call, seen, ledger } = setup();
    const refs = await call(REFS);
    expect(refs.status).toBe(200);
    expect(refs.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
    expect(await refs.text()).toContain("service=git-upload-pack");
    const pack = await call("/git/github-amiriteorg/amiriteorg/galahad.git/git-upload-pack", { method: "POST", body: "0032want abc\n", headers: { "content-type": "application/x-git-upload-pack-request" } });
    expect(await pack.text()).toBe("PACK…");
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      "GET https://github.com/amiriteorg/galahad.git/info/refs?service=git-upload-pack",
      "POST https://github.com/amiriteorg/galahad.git/git-upload-pack",
    ]);
    expect(seen.every((s) => s.auth === `Basic ${Buffer.from(`x-access-token:${KEY}`).toString("base64")}`)).toBe(true);
    expect(seen[1]!.body).toBe("0032want abc\n");
    expect(ledger).toEqual([expect.objectContaining({ class: "read", resource: "connector.github-amiriteorg", target: "git fetch amiriteorg/galahad" })]);
  });

  test("pushing is refused, whatever the path says", async () => {
    const { call, seen } = setup();
    expect((await call("/git/github-amiriteorg/amiriteorg/galahad.git/info/refs?service=git-receive-pack")).status).toBe(403);
    expect((await call("/git/github-amiriteorg/amiriteorg/galahad.git/git-receive-pack", { method: "POST", body: "x" })).status).toBe(403);
    expect(seen).toEqual([]);
  });

  test("the token reads one repository through one connector; nothing else", async () => {
    const { call, seen, tokens } = setup();
    expect((await call("/git/github-amiriteorg/amiriteorg/secrets.git/info/refs?service=git-upload-pack")).status).toBe(401);
    expect((await call("/git/github/amiriteorg/galahad.git/info/refs?service=git-upload-pack")).status).toBe(401);
    expect((await call(REFS, { token: "gw_" + "x".repeat(43) })).status).toBe(401);
    const { token: modelToken } = tokens.mint({ label: "sandbox:x", providers: ["orcarouter"], ttlMinutes: 60, maxRequests: 10 });
    expect((await call(REFS, { token: modelToken })).status).toBe(401);
    expect((await call("/git/github-amiriteorg/amiriteorg/galahad.git/objects/info/packs")).status).toBe(404);
    expect((await call("/git/github-amiriteorg/amiriteorg/galahad.git/info/refs")).status).toBe(400);
    expect(seen).toEqual([]);
  });
});
