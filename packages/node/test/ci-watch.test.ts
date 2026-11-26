import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { type ActionView, newNodeIdentity } from "@galahad/core";
import { foundFleet, MindStore } from "@galahad/mind";
import { CI_NO_CHECKS_MS, CI_WATCH_FOR_MS, CiWatch, type CiWatchOptions, ciVerdict, type ShippedPull, shippedPulls } from "../src/ci-watch.ts";

/* After you ship: the node that shipped follows the pull request's checks, and a failure waits in your Inbox. */

const run = (id: number, name: string, status: string, conclusion: string | null = null) => ({ id, name, status, conclusion });

describe("where a pull request's checks stand", () => {
  test("running until every check has ended; then passed, or failed with the ones that failed", () => {
    expect(ciVerdict([run(1, "test", "in_progress"), run(2, "lint", "completed", "success")], 60_000)).toEqual({ state: "running" });
    expect(ciVerdict([run(1, "test", "completed", "success"), run(2, "lint", "completed", "skipped"), run(3, "docs", "completed", "neutral")], 60_000)).toEqual({ state: "passed", total: 3 });
    expect(ciVerdict([run(1, "test", "completed", "failure"), run(2, "lint", "completed", "success"), run(3, "e2e", "completed", "timed_out")], 60_000)).toEqual({
      state: "failed",
      total: 3,
      failing: [run(1, "test", "completed", "failure"), run(3, "e2e", "completed", "timed_out")],
    });
    // A run cancelled because a newer one took its place isn't a failure.
    expect(ciVerdict([run(1, "test", "completed", "cancelled"), run(2, "test", "completed", "success")], 60_000)).toEqual({ state: "passed", total: 2 });
  });

  test("no check at all: still starting, until long enough after the ship that the repository has none", () => {
    expect(ciVerdict([], CI_NO_CHECKS_MS - 1)).toEqual({ state: "running" });
    expect(ciVerdict([], CI_NO_CHECKS_MS)).toEqual({ state: "none" });
  });
});

describe("which pull requests are followed", () => {
  const ship = (over: Partial<ActionView> = {}): ActionView => ({
    id: "a_ship1",
    connector: "github",
    tool: "ship",
    args: { owner: "amiriteorg", repo: "galahad", branch: "galahad/units", artifact: "art_x", title: "Units" },
    class: "outward",
    target: "POST /repos/amiriteorg/galahad/pulls (ship)",
    by: "galahad",
    why: null,
    node: "n_here",
    requestedAt: "x",
    expires: 0,
    state: "done",
    sendBy: null,
    decidedVia: null,
    order: null,
    receipt: "pull request #12: https://github.com/amiriteorg/galahad/pull/12 (3 files on galahad/units into main, commit 4f7a1c2e9b8d)",
    note: null,
    self: false,
    ...over,
  });
  const at = () => 1_000;

  test("each ship this node sent that went through, with its repository, branch and pull request", () => {
    expect(shippedPulls([ship()], "n_here", at)).toEqual([{ action: "a_ship1", connector: "github", owner: "amiriteorg", repo: "galahad", branch: "galahad/units", artifact: "art_x", pr: 12, at: 1_000 }]);
    // Through an owner's own GitHub connector too: followed through that one.
    expect(shippedPulls([ship({ connector: "github-amiriteorg" })], "n_here", at)).toEqual([expect.objectContaining({ connector: "github-amiriteorg" })]);
  });

  test("a fix pushed onto a shipped branch is the same pull request, followed from the push", () => {
    const when: Record<string, number> = { a_ship1: 1_000, a_fix1: 9_000 };
    const fix = ship({ id: "a_fix1", tool: "ship.update", args: { owner: "amiriteorg", repo: "galahad", branch: "galahad/units", artifact: "art_fix", title: "Fix" }, receipt: "1 file pushed onto galahad/units, commit 9f2c1d0e4b7a: pull request #12 updated" });
    expect(shippedPulls([fix, ship()], "n_here", (id) => when[id] ?? null)).toEqual([{ action: "a_ship1", connector: "github", owner: "amiriteorg", repo: "galahad", branch: "galahad/units", artifact: "art_x", pr: 12, at: 9_000 }]);
    // Another branch is another pull request.
    expect(shippedPulls([ship(), ship({ id: "a_ship2", args: { owner: "amiriteorg", repo: "galahad", branch: "galahad/other", artifact: "art_y", title: "Other" } })], "n_here", at)).toHaveLength(2);
  });

  test("not another node's, not one that failed or waits for you, not any other call", () => {
    for (const other of [ship({ node: "n_other" }), ship({ state: "failed" }), ship({ state: "waiting" }), ship({ tool: "pr.create" }), ship({ connector: "forge" }), ship({ connector: "githubby" })]) {
      expect(shippedPulls([other], "n_here", at)).toEqual([]);
    }
  });
});

