import { describe, expect, test } from "bun:test";
import { decide, type GitHubFacts, type OwnCall, ownApproval, ownApprovalInLog, primaryCaller } from "../src/index.ts";

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
  // What a shipment changes, as its kept manifest says.
  const CODE = ["src/units.ts", "docs/units.md"];

  test("its agents' work in the repositories you gave them: a pull request, a fix onto its branch, an issue, a comment, a review that isn't an approval", () => {
    expect(ownApproval(github({ native: "github.ship", changes: CODE }), AGENTS)).toBe("a pull request of the work, on an invincible/… branch, in amiriteorg/invincible, a repository you gave an agent");
    expect(ownApproval(github({ native: "github.ship.update", method: "PATCH", path: "/repos/{owner}/{repo}/git/refs/heads/{branch}", changes: CODE }), AGENTS)).toBe("a fix pushed onto its invincible/… branch, in amiriteorg/invincible, a repository you gave an agent");
    expect(ownApproval(github({ path: "/repos/{owner}/{repo}/issues" }), AGENTS)).toBe("an issue in amiriteorg/invincible, a repository you gave an agent");
    expect(ownApproval(github({ path: "/repos/{owner}/{repo}/issues/{number}/comments" }), AGENTS)).toStartWith("a comment in");
    expect(ownApproval(github({}), AGENTS)).toStartWith("a pull request in");
    for (const event of ["COMMENT", "REQUEST_CHANGES", "comment"]) expect(ownApproval(github({ path: "/repos/{owner}/{repo}/pulls/{number}/reviews", args: { owner: "amiriteorg", repo: "invincible", event } }), AGENTS)).toStartWith("a review in");
    // A repository is the same one however its address is written, whatever its case.
    expect(ownApproval(github({ args: { owner: "WCKDboy", repo: "engram", head: "invincible/units" } }), AGENTS)).toStartWith("a pull request in WCKDboy/engram");
  });

  // Your word, 27 November 2026: a push that changes what a repository's CI runs reaches its secrets, so it is yours.
  test("a push that changes what the repository's CI runs is yours, in a repository you gave an agent too; and one whose changes aren't known", () => {
    const CI = [".github/workflows/ci.yml", ".github/actions/setup/action.yml", ".forgejo/workflows/test.yml", ".forgejo/actions/x/action.yaml", ".gitea/workflows/build.yaml", ".gitlab-ci.yml", ".gitlab/ci/test.yml", ".circleci/config.yml", ".travis.yml", "azure-pipelines.yml", ".azure-pipelines/main.yml", "Jenkinsfile", "ci/Jenkinsfile", ".buildkite/pipeline.yml", "bitbucket-pipelines.yml", ".drone.yml", ".woodpecker.yml", ".woodpecker/build.yml", "appveyor.yml", ".appveyor.yml", "cloudbuild.yaml", ".semaphore/semaphore.yml", ".GitHub/Workflows/ci.yml"];
    for (const path of CI) {
      expect([path, ownApproval(github({ native: "github.ship", changes: [...CODE, path] }), AGENTS)]).toEqual([path, null]);
      expect([path, ownApproval(github({ native: "github.ship.update", method: "PATCH", path: "/repos/{owner}/{repo}/git/refs/heads/{branch}", changes: [path] }), AGENTS)]).toEqual([path, null]);
    }
    // What isn't the CI's stays its: a file that only names one, docs about it.
    for (const path of ["docs/github/workflows.md", "src/.github-workflows.ts", "scripts/ci-check.sh", "workflows/ci.yml"]) expect([path, ownApproval(github({ native: "github.ship", changes: [path] }), AGENTS)]).toEqual([path, expect.stringMatching(/^a pull request of the work/)]);
    expect(ownApproval(github({ native: "github.ship" }), AGENTS)).toBeNull();
    expect(ownApproval(github({ native: "github.ship.update", method: "PATCH", path: "/repos/{owner}/{repo}/git/refs/heads/{branch}" }), AGENTS)).toBeNull();
  });

  test("everything else waits for you", () => {
    // Someone else's repository: it speaks for you in another's place.
    expect(ownApproval(github({ native: "github.ship", changes: CODE, args: { owner: "oven-sh", repo: "bun" } }), AGENTS)).toBeNull();
    // No agent of yours has a repository: nothing is its.
    expect(ownApproval(github({ native: "github.ship", changes: CODE }), [])).toBeNull();
    // A review that approves is your word on your account (branch protection counts it), and one that says no event isn't known.
    expect(ownApproval(github({ path: "/repos/{owner}/{repo}/pulls/{number}/reviews", args: { owner: "amiriteorg", repo: "invincible", event: "APPROVE" } }), AGENTS)).toBeNull();
    expect(ownApproval(github({ path: "/repos/{owner}/{repo}/pulls/{number}/reviews" }), AGENTS)).toBeNull();
    // What GitHub's API does elsewhere isn't known to be safe: a merge, a delete.
    expect(ownApproval(github({ method: "PUT", path: "/repos/{owner}/{repo}/pulls/{number}/merge" }), AGENTS)).toBeNull();
    expect(ownApproval(github({ class: "delete", method: "DELETE", path: "/repos/{owner}/{repo}/git/refs/heads/{branch}" }), AGENTS)).toBeNull();
    // Another address is another service, whatever its paths look like; another native tool isn't GitHub's ship.
    expect(ownApproval(github({ origin: "https://github.example.com", native: "github.ship", changes: CODE }), AGENTS)).toBeNull();
    expect(ownApproval(github({ native: "gmail.send" }), AGENTS)).toBeNull();
    expect(ownApproval({ class: "outward", origin: "https://gmail.googleapis.com", native: "gmail.send", method: "POST", path: "/gmail/v1/users/me/messages/send", args: { to: "someone@example.com" } }, AGENTS)).toBeNull();
    // A repository that isn't named as text isn't named.
    expect(ownApproval(github({ args: { owner: ["amiriteorg"], repo: "invincible" } }), AGENTS)).toBeNull();
    // A pull request from a branch that isn't its (yours, or another fork's), or from none, is yours (Ivo's review).
    for (const head of ["feat/orders", "main", "someone:invincible/units", "invincible/", undefined]) expect([head, ownApproval(github({ args: { owner: "amiriteorg", repo: "invincible", ...(head === undefined ? {} : { head }) } }), AGENTS)]).toEqual([head, null]);
  });
});

