/*
 * The Approvals: every side-effecting action is classified before it runs.
 *
 *   read      look, list, fetch                                  → allow
 *   create    new bucket, prefix, container, credential          → allow (logged)
 *   modify    change config, write objects, edit files           → allow (logged)
 *   outward   push, branch, send, post, deploy, purchase         → ask
 *   delete    remove anything persistent                         → ask
 *   forbidden breaks a hard limit                                → deny
 *
 * One exception: the primary may clean up ephemeral things *it* created for a run
 * (sandboxes, worktrees, temp prefixes). Everything else that deletes, asks.
 * Standing orders (signed by you) are checked separately, against the exact call:
 * see orders.ts.
 */

export type ActionClass = "read" | "create" | "modify" | "outward" | "delete" | "forbidden";
export type Decision = { verdict: "allow" | "ask" | "deny"; reason: string };

export interface Action {
  class: ActionClass;
  /** e.g. "r2.bucket", "git.branch", "docker.container" */
  resource: string;
  /** Concrete target, e.g. "invincible-backups" or "wckdboy/invincible#feat/x". */
  target: string;
  /** Present when the target was created by the primary. */
  createdBy?: { run: string; ephemeral: boolean };
  /** The run asking, if any. */
  run?: string;
}

export function decide(action: Action): Decision {
  switch (action.class) {
    case "forbidden":
      return { verdict: "deny", reason: "breaks a limit of the policy" };
    case "read":
    case "create":
    case "modify":
      return { verdict: "allow", reason: `${action.class} is within your agent's freedom (logged)` };
  }

  if (
    action.class === "delete" &&
    action.createdBy?.ephemeral &&
    action.run !== undefined &&
    action.createdBy.run === action.run
  ) {
    return { verdict: "allow", reason: "cleaning up an ephemeral resource this run created" };
  }

  return {
    verdict: "ask",
    reason: action.class === "delete" ? "deleting requires your approval" : "outward-facing actions require your approval",
  };
}

/*
 * What the primary approves itself, of what asks (your word, 23 November 2026: it approves its own decisions and its
 * agents'; what is monetary, legal or destructive still asks you; and 27 November: what is your own and can be undone is
 * its, and money, legal, destructive and security stay yours). An outward call is its to answer only when what it does
 * is known, and is none of those. On GitHub that is, and nothing more:
 *   - in a repository you gave an agent, for it, its agents and its loops:
 *       an issue;
 *       a comment, or a review that comments or asks for changes, on its own thread (one opened under your account);
 *       its work on a new invincible/… branch, built on your default branch's head as GitHub says it stands when it
 *         ships (never a contributor's pull request, nor an older commit, whose CI isn't main's now), and a fix onto a
 *         branch it shipped, from the commit it last pushed there: each known by what it changes, and changing no file
 *         or folder the repository's CI runs (CI_CONFIG: it runs with the repository's secrets, which are your keys);
 *       a pull request from a branch it shipped, still where it last pushed it, into your default branch;
 *   - in a private repository of your own (GitHub says so, of a repository not a fork, owned by the account your key is,
 *     by its id): for the primary itself alone, an issue, and a comment or a review that isn't an approval on its own
 *     thread. A public repository speaks to everyone, and a pull request or a push there runs its CI with its secrets;
 *   - nowhere: words with a line a repository's bots read as a command (BOT_COMMAND: a merge bot or ChatOps acts on it
 *     as your word).
 * Anyone else's thread, in any repository, speaks to them. Only you give an agent its repository, and the account is the
 * key you gave, so it can't widen this itself. Everything else asks as before: a branch (one at any commit runs that
 * commit's own workflows with the repository's secrets); a delete, which can't be undone; whatever spends or books money;
 * whatever speaks for you to other people or in their places (mail, a repository of anyone else's, an organization's you
 * gave no agent, someone else's thread); the physical world; a review that approves (your word on your account, which
 * branch protection counts); a tool whose effects aren't known (an MCP server's outward tool). CATALOG_WHOSE says it of
 * every action the connector catalog ships that asks, and CATALOG_FREE of every one that writes and doesn't.
 */

