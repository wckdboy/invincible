import { describe, expect, test } from "bun:test";
import { changesCi, commandsABot, decide, type GitHubFacts, type OwnCall, ownApproval, ownApprovalInLog, primaryCaller, supposedFacts } from "../src/index.ts";

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
// still asks you. And 27 November, as the re-review drew it: a push is its own only where GitHub says what it lands on.
describe("what your agent approves itself in a repository you gave an agent", () => {
  const AGENTS = ["https://github.com/amiriteorg/invincible", "git@github.com:wckdboy/Engram.git"];
  const WHERE = "amiriteorg/invincible, a repository you gave an agent";
  /** Your default branch's head, as GitHub says it is when it ships; a contributor's pull request's head. */
  const MAIN = "a".repeat(40);
  const THEIRS = "7".repeat(40);
  const REPO: GitHubFacts["repo"] = { name: "amiriteorg/invincible", private: false, fork: false, ownerId: 600, ownerType: "Organization", defaultBranch: "main" };
  const at = (branch: string, sha: string, more: GitHubFacts = {}): GitHubFacts => ({ repo: REPO, head: { branch, sha }, ...more });
  const github = (over: Partial<OwnCall>, args: Record<string, unknown> = {}): OwnCall => ({ class: "outward", origin: "https://api.github.com", method: "POST", path: "/repos/{owner}/{repo}/pulls", by: "team.0123456789.ada", ...over, args: { owner: "amiriteorg", repo: "invincible", ...args } });
  // What a shipment changes and the commit it was built on, as its kept manifest says.
  const CODE = ["src/units.ts", "docs/units.md"];
  const ship = (over: Partial<OwnCall> = {}, args: Record<string, unknown> = {}) => github({ native: "github.ship", changes: CODE, base: MAIN, ...over }, { branch: "invincible/units", title: "Units", ...args });
  // A fix onto a branch it shipped: the commit it last pushed there (its receipt's, 12 hex), and where the fix began.
  const PUSHED = "c".repeat(40);
  const fix = (over: Partial<OwnCall> = {}, args: Record<string, unknown> = {}) => github({ native: "github.ship.update", method: "PATCH", path: "/repos/{owner}/{repo}/git/refs/heads/{branch}", changes: CODE, base: PUSHED, pushed: PUSHED.slice(0, 12), ...over }, { branch: "invincible/units", title: "Fix", ...args });
  const pull = (over: Partial<OwnCall> = {}, args: Record<string, unknown> = {}) => github({ pushed: PUSHED.slice(0, 12), ...over }, { head: "invincible/units", base: "main", title: "Units", ...args });
  const words = (path: string, args: Record<string, unknown>, over: Partial<OwnCall> = {}) => github({ path, ...over }, args);
  const ITS_THREAD: GitHubFacts = { user: { id: 501 }, thread: { number: 4, authorId: 501 } };

  test("its work on a new branch, built on your default branch's head as GitHub says it stands: its own; and an issue", () => {
    expect(ownApproval(ship(), AGENTS, at("main", MAIN))).toBe(`a pull request of the work on a new branch invincible/units, built on main as it stands, in ${WHERE}`);
    // Into the default branch named as such, the same.
    expect(ownApproval(ship({}, { base: "main" }), AGENTS, at("main", MAIN))).toStartWith("a pull request of the work on a new branch invincible/units");
    expect(ownApproval(words("/repos/{owner}/{repo}/issues", { title: "Units" }), AGENTS)).toBe(`an issue in ${WHERE}`);
    // A repository is the same one however its address is written, whatever its case.
    expect(ownApproval(words("/repos/{owner}/{repo}/issues", { owner: "WCKDboy", repo: "engram", title: "Units" }), AGENTS)).toBe("an issue in WCKDboy/engram, a repository you gave an agent");
  });

  test("a shipment built on anything but your default branch's head is yours: a contributor's pull request, an older commit, a branch GitHub didn't say, another base", () => {
    // A contributor's pull request's head (GitHub keeps it as refs/pull/7/head): its workflows would run with your secrets.
    expect(ownApproval(ship({ base: THEIRS }), AGENTS, at("main", MAIN))).toBeNull();
    // An older commit of main, whose CI isn't main's now.
    expect(ownApproval(ship({ base: "b".repeat(40) }), AGENTS, at("main", MAIN))).toBeNull();
    // Nothing said of where main stands, or of another branch; nothing said of the repository's default branch.
    expect(ownApproval(ship(), AGENTS, {})).toBeNull();
    expect(ownApproval(ship(), AGENTS, { repo: REPO })).toBeNull();
    expect(ownApproval(ship(), AGENTS, at("release/v9", MAIN))).toBeNull();
    expect(ownApproval(ship(), AGENTS, { head: { branch: "main", sha: MAIN } })).toBeNull();
    // Facts of another repository are never this one's.
    expect(ownApproval(ship(), AGENTS, { ...at("main", MAIN), repo: { ...REPO!, name: "amiriteorg/other" } })).toBeNull();
    // Into a branch that isn't your default one, whatever stands there (a branch a contributor's commit was given, a release).
    expect(ownApproval(ship({}, { base: "release/v9" }), AGENTS, at("release/v9", MAIN))).toBeNull();
    expect(ownApproval(ship({}, { base: "invincible/pr-7" }), AGENTS, at("invincible/pr-7", MAIN))).toBeNull();
    // A base it can't see, or one that isn't a commit's.
    expect(ownApproval(ship({ base: undefined }), AGENTS, at("main", MAIN))).toBeNull();
    expect(ownApproval(ship({ base: "a".repeat(12) }), AGENTS, at("main", "a".repeat(12)))).toBeNull();
  });

  test("a fix goes onto a branch it shipped, from the commit it last pushed there, as GitHub says the branch stands: its own; anything else is yours", () => {
    expect(ownApproval(fix(), AGENTS, at("invincible/units", PUSHED))).toBe(`a fix pushed onto invincible/units, a branch it shipped, from where it last pushed it, in ${WHERE}`);
    // A branch it never shipped (one a branch.create gave a contributor's commit, say): yours.
    expect(ownApproval(fix({ pushed: undefined }), AGENTS, at("invincible/units", PUSHED))).toBeNull();
    // Moved since it last pushed there (by anyone): yours, though the fix began where it stands now.
    expect(ownApproval(fix({ base: THEIRS }), AGENTS, at("invincible/units", THEIRS))).toBeNull();
    // The fix began somewhere else than where the branch stands.
    expect(ownApproval(fix(), AGENTS, at("invincible/units", "d".repeat(40)))).toBeNull();
    // Where another branch stands says nothing of this one; nor does nothing said; nor a receipt with no commit.
    expect(ownApproval(fix(), AGENTS, at("invincible/other", PUSHED))).toBeNull();
    expect(ownApproval(fix(), AGENTS, {})).toBeNull();
    for (const pushed of ["", "c", "cccc", "not-a-commit"]) expect([pushed, ownApproval(fix({ pushed }), AGENTS, at("invincible/units", PUSHED))]).toEqual([pushed, null]);
  });

  test("a pull request is its own only from a branch it shipped, as it last pushed it, into your default branch", () => {
    expect(ownApproval(pull(), AGENTS, at("invincible/units", PUSHED))).toBe(`a pull request from invincible/units, a branch it shipped, into main, in ${WHERE}`);
    // A branch it never shipped, or one moved since: yours.
    expect(ownApproval(pull({ pushed: undefined }), AGENTS, at("invincible/units", PUSHED))).toBeNull();
    expect(ownApproval(pull(), AGENTS, at("invincible/units", THEIRS))).toBeNull();
    // Into a branch that isn't your default one: its CI would run from a merge with whatever is there.
    expect(ownApproval(pull({}, { base: "invincible/pr-7" }), AGENTS, at("invincible/units", PUSHED))).toBeNull();
    expect(ownApproval(pull(), AGENTS, { head: { branch: "invincible/units", sha: PUSHED } })).toBeNull();
    // Where another branch stands says nothing of this one.
    expect(ownApproval(pull(), AGENTS, at("invincible/other", PUSHED))).toBeNull();
    // A branch that isn't its (yours, another fork's), or none, is yours whatever GitHub says (Ivo's review).
    for (const head of ["feat/orders", "main", "someone:invincible/units", "invincible/", undefined]) {
      const call = pull({}, { head });
      expect([head, ownApproval(call, AGENTS, typeof head === "string" ? at(head, PUSHED) : {})]).toEqual([head, null]);
    }
  });

  // Your word, 27 November 2026: anyone else's thread asks, public or private; a repository you gave an agent too.
  test("its words on a thread are its own only on its own thread (one opened under your account): anyone else's speaks to them", () => {
    expect(ownApproval(words("/repos/{owner}/{repo}/issues/{number}/comments", { number: 4, body: "Done in #5." }), AGENTS, ITS_THREAD)).toBe(`a comment on its own thread #4 in ${WHERE}`);
    for (const event of ["COMMENT", "REQUEST_CHANGES", "comment"]) {
      expect(ownApproval(words("/repos/{owner}/{repo}/pulls/{number}/reviews", { number: 4, event, body: "One test fails." }), AGENTS, ITS_THREAD)).toBe(`a review of its own pull request #4 in ${WHERE}`);
    }
    // A contributor's issue or pull request, one GitHub didn't say whose it is, another thread's facts: yours.
    for (const facts of [{ ...ITS_THREAD, thread: { number: 4, authorId: 777 } }, { user: { id: 501 } }, { thread: { number: 4, authorId: 501 } }, {}, { ...ITS_THREAD, thread: { number: 5, authorId: 501 } }]) {
      expect(ownApproval(words("/repos/{owner}/{repo}/issues/{number}/comments", { number: 4, body: "Thanks." }), AGENTS, facts)).toBeNull();
      expect(ownApproval(words("/repos/{owner}/{repo}/pulls/{number}/reviews", { number: 4, event: "COMMENT", body: "Looks off." }), AGENTS, facts)).toBeNull();
    }
    // A review that approves is your word on your account (branch protection counts it), and one that says no event isn't known.
    expect(ownApproval(words("/repos/{owner}/{repo}/pulls/{number}/reviews", { number: 4, event: "APPROVE", body: "OK" }), AGENTS, ITS_THREAD)).toBeNull();
    expect(ownApproval(words("/repos/{owner}/{repo}/pulls/{number}/reviews", { number: 4, body: "OK" }), AGENTS, ITS_THREAD)).toBeNull();
  });

  // Your word, 27 November 2026: a push that changes what a repository's CI runs reaches its secrets, so it is yours.
  test("a push naming a file or a folder the repository's CI runs is yours, added, changed or deleted; and one whose changes aren't known", () => {
    const CI = [
      // GitHub's, Forgejo's and Gitea's folders, whole and named themselves (a folder deleted or replaced deletes what's in it).
      ".github",
      ".github/workflows",
      ".github/workflows/ci.yml",
      ".github/actions",
      ".github/actions/setup/action.yml",
      ".github/dependabot.yml",
      ".github/setup/action.yml",
      ".forgejo",
      ".forgejo/workflows",
      ".forgejo/workflows/test.yml",
      ".gitea/workflows/build.yaml",
      ".GitHub/Workflows/ci.yml",
      // A local action anywhere: a workflow runs one from any folder (uses: ./…).
      "action.yml",
      "action.yaml",
      "ci/deploy/action.yaml",
      "tools/Action.YML",
      // The CI services' own files and folders, and a folder that holds one.
      ".gitlab-ci.yml",
      ".gitlab",
      ".gitlab/ci",
      ".gitlab/ci/test.yml",
      ".circleci",
      ".circleci/config.yml",
      ".travis.yml",
      "azure-pipelines.yml",
      ".azure-pipelines/main.yml",
      "Jenkinsfile",
      "ci/Jenkinsfile",
      ".buildkite",
      ".buildkite/pipeline.yml",
      "buildkite.yml",
      "bitbucket-pipelines.yml",
      ".drone.yml",
      ".drone.jsonnet",
      ".drone.star",
      ".woodpecker",
      ".woodpecker.yml",
      ".woodpecker/build.yml",
      "appveyor.yml",
      ".appveyor.yml",
      "cloudbuild.yaml",
      "cloudbuild.json",
      ".semaphore",
      ".semaphore/semaphore.yml",
      ".cirrus.yml",
      ".cirrus.star",
      ".tekton",
      ".tekton/push.yaml",
      ".build.yml",
      ".builds",
      ".builds/ci.yml",
      "buildspec.yml",
      "codefresh.yml",
      "bitrise.yml",
      "codemagic.yaml",
      ".teamcity",
      ".teamcity/settings.kts",
      "netlify.toml",
      "vercel.json",
      "amplify.yml",
      // An entry under one of their files replaces the file with a folder: the file goes.
      "Jenkinsfile/x",
      ".travis.yml/x",
      "action.yml/x",
      "./.github/workflows/ci.yml",
    ];
    for (const path of CI) {
      expect([path, changesCi([path])]).toEqual([path, true]);
      expect([path, ownApproval(ship({ changes: [...CODE, path] }), AGENTS, at("main", MAIN))]).toEqual([path, null]);
      expect([path, ownApproval(fix({ changes: [path] }), AGENTS, at("invincible/units", PUSHED))]).toEqual([path, null]);
    }
    // What isn't the CI's stays its: a file that only names one, docs about it, a .github of a folder (GitHub reads the
    // root's only), and the code CI runs, which is a push's ordinary content (SECURITY.md says so).
    for (const path of ["docs/github/workflows.md", "src/.github-workflows.ts", "scripts/ci-check.sh", "workflows/ci.yml", "src/.github/workflows/x.yml", "actions.yml", "my-action.yml", "src/action.ts", "Makefile", "package.json", ".pre-commit-config.yaml", "scripts/ci.sh"]) {
      expect([path, changesCi([path])]).toEqual([path, false]);
      expect([path, ownApproval(ship({ changes: [path] }), AGENTS, at("main", MAIN))]).toEqual([path, expect.stringMatching(/^a pull request of the work/)]);
    }
    expect(ownApproval(ship({ changes: undefined }), AGENTS, at("main", MAIN))).toBeNull();
    expect(ownApproval(fix({ changes: undefined }), AGENTS, at("invincible/units", PUSHED))).toBeNull();
  });

  // Your word, 27 November 2026 (slice 5): merging is its, of proven work, in the repositories you gave your agents.
  test("a merge is its own only as the node's own (which checked the work was proven and shipped), in a repository you gave an agent, landing nothing the CI runs", () => {
    const merge = (over: Partial<OwnCall> = {}): OwnCall => github({ native: "github.merge", method: "PUT", path: "/repos/{owner}/{repo}/pulls/{number}/merge", args: { owner: "amiriteorg", repo: "invincible", number: 7, sha: "c".repeat(12) }, by: "primary", changes: CODE, ...over });
    expect(ownApproval(merge(), AGENTS)).toBe("a merge of its agents' proven work, through GitHub's own merge once every check its rules require passed, in amiriteorg/invincible, a repository you gave an agent");
    // One its chat, its agents or its loops ask for themselves is yours: none of them checked what the node checks.
    for (const by of ["arm:primary", "team.0123456789.ada", "arm:team.0123456789.ada", "loop:release", "arm:claude-code"]) expect([by, ownApproval(merge({ by }), AGENTS)]).toEqual([by, null]);
    // Landing a change to what the CI runs, or changes not known: yours. Anyone else's repository, or a private one of
    // yours: yours too.
    expect(ownApproval(merge({ changes: [...CODE, ".github/workflows/release.yml"] }), AGENTS)).toBeNull();
    expect(ownApproval(merge({ changes: undefined }), AGENTS)).toBeNull();
    expect(ownApproval(merge(), [])).toBeNull();
    expect(ownApproval(merge(), [], { user: { id: 501 }, repo: { name: "amiriteorg/invincible", private: true, fork: false, ownerId: 501, ownerType: "User" } })).toBeNull();
  });

  test("everything else waits for you", () => {
    // Someone else's repository: it speaks for you in another's place.
    expect(ownApproval(ship({}, { owner: "oven-sh", repo: "bun" }), AGENTS, at("main", MAIN))).toBeNull();
    // No agent of yours has a repository: nothing is its.
    expect(ownApproval(ship(), [], at("main", MAIN))).toBeNull();
    // What GitHub's API does elsewhere isn't known to be safe: a branch (a ref at any commit runs that commit's
    // workflows), a merge, a delete.
    expect(ownApproval(github({ path: "/repos/{owner}/{repo}/git/refs" }, { ref: "refs/heads/invincible/pr-7", sha: THEIRS }), AGENTS, at("invincible/pr-7", THEIRS))).toBeNull();
    expect(ownApproval(github({ method: "PUT", path: "/repos/{owner}/{repo}/pulls/{number}/merge" }, { number: 4 }), AGENTS, ITS_THREAD)).toBeNull();
    expect(ownApproval(github({ class: "delete", method: "DELETE", path: "/repos/{owner}/{repo}/git/refs/heads/{branch}" }, { branch: "invincible/units" }), AGENTS)).toBeNull();
    // Another address is another service, whatever its paths look like; another native tool isn't GitHub's ship.
    expect(ownApproval(ship({ origin: "https://github.example.com" }), AGENTS, at("main", MAIN))).toBeNull();
    expect(ownApproval(github({ native: "gmail.send" }), AGENTS)).toBeNull();
    expect(ownApproval({ class: "outward", origin: "https://gmail.googleapis.com", native: "gmail.send", method: "POST", path: "/gmail/v1/users/me/messages/send", args: { to: "someone@example.com" } }, AGENTS)).toBeNull();
    // A repository that isn't named as text isn't named.
    expect(ownApproval(words("/repos/{owner}/{repo}/issues", { owner: ["amiriteorg"], title: "Units" }), AGENTS)).toBeNull();
  });
});

