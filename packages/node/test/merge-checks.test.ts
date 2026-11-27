// What a merge's checks wait for (N10) and what a fix's proof is (N1), held by the tests and not by the code alone: the
// re-review of 27 November (A1) found the shipped tests wouldn't notice if they stopped holding (its mutants R17, R20-R23
// and R25). The real ConnectorService, policy, shipNative, shipmentFiles and mergeNative, with a stand-in GitHub
// (github-world.ts). No real service is called; the key is obviously fake.
import { expect, test } from "bun:test";
import { gh, MAIN, manifest, type Run, world } from "./github-world.ts";

const ada = { kind: "agent" as const, by: "team.0123456789.ada" };
const at = { owner: "lin-example", repo: "site" };
const UNITS = { art_AAAAAAAAAAAAAAAAAAAAAA: { "ship/manifest.json": manifest(MAIN, ["src/units.ts"]), "ship/files/src/units.ts": "export const k = 1e3;\n" } };
const CI = "name: ci\non:\n  pull_request:\n  push:\n    branches: [main]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: bun test\n";

async function shipThenMerge(o: Parameters<typeof gh>[0]) {
  const w = world(UNITS, gh(o));
  expect((await w.service.call({ connector: "github", tool: "ship", args: { ...at, artifact: "art_AAAAAAAAAAAAAAAAAAAAAA", branch: "invincible/units", title: "Units" } }, ada)).status).toBe("done");
  const head = w.g.heads.get("invincible/units")!;
  const merged = await w.service.call({ connector: "github", tool: "merge", args: { ...at, number: 7, sha: head } }, { kind: "agent", by: "primary" });
  return { w, head, merged };
}
const run = (head: string, conclusion: string | null, event = "pull_request", status = conclusion === null ? "in_progress" : "completed"): Run => ({ event, status, conclusion, head_sha: head });

test("its pull request's checks green: it merges (the control)", async () => {
  const { w, merged } = await shipThenMerge({ workflows: { "ci.yml": CI }, runs: (head) => [run(head, "success")] });
  expect(merged.status).toBe("done");
  expect(w.g.merges).toHaveLength(1);
});

test("a pull request's run that failed is not green: the merge asks", async () => {
  const { w, merged } = await shipThenMerge({ workflows: { "ci.yml": CI }, runs: (head) => [run(head, "failure")] });
  expect(merged.status).toBe("asked");
  expect(w.g.merges).toEqual([]);
});

test("no run on its head yet: the merge asks", async () => {
  const { w, merged } = await shipThenMerge({ workflows: { "ci.yml": CI }, runs: () => [] });
  expect(merged.status).toBe("asked");
  expect(w.g.merges).toEqual([]);
});

test("a workflow GitHub won't give: the merge asks", async () => {
  const { w, merged } = await shipThenMerge({ workflows: { "ci.yml": CI, "release.yml": null }, runs: (head) => [run(head, "success")] });
  expect(merged.status).toBe("asked");
  expect(w.g.merges).toEqual([]);
});

test("a workflow on pull_request_target alone, still running: the merge asks", async () => {
  const { w, merged } = await shipThenMerge({ workflows: { "label.yml": "on:\n  pull_request_target:\njobs: {}\n" }, runs: (head) => [run(head, null, "pull_request_target")] });
  expect(merged.status).toBe("asked");
  expect(w.g.merges).toEqual([]);
});

for (const [given, own] of [["invincible/other", false], ["invincible/units", true]] as const) {
  test(`a verified fix given for ${given}, pushed onto invincible/units, is ${own ? "its own (the control)" : "yours"}`, async () => {
    const files: Record<string, Record<string, string>> = { ...UNITS };
    const proven: Record<string, { fix?: { owner: string; repo: string; branch: string } }> = {};
    const w = world(files, gh(), proven);
    expect((await w.service.call({ connector: "github", tool: "ship", args: { ...at, artifact: "art_AAAAAAAAAAAAAAAAAAAAAA", branch: "invincible/units", title: "Units" } }, ada)).status).toBe("done");
    const head = w.g.heads.get("invincible/units")!;
    // A fix task's verified kept work, built on the branch's head as it stands (where it last pushed), for `given`.
    files.art_BBBBBBBBBBBBBBBBBBBBBB = { "ship/manifest.json": manifest(head, ["src/units.ts"]), "ship/files/src/units.ts": "export const k = 1000;\n" };
    proven.art_BBBBBBBBBBBBBBBBBBBBBB = { fix: { owner: "lin-example", repo: "site", branch: given } };
    const pushed = await w.service.call({ connector: "github", tool: "ship.update", args: { ...at, artifact: "art_BBBBBBBBBBBBBBBBBBBBBB", branch: "invincible/units", title: "Fix" } }, ada);
    expect(pushed.status).toBe(own ? "done" : "asked");
  });
}

// The re-review's minor survivors (R19, R24): a review comment drives a workflow as a comment does; and checks still to
// come are pending checks.
test("where the workflows run on review comments, its comment on its own thread asks; where they run on pushes only, it goes", async () => {
  for (const [file, text, status] of [["review.yml", "on:\n  pull_request_review_comment:\njobs: {}\n", "asked"], ["ci.yml", "on:\n  push:\njobs: {}\n", "done"]] as const) {
    const w = world({}, gh({ workflows: { [file]: text } }));
    const said = await w.service.call({ connector: "github", tool: "issue.comment", args: { ...at, number: 3, body: "Thanks, fixed in the next push." } }, { kind: "agent", by: "primary" });
    expect([file, said.status]).toEqual([file, status]);
  }
});

test("its pull request's checks are pending while a run is still to come: none on its head yet, or one still going", async () => {
  const head = "c".repeat(40);
  const pending = (runs: Run[]) => world({}, gh({ workflows: { "ci.yml": CI }, runs: () => runs })).service.mergeChecksPending("github", "lin-example", "site", head);
  expect([await pending([]), await pending([run(head, null)]), await pending([run(head, "success")])]).toEqual([true, true, false]);
});
