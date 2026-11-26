/*
 * The Oath gate: every side-effecting action is classified before it runs.
 *
 *   read      look, list, fetch                                  → allow
 *   create    new bucket, prefix, branch, container, credential  → allow (logged)
 *   modify    change config, write objects, edit files           → allow (logged)
 *   outward   push, send, post, deploy, purchase                 → ask
 *   delete    remove anything persistent                         → ask
 *   forbidden breaks a hard limit                                → deny
 *
 * One exception: Galahad may clean up ephemeral things *he* created for a quest
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
  /** Concrete target, e.g. "galahad-backups" or "amiriteorg/galahad#feat/x". */
  target: string;
  /** Present when the target was created by Galahad. */
  createdBy?: { quest: string; ephemeral: boolean };
  /** The quest asking, if any. */
  quest?: string;
}

export function decide(action: Action): Decision {
  switch (action.class) {
    case "forbidden":
      return { verdict: "deny", reason: "breaks a limit of the oath" };
    case "read":
    case "create":
    case "modify":
      return { verdict: "allow", reason: `${action.class} is within Galahad's freedom (logged)` };
  }

  if (
    action.class === "delete" &&
    action.createdBy?.ephemeral &&
    action.quest !== undefined &&
    action.createdBy.quest === action.quest
  ) {
    return { verdict: "allow", reason: "cleaning up an ephemeral resource this quest created" };
  }

  return {
    verdict: "ask",
    reason: action.class === "delete" ? "deleting requires your approval" : "outward-facing actions require your approval",
  };
}

/*
 * What Galahad approves himself, of what asks (your word, 23 November 2026: he approves his own decisions and his
 * knights'; what is monetary, legal or destructive still asks you). An outward call is his to answer only when what it
 * does is known, and is none of the three: his knights' work in the repositories you gave them, on GitHub (a pull
 * request from a galahad/… branch, a fix pushed onto one, an issue, a comment on an issue or a pull request, a review
 * that comments or asks for changes). Only you give a knight its repository, so he can't widen this himself. Everything else asks as
 * before: a delete, which can't be undone; whatever spends or books money; whatever speaks for you to other people or
 * in their places (mail, someone else's repository); the physical world; a review that approves (your word on your
 * account, which branch protection counts); a tool whose effects aren't known (an MCP server's outward tool).
 */

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
}

const GITHUB = "https://api.github.com";
/** GitHub's request templates his knights' work may use in their repositories, by what each does. */
const GITHUB_OWN: Record<string, string> = {
  "POST /repos/{owner}/{repo}/issues": "an issue",
  "POST /repos/{owner}/{repo}/issues/{number}/comments": "a comment",
  "POST /repos/{owner}/{repo}/pulls": "a pull request",
  "POST /repos/{owner}/{repo}/pulls/{number}/reviews": "a review",
};

/**
 * Why Galahad may approve this call himself, or null when it waits for you. `repositories` are the ones you gave your
 * knights (github.com addresses, as you gave them).
 */
export function ownApproval(call: OwnCall, repositories: readonly string[]): string | null {
  if (call.class !== "outward" || call.origin !== GITHUB) return null;
  const { owner, repo } = call.args;
  if (typeof owner !== "string" || typeof repo !== "string") return null;
  const theirs = repositories.some((remote) => githubRepository(remote) === `${owner}/${repo}`.toLowerCase());
  if (!theirs) return null;
  const where = `${owner}/${repo}, a repository you gave a knight`;
  if (call.native === "github.ship") return `a pull request of the work, on a galahad/… branch, in ${where}`;
  if (call.native === "github.ship.update") return `a fix pushed onto its galahad/… branch, in ${where}`;
  if (call.native !== undefined) return null;
  const what = GITHUB_OWN[`${call.method} ${call.path}`];
  if (!what) return null;
  if (what === "a review" && !["COMMENT", "REQUEST_CHANGES"].includes(String(call.args.event ?? "").toUpperCase())) return null;
  // A pull request is his only from a branch of his own, as a shipment's is (Percival's review, 23 November 2026: the
  // template's head was any branch, a branch of yours too).
  if (what === "a pull request" && !(typeof call.args.head === "string" && GALAHAD_BRANCH.test(call.args.head))) return null;
  return `${what} in ${where}`;
}

/** A branch of Galahad's own, as the GitHub connector's shipments pin it (connector-catalog.ts). */
const GALAHAD_BRANCH = /^galahad\/[A-Za-z0-9._-]{1,80}(\/[A-Za-z0-9._-]{1,80})?$/;

/** "owner/repo" of a github.com repository's address (https or ssh), lowercased; null for anything else. */
function githubRepository(remote: string): string | null {
  const m = remote.trim().match(/^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}
