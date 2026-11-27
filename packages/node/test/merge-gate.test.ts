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
const URL8 = "https://github.com/amiriteorg/shipyard/pull/8";
const MAIN = "a".repeat(40);
const SHIPPED = "c".repeat(40);
/** Each kept shipment: what it changes, and the commit it began on (the ship on main; each fix where the ship left it). */
const KEPT: Record<string, { files: string[]; base: string }> = {
  art_AAAAAAAAAAAAAAAAAAAAAA: { files: ["src/units.ts", "docs/units.md"], base: MAIN },
  art_BBBBBBBBBBBBBBBBBBBBBB: { files: ["src/units.ts"], base: SHIPPED },
  art_CCCCCCCCCCCCCCCCCCCCCC: { files: [".github/workflows/ci.yml"], base: SHIPPED },
  art_EEEEEEEEEEEEEEEEEEEEEE: { files: ["src/parse.ts"], base: MAIN },
};
/** Whose proven work each is: the ship's, a verified task's; each fix's, a verified fix task's for the shipped branch. */
const PROVEN: Record<string, { fix?: { owner: string; repo: string; branch: string } }> = {
  art_AAAAAAAAAAAAAAAAAAAAAA: {},
  art_BBBBBBBBBBBBBBBBBBBBBB: { fix: { owner: "amiriteorg", repo: "shipyard", branch: "invincible/units" } },
  art_CCCCCCCCCCCCCCCCCCCCCC: { fix: { owner: "amiriteorg", repo: "shipyard", branch: "invincible/units" } },
  art_EEEEEEEEEEEEEEEEEEEEEE: {},
};
/** What GitHub says, asked before a push may be its own: the repository, and where main and the shipped branch stand;
 * and before a merge: the pull request (into main, from the shipped branch, its head the fix's commit), its two commits
 * and its files. (No workflows: none runs on a pull request.) */
const SAID: Record<string, unknown> = {
  "/repos/amiriteorg/shipyard/pulls/7": { number: 7, state: "open", changed_files: 2, base: { ref: "main", repo: { full_name: "amiriteorg/shipyard" } }, head: { ref: "invincible/units", sha: "e".repeat(40), repo: { full_name: "amiriteorg/shipyard" } } },
  "/repos/amiriteorg/shipyard/pulls/7/commits": [{ sha: "c".repeat(40) }, { sha: "e".repeat(40) }],
  "/repos/amiriteorg/shipyard/pulls/7/files": [{ filename: "src/units.ts" }, { filename: "docs/units.md" }],
  "/repos/amiriteorg/shipyard": { full_name: "amiriteorg/shipyard", private: false, fork: false, default_branch: "main", owner: { login: "amiriteorg", id: 600, type: "Organization" } },
  "/repos/amiriteorg/shipyard/git/ref/heads/main": { ref: "refs/heads/main", object: { sha: MAIN, type: "commit" } },
  "/repos/amiriteorg/shipyard/git/ref/heads/invincible/units": { ref: "refs/heads/invincible/units", object: { sha: SHIPPED, type: "commit" } },
};
/** A second pull request in the same repository, #8, from its own branch: its one commit, its one file. */
const SAID8: Record<string, unknown> = {
  "/repos/amiriteorg/shipyard/pulls/8": { number: 8, state: "open", changed_files: 1, base: { ref: "main", repo: { full_name: "amiriteorg/shipyard" } }, head: { ref: "invincible/parse", sha: "f".repeat(40), repo: { full_name: "amiriteorg/shipyard" } } },
  "/repos/amiriteorg/shipyard/pulls/8/commits": [{ sha: "f".repeat(40) }],
  "/repos/amiriteorg/shipyard/pulls/8/files": [{ filename: "src/parse.ts" }],
};
/** #7 as its ship left it, no fix since: its one commit. */
const SHIPPED7: Record<string, unknown> = {
  "/repos/amiriteorg/shipyard/pulls/7": { ...(SAID["/repos/amiriteorg/shipyard/pulls/7"] as object), head: { ref: "invincible/units", sha: SHIPPED, repo: { full_name: "amiriteorg/shipyard" } } },
  "/repos/amiriteorg/shipyard/pulls/7/commits": [{ sha: SHIPPED }],
};