// Your word, 27 November 2026, as the re-review drew it: a line a repository's bots read as a command is yours, even
// on its own thread: a merge bot or ChatOps acts on it as your word.
describe("words a repository's bots read as a command", () => {
  // The merge bot that takes a command by its bare name: one of the old theme's words, so written backwards (policy.ts).
  const BOT = [..."srob"].reverse().join("");
  const Bot = BOT[0]!.toUpperCase() + BOT.slice(1);
  const COMMANDS = [`${BOT} r+`, `${Bot}: try`, `${BOT} retry`, "/deploy production", "/release v2.0.0", "  /merge", "Done.\n/approve", "@mergifyio queue", "@Mergifyio refresh", "@dependabot merge", "@dependabot[bot] rebase", "@lin-example, rebase this", "Thanks!\r\n@renovate-bot retry"];
  const PLAIN = ["Done in #5.", "Fixed the /usr paths in the docs.", "Reach me at lin@example.test", "> /deploy, as you said, waits for you", "@", "@lin-example", BOT, `${BOT}cht recipe`, "//deploy", "/ deploy", "@org/reviewers please look"];

  test("a line that starts /word, the merge bot's name and a word, or @name word, in a title or a body: commandsABot", () => {
    for (const text of COMMANDS) {
      expect([text, commandsABot({ body: text })]).toEqual([text, true]);
      expect([text, commandsABot({ title: text })]).toEqual([text, true]);
    }
    for (const text of PLAIN) expect([text, commandsABot({ title: "Units", body: text })]).toEqual([text, false]);
    // Only the words it writes: what a call names isn't a line of them.
    expect(commandsABot({ owner: "lin-example", repo: "notes", head: "invincible/units", branch: "/deploy", base: "@x y" })).toBe(false);
  });

  test("is yours wherever it would be its own: an issue, a comment or a review on its own thread, a pull request, a shipment, a fix", () => {
    const GIVEN = ["https://github.com/lin-example/notes"];
    const SHA = "c".repeat(40);
    const facts: GitHubFacts = { user: { id: 501 }, repo: { name: "lin-example/notes", private: true, fork: false, ownerId: 501, ownerType: "User", defaultBranch: "main" }, thread: { number: 4, authorId: 501 } };
    const call = (over: Partial<OwnCall>, args: Record<string, unknown>): OwnCall => ({ class: "outward", origin: "https://api.github.com", method: "POST", path: "/repos/{owner}/{repo}/issues", by: "arm:primary", ...over, args: { owner: "lin-example", repo: "notes", ...args } });
    const cases: [OwnCall, GitHubFacts][] = [
      [call({}, { title: "Units" }), facts],
      [call({ path: "/repos/{owner}/{repo}/issues/{number}/comments" }, { number: 4 }), facts],
      [call({ path: "/repos/{owner}/{repo}/pulls/{number}/reviews" }, { number: 4, event: "COMMENT" }), facts],
      [call({ path: "/repos/{owner}/{repo}/pulls", pushed: SHA.slice(0, 12) }, { head: "invincible/units", base: "main", title: "Units" }), { ...facts, head: { branch: "invincible/units", sha: SHA } }],
      [call({ native: "github.ship", path: "/repos/{owner}/{repo}/pulls", changes: ["src/units.ts"], base: SHA }, { branch: "invincible/units", title: "Units" }), { ...facts, head: { branch: "main", sha: SHA } }],
      [call({ native: "github.ship.update", method: "PATCH", path: "/repos/{owner}/{repo}/git/refs/heads/{branch}", changes: ["src/units.ts"], base: SHA, pushed: SHA.slice(0, 12) }, { branch: "invincible/units", title: "Fix" }), { ...facts, head: { branch: "invincible/units", sha: SHA } }],
    ];
    for (const [one, said] of cases) {
      // Its own, as it is: where it may speak (a repository you gave an agent, and for issues and threads a private one of yours).
      expect([one.path, ownApproval({ ...one, args: { ...one.args, body: "Done." } }, GIVEN, said)]).toEqual([one.path, expect.any(String)]);
      for (const text of [`${BOT} r+`, "/deploy production", "Done.\n@mergifyio queue"]) {
        for (const where of [GIVEN, []]) expect([one.path, text, ownApproval({ ...one, args: { ...one.args, body: text } }, where, said)]).toEqual([one.path, text, null]);
        expect([one.path, text, ownApproval({ ...one, args: { ...one.args, title: text, body: "Done." } }, GIVEN, said)]).toEqual([one.path, text, null]);
      }
    }
  });
});

