// What its words at GitHub may do on their own word (the re-review of 27 November, A3; its PoC turned around): where a
// repository's workflows run on issues, an issue's words drive them (IssueOps: a job with the repository's secrets runs
// on what the issue says), so an issue its word would make asks, as a comment does where they run on comments (N5).
// Against the connector service, on github-world.ts's stand-in GitHub. No real service is called; the key is obviously
// fake.
import { expect, test } from "bun:test";
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
