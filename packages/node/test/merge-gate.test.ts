import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { newNodeIdentity } from "@invincible/core";
import { foundFleet, LedgerStore, Vault } from "@invincible/ledger";
import { CATALOG } from "@invincible/models";
import { ConnectorService, type NativeTool } from "../src/connectors.ts";

/*
 * Whether a merge of its agents' work is its own (policy.ts ownApproval, with what connectors.ts reads of what it
 * shipped): what a merge lands is every push this node sent onto the pull request's branch, its ship and each fix since,
 * from their kept shipments. One that lands a change to what the repository's CI runs is yours, though you approved the
 * push of it, since merging lands it where the repository's secrets run it. GitHub is played by the natives here, and
 * by a stand-in for what it says before a push is its own: main where the ship began, its branch where the ship left it.
 */

const ORIGIN = "https://api.github.com";
const KEY = "github_pat_FAKEFAKEFAKEFAKE0000_merge";
const URL7 = "https://github.com/amiriteorg/shipyard/pull/7";
const MAIN = "a".repeat(40);
const SHIPPED = "c".repeat(40);
/** Each kept shipment: what it changes, and the commit it began on (the ship on main; each fix where the ship left it). */
const KEPT: Record<string, { files: string[]; base: string }> = {
  art_AAAAAAAAAAAAAAAAAAAAAA: { files: ["src/units.ts", "docs/units.md"], base: MAIN },
  art_BBBBBBBBBBBBBBBBBBBBBB: { files: ["src/units.ts"], base: SHIPPED },
  art_CCCCCCCCCCCCCCCCCCCCCC: { files: [".github/workflows/ci.yml"], base: SHIPPED },
};
/** What GitHub says, asked before a push may be its own: the repository, and where main and the shipped branch stand. */
const SAID: Record<string, unknown> = {
  "/repos/amiriteorg/shipyard": { full_name: "amiriteorg/shipyard", private: false, fork: false, default_branch: "main", owner: { login: "amiriteorg", id: 600, type: "Organization" } },
  "/repos/amiriteorg/shipyard/git/ref/heads/main": { ref: "refs/heads/main", object: { sha: MAIN, type: "commit" } },
  "/repos/amiriteorg/shipyard/git/ref/heads/invincible/units": { ref: "refs/heads/invincible/units", object: { sha: SHIPPED, type: "commit" } },
};
const github = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const said = (init?.method ?? "GET") === "GET" && url.origin === ORIGIN ? SAID[url.pathname] : undefined;
  return said ? Response.json(said) : Response.json({ message: "Not Found" }, { status: 404 });
}) as unknown as typeof fetch;

function world() {
  const identity = newNodeIdentity();
  const store = new LedgerStore(":memory:");
  foundFleet(store, identity, { fleetName: "homelab", nodeName: "solo" });
  const vault = new Vault(store, identity);
  vault.set("github", KEY, { provider: "github", origin: ORIGIN });
  store.emit(identity, "connector.set", { id: "github", manifest: CATALOG.github!.manifest });
  const merged: unknown[] = [];
  const answer = (status: number, body: string): ReturnType<NativeTool> => Promise.resolve({ ok: status < 300, status, contentType: "text/plain", body, truncated: false, durationMs: 1 });
  const natives: Record<string, NativeTool> = {
    "github.ship": () => answer(201, `pull request #7: ${URL7} (2 files on invincible/units into main, commit ${"c".repeat(40)})`),
    "github.ship.update": () => answer(200, `1 file pushed onto invincible/units, commit ${"e".repeat(40)}: pull request #7 updated, ${URL7}`),
    "github.merge": (_m, args) => (merged.push(args), answer(200, `merged #7 into main (squash) at ${"d".repeat(40)}: ${URL7}`)),
  };
  const service = new ConnectorService({ store, vault, identity, local: new Database(":memory:"), ledger: () => {}, log: () => {}, natives, fetch: github, repositories: () => ["https://github.com/amiriteorg/shipyard"], shipment: (artifact) => KEPT[artifact] ?? null });
  return { service, merged };
}
const noa = { kind: "agent" as const, by: "team.0123456789.noa" };
const at = { owner: "amiriteorg", repo: "shipyard" };
const ship = (artifact: string) => ({ connector: "github", tool: "ship", args: { ...at, artifact, branch: "invincible/units", title: "Units" } });
const fix = (artifact: string) => ({ connector: "github", tool: "ship.update", args: { ...at, artifact, branch: "invincible/units", title: "Fix the checks" } });
const merge = (sha: string) => ({ connector: "github", tool: "merge", args: { ...at, number: 7, sha } });

describe("what a merge of its agents' work lands", () => {
  test("its ship and each fix since, none changing what the CI runs: its own merge", async () => {
    const w = world();
    expect((await w.service.call(ship("art_AAAAAAAAAAAAAAAAAAAAAA"), noa)).status).toBe("done");
    expect((await w.service.call(fix("art_BBBBBBBBBBBBBBBBBBBBBB"), noa)).status).toBe("done");
    const merged = await w.service.call(merge("e".repeat(40)), { kind: "agent", by: "primary" });
    expect(merged.status === "done" && merged.own).toBe("a merge of its agents' proven work, through GitHub's own merge once every check its rules require passed, in amiriteorg/shipyard, a repository you gave an agent");
  });

  test("a fix since that changes what the CI runs, whose push you approved: the merge that would land it is yours too", async () => {
    const w = world();
    expect((await w.service.call(ship("art_AAAAAAAAAAAAAAAAAAAAAA"), noa)).status).toBe("done");
    const pushed = await w.service.call(fix("art_CCCCCCCCCCCCCCCCCCCCCC"), noa);
    expect(pushed.status).toBe("asked");
    w.service.decide(pushed.status === "asked" ? pushed.action : "", true, null);
    await w.service.drain();
    expect((await w.service.call(merge("e".repeat(40)), { kind: "agent", by: "primary" })).status).toBe("asked");
    expect(w.merged).toEqual([]);
  });

  test("a pull request this node didn't ship, or one whose kept work it can't read: the merge is yours", async () => {
    const w = world();
    expect((await w.service.call(merge("c".repeat(40)), { kind: "agent", by: "primary" })).status).toBe("asked");
    expect((await w.service.call(ship("art_DDDDDDDDDDDDDDDDDDDDDD"), noa)).status).toBe("asked");
    expect(w.merged).toEqual([]);
  });
});