// Your word, 27 November 2026, as the review of 27 November drew it: in a repository that is your own (private, not a
// fork, your account's by GitHub's id for it), its own threads are its to speak in; anyone else's thread speaks to them,
// a public repository speaks to everyone, and a push or a pull request runs the repository's CI with its secrets.
describe("what your agent approves itself in a private repository of your own", () => {
  const FACTS: GitHubFacts = { user: { id: 501 }, repo: { name: "lin-example/notes", private: true, fork: false, ownerId: 501, ownerType: "User", defaultBranch: "main" } };
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
    const SHA = "c".repeat(40);
    const all: GitHubFacts = { ...OWN_THREAD, head: { branch: "invincible/units", sha: SHA } };
    expect(ownApproval(call({ path: "/repos/{owner}/{repo}/pulls", pushed: SHA.slice(0, 12) }, { head: "invincible/units", base: "main" }), [], all)).toBeNull();
    expect(ownApproval(call({ native: "github.ship", path: "/repos/{owner}/{repo}/pulls", changes: ["src/units.ts"], base: SHA }, { branch: "invincible/units" }), [], { ...all, head: { branch: "main", sha: SHA } })).toBeNull();
    expect(ownApproval(call({ native: "github.ship.update", method: "PATCH", path: "/repos/{owner}/{repo}/git/refs/heads/{branch}", changes: ["src/units.ts"], base: SHA, pushed: SHA.slice(0, 12) }, { branch: "invincible/units" }), [], all)).toBeNull();
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
    expect(ownApprovalInLog({ ...call, path: "/repos/{owner}/{repo}/git/refs", args: { owner: "amiriteorg", repo: "invincible", ref: "refs/heads/invincible/x", sha: "7".repeat(40) }, by: "primary" })).toBeNull();
    // What a push changed and was built on, the commit it last pushed, where a branch stood, who opened a thread and
    // whose a repository is aren't in the log: those parts stay the approving node's, so a shipment, a fix, a pull
    // request or a comment it approved replays as it always did.
    expect(ownApprovalInLog({ ...call, native: "github.ship", path: "/repos/{owner}/{repo}/pulls", args: { owner: "amiriteorg", repo: "invincible", branch: "invincible/units" }, by: "team.0123456789.ada" })).toStartWith("a pull request of the work");
    expect(ownApprovalInLog({ ...call, native: "github.ship.update", method: "PATCH", path: "/repos/{owner}/{repo}/git/refs/heads/{branch}", args: { owner: "amiriteorg", repo: "invincible", branch: "invincible/units" }, by: "team.0123456789.ada" })).toStartWith("a fix pushed onto invincible/units");
    expect(ownApprovalInLog({ ...call, path: "/repos/{owner}/{repo}/pulls", args: { owner: "amiriteorg", repo: "invincible", head: "invincible/units", base: "main" }, by: "arm:primary" })).toStartWith("a pull request from invincible/units");
    expect(ownApprovalInLog({ ...call, path: "/repos/{owner}/{repo}/issues/{number}/comments", args: { owner: "lin-example", repo: "notes", number: 4 }, by: "arm:primary" })).toBe("a comment on its own thread #4 in lin-example/notes, a repository you gave an agent");
    // And so do its words, which the node reads before it files them: one approved before that was the rule replays.
    expect(ownApprovalInLog({ ...call, path: "/repos/{owner}/{repo}/issues/{number}/comments", args: { owner: "lin-example", repo: "notes", number: 4, body: "@lin-example thanks, merged" }, by: "arm:primary" })).toStartWith("a comment on its own thread #4");
    // A merge is held to its caller in the log too: the node's own, never its chat's or an agent's.
    const merge = { ...call, native: "github.merge", method: "PUT", path: "/repos/{owner}/{repo}/pulls/{number}/merge", args: { owner: "amiriteorg", repo: "invincible", number: 7, sha: "c".repeat(12) } };
    expect(ownApprovalInLog({ ...merge, by: "primary" })).toStartWith("a merge of its agents' proven work");
    for (const by of ["arm:primary", "team.0123456789.ada", "arm:team.0123456789.ada", "loop:release"]) expect([by, ownApprovalInLog({ ...merge, by })]).toEqual([by, null]);
  });

  test("what would make a call its own, were GitHub to say it, keeps what the node itself knows of it", () => {
    const SHA = "c".repeat(40);
    const fix: OwnCall = { class: "outward", origin: "https://api.github.com", native: "github.ship.update", method: "PATCH", path: "/repos/{owner}/{repo}/git/refs/heads/{branch}", args: { owner: "amiriteorg", repo: "invincible", branch: "invincible/units" }, by: "primary", changes: ["src/units.ts"], base: SHA, pushed: SHA.slice(0, 12) };
    expect(ownApproval(fix, ["https://github.com/amiriteorg/invincible"], supposedFacts(fix))).toStartWith("a fix pushed onto invincible/units");
    // A fix that began elsewhere than where it last pushed can't be its own, whatever GitHub says.
    expect(ownApproval({ ...fix, base: "d".repeat(40) }, ["https://github.com/amiriteorg/invincible"], supposedFacts({ ...fix, base: "d".repeat(40) }))).toBeNull();
  });
});
