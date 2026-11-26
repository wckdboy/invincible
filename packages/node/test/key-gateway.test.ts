import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { newNodeIdentity } from "@galahad/core";
import { GatewayTokens } from "@galahad/brain";
import { foundFleet, MindStore, Vault } from "@galahad/mind";
import type { LedgerEntryInput } from "@galahad/sandbox";
import { handleKeyGateway, keyScope, ungivable } from "../src/key-gateway.ts";

/*
 * Keys a knight uses but never sees (PLAN #17): its script calls the key gateway with its VM's token where the key would
 * go, and the call leaves for the key's pinned address with the vault's key put in. The API is a stand-in that says what
 * reached it; nothing leaves this machine, and every key here is an obvious fake.
 */

const KEY = ["FAKE", "stripe", "test", "key"].join("-");

function world(grants: { secret: string; header?: string; write?: boolean }[]) {
  const identity = newNodeIdentity();
  const store = new MindStore(":memory:");
  foundFleet(store, identity, { fleetName: "camelot", nodeName: "ultra" });
  const vault = new Vault(store, identity);
  vault.set("stripe", KEY, { origin: "https://api.stripe.test" });
  vault.set("plain", "FAKE-unpinned-value");
  vault.set("deepseek", "FAKE-model-key", { provider: "deepseek", origin: "https://api.deepseek.com" });
  const tokens = new GatewayTokens(new Database(":memory:"));
  const { token } = tokens.mint({ label: "sandbox:0123456789", providers: ["deepseek", ...grants.map((g) => keyScope({ header: "authorization", write: false, ...g }))], ttlMinutes: 30, maxRequests: 50 });
  const reached: { url: string; method: string; headers: Record<string, string>; body: string; redirect?: RequestRedirect }[] = [];
  let answer = () => Response.json({ object: "list", data: [] }, { headers: { "request-id": "req_1", "set-cookie": "s=1" } });
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    reached.push({ url: String(input), method: init?.method ?? "GET", headers, body: init?.body ? new TextDecoder().decode(init.body as ArrayBuffer) : "", redirect: init?.redirect });
    return answer();
  }) as typeof globalThis.fetch;
  const ledger: LedgerEntryInput[] = [];
  const call = (path: string, init: RequestInit = {}) => handleKeyGateway(new Request(`http://10.0.0.1:7778${path}`, init), { vault, tokens, fetch, ledger: (entry) => void ledger.push(entry) });
  return { token, call, reached, ledger, vault, answer: (make: () => Response) => void (answer = make) };
}

