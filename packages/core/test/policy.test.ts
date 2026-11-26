import { describe, expect, test } from "bun:test";
import { decide, type OwnCall, ownApproval } from "../src/index.ts";

describe("approvals", () => {
  test("creating infrastructure is free; deleting it asks", () => {
    expect(decide({ class: "create", resource: "r2.bucket", target: "invincible-cache" }).verdict).toBe("allow");
    expect(decide({ class: "modify", resource: "r2.lifecycle", target: "invincible-cache" }).verdict).toBe("allow");
    expect(decide({ class: "delete", resource: "r2.bucket", target: "invincible-cache" }).verdict).toBe("ask");
  });

  test("a run may clean up only the ephemeral things it created", () => {
    const scratch = { class: "delete" as const, resource: "docker.container", target: "agent-7" };
    expect(decide({ ...scratch, run: "q1", createdBy: { run: "q1", ephemeral: true } }).verdict).toBe("allow");
    expect(decide({ ...scratch, run: "q2", createdBy: { run: "q1", ephemeral: true } }).verdict).toBe("ask");
    expect(decide({ ...scratch, run: "q1", createdBy: { run: "q1", ephemeral: false } }).verdict).toBe("ask");
    expect(decide({ ...scratch, createdBy: { run: "q1", ephemeral: true } }).verdict).toBe("ask");
  });

  test("outward always asks here: standing orders are checked against the exact call in orders.ts", () => {
    expect(decide({ class: "outward", resource: "git.push", target: "someone/repo#feat/x" })).toEqual({ verdict: "ask", reason: "outward-facing actions require your approval" });
  });

  test("forbidden is always denied", () => {
    expect(decide({ class: "forbidden", resource: "policy", target: "self" }).verdict).toBe("deny");
  });
});

// Your word, 23 November 2026: it approves its own decisions and its agents'; what is monetary, legal or destructive
// still asks you.
describe("what your agent approves itself", () => {
  const AGENTS = ["https://github.com/amiriteorg/invincible", "git@github.com:wckdboy/Engram.git"];
  const github = (over: Partial<OwnCall>): OwnCall => ({ class: "outward", origin: "https://api.github.com", method: "POST", path: "/repos/{owner}/{repo}/pulls", args: { owner: "amiriteorg", repo: "invincible", head: "invincible/units" }, ...over });

  test("its agents' work in the repositories you gave them: a pull request, a fix onto its branch, an issue, a comment, a review that isn't an approval", () => {
    expect(ownApproval(github({ native: "github.ship" }), AGENTS)).toBe("a pull request of the work, on a invincible/… branch, in amiriteorg/invincible, a repository you gave an agent");
    expect(ownApproval(github({ native: "github.ship.update", method: "PATCH", path: "/repos/{owner}/{repo}/git/refs/heads/{branch}" }), AGENTS)).toBe("a fix pushed onto its invincible/… branch, in amiriteorg/invincible, a repository you gave an agent");
    expect(ownApproval(github({ path: "/repos/{owner}/{repo}/issues" }), AGENTS)).toBe("an issue in amiriteorg/invincible, a repository you gave an agent");
    expect(ownApproval(github({ path: "/repos/{owner}/{repo}/issues/{number}/comments" }), AGENTS)).toStartWith("a comment in");
    expect(ownApproval(github({}), AGENTS)).toStartWith("a pull request in");
    for (const event of ["COMMENT", "REQUEST_CHANGES", "comment"]) expect(ownApproval(github({ path: "/repos/{owner}/{repo}/pulls/{number}/reviews", args: { owner: "amiriteorg", repo: "invincible", event } }), AGENTS)).toStartWith("a review in");
    // A repository is the same one however its address is written, whatever its case.
    expect(ownApproval(github({ args: { owner: "WCKDboy", repo: "engram", head: "invincible/units" } }), AGENTS)).toStartWith("a pull request in WCKDboy/engram");
  });

  test("everything else waits for you", () => {
    // Someone else's repository: it speaks for you in another's place.
    expect(ownApproval(github({ native: "github.ship", args: { owner: "oven-sh", repo: "bun" } }), AGENTS)).toBeNull();
    // No agent of yours has a repository: nothing is its.
    expect(ownApproval(github({ native: "github.ship" }), [])).toBeNull();
    // A review that approves is your word on your account (branch protection counts it), and one that says no event isn't known.
    expect(ownApproval(github({ path: "/repos/{owner}/{repo}/pulls/{number}/reviews", args: { owner: "amiriteorg", repo: "invincible", event: "APPROVE" } }), AGENTS)).toBeNull();
    expect(ownApproval(github({ path: "/repos/{owner}/{repo}/pulls/{number}/reviews" }), AGENTS)).toBeNull();
    // What GitHub's API does elsewhere isn't known to be safe: a merge, a delete.
    expect(ownApproval(github({ method: "PUT", path: "/repos/{owner}/{repo}/pulls/{number}/merge" }), AGENTS)).toBeNull();
    expect(ownApproval(github({ class: "delete", method: "DELETE", path: "/repos/{owner}/{repo}/git/refs/heads/{branch}" }), AGENTS)).toBeNull();
    // Another address is another service, whatever its paths look like; another native tool isn't GitHub's ship.
    expect(ownApproval(github({ origin: "https://github.example.com", native: "github.ship" }), AGENTS)).toBeNull();
    expect(ownApproval(github({ native: "gmail.send" }), AGENTS)).toBeNull();
    expect(ownApproval({ class: "outward", origin: "https://gmail.googleapis.com", native: "gmail.send", method: "POST", path: "/gmail/v1/users/me/messages/send", args: { to: "someone@example.com" } }, AGENTS)).toBeNull();
    // A repository that isn't named as text isn't named.
    expect(ownApproval(github({ args: { owner: ["amiriteorg"], repo: "invincible" } }), AGENTS)).toBeNull();
    // A pull request from a branch that isn't its (yours, or another fork's), or from none, is yours (Ivo's review).
    for (const head of ["feat/orders", "main", "someone:invincible/units", "invincible/", undefined]) expect([head, ownApproval(github({ args: { owner: "amiriteorg", repo: "invincible", ...(head === undefined ? {} : { head }) } }), AGENTS)]).toEqual([head, null]);
  });
});
