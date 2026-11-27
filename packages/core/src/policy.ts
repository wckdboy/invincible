/*
 * The Approvals: every side-effecting action is classified before it runs.
 *
 *   read      look, list, fetch                                  → allow
 *   create    new bucket, prefix, branch, container, credential  → allow (logged)
 *   modify    change config, write objects, edit files           → allow (logged)
 *   outward   push, send, post, deploy, purchase                 → ask
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
 *   - in a repository you gave an agent: its and its agents' work, as a pull request from an invincible/… branch, a fix
 *     pushed onto one, an issue, a comment on an issue or a pull request, or a review that comments or asks for changes;
 *     but never a push that changes what the repository's CI runs (CI_CONFIG: it runs with the repository's secrets,
 *     which are your keys), nor one whose changes aren't known;
 *   - in a private repository of your own (GitHub says so, of a repository not a fork, owned by the account your key is,
 *     by its id): for the primary itself alone, an issue, and a comment or a review that isn't an approval on its own
 *     thread, one it, its agents or you opened. Anyone else's thread speaks to them, and a public repository to everyone;
 *     a pull request or a push there runs the repository's CI with its secrets.
 * Only you give an agent its repository, and the account is the key you gave, so it can't widen this itself. Everything
 * else asks as before: a delete, which can't be undone; whatever spends or books money; whatever speaks for you to other
 * people or in their places (mail, a repository of anyone else's, an organization's you gave no agent, a public one,
 * someone else's thread); the physical world; a review that approves (your word on your account, which branch
 * protection counts); a tool whose effects aren't known (an MCP server's outward tool). CATALOG_WHOSE says it of every
 * action the connector catalog ships that asks, and CATALOG_FREE of every one that writes and doesn't.
 */

/** The parts of what stays yours (your word, 27 November 2026). */
export type Boundary = "money" | "legal" | "destructive" | "security";
/** Whose an action is to decide: its, where ownApproval says (`given`: a repository you gave an agent; `private`: a
 * private repository of your own, for the primary itself), or yours, by the part of the boundary it is in, and why. */
export type Whose = { its: string; where: readonly ("given" | "private")[] } | { yours: Boundary; why: string };

/**
 * Whose each action the connector catalog ships is to decide, of those that ask (outward, delete). The catalog's test
 * (packages/models/test/catalog-whose.test.ts) classes every action by what it does (a GET reads; any other request is
 * free only in CATALOG_FREE) and holds each that asks to an entry here, and each entry to ownApproval: an action added
 * without its place fails, and so does an entry for an action the catalog no longer has.
 */
export const CATALOG_WHOSE = {
  "github.issue.create": { its: "an issue", where: ["given", "private"] },
  "github.issue.comment": { its: "a comment on an issue or a pull request (in a private repository of yours, only on its own thread)", where: ["given", "private"] },
  "github.pull.review": { its: "a review that comments or asks for changes (in a private repository of yours, only of its own pull request; one that approves is yours: your word on your account, which branch protection counts)", where: ["given", "private"] },
  "github.pr.create": { its: "a pull request from a branch of its own (invincible/…): it runs the repository's CI", where: ["given"] },
  "github.ship": { its: "its work as a pull request on a new invincible/… branch, when it changes nothing the repository's CI runs", where: ["given"] },
  "github.ship.update": { its: "a fix pushed onto one of its invincible/… branches, never forced, when it changes nothing the repository's CI runs", where: ["given"] },
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
  "github.branch.create": "a new branch at a commit, nothing else moved (free as it always was; a branch is a push of a ref, so it runs the repository's on-push and on-create workflows: SECURITY.md says so)",
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
}

/**
 * What GitHub said, asked with your key at its own origin before the call is filed (connectors.ts githubFacts): whose
 * the key is (its user's id, which a rename never changes), the repository the call names, and the issue or pull request
 * it answers. A part absent was not asked, or not said: nothing of it is its then.
 */
export interface GitHubFacts {
  user?: { id: number };
  /** `name`: the repository's own "owner/repo", as GitHub gives it: facts of another repository are never this one's. */
  repo?: { name: string; private: boolean; fork: boolean; ownerId: number; ownerType: string };
  /** `number`: the issue's or pull request's, as GitHub gives it: facts of another thread are never this one's. */
  thread?: { number: number; authorId: number };
}

const GITHUB = "https://api.github.com";
/** GitHub's request templates its agents' work may use in their repositories, by what each does. */
const GITHUB_OWN: Record<string, string> = {
  "POST /repos/{owner}/{repo}/issues": "an issue",
  "POST /repos/{owner}/{repo}/issues/{number}/comments": "a comment",
  "POST /repos/{owner}/{repo}/pulls": "a pull request",
  "POST /repos/{owner}/{repo}/pulls/{number}/reviews": "a review",
};
/** The primary itself: its chat's tools, and the node's work for it. Not its agents', nor its loops. */
const ITSELF = new Set(["primary", "arm:primary"]);

/**
 * Files a repository's CI runs, with its secrets (your word, 27 November 2026: a push that changes one is the security
 * part, yours everywhere): the workflows and actions of GitHub, Forgejo and Gitea, and the pipelines of the CI services a
 * repository names by a file of its own. Matched whatever their case, as a path from the repository's root.
 */
