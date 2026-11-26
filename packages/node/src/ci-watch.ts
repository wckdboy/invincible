import type { Database } from "bun:sqlite";
import { type ActionView, findSecrets, type NodeIdentity } from "@galahad/core";
import type { MindStore } from "@galahad/mind";

/*
 * After you ship, the node that shipped follows the pull request's checks (CI). A ship you approved names the
 * repository and its new branch, and its receipt the pull request. For a day the node reads the branch's check runs
 * every few minutes (github.checks: a read, logged like any other, never asked about). Once every check has ended:
 *   all passed: nothing to tell, and a failure it told you about is cleared (a later push fixed it); it stops looking;
 *   one failed: a notice in your Inbox names the pull request and each failing check, with what each reported
 *     against the code (github.check.annotations: the file, the line, the message), for you or a knight to fix;
 *     where the work was a knight's, it may go back to that knight, and the notice says whether (ci-back.ts).
 * A fix pushed onto the branch keeps it followed, under the same notice. It writes nothing to GitHub and sends
 * nothing anywhere. What CI printed is someone else's text: it is shown as data, bounded, and a line that looks
 * like a key is left out.
 */

export const CI_WATCH_EVERY_MS = 3 * 60_000;
/** How long after its ship a pull request is followed. */
export const CI_WATCH_FOR_MS = 24 * 3600 * 1000;
/** A branch with no check this long after its ship has no CI to follow. */
export const CI_NO_CHECKS_MS = 20 * 60_000;
/** How a check run ends in failure. (Cancelled is not one: a newer run usually took its place.) */
const FAILED = new Set(["failure", "timed_out", "action_required", "startup_failure"]);
/** At most this many failing checks have their annotations read, and this many lines shown. */
const ANNOTATED = 3;
const LINES = 6;

export interface ShippedPull {
  /** The approved ship (an action id): the branch's first. */
  action: string;
  /** The GitHub connector it went through (github, or github-<owner>). */
  connector: string;
  owner: string;
  repo: string;
  branch: string;
  /** The work it shipped (an artifact's id). */
  artifact: string;
  /** Its pull request's number, from the ship's receipt. */
  pr: number | null;
  /** When it was shipped, or a fix last pushed onto it. */
  at: number;
}

/**
 * The pull requests this node shipped: each approved ship that went through, with its repository, branch and number.
 * One branch is one pull request: its first ship names it, and a fix pushed onto it since (ship.update) keeps it followed from then.
 */
export function shippedPulls(actions: ActionView[], node: string, doneAt: (action: string) => number | null): ShippedPull[] {
  const ships = actions.flatMap((action) => {
    if (!/^github(-[a-z0-9-]+)?$/.test(action.connector) || (action.tool !== "ship" && action.tool !== "ship.update") || action.state !== "done" || action.node !== node) return [];
    const { owner, repo, branch, artifact } = action.args as { owner?: unknown; repo?: unknown; branch?: unknown; artifact?: unknown };
    const at = doneAt(action.id);
    if (typeof owner !== "string" || typeof repo !== "string" || typeof branch !== "string" || typeof artifact !== "string" || at === null) return [];
    const pr = Number(/pull request #(\d+)/.exec(action.receipt ?? "")?.[1]) || null;
    return [{ action: action.id, connector: action.connector, owner, repo, branch, artifact, pr, at }];
  });
  const pulls = new Map<string, ShippedPull>();
  for (const ship of ships.sort((a, b) => a.at - b.at)) {
    const key = `${ship.owner.toLowerCase()}/${ship.repo.toLowerCase()}/${ship.branch}`;
    const first = pulls.get(key);
    pulls.set(key, first ? { ...first, at: ship.at, pr: first.pr ?? ship.pr } : ship);
  }
  return [...pulls.values()];
}

export interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  /** The commit it ran on. */
  head?: string;
}

/** A pull request's failure as the notice says it: the commit, the failing checks, and what they reported (as data). */
export interface CiFailure {
  head: string;
  failing: string[];
  lines: string[];
  /** Not its checks but a conflict with its base (GitHub: mergeable false, state "dirty"): the base commit, which is its head too. */
  conflict?: string;
}