/** The parts of what stays yours (your word, 27 November 2026). */
export type Boundary = "money" | "legal" | "destructive" | "security";
/** Whose an action is to decide: its, where ownApproval says (`given`: a repository you gave an agent; `private`: a
 * private repository of your own, for the primary itself), or yours, by the part of the boundary it is in, and why. */
export type Whose = { its: string; where: readonly ("given" | "private")[] } | { yours: Boundary; why: string };

/**
 * Whose each action the connector catalog ships is to decide, of those that ask (outward, delete). The catalog's test
 * (packages/models/test/catalog-whose.test.ts) classes every action by what it does (a template's GET reads; a native
 * declared GET must be one that reads, at the path it reads; any other request is free only in CATALOG_FREE) and holds
 * each that asks to an entry here, and each entry to ownApproval: an action added without its place fails, and so does an
 * entry for an action the catalog no longer has.
 */
export const CATALOG_WHOSE = {
  "github.issue.create": { its: "an issue", where: ["given", "private"] },
  "github.issue.comment": { its: "a comment on its own thread, one opened under your account (anyone else's speaks to them)", where: ["given", "private"] },
  "github.pull.review": { its: "a review that comments or asks for changes, of its own pull request (one that approves is yours: your word on your account, which branch protection counts)", where: ["given", "private"] },
  "github.pr.create": { its: "a pull request from a branch it shipped, still where it last pushed it, into your default branch: it runs the repository's CI", where: ["given"] },
  "github.ship": { its: "its work as a pull request on a new invincible/… branch, built on your default branch's head as GitHub says it stands, changing nothing the repository's CI runs", where: ["given"] },
  "github.ship.update": { its: "a fix pushed onto a branch it shipped, from the commit it last pushed there, never forced, changing nothing the repository's CI runs", where: ["given"] },
  "github.merge": { its: "a merge of its agents' proven work (the node's own, of a task whose gates and independent reviewer passed and that it shipped), through GitHub's own merge once every check and review its rules require passed, never forced, landing nothing the repository's CI runs", where: ["given"] },
  "github.branch.create": { yours: "security", why: "a branch at a commit runs that commit's own workflows with the repository's secrets, which are your keys, whoever made the commit (a stranger's pull request too)" },
  "cloudflare.r2.bucket.delete": { yours: "destructive", why: "a bucket deleted can't be had back" },
  "home-assistant.service": { yours: "security", why: "the physical world: what moves, heats, unlocks or opens in your home" },
  "gmail.send": { yours: "legal", why: "mail speaks for you to other people" },
  "outlook.send": { yours: "legal", why: "mail speaks for you to other people" },
  "gmail.trash": { yours: "destructive", why: "it deletes your mail (Trash keeps it 30 days)" },
  "outlook.trash": { yours: "destructive", why: "it deletes your mail (Deleted Items keeps it until it is emptied)" },
} as const satisfies Record<string, Whose>;

/**
 * Each action the connector catalog ships that writes and is free (logged, never asked): why. The catalog's test holds
 * every request that isn't a GET to an entry here or in CATALOG_WHOSE, so one labelled free that isn't fails there.
 */
export const CATALOG_FREE: Readonly<Record<string, string>> = {
  "cloudflare.r2.bucket.create": "an empty bucket: free, and nothing in it until something is put there",
  "gmail.draft": "a draft, which nobody reads until you send it",
  "gmail.archive": "out of the inbox, kept and found as before",
  "outlook.draft": "a draft, which nobody reads until you send it",
  "outlook.archive": "out of the inbox, kept and found as before",
};