describe("the key gateway", () => {
  test("a read leaves for the key's own address with the key put in, never the VM's token; what of the answer comes back", async () => {
    const w = world([{ secret: "stripe" }]);
    const res = await w.call("/key/stripe/v1/charges?limit=1", { headers: { authorization: `Bearer ${w.token}`, "stripe-version": "2026-10-01", cookie: "owner=1", accept: "application/json" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("request-id")).toBe("req_1");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(w.reached).toHaveLength(1);
    const [sent] = w.reached;
    expect(sent!.url).toBe("https://api.stripe.test/v1/charges?limit=1");
    expect(sent!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(sent!.headers["stripe-version"]).toBe("2026-10-01");
    expect(sent!.headers.cookie).toBeUndefined();
    expect(JSON.stringify(sent)).not.toContain(w.token);
    // (It goes to that address alone: a redirect is never followed.)
    expect(sent!.redirect).toBe("manual");
    // (Which VM's lease made the call: a knight's page counts its uses by it.)
    expect(w.ledger).toEqual([expect.objectContaining({ class: "read", resource: "key.stripe", target: "GET https://api.stripe.test/v1/charges", verdict: "allow", detail: "sandbox:0123456789" })]);
  });

  test("in the API's own header: the token found there, the key put there, as it is", async () => {
    const w = world([{ secret: "stripe", header: "x-api-key" }]);
    expect((await w.call("/key/stripe/v1/items", { headers: { "x-api-key": w.token } })).status).toBe(200);
    expect(w.reached[0]!.headers["x-api-key"]).toBe(KEY);
    expect(w.reached[0]!.headers.authorization).toBeUndefined();
  });

  test("reads alone unless you said writes too: a change waits, and goes once you have", async () => {
    const read = world([{ secret: "stripe" }]);
    const refused = await read.call("/key/stripe/v1/charges", { method: "POST", headers: { authorization: `Bearer ${read.token}`, "content-type": "application/json" }, body: '{"amount":1}' });
    expect(refused.status).toBe(403);
    expect(read.reached).toEqual([]);
    const write = world([{ secret: "stripe", write: true }]);
    expect((await write.call("/key/stripe/v1/charges", { method: "POST", headers: { authorization: `Bearer ${write.token}`, "content-type": "application/json" }, body: '{"amount":1}' })).status).toBe(200);
    expect(write.reached[0]).toMatchObject({ method: "POST", body: '{"amount":1}' });
    expect(write.ledger[0]).toMatchObject({ class: "modify", target: "POST https://api.stripe.test/v1/charges" });
  });

  test("no token, a token without the key, a path that climbs: refused before anything leaves", async () => {
    const w = world([]);
    expect((await w.call("/key/stripe/v1/charges")).status).toBe(401);
    expect((await w.call("/key/stripe/v1/charges", { headers: { authorization: `Bearer ${w.token}` } })).status).toBe(401);
    // (A climb out of the key's path is folded by the URL itself into another name, which it wasn't given.)
    const given = world([{ secret: "stripe" }]);
    for (const path of ["/key/stripe/v1/../../admin", "/key/stripe/%2e%2e/%2e%2e/other"]) expect([400, 401, 404]).toContain((await given.call(path, { headers: { authorization: `Bearer ${given.token}` } })).status);
    expect([...w.reached, ...given.reached]).toEqual([]);
  });

  test("an API that echoes the key back in an error has it scrubbed", async () => {
    const w = world([{ secret: "stripe" }]);
    w.answer(() => new Response(`invalid key ${KEY}`, { status: 401 }));
    const res = await w.call("/key/stripe/v1/charges", { headers: { authorization: `Bearer ${w.token}` } });
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(KEY);
  });

  test("what can be given: a key pinned to an https address that is nobody else's; a model's or a connector's, or one pinned nowhere, never", async () => {
    const w = world([{ secret: "plain" }, { secret: "deepseek" }]);
    expect(ungivable(w.vault, "stripe")).toBeNull();
    expect(ungivable(w.vault, "plain")).toContain("pinned to no address");
    expect(ungivable(w.vault, "deepseek")).toContain("deepseek's key");
    expect(ungivable(w.vault, "missing")).toContain("there is no secret missing in the vault");
    // Given anyway (a grant from before the key changed), the call goes nowhere.
    for (const name of ["plain", "deepseek"]) expect((await w.call(`/key/${name}/v1`, { headers: { authorization: `Bearer ${w.token}` } })).status).toBe(424);
    expect(w.reached).toEqual([]);
  });

  test("a knight's uses of a key are counted from the ledger, by the VM that made them, over the days asked", () => {
    const identity = newNodeIdentity();
    const store = new MindStore(":memory:");
    foundFleet(store, identity, { fleetName: "camelot", nodeName: "ultra" });
    const line = (detail: string, resource = "key.stripe") => store.emit(identity, "ledger.recorded", { class: "read", resource, target: "GET https://api.stripe.test/v1/x", verdict: "allow", detail });
    line("sandbox:0123456789");
    line("sandbox:0123456789");
    line("sandbox:aaaaaaaaaa");
    line("sandbox:0123456789", "key.acme");
    expect(store.ledgerCount("key.stripe", 0, "sandbox:0123456789")).toBe(2);
    expect(store.ledgerCount("key.stripe", 0)).toBe(3);
    expect(store.ledgerCount("key.stripe", Date.now() + 60_000, "sandbox:0123456789")).toBe(0);
  });
});