/** A review that asked for changes, as data: its id, who, the commit it was on, its words and what it said on the code. */
export interface CiReview {
  id: number;
  by: string;
  head: string;
  body: string;
  lines: string[];
}

/** How long after its last push a pull request's reviews are read, and how often. */
export const CI_REVIEWS_FOR_MS = 7 * 24 * 3600 * 1000;
export const CI_REVIEWS_EVERY_MS = 15 * 60_000;
/** Whose asking for changes counts: someone who may push to the repository (anyone may review a public one). */
const MAY_PUSH = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** What one review said on the code, from a pull request's comments: "path:line words", one line each. */
export function reviewLines(comments: unknown[], review: number): string[] {
  return comments
    .flatMap((raw) => {
      const c = raw as { pull_request_review_id?: unknown; path?: unknown; line?: unknown; original_line?: unknown; body?: unknown };
      if (c.pull_request_review_id !== review || typeof c.path !== "string" || typeof c.body !== "string" || !c.body.trim()) return [];
      const at = typeof c.line === "number" ? c.line : typeof c.original_line === "number" ? c.original_line : null;
      const line = `${c.path}${at === null ? "" : `:${at}`} ${c.body.trim().split("\n")[0]!.trim()}`.slice(0, 300);
      return [findSecrets(line).length ? "(a line that looked like a key was left out)" : line];
    })
    .slice(0, 10);
}

export type CiVerdict ={ state: "running" } | { state: "none" } | { state: "passed"; total: number } | { state: "failed"; total: number; failing: CheckRun[] };

/** Where a branch's checks stand: still running, none at all (after a while), all passed, or some failed. */
export function ciVerdict(runs: CheckRun[], sinceShipMs: number): CiVerdict {
  if (!runs.length) return sinceShipMs >= CI_NO_CHECKS_MS ? { state: "none" } : { state: "running" };
  if (runs.some((run) => run.status !== "completed")) return { state: "running" };
  const failing = runs.filter((run) => run.conclusion !== null && FAILED.has(run.conclusion));
  return failing.length ? { state: "failed", total: runs.length, failing } : { state: "passed", total: runs.length };
}

export interface CiWatchOptions {
  store: MindStore;
  identity: NodeIdentity;
  local: Database;
  /** The pull requests to follow (shippedPulls over the outbox). */
  shipped: () => ShippedPull[];
  /** One GitHub read through the connector the pull request was shipped by (<connector>.<tool>), as the node's own. */
  call: (tool: "checks" | "check.annotations" | "pull" | "pull.reviews" | "pull.comments", args: Record<string, string | number>, connector: string) => Promise<{ ok: boolean; status: number; body: string }>;
  /** A review that asks for changes on a knight's work (ci-back.ts): whether a pull request's are worth reading, and each one read. */
  reviews?: { wanted: (pull: ShippedPull) => boolean; asked: (pull: ShippedPull, review: CiReview) => void };
  /**
   * Whether its failure goes back to the knight whose work it was: what the notice says of that (ci-back.ts), or nothing,
   * and whether a fix is under way (then the notice is a note, for the day's digest: a knight is on it; PLAN #59).
   */
  back?: (pull: ShippedPull, failure: CiFailure) => { said: string; fixing: boolean } | null;
  now?: () => number;
  log: (message: string) => void;
}

export class CiWatch {
  private timer: ReturnType<typeof setInterval> | null = null;
  private looking: Promise<void> | null = null;
  private readonly now: () => number;
  /** When each pull request's reviews were last read (by its first ship). */
  private readonly reviewsRead = new Map<string, number>();
  /** The connectors that can't read reviews yet, said once. */
  private readonly noReviews = new Set<string>();
  /** The connectors that can't read a pull request yet, said once (apart from reviews: one doesn't stop the other). */
  private readonly noConflicts = new Set<string>();