// Your word, 27 November 2026, as the review of 27 November drew it: in a repository that is your own (private, not a
// fork, your account's by GitHub's id for it), its own threads are its to speak in; anyone else's thread speaks to them,
// a public repository speaks to everyone, and a push or a pull request runs the repository's CI with its secrets.
describe("what your agent approves itself in a private repository of your own", () => {
  const FACTS: GitHubFacts = { user: { id: 501 }, repo: { name: "lin-example/notes", private: true, fork: false, ownerId: 501, ownerType: "User" } };
  const OWN_THREAD: GitHubFacts = { ...FACTS, thread: { number: 4, authorId: 501 } };
  const call = (over: Partial<OwnCall> = {}, args: Record<string, unknown> = {}): OwnCall => ({ class: "outward", origin: "https://api.github.com", method: "POST", path: "/repos/{owner}/{repo}/issues", by: "arm:primary", ...over, args: { owner: "lin-example", repo: "notes", ...args } });
  const comment = { path: "/repos/{owner}/{repo}/issues/{number}/comments" };
  const review = { path: "/repos/{owner}/{repo}/pulls/{number}/reviews" };

  test("the primary itself: an issue; a comment, or a review that isn't an approval, on its own thread (one it, its agents or you opened, all under your account)", () => {
    expect(ownApproval(call(), [], FACTS)).toBe("an issue in lin-example/notes, a private repository of yours");
    expect(ownApproval(call({ by: "primary" }), [], FACTS)).toBe("an issue in lin-example/notes, a private repository of yours");
    expect(ownApproval(call(comment, { number: 4 }), [], OWN_THREAD)).toBe("a comment on its own thread #4 in lin-example/notes, a private repository of yours");
    for (const event of ["COMMENT", "REQUEST_CHANGES"]) expect(ownApproval(call(review, { number: 4, event }), [], OWN_THREAD)).toBe("a review of its own pull request #4 in lin-example/notes, a private repository of yours");
  });

  test("anyone else's thread speaks to them, a collaborator's too: yours, even in a private repository of yours; and so is a thread GitHub didn't say whose it is", () => {
    for (const facts of [{ ...FACTS, thread: { number: 4, authorId: 777 } }, FACTS]) {
      expect(ownApproval(call(comment, { number: 4 }), [], facts)).toBeNull();
      expect(ownApproval(call(review, { number: 4, event: "COMMENT" }), [], facts)).toBeNull();
    }
    // An approving review is yours on its own pull request too.
    expect(ownApproval(call(review, { number: 4, event: "APPROVE" }), [], OWN_THREAD)).toBeNull();
  });

  test("a public repository speaks to everyone, a fork is its upstream's place, and only GitHub's own id for your account makes one yours (a renamed login is anyone's): yours", () => {
    for (const repo of [{ ...FACTS.repo!, private: false }, { ...FACTS.repo!, fork: true }, { ...FACTS.repo!, ownerId: 777 }, { ...FACTS.repo!, ownerType: "Organization" }]) {
      expect([repo, ownApproval(call(), [], { ...FACTS, repo })]).toEqual([repo, null]);
      expect([repo, ownApproval(call(comment, { number: 4 }), [], { ...OWN_THREAD, repo })]).toEqual([repo, null]);
    }
    // Nothing said, or only half of it: nothing of it is its.
    for (const facts of [{}, { user: FACTS.user }, { repo: FACTS.repo }]) expect(ownApproval(call(), [], facts)).toBeNull();
    expect(ownApproval(call(), [])).toBeNull();
    // Facts of another repository, or of another thread, are never this one's.
    expect(ownApproval(call(), [], { ...FACTS, repo: { ...FACTS.repo!, name: "lin-example/other" } })).toBeNull();
    expect(ownApproval(call(comment, { number: 5 }), [], OWN_THREAD)).toBeNull();
    // A name is the same whatever its case.
    expect(ownApproval(call({}, { owner: "Lin-Example", repo: "Notes" }), [], FACTS)).toBe("an issue in Lin-Example/Notes, a private repository of yours");
  });

  test("there it pushes nothing and opens no pull request: those run the repository's CI with its secrets, so they ask outside the repositories you gave an agent", () => {
    expect(ownApproval(call({ path: "/repos/{owner}/{repo}/pulls" }, { head: "invincible/units" }), [], OWN_THREAD)).toBeNull();
    expect(ownApproval(call({ native: "github.ship", path: "/repos/{owner}/{repo}/pulls", changes: ["src/units.ts"] }), [], OWN_THREAD)).toBeNull();
    expect(ownApproval(call({ native: "github.ship.update", method: "PATCH", path: "/repos/{owner}/{repo}/git/refs/heads/{branch}", changes: ["src/units.ts"] }), [], OWN_THREAD)).toBeNull();
    expect(ownApproval(call({ method: "PUT", path: "/repos/{owner}/{repo}/pulls/{number}/merge" }, { number: 4 }), [], OWN_THREAD)).toBeNull();
  });

  test("the part of your own repositories is the primary's alone: never its agents' work, their calls from their VMs, nor its loops", () => {
    for (const by of ["team.0123456789.ada", "arm:team.0123456789.ada", "loop:triage", "arm:claude-code"]) {
      expect([by, ownApproval(call({ by }), [], FACTS)]).toEqual([by, null]);
      expect([by, ownApproval(call({ ...comment, by }, { number: 4 }), [], OWN_THREAD)]).toEqual([by, null]);
    }
    const { by: _, ...nobody } = call();
    expect(ownApproval(nobody, [], FACTS)).toBeNull();
  });
});