/** An outward call, as the node about to file it knows it: where it goes, which tool, and its arguments. */
export interface OwnCall {
  class: ActionClass;
  /** The connector's origin, as it was pinned. */
  origin: string;
  /** A native tool's name (connectors.ts NATIVE_TOOLS), absent for a request template. */
  native?: string;
  method: string;
  /** The tool's path, as its template has it: /repos/{owner}/{repo}/issues. */
  path: string;
  args: Record<string, unknown>;
  /** Who calls (primaryCaller): the part of your own repositories is the primary's itself alone. */
  by?: string;
  /** The files a push changes (a shipment's kept manifest says): absent, not known, and a push it can't see is yours. */
  changes?: readonly string[];
  /** The commit a push is built on (a shipment's kept manifest says): absent, not known. */
  base?: string;
  /** The commit your agent last pushed onto the branch the call names (its done shipment's or fix's receipt says it,
   * whole): absent, it pushed none there, and the branch isn't one it shipped. */
  pushed?: string;
  /** A fix's kept work is a verified fix task's, for this repository and branch (ci-back's path): only such a fix is
   * its own (the review of 27 November, N1). */
  proven?: boolean;
  /** What a merge would land, as this node knows it: the pull request's branch, and the commits it pushed there (whole,
   * oldest first), every one proven work of this node's (its ship of the merged task's kept work, each fix a verified
   * fix task's). Absent: one of them isn't, or isn't known, or another pushed there. */
  landed?: { branch: string; commits: readonly string[] };
}

/**
 * What GitHub said, asked with your key at its own origin before the call is filed (connectors.ts githubFacts): whose
 * the key is (its user's id, which a rename never changes), the repository the call names, the issue or pull request it
 * answers, and where the branch a push or a pull request is judged on stands. A part absent was not asked, or not said:
 * nothing of it is its then.
 */
export interface GitHubFacts {
  user?: { id: number };
  /** `name`: the repository's own "owner/repo", as GitHub gives it: facts of another repository are never this one's. */
  /** `defaultBranch`: the branch a shipment or a pull request of its own goes into, absent when GitHub didn't say. */
  repo?: { name: string; private: boolean; fork: boolean; ownerId: number; ownerType: string; defaultBranch?: string };
  /** `number`: the issue's or pull request's, as GitHub gives it: facts of another thread are never this one's. */
  thread?: { number: number; authorId: number };
  /** A branch, and the commit GitHub says it stands at: facts of another branch are never this one's. */
  head?: { branch: string; sha: string };
  /** The pull request a merge names, as GitHub says it is now: where it goes and comes from, its head, how many files. */
  pull?: { number: number; baseRef: string; baseRepo: string; headRepo: string; headRef: string; headSha: string; changedFiles: number };
  /** Every commit it holds, every page of them (absent: unreadable, or more than GitHub lists). */
  pullCommits?: readonly string[];
  /** Every file it changes, every page, as many as GitHub says it changes (absent: unreadable, or past its 3,000). */
  pullFiles?: readonly string[];
  /** Whether what the repository's workflows run on a pull request has finished green on its head (true when none run
   * on one; false while any runs, or once one failed). */
  checksSettled?: boolean;
}

const GITHUB = "https://api.github.com";
/** GitHub's request templates its words and its pull requests may use, by what each is. */
const GITHUB_OWN: Record<string, "an issue" | "a comment" | "a pull request" | "a review"> = {
  "POST /repos/{owner}/{repo}/issues": "an issue",
  "POST /repos/{owner}/{repo}/issues/{number}/comments": "a comment",
  "POST /repos/{owner}/{repo}/pulls": "a pull request",
  "POST /repos/{owner}/{repo}/pulls/{number}/reviews": "a review",
};
/** The primary itself: its chat's tools, and the node's work for it. Not its agents', nor its loops. */
const ITSELF = new Set(["primary", "arm:primary"]);

/*
 * Files and folders a repository's CI runs, with its secrets (your word, 27 November 2026: a push that changes one is the
 * security part, yours everywhere; and as the re-review drew it, whether it is added, changed or deleted). Matched
 * whatever their case, as a path from the repository's root; a path names one when it is one, is inside one, or is a
 * folder that holds one (deleted or replaced by a file, everything in it goes).
 */
/** Folders: GitHub's, Forgejo's and Gitea's whole (their workflows, their actions, what their automation reads), and the
 * CI services' own. */
