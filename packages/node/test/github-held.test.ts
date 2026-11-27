// What a GitHub tool is held to (the re-review of 27 November, A2; its PoC turned around): what the call does, not
// the label its manifest gives it. The pull request merge endpoint, a commit status and a branch rename are outward;
// the node's own merge and ship natives are outward under any label; and a path that names its segments through
// parameters is judged by the request it builds. Against the connector service, on github-world.ts's stand-in GitHub,
// for a loop's call (an agent's, the primary's, are the same). No real service is called; the key is obviously fake.
import { expect, test } from "bun:test";
import { heldClass } from "@invincible/core";
import { CATALOG } from "@invincible/models";
import { gh, MAIN, manifest, ORIGIN, world } from "./github-world.ts";

const at = { owner: "lin-example", repo: "site" };
const loop = { kind: "agent" as const, by: "loop:tidy" };
const m = { origin: ORIGIN };

test("the pull request merge endpoint, a commit status and a branch rename are outward, whatever their label", () => {
  expect(heldClass(m, { description: "Merge a PR", method: "PUT", path: "/repos/{owner}/{repo}/pulls/{number}/merge", class: "modify" } as never)).toBe("outward");
  // A status can make a required check pass, so a pull request clean, where a protection doesn't pin its source.
  expect(heldClass(m, { description: "Set a status", method: "POST", path: "/repos/{owner}/{repo}/statuses/{sha}", class: "create" } as never)).toBe("outward");
  expect(heldClass(m, { description: "Rename a branch", method: "POST", path: "/repos/{owner}/{repo}/branches/{branch}/rename", class: "modify" } as never)).toBe("outward");
  // (What writes no branch is held to its own label: a comment on an issue; and a read of whether it merged.)
  expect(heldClass(m, { description: "Comment", method: "POST", path: "/repos/{owner}/{repo}/issues/{number}/comments", class: "create" } as never)).toBe("create");
  expect(heldClass(m, { description: "Merged?", method: "GET", path: "/repos/{owner}/{repo}/pulls/{number}/merge", class: "read" } as never)).toBe("read");
});

test("the node's own merge under a free label asks: a loop's call merges nothing", async () => {
  const mine = structuredClone(CATALOG.github!.manifest) as any;
  mine.tools.merge.class = "modify"; // PUT may be modify (classFits): the manifest parses
  const g = gh();
  const w = world({}, g, {}, mine);
  g.heads.set("contrib", "9".repeat(40));
  g.pulls.set(7, { head: "contrib", base: "main" });
  const out = await w.service.call({ connector: "github", tool: "merge", args: { ...at, number: 7, sha: "9".repeat(40) } }, loop);
  expect([out.status, g.merges]).toEqual(["asked", []]);
});

test("its ship and its update under a free label ask: no branch is pushed", async () => {
  const mine = structuredClone(CATALOG.github!.manifest) as any;
  mine.tools.ship.class = "create"; // its declared path is /repos/{owner}/{repo}/pulls, off the list of writes
  expect([heldClass(m, mine.tools.ship), heldClass(m, { ...mine.tools["ship.update"], class: "modify" })]).toEqual(["outward", "outward"]);
  const g = gh();
  const files = { art_AAAAAAAAAAAAAAAAAAAAAA: { "ship/manifest.json": manifest(MAIN, [".github/workflows/deploy.yml"]), "ship/files/.github/workflows/deploy.yml": "on: push\njobs: {}\n" } };
  const w = world(files, g, {}, mine);
  const out = await w.service.call({ connector: "github", tool: "ship", args: { ...at, artifact: "art_AAAAAAAAAAAAAAAAAAAAAA", branch: "invincible/ci", title: "CI" } }, loop);
  expect([out.status, g.heads.has("invincible/ci")]).toEqual(["asked", false]);
});

test("a path that names its segments through parameters is judged by the request it builds: a ref made, a GraphQL mutation", async () => {
  const refs = { description: "Make a ref", method: "POST", path: "/repos/{owner}/{repo}/{kind}/refs", params: { owner: { type: "string" }, repo: { type: "string" }, kind: { type: "string" }, ref: { type: "string" }, sha: { type: "string" } }, class: "create" } as const;
  const api = { description: "GitHub's API", method: "POST", path: "/{api}", params: { api: { type: "string" }, query: { type: "string" } }, class: "create" } as const;
  expect(heldClass(m, refs as never, { owner: "o", repo: "r", kind: "git", ref: "refs/heads/x", sha: "1".repeat(40) })).toBe("outward");
  expect(heldClass(m, api as never, { api: "graphql", query: "mutation { createRef(input: {}) { clientMutationId } }" })).toBe("outward");
  // (Its other requests are as labeled: an issue made through the same template.)
  expect(heldClass(m, refs as never, { owner: "o", repo: "r", kind: "issues", ref: "x", sha: "1" })).toBe("create");
  const mine = structuredClone(CATALOG.github!.manifest) as any;
  mine.tools["ref.make"] = refs;
  const g = gh();
  const w = world({}, g, {}, mine);
  const out = await w.service.call({ connector: "github", tool: "ref.make", args: { ...at, kind: "git", ref: "refs/heads/release", sha: "1".repeat(40) } }, loop);
  expect([out.status, g.heads.has("release"), g.sent.some((s: string) => s.startsWith("POST /repos/lin-example/site/git/refs"))]).toEqual(["asked", false, false]);
});
