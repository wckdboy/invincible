import { describe, expect, test } from "bun:test";
import type { BuiltRequest } from "@invincible/core";
import { CATALOG, type ConnectorResult } from "@invincible/models";
import { mergeNative } from "../src/merge.ts";

/*
 * Merging a pull request of its agents' proven work (merge.ts, github.merge): through GitHub's own merge, and only once
 * GitHub says it is clean (every check and review its rules require passed, which a key that could pass a protection
 * doesn't change), while its head is still the commit that was proven, by a method the repository allows. Never forced,
 * never tried again another way. GitHub is the stand-in here; each request it is sent is said.
 */

const HEAD = "c".repeat(40);
const pull = (over: object = {}) => ({ number: 7, state: "open", merged: false, mergeable: true, mergeable_state: "clean", head: { sha: HEAD, ref: "invincible/units" }, base: { ref: "main" }, html_url: "https://github.com/amiriteorg/shipyard/pull/7", ...over });
const repo = (over: object = {}) => ({ full_name: "amiriteorg/shipyard", allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: true, ...over });

function github(answers: { pull?: object; repo?: object; merged?: { status: number; json: object } }) {
  const sent: { method: string; path: string; body?: unknown }[] = [];
  const send = async (step: BuiltRequest): Promise<ConnectorResult> => {
    const url = new URL(step.url);
    sent.push({ method: step.method, path: url.pathname, ...(step.body ? { body: JSON.parse(step.body) } : {}) });
    const json = url.pathname.endsWith("/merge") ? (answers.merged ?? { status: 200, json: { merged: true, sha: "d".repeat(40), message: "Pull Request successfully merged" } }) : url.pathname.endsWith("/pulls/7") ? { status: 200, json: answers.pull ?? pull() } : { status: 200, json: answers.repo ?? repo() };
    return { ok: json.status < 300, status: json.status, contentType: "application/json", body: JSON.stringify(json.json), truncated: false, durationMs: 1 };
  };
  return { sent, send };
}
const ARGS = { owner: "amiriteorg", repo: "shipyard", number: 7, sha: HEAD };
const merge = (args: Record<string, string | number> = ARGS, answers: Parameters<typeof github>[0] = {}) => {
  const gh = github(answers);
  return mergeNative()({ ...CATALOG.github!.manifest, origin: "https://api.github.com" }, args, gh.send).then((result) => ({ result, sent: gh.sent }));
};