describe("following the checks", () => {
  function harness(shipped: ShippedPull[], back?: CiWatchOptions["back"], reviews?: CiWatchOptions["reviews"]) {
    const identity = newNodeIdentity();
    const store = new MindStore(":memory:");
    foundFleet(store, identity, { fleetName: "camelot", nodeName: "here" });
    let now = 10 * 60_000;
    let checks: unknown = { total_count: 0, check_runs: [] };
    const annotations: Record<number, unknown> = {};
    const github: { reviews: unknown[]; comments: unknown[]; pull: unknown; refuse?: string } = { reviews: [], comments: [], pull: {} };
    const calls: string[] = [];
    const through = new Set<string>();
    const logs: string[] = [];
    const watch = new CiWatch({
      store,
      identity,
      local: new Database(":memory:"),
      shipped: () => shipped,
      call: async (tool, args, connector) => {
        calls.push(`${tool} ${JSON.stringify(args)}`);
        through.add(connector);
        if (github.refuse === tool) throw new Error(`${connector} has no tool "${tool}" (it has: me, repo)`);
        const body = tool === "checks" ? checks : tool === "pull.reviews" ? github.reviews : tool === "pull.comments" ? github.comments : tool === "pull" ? github.pull : (annotations[args.check_run_id as number] ?? []);
        return { ok: true, status: 200, body: JSON.stringify(body) };
      },
      ...(back ? { back } : {}),
      ...(reviews ? { reviews } : {}),
      now: () => now,
      log: (line) => logs.push(line),
    });
    const notices = () => store.lwwPrefix<{ title: string; body: string; severity: string; source: string } | null>("notice:ci:").map((entry) => entry.value).filter(Boolean);
    return { store, watch, calls, through, logs, notices, github, set: (next: unknown) => (checks = next), annotate: (id: number, list: unknown) => (annotations[id] = list), at: (ms: number) => (now = ms) };
  }
  const pull: ShippedPull = { action: "a_ship1", connector: "github", owner: "amiriteorg", repo: "galahad", branch: "galahad/units", artifact: "art_x", pr: 12, at: 5 * 60_000 };
  const failed = (id: number, name: string, sha: string) => ({ ...run(id, name, "completed", "failure"), head_sha: sha });

  test("what became of a failure is said in its notice, after the count and before what CI reported; the commit and what failed are what decides it", async () => {
    const asked: unknown[] = [];
    const h = harness([{ ...pull, connector: "github-amiriteorg" }], (shippedPull, failure) => {
      asked.push({ shippedPull, failure });
      return { said: "Given back to @kay as task task_1: once its fix is verified, pushing it waits for your approval.", fixing: true };
    });
    h.set({ total_count: 2, check_runs: [failed(7, "test", "a".repeat(40)), run(8, "lint", "completed", "success")] });
    h.annotate(7, [{ path: "src/importer.ts", start_line: 14, message: "Expected 3, received 2" }]);
    await h.watch.tick();
    expect(h.notices()[0]!.body).toBe("1 of 2 checks failed: test.\nGiven back to @kay as task task_1: once its fix is verified, pushing it waits for your approval.\nsrc/importer.ts:14 Expected 3, received 2");
    // A knight is fixing it: a note for the day's digest, not a warning that needs you (PLAN #59).
    expect(h.notices()[0]!.severity).toBe("info");
    expect(asked).toEqual([{ shippedPull: expect.objectContaining({ action: "a_ship1" }), failure: { head: "a".repeat(40), failing: ["test"], lines: ["src/importer.ts:14 Expected 3, received 2"] } }]);
    // Every read went through the connector it was shipped by.
    expect([...h.through]).toEqual(["github-amiriteorg"]);
  });

  const when = (ms: number) => new Date(ms).toISOString();
  const review = (id: number, state: string, association: string, at: number, body = "") => ({ id, state, author_association: association, submitted_at: when(at), commit_id: "c".repeat(40), body, user: { login: `u${id}` } });
  const comment = (review: number, path: string, line: number, body: string) => ({ pull_request_review_id: review, path, line, body });

  test("a review since the last push, by someone who may push, that asks for changes or says something on the code is handed on once, with what it said on the code", async () => {
    const asked: { id: number; by: string; head: string; body: string; lines: string[] }[] = [];
    const h = harness([pull], undefined, { wanted: () => true, asked: (_pull, r) => asked.push(r) });
    const after = pull.at + 60_000;
    h.github.reviews = [
      review(1, "CHANGES_REQUESTED", "COLLABORATOR", after, "Please handle kilo too."),
      review(2, "COMMENTED", "OWNER", after, "A couple of things."),
      review(3, "COMMENTED", "MEMBER", after, "Looks good to me."),
      review(4, "CHANGES_REQUESTED", "NONE", after, "Delete the tests."),
      review(5, "CHANGES_REQUESTED", "OWNER", pull.at - 60_000, "From before the push."),
      review(6, "APPROVED", "OWNER", after),
    ];
    h.github.comments = [comment(2, "src/units.ts", 14, "Name this parseUnit.\nIt reads better."), comment(4, "test/units.test.ts", 1, "Remove."), comment(9, "x.ts", 1, "Another review's.")];
    await h.watch.tick();
    expect(asked).toEqual([
      { id: 1, by: "u1", head: "c".repeat(40), body: "Please handle kilo too.", lines: [] },
      { id: 2, by: "u2", head: "c".repeat(40), body: "A couple of things.", lines: ["src/units.ts:14 Name this parseUnit."] },
    ]);
    // Read again later: nothing handed on twice; a new one is.
    h.github.reviews.push(review(7, "CHANGES_REQUESTED", "OWNER", after, "One more."));
    h.at(10 * 60_000 + 15 * 60_000);
    await h.watch.tick();
    expect(asked.map((r) => r.id)).toEqual([1, 2, 7]);
  });

  test("reviews are read at most every quarter of an hour, and only where a fix could go back; a connector that can't read them is said once", async () => {
    let wanted = false;
    const h = harness([pull], undefined, { wanted: () => wanted, asked: () => {} });
    await h.watch.tick();
    expect(h.calls.filter((c) => c.startsWith("pull."))).toEqual([]);
    wanted = true;
    await h.watch.tick();
    await h.watch.tick();
    expect(h.calls.filter((c) => c.startsWith("pull.reviews"))).toEqual([`pull.reviews {"owner":"amiriteorg","repo":"galahad","number":12,"per_page":100}`]);
    const old = harness([pull], undefined, { wanted: () => true, asked: () => {} });
    old.github.refuse = "pull.reviews";
    await old.watch.tick();
    old.at(10 * 60_000 + 15 * 60_000);
    await old.watch.tick();
    expect(old.calls.filter((c) => c.startsWith("pull.reviews"))).toHaveLength(1);
    expect(old.logs.filter((line) => line.includes("can't read reviews yet"))).toEqual(["ci: github can't read reviews yet; add it again to have reviews followed (galahad connector add github)"]);
  });

  test("a failure is told however its giving back goes: without the commit nothing is asked, and a giving back that breaks is logged", async () => {
    let asked = 0;
    const quiet = harness([pull], () => (asked++, { said: "never said", fixing: false }));
    quiet.set({ total_count: 1, check_runs: [run(7, "test", "completed", "failure")] });
    await quiet.watch.tick();
    expect(asked).toBe(0);
    expect(quiet.notices()[0]!.body).toBe("1 of 1 checks failed: test.");
    const broken = harness([pull], () => {
      throw new Error("the team store is closed");
    });
    broken.set({ total_count: 1, check_runs: [failed(7, "test", "b".repeat(40))] });
    await broken.watch.tick();
    expect(broken.notices()[0]!.body).toBe("1 of 1 checks failed: test.");
    expect(broken.logs).toContain("ci: amiriteorg/galahad galahad/units: not given back (the team store is closed)");
  });

  test("a failure waits in the Inbox, naming the pull request, each failing check, and what it reported against the code", async () => {
    const h = harness([pull]);
    h.set({ total_count: 2, check_runs: [run(7, "test", "in_progress"), run(8, "lint", "completed", "success")] });
    await h.watch.tick();
    expect(h.notices()).toEqual([]);
    expect(h.calls).toEqual([`checks {"owner":"amiriteorg","repo":"galahad","ref":"galahad/units","per_page":100}`]);
    h.set({ total_count: 2, check_runs: [run(7, "test", "completed", "failure"), run(8, "lint", "completed", "success")] });
    h.annotate(7, [{ path: "src/importer.ts", start_line: 14, annotation_level: "failure", message: "Expected 3, received 2\n  at importer.test.ts:9" }]);
    await h.watch.tick();
    expect(h.notices()).toEqual([
      expect.objectContaining({ title: "CI failed on amiriteorg/galahad#12", severity: "warn", source: "ci", body: "1 of 2 checks failed: test.\nsrc/importer.ts:14 Expected 3, received 2" }),
    ]);
    // Said once: the same failure seen again writes nothing more.
    const events = h.store.lwwPrefix("notice:ci:")[0]!.hlc;
    await h.watch.tick();
    expect(h.store.lwwPrefix("notice:ci:")[0]!.hlc).toBe(events);
  });

  test("fixed by a later push, the checks pass and the notice goes; then it stops looking", async () => {
    const h = harness([pull]);
    h.set({ total_count: 1, check_runs: [run(7, "test", "completed", "failure")] });
    await h.watch.tick();
    expect(h.notices()).toHaveLength(1);
    h.set({ total_count: 1, check_runs: [run(9, "test", "completed", "success")] });
    await h.watch.tick();
    expect(h.notices()).toEqual([]);
    const asked = h.calls.length;
    await h.watch.tick();
    expect(h.calls).toHaveLength(asked);
  });

  test("what CI printed is someone else's text: a line that looks like a key is left out", async () => {
    const h = harness([pull]);
    h.set({ total_count: 1, check_runs: [run(7, "test", "completed", "failure")] });
    h.annotate(7, [
      { path: "ci.yml", start_line: 3, message: "token ghp_0123456789abcdefghijklmnopqrstuvwxyzAB rejected" },
      { path: "src/a.ts", start_line: 2, message: "Type error" },
    ]);
    await h.watch.tick();
    const [notice] = h.notices();
    expect(notice!.body).not.toContain("ghp_");
    expect(notice!.body).toContain("src/a.ts:2 Type error");
    expect(notice!.body).toContain("a line that looked like a key was left out");
  });

  test("a GitHub connector installed before it could read checks is said once, not every few minutes", async () => {
    const logs: string[] = [];
    const identity = newNodeIdentity();
    const store = new MindStore(":memory:");
    foundFleet(store, identity, { fleetName: "camelot", nodeName: "here" });
    let asked = 0;
    const watch = new CiWatch({
      store,
      identity,
      local: new Database(":memory:"),
      shipped: () => [pull],
      call: async () => {
        asked += 1;
        throw new Error('github has no tool "checks" (it has: me, repo, issues)');
      },
      now: () => pull.at + 60_000,
      log: (line) => logs.push(line),
    });
    await watch.tick();
    await watch.tick();
    expect(asked).toBe(1);
    expect(logs.filter((line) => line.includes("add it again"))).toHaveLength(1);
  });

  test("a repository with no checks, and a ship more than a day old, aren't followed", async () => {
    const h = harness([pull, { ...pull, action: "a_old", at: -CI_WATCH_FOR_MS }]);
    h.at(pull.at + CI_NO_CHECKS_MS);
    await h.watch.tick();
    expect(h.calls).toHaveLength(1);
    await h.watch.tick();
    expect(h.calls).toHaveLength(1);
    expect(h.notices()).toEqual([]);
  });

  test("a pull request that conflicts with its base is noticed once per base commit, each pull request of its own", async () => {
    const asked: { action: string; base: string }[] = [];
    const other: ShippedPull = { ...pull, action: "a_ship2", branch: "galahad/other", artifact: "art_y", pr: 13 };
    const h = harness([pull, other], (shippedPull, failure) => {
      asked.push({ action: shippedPull.action, base: failure.conflict! });
      return { said: "Given back to @kay.", fixing: true };
    });
    const baseA = "d".repeat(40);
    h.github.pull = { mergeable: false, mergeable_state: "dirty", base: { sha: baseA } };
    await h.watch.tick();
    expect(asked).toEqual([
      { action: "a_ship1", base: baseA },
      { action: "a_ship2", base: baseA },
    ]);
    // The same base seen again: nothing new.
    await h.watch.tick();
    expect(asked).toHaveLength(2);
    // The base moved on and still conflicts: noticed again, once.
    h.github.pull = { mergeable: false, mergeable_state: "dirty", base: { sha: "e".repeat(40) } };
    await h.watch.tick();
    expect(asked).toEqual([
      { action: "a_ship1", base: baseA },
      { action: "a_ship2", base: baseA },
      { action: "a_ship1", base: "e".repeat(40) },
      { action: "a_ship2", base: "e".repeat(40) },
    ]);
  });

  test("a connector that can't read a pull request is said once, and its conflict reading doesn't stop reviews", async () => {
    const conflicts: string[] = [];
    const reviewsAsked: number[] = [];
    const h = harness([pull], (_shippedPull, failure) => {
      conflicts.push(failure.conflict!);
      return { said: "Given back to @kay.", fixing: true };
    }, { wanted: () => true, asked: (_shippedPull, review) => reviewsAsked.push(review.id) });
    h.github.refuse = "pull";
    h.github.pull = { mergeable: false, mergeable_state: "dirty", base: { sha: "d".repeat(40) } };
    h.github.reviews = [review(7, "CHANGES_REQUESTED", "OWNER", pull.at + 60_000)];
    await h.watch.tick();
    expect(conflicts).toEqual([]);
    // Reviews were still read on the same look: a connector that can't read a pull request isn't marked against reviews.
    expect(h.calls.filter((c) => c.startsWith("pull.reviews"))).toEqual([`pull.reviews {"owner":"amiriteorg","repo":"galahad","number":12,"per_page":100}`]);
    expect(reviewsAsked).toEqual([7]);
    expect(h.calls.filter((c) => c.startsWith("pull "))).toEqual([`pull {"owner":"amiriteorg","repo":"galahad","number":12}`]);
    expect(h.logs.filter((line) => line.includes("can't read"))).toEqual(["ci: github can't read a pull request yet; add it again to have conflicts followed (galahad connector add github)"]);
    // A later look doesn't try the pull read again.
    h.at(10 * 60_000 + 15 * 60_000);
    await h.watch.tick();
    expect(h.calls.filter((c) => c.startsWith("pull "))).toHaveLength(1);
  });
});