const CI_FOLDERS = [".github", ".forgejo", ".gitea", ".gitlab/ci", ".circleci", ".azure-pipelines", ".buildkite", ".woodpecker", ".semaphore", ".tekton", ".builds", ".teamcity"];
/** The CI services' own files at the root: GitLab, Travis, Azure, Bitbucket, Drone, Woodpecker, AppVeyor, Cloud Build,
 * Buildkite, Cirrus, sourcehut, CodeBuild, Codefresh, Bitrise, Codemagic, and the hosts that build each push (Netlify,
 * Vercel, Amplify) with their environments' secrets. */
const CI_FILES = new Set(
  [
    ".gitlab-ci.yml",
    ".travis.yml",
    "azure-pipelines.yml",
    "bitbucket-pipelines.yml",
    ".drone.yml",
    ".drone.jsonnet",
    ".drone.star",
    ".woodpecker.yml",
    "appveyor.yml",
    ".appveyor.yml",
    "cloudbuild.yml",
    "cloudbuild.json",
    "buildkite.yml",
    "buildkite.json",
    ".cirrus.yml",
    ".cirrus.star",
    ".build.yml",
    "buildspec.yml",
    "codefresh.yml",
    "bitrise.yml",
    "codemagic.yml",
    "netlify.toml",
    "vercel.json",
    "amplify.yml",
  ].flatMap((name) => (name.endsWith(".yml") ? [name, `${name.slice(0, -4)}.yaml`] : [name])),
);
/** Files in any folder: a Jenkinsfile, and a local action (a workflow runs one from anywhere: uses: ./…). */
const CI_ANYWHERE = new Set(["jenkinsfile", "action.yml", "action.yaml"]);