  constructor(private readonly o: CiWatchOptions) {
    this.now = o.now ?? Date.now;
    o.local.exec("CREATE TABLE IF NOT EXISTS ci_watch (action TEXT PRIMARY KEY, state TEXT NOT NULL, at INTEGER NOT NULL)");
    // Each review handed on once, whatever came of it.
    o.local.exec("CREATE TABLE IF NOT EXISTS ci_reviews (review INTEGER PRIMARY KEY, at INTEGER NOT NULL)");
    // Each pull request's conflict handed on once for each base commit it conflicts with (a pull request is owner/repo/branch#number).
    o.local.exec("CREATE TABLE IF NOT EXISTS ci_conflicts (pull TEXT NOT NULL, base TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (pull, base))");
  }

  start(everyMs = CI_WATCH_EVERY_MS): void {
    this.stopTimer();
    this.timer = setInterval(() => void this.tick(), everyMs);
  }

  async stop(): Promise<void> {
    this.stopTimer();
    await this.looking;
  }

  /** One look at every pull request still followed (a look under way is joined, not doubled). */
  tick(): Promise<void> {
    this.looking ??= this.look().finally(() => (this.looking = null));
    return this.looking;
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async look(): Promise<void> {
    const now = this.now();
    for (const pull of this.o.shipped()) {
      if (now - pull.at < CI_WATCH_FOR_MS) await this.followChecks(pull, now);
      const read = this.reviewsRead.get(pull.action);
      if (pull.pr && now - pull.at < CI_REVIEWS_FOR_MS && (read === undefined || now - read >= CI_REVIEWS_EVERY_MS)) await this.followReviews(pull, now);
      if (pull.pr && now - pull.at < CI_REVIEWS_FOR_MS) await this.followConflicts(pull, now);
    }
  }

  /**
   * Whether a pull request conflicts with its base (github.pull: mergeable false, mergeable_state "dirty"). Each base
   * commit it conflicts with is handed on once for that pull request, and said in your Inbox with what became of it.
   */
  private async followConflicts(pull: ShippedPull, now: number): Promise<void> {
    if (!this.o.back || this.noConflicts.has(pull.connector)) return;
    try {
      const read = await this.o.call("pull", { owner: pull.owner, repo: pull.repo, number: pull.pr! }, pull.connector);
      if (!read.ok) return;
      const p = JSON.parse(read.body) as { mergeable?: unknown; mergeable_state?: unknown; base?: { sha?: unknown } };
      const base = p.base?.sha;
      if (p.mergeable !== false || p.mergeable_state !== "dirty" || typeof base !== "string" || !/^[0-9a-f]{40}$/.test(base)) return;
      const key = `${pull.owner.toLowerCase()}/${pull.repo.toLowerCase()}/${pull.branch}#${pull.pr}`;
      if (this.o.local.query("SELECT 1 FROM ci_conflicts WHERE pull = ? AND base = ?").get(key, base)) return;
      this.o.local.query("INSERT OR IGNORE INTO ci_conflicts (pull, base, at) VALUES (?, ?, ?)").run(key, base, now);
      let back: { said: string; fixing: boolean } | null = null;
      try {
        back = this.o.back(pull, { head: base, failing: [], lines: [], conflict: base });
      } catch (error) {
        this.o.log(`ci: ${pull.owner}/${pull.repo} ${pull.branch}: not given back (${(error as Error).message})`);
      }
      const body = [`It conflicts with its base branch (at ${base.slice(0, 12)}): merge the base in and resolve the conflicts.`, ...(back ? [back.said] : [])].join("\n").slice(0, 600);
      this.o.store.emit(this.o.identity, "notice.raised", { key: `ci-conflict:${pull.action}`, severity: back?.fixing ? "info" : "warn", title: `Conflicts on ${pull.owner}/${pull.repo}#${pull.pr}`, body, source: "ci", at: this.now() });
    } catch (error) {
      const message = (error as Error).message;
      if (/has no tool "pull"/.test(message)) {
        this.noConflicts.add(pull.connector);
        this.o.log(`ci: ${pull.connector} can't read a pull request yet; add it again to have conflicts followed (galahad connector add github)`);
      } else this.o.log(`ci: ${pull.owner}/${pull.repo} ${pull.branch}: conflicts: ${message}`);
    }
  }

  private async followChecks(pull: ShippedPull, now: number): Promise<void> {
    const seen = this.o.local.query<{ state: string }, [string]>("SELECT state FROM ci_watch WHERE action = ?").get(pull.action)?.state;
    if (seen === "passed" || seen === "none" || seen === "unreadable") return;
    try {
      const verdict = ciVerdict(await this.checks(pull), now - pull.at);
      if (verdict.state === "running") return;
      if (verdict.state === "failed") await this.tell(pull, verdict.total, verdict.failing);
      else this.clear(pull);
      this.o.local.query("INSERT INTO ci_watch (action, state, at) VALUES (?, ?, ?) ON CONFLICT (action) DO UPDATE SET state = excluded.state, at = excluded.at").run(pull.action, verdict.state, now);
    } catch (error) {
      const message = (error as Error).message;
      this.o.log(`ci: ${pull.owner}/${pull.repo} ${pull.branch}: ${message}`);
      // A GitHub connector installed before it could read checks: said once, not every few minutes for a day.
      if (/has no tool "checks"/.test(message)) {
        this.o.log("ci: the GitHub connector can't read checks yet; add it again to have shipped pull requests followed (galahad connector add github)");
        this.o.local.query("INSERT OR REPLACE INTO ci_watch (action, state, at) VALUES (?, 'unreadable', ?)").run(pull.action, now);
      }
    }
  }

  /**
   * A pull request's reviews, where a fix could go back: each one since the last push, by someone who may push, that
   * asks for changes or says something on the code (one that only comments asks nothing of it: "looks good"). Each is
   * handed on once with what it said on the code. (GitHub lets no author ask for changes on their own pull request,
   * and a shipped one is yours: your word on a line of it is how you ask.) Its words are someone else's: bounded, and
   * anything that looks like a key left out.
   */
  private async followReviews(pull: ShippedPull, now: number): Promise<void> {
    if (this.noReviews.has(pull.connector) || !this.o.reviews?.wanted(pull)) return;
    this.reviewsRead.set(pull.action, now);
    try {
      const read = await this.o.call("pull.reviews", { owner: pull.owner, repo: pull.repo, number: pull.pr!, per_page: 100 }, pull.connector);
      if (!read.ok) return;
      let comments: unknown[] | null = null;
      for (const raw of JSON.parse(read.body) as unknown[]) {
        const r = raw as { id?: unknown; state?: unknown; author_association?: unknown; submitted_at?: unknown; commit_id?: unknown; body?: unknown; user?: { login?: unknown } };
        if (typeof r.id !== "number" || (r.state !== "CHANGES_REQUESTED" && r.state !== "COMMENTED") || !MAY_PUSH.has(String(r.author_association)) || typeof r.commit_id !== "string") continue;
        if (!(Date.parse(String(r.submitted_at)) > pull.at)) continue;
        if (this.o.local.query("SELECT 1 FROM ci_reviews WHERE review = ?").get(r.id)) continue;
        comments ??= await this.comments(pull);
        const lines = reviewLines(comments, r.id);
        const body = typeof r.body === "string" ? r.body.trim().slice(0, 2000) : "";
        if (r.state === "CHANGES_REQUESTED" || lines.length) {
          this.o.reviews.asked(pull, {
            id: r.id,
            by: typeof r.user?.login === "string" ? r.user.login : "someone",
            head: r.commit_id,
            body: findSecrets(body).length ? "(its words looked like they held a key, so they were left out: read it on GitHub)" : body,
            lines,
          });
        }
        this.o.local.query("INSERT OR IGNORE INTO ci_reviews (review, at) VALUES (?, ?)").run(r.id, now);
      }
    } catch (error) {
      const message = (error as Error).message;
      if (/has no tool "pull\.(reviews|comments)"/.test(message)) {
        this.noReviews.add(pull.connector);
        this.o.log(`ci: ${pull.connector} can't read reviews yet; add it again to have reviews followed (galahad connector add github)`);
      } else this.o.log(`ci: ${pull.owner}/${pull.repo} ${pull.branch}: reviews: ${message}`);
    }
  }

  /** A pull request's comments on its code (every review's). */
  private async comments(pull: ShippedPull): Promise<unknown[]> {
    const read = await this.o.call("pull.comments", { owner: pull.owner, repo: pull.repo, number: pull.pr!, per_page: 100 }, pull.connector);
    return read.ok ? (JSON.parse(read.body) as unknown[]) : [];
  }

  private async checks(pull: ShippedPull): Promise<CheckRun[]> {
    const result = await this.o.call("checks", { owner: pull.owner, repo: pull.repo, ref: pull.branch, per_page: 100 }, pull.connector);
    if (!result.ok) throw new Error(`GitHub answered ${result.status}`);
    const runs = (JSON.parse(result.body) as { check_runs?: unknown[] }).check_runs ?? [];
    return runs.flatMap((raw) => {
      const r = raw as { id?: unknown; name?: unknown; status?: unknown; conclusion?: unknown; head_sha?: unknown };
      if (typeof r.id !== "number" || typeof r.name !== "string" || typeof r.status !== "string") return [];
      return [{ id: r.id, name: r.name, status: r.status, conclusion: typeof r.conclusion === "string" ? r.conclusion : null, ...(typeof r.head_sha === "string" && /^[0-9a-f]{40}$/.test(r.head_sha) ? { head: r.head_sha } : {}) }];
    });
  }

  /** What the failing checks reported against the code: "path:line message", one line each. */
  private async annotations(pull: ShippedPull, failing: CheckRun[]): Promise<string[]> {
    const lines: string[] = [];
    for (const run of failing.slice(0, ANNOTATED)) {
      const result = await this.o.call("check.annotations", { owner: pull.owner, repo: pull.repo, check_run_id: run.id, per_page: LINES }, pull.connector);
      if (!result.ok) continue;
      for (const raw of JSON.parse(result.body) as unknown[]) {
        const a = raw as { path?: unknown; start_line?: unknown; message?: unknown };
        if (typeof a.path !== "string" || typeof a.message !== "string") continue;
        const line = `${a.path}${typeof a.start_line === "number" ? `:${a.start_line}` : ""} ${a.message.split("\n")[0]!.trim()}`.slice(0, 200);
        lines.push(findSecrets(line).length ? "(a line that looked like a key was left out)" : line);
      }
    }
    return lines.slice(0, LINES);
  }

  private async tell(pull: ShippedPull, total: number, failing: CheckRun[]): Promise<void> {
    const key = `ci:${pull.action}`;
    const title = `CI failed on ${pull.owner}/${pull.repo}${pull.pr ? `#${pull.pr}` : ` (${pull.branch})`}`;
    const names = failing.map((run) => run.name);
    const lines = await this.annotations(pull, failing);
    // (What became of it comes before what CI said, so a long report never cuts it off.)
    const head = failing.find((run) => run.head)?.head;
    let back: { said: string; fixing: boolean } | null = null;
    try {
      if (head) back = this.o.back?.(pull, { head, failing: names, lines }) ?? null;
    } catch (error) {
      this.o.log(`ci: ${pull.owner}/${pull.repo} ${pull.branch}: not given back (${(error as Error).message})`);
    }
    const body = [`${failing.length} of ${total} checks failed: ${names.join(", ")}.`, ...(back ? [back.said] : []), ...lines].join("\n").slice(0, 600);
    // A knight is fixing it: a note (the day's digest counts it), not a warning that needs you. Yours: a warning.
    const severity = back?.fixing ? "info" : "warn";
    const current = this.o.store.lww<{ title: string; body: string; severity: string } | null>(`notice:${key}`)?.value;
    if (current && current.title === title && current.body === body && current.severity === severity) return;
    this.o.store.emit(this.o.identity, "notice.raised", { key, severity, title, body, source: "ci", at: this.now() });
  }

  private clear(pull: ShippedPull): void {
    const key = `ci:${pull.action}`;
    if (this.o.store.lww(`notice:${key}`)?.value) this.o.store.emit(this.o.identity, "notice.cleared", { key });
  }
}