describe("what every replica holds your agent's own approval to", () => {
  test("its own callers: it, its agents' work as the node carries it out, its agents' own calls from their VMs, and its loops; never a tool you run with a token of its own, nor another node", () => {
    for (const by of ["primary", "arm:primary", "team.0123456789.ada", "arm:team.0123456789.ada", "loop:nightly"]) expect([by, primaryCaller(by)]).toEqual([by, true]);
    for (const by of ["arm:claude-code", "arm:teams.x", "arm:team", "n_node", "you", ""]) expect([by, primaryCaller(by)]).toEqual([by, false]);
  });

  test("from the log alone: a call of its own caller that ownApproval allows, in the repository the call names", () => {
    const call = { class: "outward" as const, origin: "https://api.github.com", method: "POST", path: "/repos/{owner}/{repo}/issues", args: { owner: "amiriteorg", repo: "invincible" } };
    expect(ownApprovalInLog({ ...call, by: "team.0123456789.ada" })).toBe("an issue in amiriteorg/invincible, a repository you gave an agent");
    expect(ownApprovalInLog({ ...call, by: "arm:claude-code" })).toBeNull();
    expect(ownApprovalInLog({ ...call, class: "delete", method: "DELETE", path: "/repos/{owner}/{repo}", by: "primary" })).toBeNull();
    expect(ownApprovalInLog({ ...call, origin: "https://forge.example.test", by: "primary" })).toBeNull();
    expect(ownApprovalInLog({ ...call, args: { repo: "invincible" }, by: "primary" })).toBeNull();
    // What a push changed, who opened a thread and whose a repository is aren't in the log: those parts stay the
    // approving node's, so a shipment or a comment it approved replays as it always did.
    expect(ownApprovalInLog({ ...call, native: "github.ship", path: "/repos/{owner}/{repo}/pulls", args: { owner: "amiriteorg", repo: "invincible", branch: "invincible/units" }, by: "team.0123456789.ada" })).toStartWith("a pull request of the work");
    expect(ownApprovalInLog({ ...call, path: "/repos/{owner}/{repo}/issues/{number}/comments", args: { owner: "lin-example", repo: "notes", number: 4 }, by: "arm:primary" })).toStartWith("a comment in lin-example/notes");
  });
});