/** Whether a path names a file or a folder the repository's CI runs (CI_FOLDERS, CI_FILES, CI_ANYWHERE). */
function namesCi(path: string): boolean {
  const p = path.replace(/^\.\//, "").toLowerCase();
  const segments = p.split("/");
  if (segments.some((segment) => CI_ANYWHERE.has(segment))) return true;
  if (CI_FILES.has(segments[0]!)) return true;
  return CI_FOLDERS.some((folder) => p === folder || p.startsWith(`${folder}/`) || folder.startsWith(`${p}/`));
}
/** Whether a push of these paths changes what the repository's CI runs. */
export const changesCi = (paths: readonly string[]): boolean => paths.some(namesCi);

/** The merge bot that takes a command by its bare name at a line's start (its name then r+, try, retry): the name is
 * one of the old theme's words, so it is written backwards here, as bench/vocabulary.ts writes them. */
const MERGE_BOT = [..."srob"].reverse().join("");
/** A line a repository's bots read as a command: a leading /word (ChatOps: /deploy, /release, /merge), the merge bot's
 * name and a word, or @name word (@mergifyio queue, @dependabot merge), whatever its case, after any spaces. */
const BOT_COMMAND = new RegExp(`^[^\\S\\n]*(\\/[a-z]|${MERGE_BOT}:?[^\\S\\n]+\\S|@[a-z0-9][a-z0-9-]*(\\[bot\\])?[,:]?[^\\S\\n]+[a-z])`, "im");
/** Whether the words a call writes (its title, its body) have a line a repository's bots read as a command. */
export const commandsABot = (args: Record<string, unknown>): boolean => [args.title, args.body].some((text) => typeof text === "string" && BOT_COMMAND.test(text));

/**
 * Why the primary may approve this call itself, or null when it waits for you. `repositories` are the ones you gave your
 * agents (github.com addresses, as you gave them); `facts`, what GitHub said of your key, the repository, the thread and
 * the branch, asked just before.
 */
export function ownApproval(call: OwnCall, repositories: readonly string[], facts: GitHubFacts = {}): string | null {
  // Words a repository's bots read as a command are yours wherever they would go: its automation acts on them as yours.
  // (Each node reads them before it files the call; the log's rule, ownApprovalInLog, holds approvals to the rest.)
  if (commandsABot(call.args)) return null;
  return whereIts(call, repositories, facts);
}

function whereIts(call: OwnCall, repositories: readonly string[], facts: GitHubFacts): string | null {
  if (call.class !== "outward" || call.origin !== GITHUB) return null;
  const { owner, repo } = call.args;
  if (typeof owner !== "string" || typeof repo !== "string") return null;
  const named = `${owner}/${repo}`;
  if (givenRepository(call, repositories)) return inGiven(call, named, facts);
  return ownPrivate(call, named, facts) ? inPrivate(call, `${named}, a private repository of yours`, facts) : null;
}

/** Whether the repository a call names is one you gave an agent (`repositories`, as you gave them), whatever its case. */
export function givenRepository(call: Pick<OwnCall, "args">, repositories: readonly string[]): boolean {
  const { owner, repo } = call.args;
  return typeof owner === "string" && typeof repo === "string" && repositories.some((remote) => githubRepository(remote) === `${owner}/${repo}`.toLowerCase());
}

/** Its, its agents' and its loops' work in a repository you gave an agent: an issue, its words on its own threads, a
 * pull request from a branch it shipped, its pushes, and the node's own merge of its agents' proven work. */
function inGiven(call: OwnCall, named: string, facts: GitHubFacts): string | null {
  const where = `${named}, a repository you gave an agent`;
  if (call.native === "github.merge") return itsMerge(call, named, where, facts);
  if (call.native === "github.ship" || call.native === "github.ship.update") return itsPush(call, named, where, facts);
  if (call.native !== undefined) return null;
  const what = GITHUB_OWN[`${call.method} ${call.path}`];
  if (what === "an issue") return `an issue in ${where}`;
  if (what === "a pull request") {
    const { head, base } = call.args;
    // From a branch of its own (Ivo's review, 23 November 2026), one it shipped and still where it left it, into the
    // default branch: a pull request's checks run from its merge with what it goes into.
    if (typeof head !== "string" || !PRIMARY_BRANCH.test(head) || facts.head?.branch !== head || !lastPushedAt(call.pushed, facts.head.sha)) return null;
    const into = defaultBranchOf(named, facts);
    return into !== undefined && base === into ? `a pull request from ${head}, a branch it shipped, into ${into}, in ${where}` : null;
  }
  return what ? onItsThread(call, what, where, facts) : null;
}

/**
 * A push of its work, as GitHub says the branch stands just before it goes, known by what it changes, and changing no
 * file or folder the repository's CI runs: a shipment on a new branch built on your default branch's head (its CI is the
 * default branch's now, plus what the shipment lists), or a fix onto a branch it shipped, from the commit it last pushed
 * there (the branch is then its own commits on the default branch's head).
 */
function itsPush(call: OwnCall, named: string, where: string, { repo, head }: GitHubFacts): string | null {
  if (!call.changes || changesCi(call.changes) || !isCommit(call.base) || !head || head.sha !== call.base) return null;
  if (call.native === "github.ship") {
    // Into the default branch (named, or not named at all), on its head.
    const into = defaultBranchOf(named, { repo });
    const asked = typeof call.args.base === "string" ? call.args.base : into;
    return into !== undefined && asked === into && head.branch === into ? `a pull request of the work on a new branch ${String(call.args.branch)}, built on ${into} as it stands, in ${where}` : null;
  }
  // A fix: a verified fix task's kept work for this branch (ci-back's path), onto where it last pushed it.
  if (call.proven !== true) return null;
  return head.branch === call.args.branch && lastPushedAt(call.pushed, head.sha) ? `a fix pushed onto ${head.branch}, a branch it shipped, from where it last pushed it, in ${where}` : null;
}

/**
 * The node's own merge of its agents' proven work (primaryMerge: one its chat, an agent or a loop asks for itself is
 * yours), as GitHub says the pull request is just before (the review of 27 November, N1, N2, N10): into your default
 * branch, in this repository, from the branch it shipped; its head the very commit it last pushed; every commit in it one
 * this node pushed as proven work; every file it changes read, as many as it says, and none the repository's CI runs
 * (nor in the node's own lists of what it pushed); and what the repository's workflows run on a pull request finished
 * green on that head.
 */
function itsMerge(call: OwnCall, named: string, where: string, { repo, pull, pullCommits, pullFiles, checksSettled }: GitHubFacts): string | null {
  const landed = call.landed;
  if (call.by !== "primary" || !call.changes || changesCi(call.changes) || !landed || landed.commits.length === 0) return null;
  const into = defaultBranchOf(named, { repo });
  if (!pull || pull.number !== call.args.number || into === undefined || pull.baseRef !== into) return null;
  if (pull.baseRepo.toLowerCase() !== named.toLowerCase() || pull.headRepo.toLowerCase() !== named.toLowerCase() || pull.headRef !== landed.branch) return null;
  if (!isCommit(call.args.sha) || pull.headSha !== call.args.sha || landed.commits.at(-1) !== pull.headSha) return null;
  if (!pullCommits || pullCommits.length === 0 || !pullCommits.every((commit) => landed.commits.includes(commit))) return null;
  if (!pullFiles || pullFiles.length !== pull.changedFiles || changesCi(pullFiles)) return null;
  if (checksSettled !== true) return null;
  return `a merge of its agents' proven work into ${into} (${pullCommits.length === 1 ? "its one commit" : `its ${pullCommits.length} commits`}, each pushed by this node, its checks green), in ${where}`;
}

/** A repository GitHub says is your own (private, not a fork, your key's account's by its id), for the primary itself. */
function ownPrivate(call: OwnCall, named: string, { user, repo }: GitHubFacts): boolean {
  return ITSELF.has(call.by ?? "") && user !== undefined && repo !== undefined && repo.name.toLowerCase() === named.toLowerCase() && repo.private === true && repo.fork === false && repo.ownerType === "User" && repo.ownerId === user.id;
}

/** Its own words there: an issue; a comment or a review that isn't an approval on its own thread. No push, no pull request. */
function inPrivate(call: OwnCall, where: string, facts: GitHubFacts): string | null {
  if (call.native !== undefined) return null;
  const what = GITHUB_OWN[`${call.method} ${call.path}`];
  if (what === "an issue") return `an issue in ${where}`;
  return what === "a comment" || what === "a review" ? onItsThread(call, what, where, facts) : null;
}

/** A comment, or a review that isn't an approval, on its own thread: one opened under your account (it, its agents and
 * you all open them with your key). Anyone else's thread speaks to them. */
function onItsThread(call: OwnCall, what: "a comment" | "a review", where: string, { user, thread }: GitHubFacts): string | null {
  if (thread === undefined || user === undefined || thread.number !== call.args.number || thread.authorId !== user.id) return null;
  if (what === "a review") return reviewsOnly(call) ? `a review of its own pull request #${call.args.number} in ${where}` : null;
  return `a comment on its own thread #${call.args.number} in ${where}`;
}

/** A review that comments or asks for changes, never one that approves. */
const reviewsOnly = (call: OwnCall) => ["COMMENT", "REQUEST_CHANGES"].includes(String(call.args.event ?? "").toUpperCase());
/** A whole commit id: 40 hex (SHA-1), or 64 should GitHub give SHA-256. */
const isCommit = (sha: unknown): sha is string => typeof sha === "string" && /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(sha);
/** Whether a branch standing at `sha` stands where your agent last pushed it: the very commit, whole, never a prefix. */
const lastPushedAt = (pushed: unknown, sha: string): boolean => isCommit(pushed) && sha === pushed;
/** The repository's default branch, as GitHub said it of this repository. */
const defaultBranchOf = (named: string, { repo }: GitHubFacts): string | undefined => (repo && repo.name.toLowerCase() === named.toLowerCase() ? repo.defaultBranch : undefined);

/**
 * The branch whose head a call is judged on (GitHubFacts.head): a shipment's, the branch it goes into (the default one,
 * unless it names one); a fix's, its own; a pull request's, the branch it comes from. None for anything else.
 */
export function judgedBranch(call: OwnCall, defaultBranch: string | undefined): string | undefined {
  const { base, branch, head } = call.args;
  if (call.native === "github.ship") return typeof base === "string" ? base : defaultBranch;
  if (call.native === "github.ship.update") return typeof branch === "string" ? branch : undefined;
  if (call.native === undefined && GITHUB_OWN[`${call.method} ${call.path}`] === "a pull request") return typeof head === "string" ? head : undefined;
  return undefined;
}

/**
 * What GitHub would have to say for a call to be its own, given what the node itself knows of it (a push's changes and
 * base, the commit it last pushed): a key's account, a private repository of it whose default branch is the one the call
 * names (or main), its own thread, and the branch the call is judged on standing where the call needs it. What the node
 * asks GitHub at all (connectors.ts), and what a replica takes as said (ownApprovalInLog).
 */
export function supposedFacts(call: OwnCall): GitHubFacts {
  const { owner, repo, number, base } = call.args;
  const defaultBranch = typeof base === "string" ? base : "main";
  const branch = judgedBranch(call, defaultBranch);
  const sha = isCommit(call.base) ? call.base : isCommit(call.pushed) ? call.pushed : "";
  const named = `${String(owner)}/${String(repo)}`;
  // A merge: the pull request as it would have to be, and all it lands as this node says it pushed it.
  const merge = call.native === "github.merge" && typeof number === "number" && isCommit(call.args.sha) && call.landed
    ? { pull: { number, baseRef: defaultBranch, baseRepo: named, headRepo: named, headRef: call.landed.branch, headSha: call.args.sha, changedFiles: 0 }, pullCommits: [...call.landed.commits], pullFiles: [], checksSettled: true }
    : {};
  return {
    user: { id: 1 },
    repo: { name: named, private: true, fork: false, ownerId: 1, ownerType: "User", defaultBranch: call.native === "github.merge" ? "main" : defaultBranch },
    ...(typeof number === "number" ? { thread: { number, authorId: 1 } } : {}),
    ...(branch !== undefined ? { head: { branch, sha } } : {}),
    ...merge,
  };
}

/**
 * The primary's own callers, whose calls it may approve itself: it (its chat's tools, and the node's work for it, by its
 * handle "primary"), its agents' work as the node carries it out (`team.…`), its agents' own calls from their VMs
 * (`arm:team.…`), and its loops (`loop:…`). Not a tool you run with a token of its own (`arm:…`), another node, or you
 * asking to be asked. No token you mint can take these names, and none minted before they were reserved authenticates
 * as one (arms.ts).
 */
export function primaryCaller(by: string): boolean {
  return by === "primary" || by === "arm:primary" || by.startsWith("team.") || by.startsWith("arm:team.") || by.startsWith("loop:");
}

/**
 * What every replica holds the primary's own approval to, from the log alone (ledger: an action.decided recorded as an
 * agent's): a call of one of its own callers (primaryCaller) that ownApproval allows, in the repository the call itself
 * names, as the connector stood. Which repositories you gave your agents, what GitHub said (whose your key and a
 * repository are, who opened a thread, where a branch stood), what a push changed and was built on, the commit it last
 * pushed, and whether its words read as a command to a bot are each node's to check before it files the call, not the
 * log's: the node that approved it checked those parts (in the log it is judged as if the repository were one you gave
 * an agent and GitHub had said what it needed). Null: not one it may approve itself.
 */
export function ownApprovalInLog(call: OwnCall & { by: string }): string | null {
  if (!primaryCaller(call.by)) return null;
  const { owner, repo } = call.args;
  if (typeof owner !== "string" || typeof repo !== "string") return null;
  const sha = isCommit(call.base) ? call.base : "0".repeat(40);
  // (A merge's commits and the branch they are on, a fix's proof, are the approving node's to have checked as the rest.)
  const head = isCommit(call.args.sha) ? call.args.sha : sha;
  const told: OwnCall = { ...call, changes: call.changes ?? [], base: sha, pushed: call.pushed ?? sha, proven: call.proven ?? true, landed: call.landed ?? { branch: "invincible/merged", commits: [head] } };
  return whereIts(told, [`https://github.com/${owner}/${repo}`], supposedFacts(told));
}

/** A branch of the primary's own, as the GitHub connector's shipments pin it (connector-catalog.ts). */
const PRIMARY_BRANCH = /^invincible\/[A-Za-z0-9._-]{1,80}(\/[A-Za-z0-9._-]{1,80})?$/;

/** "owner/repo" of a github.com repository's address (https or ssh), lowercased; null for anything else. */
function githubRepository(remote: string): string | null {
  const m = remote.trim().match(/^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}