const CI_CONFIG: readonly RegExp[] = [
  /^\.(github|forgejo|gitea)\/(workflows|actions)\//i,
  /^\.gitlab-ci\.ya?ml$/i,
  /^\.gitlab\/ci\//i,
  /^\.circleci\//i,
  /^\.travis\.ya?ml$/i,
  /^azure-pipelines\.ya?ml$/i,
  /^\.azure-pipelines\//i,
  /(^|\/)jenkinsfile$/i,
  /^\.buildkite\//i,
  /^bitbucket-pipelines\.ya?ml$/i,
  /^\.drone\.ya?ml$/i,
  /^\.woodpecker(\.ya?ml$|\/)/i,
  /^\.?appveyor\.ya?ml$/i,
  /^cloudbuild\.ya?ml$/i,
  /^\.semaphore\//i,
];
/** Whether a push of these files changes what the repository's CI runs. */
export const changesCi = (paths: readonly string[]): boolean => paths.some((path) => CI_CONFIG.some((pattern) => pattern.test(path.replace(/^\.\//, ""))));

/**
 * Why the primary may approve this call itself, or null when it waits for you. `repositories` are the ones you gave your
 * agents (github.com addresses, as you gave them); `facts`, what GitHub said of your key, the repository and the thread.
 */
export function ownApproval(call: OwnCall, repositories: readonly string[], facts: GitHubFacts = {}): string | null {
  if (call.class !== "outward" || call.origin !== GITHUB) return null;
  const { owner, repo } = call.args;
  if (typeof owner !== "string" || typeof repo !== "string") return null;
  const theirs = repositories.some((remote) => githubRepository(remote) === `${owner}/${repo}`.toLowerCase());
  if (theirs) return inGiven(call, `${owner}/${repo}, a repository you gave an agent`);
  return ownPrivate(call, `${owner}/${repo}`, facts) ? inPrivate(call, `${owner}/${repo}, a private repository of yours`, facts) : null;
}

/** Its and its agents' work in a repository you gave an agent: what they do there, but a push to its CI. */
function inGiven(call: OwnCall, where: string): string | null {
  if (call.native === "github.ship" || call.native === "github.ship.update") {
    // A push it can't see, or one that changes what the repository's CI runs, is yours (CI_CONFIG).
    if (!call.changes || changesCi(call.changes)) return null;
    return call.native === "github.ship" ? `a pull request of the work, on an invincible/… branch, in ${where}` : `a fix pushed onto its invincible/… branch, in ${where}`;
  }
  if (call.native !== undefined) return null;
  const what = GITHUB_OWN[`${call.method} ${call.path}`];
  if (!what) return null;
  if (what === "a review" && !reviewsOnly(call)) return null;
  // A pull request is its only from a branch of its own, as a shipment's is (Ivo's review, 23 November 2026: the
  // template's head was any branch, a branch of yours too).
  if (what === "a pull request" && !(typeof call.args.head === "string" && PRIMARY_BRANCH.test(call.args.head))) return null;
  return `${what} in ${where}`;
}

/** A repository GitHub says is your own (private, not a fork, your key's account's by its id), for the primary itself. */
function ownPrivate(call: OwnCall, named: string, { user, repo }: GitHubFacts): boolean {
  return ITSELF.has(call.by ?? "") && user !== undefined && repo !== undefined && repo.name.toLowerCase() === named.toLowerCase() && repo.private === true && repo.fork === false && repo.ownerType === "User" && repo.ownerId === user.id;
}

/** Its own words there: an issue; a comment or a review that isn't an approval on its own thread. No push, no pull request. */
function inPrivate(call: OwnCall, where: string, { user, thread }: GitHubFacts): string | null {
  if (call.native !== undefined) return null;
  const what = GITHUB_OWN[`${call.method} ${call.path}`];
  if (what === "an issue") return `an issue in ${where}`;
  if (what !== "a comment" && what !== "a review") return null;
  // Its own thread: one opened under your account (it, its agents and you all open them with your key).
  if (thread === undefined || user === undefined || thread.number !== call.args.number || thread.authorId !== user.id) return null;
  if (what === "a review") return reviewsOnly(call) ? `a review of its own pull request #${call.args.number} in ${where}` : null;
  return `a comment on its own thread #${call.args.number} in ${where}`;
}

/** A review that comments or asks for changes, never one that approves. */
const reviewsOnly = (call: OwnCall) => ["COMMENT", "REQUEST_CHANGES"].includes(String(call.args.event ?? "").toUpperCase());

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
 * names, as the connector stood. Which repositories you gave your agents, whose your key and a repository are, who opened
 * a thread and what a push changed are each node's to know, not the log's: the node that approved it checked those parts
 * (in the log it is judged as if the repository were one you gave an agent). Null: not one it may approve itself.
 */
export function ownApprovalInLog(call: OwnCall & { by: string }): string | null {
  if (!primaryCaller(call.by)) return null;
  const { owner, repo } = call.args;
  if (typeof owner !== "string" || typeof repo !== "string") return null;
  // (What a push changed is the approving node's to have seen, as whose the repository is: not in the log.)
  return ownApproval({ ...call, changes: call.changes ?? [] }, [`https://github.com/${owner}/${repo}`]);
}

/** A branch of the primary's own, as the GitHub connector's shipments pin it (connector-catalog.ts). */
const PRIMARY_BRANCH = /^invincible\/[A-Za-z0-9._-]{1,80}(\/[A-Za-z0-9._-]{1,80})?$/;

/** "owner/repo" of a github.com repository's address (https or ssh), lowercased; null for anything else. */
function githubRepository(remote: string): string | null {
  const m = remote.trim().match(/^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}