describe("a merge of its agents' proven work", () => {
  test("clean, its head what was proven: merged by GitHub's own merge, by a method the repository allows, the head it saw named so nothing else lands", async () => {
    const { result, sent } = await merge();
    expect(result).toMatchObject({ ok: true, status: 200, body: `merged #7 into main (merge) at ${"d".repeat(40)}: https://github.com/amiriteorg/shipyard/pull/7` });
    expect(sent).toEqual([
      { method: "GET", path: "/repos/amiriteorg/shipyard/pulls/7" },
      { method: "GET", path: "/repos/amiriteorg/shipyard" },
      { method: "PUT", path: "/repos/amiriteorg/shipyard/pulls/7/merge", body: { sha: HEAD, merge_method: "merge" } },
    ]);
  });

  test("by the method it is asked for when the repository allows it, else the only one it allows, else in GitHub's own order", async () => {
    expect((await merge({ ...ARGS, method: "squash" })).sent.at(-1)!.body).toEqual({ sha: HEAD, merge_method: "squash" });
    expect((await merge(ARGS, { repo: repo({ allow_merge_commit: false, allow_rebase_merge: false }) })).sent.at(-1)!.body).toEqual({ sha: HEAD, merge_method: "squash" });
    expect((await merge(ARGS, { repo: repo({ allow_merge_commit: false }) })).sent.at(-1)!.body).toEqual({ sha: HEAD, merge_method: "squash" });
    const refused = await merge({ ...ARGS, method: "rebase" }, { repo: repo({ allow_rebase_merge: false }) });
    expect(refused.result).toMatchObject({ ok: false, body: "not merged: amiriteorg/shipyard allows merge, squash, not rebase" });
    expect(refused.sent.some((s) => s.method === "PUT")).toBe(false);
  });

  test("not clean, its head moved, merged or closed already: not merged, and nothing is sent to merge it", async () => {
    for (const [answers, said] of [
      [{ pull: pull({ mergeable_state: "blocked" }) }, "not merged: GitHub says #7 is blocked, and it merges only once every check and review its rules require has passed (clean)"],
      [{ pull: pull({ mergeable_state: "unstable" }) }, "not merged: GitHub says #7 is unstable, and it merges only once every check and review its rules require has passed (clean)"],
      [{ pull: pull({ mergeable_state: "behind" }) }, "not merged: GitHub says #7 is behind, and it merges only once every check and review its rules require has passed (clean)"],
      [{ pull: pull({ mergeable: null, mergeable_state: "unknown" }) }, "not merged: GitHub says #7 is unknown, and it merges only once every check and review its rules require has passed (clean)"],
      [{ pull: pull({ head: { sha: "e".repeat(40) } }) }, `not merged: #7's head is ${"e".repeat(40)}, not ${"c".repeat(40)}, which was proven: something was pushed onto it since`],
      // The review of 27 November (N3): a commit that only begins as the proven one does (48 bits can be found) is another.
      [{ pull: pull({ head: { sha: `${"c".repeat(12)}${"7".repeat(28)}` } }) }, `not merged: #7's head is ${"c".repeat(12)}${"7".repeat(28)}, not ${"c".repeat(40)}, which was proven: something was pushed onto it since`],
      [{ pull: pull({ merged: true }) }, "not merged: #7 is merged already"],
      [{ pull: pull({ state: "closed" }) }, "not merged: #7 is closed"],
    ] as const) {
      const { result, sent } = await merge(ARGS, answers);
      expect([said, result.ok]).toEqual([said, false]);
      expect(result.body).toBe(said);
      expect([said, sent.map((s) => s.method)]).toEqual([said, sent.length === 2 ? ["GET", "GET"] : ["GET"]]);
    }
  });

  test("the commit that was proven is named whole: a prefix of it merges nothing, and GitHub isn't asked to", async () => {
    for (const sha of ["c".repeat(12), "c".repeat(39), "c".repeat(41)]) {
      const { result, sent } = await merge({ ...ARGS, sha }, {});
      expect([sha.length, result.ok, result.body]).toEqual([sha.length, false, "not merged: the commit that was proven isn't named whole"]);
      expect(sent.filter((s) => s.method === "PUT")).toEqual([]);
    }
  });

  // The review of 27 November, N2 (N8's run: its mutants N2e and N2f): its own approval merges only what it stood on.
  test("on its own approval, only what that approval stood on, read again just before: into the default branch, from the branch it shipped, in this repository", async () => {
    const at = { full_name: "amiriteorg/shipyard" };
    const stood = { number: 7, baseRef: "main", baseRepo: "amiriteorg/shipyard", headRepo: "amiriteorg/shipyard", headRef: "invincible/units", headSha: HEAD, changedFiles: 1 };
    const own = async (answers: Parameters<typeof github>[0]) => {
      const gh = github(answers);
      const result = await mergeNative()({ ...CATALOG.github!.manifest, origin: "https://api.github.com" }, ARGS, gh.send, { own: true, facts: { pull: stood } });
      return { result, merged: gh.sent.some((s) => s.method === "PUT") };
    };
    const now = (over: object = {}) => pull({ base: { ref: "main", repo: at }, head: { sha: HEAD, ref: "invincible/units", repo: at }, ...over });
    // As it stood: merged.
    expect(await own({ pull: now(), repo: repo({ default_branch: "main" }) })).toMatchObject({ result: { ok: true }, merged: true });
    // Retargeted, the default branch changed, from another branch, or from a fork since: not merged, and it is yours.
    for (const [why, answers] of [
      ["retargeted onto production", { pull: now({ base: { ref: "production", repo: at } }), repo: repo({ default_branch: "main" }) }],
      ["the default branch is develop now", { pull: now(), repo: repo({ default_branch: "develop" }) }],
      ["from another branch", { pull: now({ head: { sha: HEAD, ref: "invincible/other", repo: at } }), repo: repo({ default_branch: "main" }) }],
      ["from a fork", { pull: now({ head: { sha: HEAD, ref: "invincible/units", repo: { full_name: "lin-example/shipyard" } } }), repo: repo({ default_branch: "main" }) }],
    ] as const) {
      const { result, merged } = await own(answers);
      expect([why, result.ok, result.status, merged]).toEqual([why, false, 409, false]);
      expect(result.body).toContain("merging it is yours");
    }
  });

  test("an own approval whose reads weren't kept (sent after a restart) merges nothing, and GitHub isn't asked: it is asked again", async () => {
    const gh = github({});
    const result = await mergeNative()({ ...CATALOG.github!.manifest, origin: "https://api.github.com" }, ARGS, gh.send, { own: true });
    expect(result).toMatchObject({ ok: false, status: 409, body: "not merged: what your agent's own approval of #7 stood on wasn't kept (it was sent after a restart): merging it is asked again" });
    expect(gh.sent).toEqual([]);
  });

  test("what GitHub refuses is said, and never tried again another way", async () => {
    const { result, sent } = await merge(ARGS, { merged: { status: 405, json: { message: "Required status check \"test\" is expected." } } });
    expect(result).toMatchObject({ ok: false, status: 405, body: "not merged: GitHub said 405: Required status check \"test\" is expected." });
    expect(sent.filter((s) => s.method === "PUT")).toHaveLength(1);
  });
});