/** A world of one node: its GitHub (what it says), its kept shipments (a copy, which a test may lose one of). */
function world(over: { said?: Record<string, unknown> } = {}) {
  const said = { ...SAID, ...over.said };
  const kept = { ...KEPT };
  const github = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const answer = (init?.method ?? "GET") === "GET" && url.origin === ORIGIN ? said[url.pathname] : undefined;
    return answer ? Response.json(answer) : Response.json({ message: "Not Found" }, { status: 404 });
  }) as unknown as typeof fetch;
  const identity = newNodeIdentity();
  const store = new LedgerStore(":memory:");
  foundFleet(store, identity, { fleetName: "homelab", nodeName: "solo" });
  const vault = new Vault(store, identity);
  vault.set("github", KEY, { provider: "github", origin: ORIGIN });
  store.emit(identity, "connector.set", { id: "github", manifest: CATALOG.github!.manifest });
  const merged: unknown[] = [];
  const answer = (status: number, body: string): ReturnType<NativeTool> => Promise.resolve({ ok: status < 300, status, contentType: "text/plain", body, truncated: false, durationMs: 1 });
  const natives: Record<string, NativeTool> = {
    "github.ship": (_m, args) => (args.branch === "invincible/parse" ? answer(201, `pull request #8: ${URL8} (1 file on invincible/parse into main, commit ${"f".repeat(40)})`) : answer(201, `pull request #7: ${URL7} (2 files on invincible/units into main, commit ${"c".repeat(40)})`)),
    "github.ship.update": () => answer(200, `1 file pushed onto invincible/units, commit ${"e".repeat(40)}: pull request #7 updated, ${URL7}`),
    "github.merge": (_m, args) => (merged.push(args), answer(200, `merged #${args.number} into main (squash) at ${"d".repeat(40)}: https://github.com/amiriteorg/shipyard/pull/${args.number}`)),
  };
  const service = new ConnectorService({ store, vault, identity, local: new Database(":memory:"), ledger: () => {}, log: () => {}, natives, fetch: github, repositories: () => ["https://github.com/amiriteorg/shipyard"], shipment: (artifact) => kept[artifact] ?? null, proven: (artifact) => PROVEN[artifact] ?? null });
  return { service, merged, kept };
}
const noa = { kind: "agent" as const, by: "team.0123456789.noa" };
const at = { owner: "amiriteorg", repo: "shipyard" };
const ship = (artifact: string, branch = "invincible/units") => ({ connector: "github", tool: "ship", args: { ...at, artifact, branch, title: "Units" } });
const fix = (artifact: string) => ({ connector: "github", tool: "ship.update", args: { ...at, artifact, branch: "invincible/units", title: "Fix the checks" } });
const merge = (sha: string, number = 7) => ({ connector: "github", tool: "merge", args: { ...at, number, sha } });

describe("what a merge of its agents' work lands", () => {
  test("its ship and each fix since, none changing what the CI runs: its own merge", async () => {
    const w = world();
    expect((await w.service.call(ship("art_AAAAAAAAAAAAAAAAAAAAAA"), noa)).status).toBe("done");
    expect((await w.service.call(fix("art_BBBBBBBBBBBBBBBBBBBBBB"), noa)).status).toBe("done");
    const merged = await w.service.call(merge("e".repeat(40)), { kind: "agent", by: "primary" });
    expect(merged.status === "done" && merged.own).toBe("a merge of its agents' proven work into main (its 2 commits, each pushed by this node, its checks green), in amiriteorg/shipyard, a repository you gave an agent");
    // And it says which commits it lands, whole.
    expect(merged.status === "done" && merged.commits).toEqual(["c".repeat(40), "e".repeat(40)]);
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

  // The review of 27 November, N8 (G5): a merge lands every push onto the branch, so each one's kept work is read.
  test("a fix since whose kept work can't be read any more: the merge that would land it is yours", async () => {
    const w = world();
    expect((await w.service.call(ship("art_AAAAAAAAAAAAAAAAAAAAAA"), noa)).status).toBe("done");
    expect((await w.service.call(fix("art_BBBBBBBBBBBBBBBBBBBBBB"), noa)).status).toBe("done");
    delete w.kept.art_BBBBBBBBBBBBBBBBBBBBBB;
    expect((await w.service.call(merge("e".repeat(40)), { kind: "agent", by: "primary" })).status).toBe("asked");
    expect(w.merged).toEqual([]);
  });

  // The review of 27 November, N8 (G7): two pull requests of its work in one repository, each judged by its own pushes.
  test("two pull requests in one repository: each merge lands its own pull request's pushes, and one whose kept work can't be read is yours", async () => {
    const both = async (w: ReturnType<typeof world>) => {
      expect((await w.service.call(ship("art_AAAAAAAAAAAAAAAAAAAAAA"), noa)).status).toBe("done");
      expect((await w.service.call(ship("art_EEEEEEEEEEEEEEEEEEEEEE", "invincible/parse"), noa)).status).toBe("done");
    };
    const primary = { kind: "agent" as const, by: "primary" };
    const w = world({ said: { ...SHIPPED7, ...SAID8 } });
    await both(w);
    for (const [number, head] of [[8, "f".repeat(40)], [7, SHIPPED]] as const) {
      const merged = await w.service.call(merge(head, number), primary);
      expect([number, merged.status === "done" && merged.commits]).toEqual([number, [head]]);
    }
    // #8's kept work lost: its merge is yours, and #7's is still its own.
    const lost = world({ said: { ...SHIPPED7, ...SAID8 } });
    await both(lost);
    delete lost.kept.art_EEEEEEEEEEEEEEEEEEEEEE;
    expect((await lost.service.call(merge(SHIPPED, 7), primary)).status).toBe("done");
    expect((await lost.service.call(merge("f".repeat(40), 8), primary)).status).toBe("asked");
    expect(lost.merged).toEqual([{ ...at, number: 7, sha: SHIPPED }]);
  });

  test("a pull request this node didn't ship, or one whose kept work it can't read: the merge is yours", async () => {
    const w = world();
    expect((await w.service.call(merge("c".repeat(40)), { kind: "agent", by: "primary" })).status).toBe("asked");
    expect((await w.service.call(ship("art_DDDDDDDDDDDDDDDDDDDDDD"), noa)).status).toBe("asked");
    expect(w.merged).toEqual([]);
  });
});
