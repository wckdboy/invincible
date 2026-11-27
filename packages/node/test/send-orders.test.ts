import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { newNodeIdentity } from "@invincible/core";
import { foundFleet, LedgerStore, Vault } from "@invincible/ledger";
import { CATALOG, type ConnectorResult } from "@invincible/models";
import { ConnectorService, type NativeTool } from "../src/connectors.ts";

/*
 * A standing order to send mail answers a send only to whom it names (orders.ts MAIL_SENDS; the lead's word of 27
 * November 2026): signed, it names every address it may send to; applied, every address in a call's to and cc must be
 * one of them. This node holds what it applies so from now, though the replicas read it so only from 28 November.
 * Gmail is a stand-in here (its send native); every address is made up.
 */

function world() {
  const identity = newNodeIdentity();
  const store = new LedgerStore(":memory:");
  foundFleet(store, identity, { fleetName: "homelab", nodeName: "solo" });
  const vault = new Vault(store, identity);
  store.emit(identity, "connector.set", { id: "gmail", manifest: CATALOG.gmail!.manifest });
  const sent: Record<string, unknown>[] = [];
  const answer: ConnectorResult = { ok: true, status: 200, contentType: "application/json", body: '{"sent":"s1","thread":"t1"}', truncated: false, durationMs: 1 };
  const natives: Record<string, NativeTool> = { "gmail.send": (_m, args) => (sent.push(args), Promise.resolve(answer)) };
  const service = new ConnectorService({ store, vault, identity, local: new Database(":memory:"), ledger: () => {}, log: () => {}, natives });
  return { service, sent };
}
const primary = { kind: "agent" as const, by: "primary" };

test("an order to send mail names whom it may send to: one that names nobody, or a pattern, isn't signed", () => {
  const w = world();
  expect(() => w.service.sign({ connector: "gmail", tool: "send", args: {}, label: "Any reply" }, null)).toThrow("an order to send mail names whom it may send to");
  expect(() => w.service.sign({ connector: "gmail", tool: "send", args: { to: "*@example.test" }, label: "Anyone there" }, null)).toThrow("to: name each address in full, comma-separated, with no *");
  expect(w.service.sign({ connector: "gmail", tool: "send", args: { to: "anna@example.test" }, label: "Replies to Anna" }, null).order).toMatchObject({ args: { to: "anna@example.test" } });
});

test("it answers a send only to whom it names, today too: anyone else, in to or in cc, asks", async () => {
  const w = world();
  w.service.sign({ connector: "gmail", tool: "send", args: { to: "anna@example.test" }, label: "Replies to Anna" }, null);
  const toAnna = await w.service.call({ connector: "gmail", tool: "send", args: { to: "anna@example.test", body: "Thanks, paid." } }, primary);
  expect(toAnna.status === "done" && toAnna.order?.label).toBe("Replies to Anna");
  const others: Record<string, string>[] = [{ to: "anna@example.test", cc: "eve@example.test", body: "Thanks, paid." }, { to: "anna@example.test, eve@example.test", body: "Thanks, paid." }, { to: "eve@example.test", body: "Thanks, paid." }];
  for (const args of others) {
    expect([args, (await w.service.call({ connector: "gmail", tool: "send", args }, primary)).status]).toEqual([args, "asked"]);
  }
  expect(w.sent.map((args) => [args.to, args.cc ?? null])).toEqual([["anna@example.test", null]]);
});
