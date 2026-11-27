// What its words at GitHub may do on their own word, and what the node says of what GitHub said (the re-review of
// 27 November, A3 and A4; their PoCs turned around). Where a repository's workflows run on issues, an issue's words drive
// them (IssueOps: a job with the repository's secrets runs on what the issue says), so an issue its word would make asks,
// as a comment does where they run on comments (N5). Each read for its own approval is a ledger line of what was read,
// its size and its digest, never what GitHub said: a private repository's workflows aren't every agent's to read, and a
// line within the log's limits is always recorded. Against the connector service, on github-world.ts's stand-in
// GitHub. No real service is called; the key is obviously fake.
import { expect, test } from "bun:test";
import { Bodies } from "@invincible/core";
import { gh, world } from "./github-world.ts";

const at = { owner: "lin-example", repo: "site" };
const primary = { kind: "agent" as const, by: "primary" };
const ISSUEOPS = "name: deploy request\non:\n  issues:\n    types: [opened, edited]\njobs:\n  deploy:\n    if: contains(github.event.issue.body, 'environment: production')\n    runs-on: ubuntu-latest\n    steps:\n      - run: ./deploy.sh production\n        env:\n          DEPLOY_KEY: ${{ secrets.DEPLOY_KEY }}\n";
const CI = "name: ci\non:\n  pull_request:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: bun test\n";

test("where a repository's workflows run on issues, an issue its word would make asks; where none do, it goes", async () => {
  const g = gh({ workflows: { "deploy-request.yml": ISSUEOPS } });
  const out = await world({}, g).service.call({ connector: "github", tool: "issue.create", args: { ...at, title: "Deploy request", body: "environment: production\nversion: main" } }, primary);
  expect([out.status, g.issues]).toEqual(["asked", []]);
  // Its workflows are read for it, as for a comment.
  expect(g.sent.some((s) => s.startsWith("GET /repos/lin-example/site/contents/.github/workflows/deploy-request.yml"))).toBe(true);
  // Where they run on pull requests alone, the issue is its own, and goes.
  const ci = gh({ workflows: { "ci.yml": CI } });
  const done = await world({}, ci).service.call({ connector: "github", tool: "issue.create", args: { ...at, title: "A bug", body: "It fails on an empty list." } }, primary);
  expect(done.status === "done" && done.own).toBe("an issue in lin-example/site, a repository you gave an agent");
  // Where they can't be read, it asks: unread is unknown, as for a comment.
  const unread = gh({ workflows: { "ci.yml": null } });
  expect((await world({}, unread).service.call({ connector: "github", tool: "issue.create", args: { ...at, title: "A bug", body: "x" } }, primary)).status).toBe("asked");
});

test("each read for its own approval is a line of its size and digest, never what GitHub said, a long one too", async () => {
  const LONG = `${CI}${"      - run: echo step\n".repeat(120)}`; // ~3 KB, an ordinary workflow
  for (const text of [CI, LONG]) {
    const w = world({}, gh({ workflows: { "ci.yml": text } }));
    expect((await w.service.call({ connector: "github", tool: "issue.comment", args: { ...at, number: 3, body: "Thanks, fixed in the last push." } }, primary)).status).toBe("done");
    const line = w.lines.find((l) => l.target.startsWith("GET /repos/lin-example/site/contents/.github/workflows/ci.yml"))!;
    expect(line.detail).toMatch(/^said \d+ bytes, sha256 [A-Za-z0-9_-]{43}$/);
    expect([line.detail!.includes("bun test"), Bodies["ledger.recorded"].safeParse(line).success]).toEqual([false, true]);
    // Every read it made says so, within the log's limits: none of them goes unrecorded.
    for (const read of w.lines.filter((l) => l.target.startsWith("GET "))) expect([read.target, Bodies["ledger.recorded"].safeParse(read).success]).toEqual([read.target, true]);
  }
});
