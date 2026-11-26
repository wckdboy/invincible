import { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { BankAccountView, BankStatusView, UntrustedBankData } from "@galahad/core";
import { z } from "zod";
import { EnableBankingClient, EnableBankingError } from "./eb-client.ts";
import { type BalanceOut, cleanText, maskIban, shapeBalances, shapeTransactions, type TransactionOut, UNTRUSTED_NOTICE } from "./sanitize.ts";

/*
 * Bank access on the node that holds the key (ultra): read-only account information
 * from your own accounts through Enable Banking.
 *
 * Files live in <node home>/bank (mode 700), each mode 600 and created that way
 * (never briefly readable by anyone else): config.json, session.json, pending.json,
 * cache.db, audit.log. The application's private key is yours to place, anywhere
 * outside an agent's reach; bank access stays off while the key, the session or the
 * config is readable by any other user.
 *
 * Agents read through the bank:read tools: accounts on the session's allowlist only,
 * cached by default, and a budget of background fetches per account per rolling 24
 * hours (many banks allow 4 when you're not present). Authorising is yours alone.
 */

const DAY_MS = 24 * 60 * 60_000;
export const BALANCES_TTL_MS = 60 * 60_000;
export const TRANSACTIONS_TTL_MS = 6 * 60 * 60_000;
export const MAX_RANGE_DAYS = 365;
export const MAX_PAGES = 10;
/** The FAQ's advice after ASPSP_RATE_LIMIT_EXCEEDED in the background: try again after 6 hours. */
export const COOLDOWN_MS = 6 * 60 * 60_000;
const PENDING_TTL_MS = 15 * 60_000;
export const REAUTHORIZE = "Bank access needs re-authorisation. Ask the human to re-authorize Galahad's bank connection (Galahad → Bank → Re-authorize).";

/** Enable Banking's error codes that say the session itself is over: no need to ask. */
const SESSION_OVER = new Set(["EXPIRED_SESSION", "CLOSED_SESSION", "REVOKED_SESSION", "SESSION_DOES_NOT_EXIST"]);
/** Refusals that may or may not mean the consent ended (like any 401 or 403): the session is asked once. */
const REFUSED = new Set(["WRONG_SESSION_STATUS", "UNAUTHORIZED_ACCESS", "ACCESS_DENIED"]);
/** Session statuses that end the consent. AUTHORIZED is the one that reads; anything unknown isn't taken as an end. */
const SESSION_ENDED = new Set(["EXPIRED", "REVOKED", "CLOSED", "CANCELLED", "INVALID"]);
/** What a broken session file says: never its text, which a parser would quote. */
const BROKEN_SESSION = "the bank session file doesn't hold up: disconnect, then re-authorize (Bank → Re-authorize)";

const SessionFile = z.object({
  session_id: z.string().min(1).max(200),
  aspsp: z.string().max(200),
  accounts: z.array(z.object({ uid: z.string(), name: z.string().nullable(), iban: z.string().nullable(), currency: z.string().nullable() })),
  valid_until: z.string(),
  created_at: z.string(),
  invalid_since: z.string().optional(),
});

/** What setup needs to be told: no bank or country is assumed. Said in words, never quoting what was given. */
const BANK_NAME = 'the bank\'s name as Enable Banking lists it: --aspsp "<bank>"';
const BANK_COUNTRY = "the bank's two-letter country code, in capitals: --country <XX>";

export const BankConfig = z.strictObject({
  appId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "the application ID (a UUID)"),
  keyPath: z.string().max(1024).refine((p) => isAbsolute(p), "an absolute path"),
  redirectUrl: z.string().max(500).url().refine((u) => u.startsWith("https://"), "an https:// URL, exactly as registered with Enable Banking"),
  /** The bank, by the name Enable Banking lists it under (GET /aspsps), and its country: yours to give. */
  aspsp: z.string({ error: BANK_NAME }).min(1, BANK_NAME).max(100),
  country: z.string({ error: BANK_COUNTRY }).regex(/^[A-Z]{2}$/, BANK_COUNTRY),
  /** Consent length asked for; less if the bank allows less. */
  consentDays: z.number().int().min(1).max(180).default(89),
  /** Background fetches per account per rolling 24 hours. */
  budgetPerDay: z.number().int().min(1).max(24).default(4),
});
export type BankConfig = z.infer<typeof BankConfig>;

/** A config checked: what is wrong said as each field and why, never quoting the input. */
function checked(input: unknown): BankConfig {
  const parsed = BankConfig.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`).join("; "));
  return parsed.data;
}

interface Session {
  session_id: string;
  aspsp: string;
  accounts: { uid: string; name: string | null; iban: string | null; currency: string | null }[];
  valid_until: string;
  created_at: string;
  invalid_since?: string;
}

export class BankError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type Reauthorize = { reauthorization_required: true; message: string };

export interface FileStat {
  mode: number;
  uid: number;
  isFile(): boolean;
}

export interface BankServiceOptions {
  /** <node home>/bank */
  dir: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Tests: a throwaway key, file modes and owners. */
  readKey?: (path: string) => string;
  stat?: (path: string) => FileStat;
  uid?: number;
  platform?: NodeJS.Platform;
}

/** Create a file readable only by its owner, atomically; it is never wider than 600, not even for a moment. */
export function writePrivate(path: string, content: string): void {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

const sha256 = (text: string) => createHash("sha256").update(text).digest();
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export class BankService {
  private readonly now: () => number;
  private db: Database | null = null;

  constructor(private readonly o: BankServiceOptions) {
    this.now = o.now ?? Date.now;
  }

  private path(name: string): string {
    return join(this.o.dir, name);
  }

  private stat(path: string): FileStat {
    return (this.o.stat ?? ((p) => statSync(p)))(path);
  }

  /** Why a file isn't private to this node's user, or null. */
  private privacyProblem(path: string, what: string): string | null {
    let st: FileStat;
    try {
      st = this.stat(path);
    } catch {
      return `${what} isn't there (see galahad bank status on the node)`;
    }
    if (!st.isFile()) return `${what} isn't a regular file`;
    if ((st.mode & 0o077) !== 0) return `${what} is readable by other users (mode ${(st.mode & 0o777).toString(8)}): chmod 600 it`;
    const uid = this.o.uid ?? process.getuid?.();
    if (uid !== undefined && st.uid !== uid) return `${what} belongs to another user: it must be owned by the user Galahad runs as`;
    return null;
  }

  config(): BankConfig | null {
    if (!existsSync(this.path("config.json"))) return null;
    return checked(JSON.parse(readFileSync(this.path("config.json"), "utf8")));
  }

  /**
   * Whether bank access may run at all: on a node where file modes mean something,
   * with the config, the key and any session private to this node's user.
   */
  problem(): string | null {
    if ((this.o.platform ?? process.platform) === "win32") return "bank access runs on Linux or macOS nodes only: file permissions can't be enforced here";
    if (!existsSync(this.path("config.json"))) return "not set up: galahad bank setup --app-id <uuid> --key <path to the .pem> --redirect-url <url> --aspsp \"<bank>\" --country <XX>";
    let config: BankConfig;
    try {
      config = this.config()!;
    } catch (error) {
      // A parser's message quotes the file: say only that it isn't JSON.
      return `the bank config doesn't hold up: ${error instanceof SyntaxError ? "it isn't valid JSON" : (error as Error).message.slice(0, 200)}`;
    }
    for (const [path, what] of [
      [this.path("config.json"), "the bank config"],
      [config.keyPath, "the private key"],
      ...(existsSync(this.path("session.json")) ? [[this.path("session.json"), "the bank session"] as const] : []),
    ] as const) {
      const problem = this.privacyProblem(path, what);
      if (problem) return problem;
    }
    try {
      this.session();
    } catch (error) {
      if (error instanceof BankError) return error.message;
      throw error;
    }
    return null;
  }

  private ready(): { config: BankConfig; client: EnableBankingClient } {
    const problem = this.problem();
    if (problem) throw new BankError(424, problem);
    const config = this.config()!;
    return {
      config,
      client: new EnableBankingClient({ appId: config.appId, keyPath: config.keyPath, ...(this.o.fetch ? { fetch: this.o.fetch } : {}), now: this.now, ...(this.o.readKey ? { readKey: this.o.readKey } : {}) }),
    };
  }

  private ensureDir(): void {
    mkdirSync(this.o.dir, { recursive: true, mode: 0o700 });
    if ((this.o.platform ?? process.platform) !== "win32") chmodSync(this.o.dir, 0o700);
  }

  /** You, at a terminal on this node: what to use. Validated; written private. */
  setup(input: z.input<typeof BankConfig>): BankConfig {
    const config = checked(input);
    this.ensureDir();
    rmSync(this.path("config.json"), { force: true });
    writePrivate(this.path("config.json"), JSON.stringify(config, null, 2));
    return config;
  }

  /* ---------- the session ---------- */

  /** The session on disk, checked; a broken file is a BankError that quotes none of it. */
  private session(): Session | null {
    if (!existsSync(this.path("session.json"))) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path("session.json"), "utf8"));
    } catch {
      throw new BankError(424, BROKEN_SESSION);
    }
    const session = SessionFile.safeParse(parsed);
    if (!session.success) throw new BankError(424, BROKEN_SESSION);
    return session.data;
  }

  private saveSession(session: Session): void {
    this.ensureDir();
    writePrivate(this.path("session.json"), JSON.stringify(session, null, 2));
  }

  private connected(): Session | Reauthorize {
    const session = this.session();
    if (!session || session.invalid_since || Date.parse(session.valid_until) <= this.now()) return { reauthorization_required: true, message: REAUTHORIZE };
    return session;
  }

  /* ---------- the cache, the budget, the audit log ---------- */

  private cache(): Database {
    if (this.db) return this.db;
    this.ensureDir();
    const file = this.path("cache.db");
    if (!existsSync(file)) closeSync(openSync(file, "wx", 0o600));
    this.db = new Database(file);
    this.db.exec(`CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, account TEXT NOT NULL, fetched_at INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calls (account TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cooldown (account TEXT PRIMARY KEY, until INTEGER NOT NULL);`);
    return this.db;
  }

  private cached<T>(key: string): { at: number; body: T } | null {
    const row = this.cache().query<{ fetched_at: number; body: string }, [string]>("SELECT fetched_at, body FROM cache WHERE key = ?").get(key);
    return row ? { at: row.fetched_at, body: JSON.parse(row.body) as T } : null;
  }

  private store(key: string, account: string, body: unknown, at: number): void {
    this.cache().query("INSERT INTO cache (key, account, fetched_at, body) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET fetched_at = excluded.fetched_at, body = excluded.body").run(key, account, at, JSON.stringify(body));
  }

  /** Background fetches left for an account in the last 24 hours. */
  remaining(account: string, perDay: number): number {
    const used = this.cache().query<{ n: number }, [string, number]>("SELECT COUNT(*) AS n FROM calls WHERE account = ? AND at > ?").get(account, this.now() - DAY_MS)!.n;
    return Math.max(0, perDay - used);
  }

  private spend(account: string): void {
    this.cache().query("INSERT INTO calls (account, at) VALUES (?, ?)").run(account, this.now());
  }

  private coolingUntil(account: string): number | null {
    const row = this.cache().query<{ until: number }, [string]>("SELECT until FROM cooldown WHERE account = ?").get(account);
    return row && row.until > this.now() ? row.until : null;
  }

  private audit(tool: string, account: string | null, status: string): void {
    this.ensureDir();
    // Never keys, tokens, IBANs, balances or transactions: the tool, the account's last 4, how it went.
    appendFileSync(this.path("audit.log"), `${new Date(this.now()).toISOString()} ${tool} ${account ? `…${account.slice(-4)}` : "-"} ${status}\n`, { mode: 0o600 });
  }

  /**
   * A failure the agent may see: never the body, headers or stack. The consent is taken
   * as ended only when the bank says the session is over, or when it refused a fetch
   * (a 401 or 403) and the session, asked once, says so: a passing refusal must not
   * cost you a new authorisation at the bank.
   */
  private async failure(tool: string, account: string | null, error: unknown, client: EnableBankingClient): Promise<Reauthorize> {
    if (error instanceof EnableBankingError) {
      const over = error.code !== null && SESSION_OVER.has(error.code);
      const refused = error.status === 401 || error.status === 403 || (error.code !== null && REFUSED.has(error.code));
      if (over || (refused && (await this.sessionEnded(client)))) {
        const session = this.session();
        if (session && !session.invalid_since) this.saveSession({ ...session, invalid_since: new Date(this.now()).toISOString() });
        this.audit(tool, account, "reauthorization-required");
        return { reauthorization_required: true, message: REAUTHORIZE };
      }
      if (refused) {
        this.audit(tool, account, `refused-${error.status}-consent-holds`);
        throw new BankError(503, `the bank refused this fetch for now (${error.status}${error.code ? ` ${error.code}` : ""}); the consent still holds: try again later`);
      }
    }
    this.audit(tool, account, error instanceof EnableBankingError ? `error-${error.status}` : "error");
    if (error instanceof BankError) throw error;
    if (error instanceof EnableBankingError) throw new BankError(502, `the bank couldn't answer (${error.status}${error.code ? ` ${error.code}` : ""})`);
    throw new BankError(502, "the bank couldn't be reached");
  }

  /** Asked once, after a refused fetch: whether the session itself says the consent is over. */
  private async sessionEnded(client: EnableBankingClient): Promise<boolean> {
    const session = this.session();
    if (!session) return true;
    try {
      const answer = await client.getSession(session.session_id);
      const status = typeof answer?.status === "string" ? answer.status.toUpperCase() : null;
      const until = answer?.access?.valid_until;
      return (status !== null && SESSION_ENDED.has(status)) || (typeof until === "string" && Date.parse(until) <= this.now());
    } catch (error) {
      // The session is gone, or can't be asked just now (which proves nothing).
      return error instanceof EnableBankingError && (error.status === 404 || (error.code !== null && SESSION_OVER.has(error.code)));
    }
  }

  private allowed(session: Session, account: string): void {
    if (!session.accounts.some((a) => a.uid === account)) throw new BankError(403, "that account isn't one of the accounts you authorised (bank_accounts lists them)");
  }

  private wrap<T>(data: T, source: "cache" | "live", at: number | null, note?: string): UntrustedBankData<T> {
    return { untrusted_data: true, notice: UNTRUSTED_NOTICE, source, fetched_at: at === null ? null : new Date(at).toISOString(), ...(note ? { note } : {}), data };
  }

  /* ---------- what agents may read (bank:read) ---------- */

  status(): BankStatusView {
    const problem = this.problem();
    let config: BankConfig | null = null;
    try {
      config = this.config();
    } catch {
      config = null;
    }
    const session = problem ? null : this.session();
    const now = this.now();
    const validUntil = session?.valid_until ?? null;
    const expired = !session || !!session.invalid_since || (validUntil !== null && Date.parse(validUntil) <= now);
    const accounts: BankAccountView[] = (session?.accounts ?? []).map((a) => ({ uid: a.uid, name: a.name ?? "", iban: maskIban(a.iban), currency: a.currency }));
    const budget =
      session && config
        ? session.accounts.map((a) => {
            const newest = this.cache().query<{ at: number | null }, [string]>("SELECT MAX(fetched_at) AS at FROM cache WHERE account = ?").get(a.uid)?.at ?? null;
            const cooling = this.coolingUntil(a.uid);
            return { account: a.uid, remaining: this.remaining(a.uid, config!.budgetPerDay), perDay: config!.budgetPerDay, cacheAgeSeconds: newest === null ? null : Math.round((now - newest) / 1000), coolingDownUntil: cooling ? new Date(cooling).toISOString() : null };
          })
        : [];
    return {
      configured: !!config,
      problem,
      aspsp: session?.aspsp ?? config?.aspsp ?? null,
      accounts,
      validUntil,
      daysRemaining: validUntil && !expired ? Math.max(0, Math.ceil((Date.parse(validUntil) - now) / DAY_MS)) : null,
      reauthorizationRequired: !problem && expired,
      budget,
      message: problem ? `Bank access is off: ${problem}` : expired ? REAUTHORIZE : `Connected to ${session!.aspsp} until ${validUntil!.slice(0, 10)}.`,
    };
  }

  accounts(): { accounts: BankAccountView[] } | Reauthorize {
    this.ready();
    const session = this.connected();
    if ("reauthorization_required" in session) return session;
    this.audit("bank_accounts", null, "ok");
    return { accounts: session.accounts.map((a) => ({ uid: a.uid, name: cleanText(a.name, 60) ?? "", iban: maskIban(a.iban), currency: a.currency })) };
  }

  async balances(input: { account: string; refresh?: boolean }): Promise<UntrustedBankData<BalanceOut[]> | Reauthorize> {
    const { config, client } = this.ready();
    const session = this.connected();
    if ("reauthorization_required" in session) return session;
    this.allowed(session, input.account);
    const key = `balances:${input.account}`;
    const hit = this.cached<BalanceOut[]>(key);
    if (hit && !input.refresh && this.now() - hit.at < BALANCES_TTL_MS) {
      this.audit("bank_balances", input.account, "cache");
      return this.wrap(hit.body, "cache", hit.at);
    }
    const blocked = this.blocked(input.account, config, 1);
    if (blocked) {
      this.audit("bank_balances", input.account, "budget");
      return hit ? this.wrap(hit.body, "cache", hit.at, blocked) : this.wrap([], "cache", null, `${blocked} Nothing is cached for this account yet.`);
    }
    try {
      this.spend(input.account);
      const answer = await client.balances(input.account);
      const shaped = shapeBalances(Array.isArray(answer?.balances) ? answer.balances : []);
      const at = this.now();
      this.store(key, input.account, shaped, at);
      this.audit("bank_balances", input.account, "live");
      return this.wrap(shaped, "live", at);
    } catch (error) {
      return this.rateLimited(error, input.account, "bank_balances", hit) ?? (await this.failure("bank_balances", input.account, error, client));
    }
  }

  async transactions(input: { account: string; from: string; to: string; refresh?: boolean }): Promise<UntrustedBankData<TransactionOut[]> | Reauthorize> {
    const { config, client } = this.ready();
    const session = this.connected();
    if ("reauthorization_required" in session) return session;
    this.allowed(session, input.account);
    const from = Date.parse(`${input.from}T00:00:00Z`);
    const to = Date.parse(`${input.to}T00:00:00Z`);
    if (from > to) throw new BankError(400, "from is after to");
    if (input.from > isoDay(this.now())) throw new BankError(400, "from is in the future");
    if ((to - from) / DAY_MS > MAX_RANGE_DAYS) throw new BankError(400, `at most ${MAX_RANGE_DAYS} days at a time`);
    const key = `transactions:${input.account}:${input.from}:${input.to}`;
    // The freshest of what's cached: this exact range, or a wider one that covers it (a stale
    // copy of the exact range must not hide a fresh wider one and cost a fetch from the bank).
    const exact = this.cached<TransactionOut[]>(key);
    const wider = this.covering(input.account, input.from, input.to);
    const hit = exact && (!wider || exact.at >= wider.at) ? exact : (wider ?? exact);
    if (hit && !input.refresh && this.now() - hit.at < TRANSACTIONS_TTL_MS) {
      this.audit("bank_transactions", input.account, "cache");
      return this.wrap(hit.body, "cache", hit.at);
    }
    const blocked = this.blocked(input.account, config, 1);
    if (blocked) {
      this.audit("bank_transactions", input.account, "budget");
      return hit ? this.wrap(hit.body, "cache", hit.at, blocked) : this.wrap([], "cache", null, `${blocked} Nothing is cached for this range yet.`);
    }
    const out: TransactionOut[] = [];
    let continuation: string | undefined;
    let pages = 0;
    let note: string | undefined;
    try {
      do {
        // Each page is a fetch from the bank: it counts, and the budget can end the walk.
        if (pages > 0 && this.remaining(input.account, config.budgetPerDay) < 1) {
          note = "Only part of this range: the day's budget for background fetches ran out. Ask again later for the rest.";
          break;
        }
        this.spend(input.account);
        const page = await client.transactions(input.account, { date_from: input.from, date_to: input.to, ...(continuation ? { continuation_key: continuation } : {}) });
        out.push(...shapeTransactions(Array.isArray(page?.transactions) ? page.transactions : []));
        continuation = typeof page?.continuation_key === "string" && page.continuation_key ? page.continuation_key : undefined;
        pages += 1;
      } while (continuation && pages < MAX_PAGES);
      if (continuation && pages >= MAX_PAGES) note = `Only the first ${MAX_PAGES} pages: narrow the range for the rest.`;
    } catch (error) {
      return this.rateLimited(error, input.account, "bank_transactions", hit) ?? (await this.failure("bank_transactions", input.account, error, client));
    }
    const at = this.now();
    if (!note) this.store(key, input.account, out, at);
    this.audit("bank_transactions", input.account, note ? "live-partial" : "live");
    return this.wrap(out, "live", at, note);
  }

  /** The freshest fetched range that covers this one, cut to it: a range inside it never asks the bank again. */
  private covering(account: string, from: string, to: string): { at: number; body: TransactionOut[] } | null {
    const rows = this.cache()
      .query<{ key: string; fetched_at: number; body: string }, [string]>("SELECT key, fetched_at, body FROM cache WHERE account = ? AND key LIKE 'transactions:%' ORDER BY fetched_at DESC")
      .all(account);
    for (const row of rows) {
      const [, , cachedFrom, cachedTo] = row.key.split(":");
      if (!cachedFrom || !cachedTo || cachedFrom > from || cachedTo < to) continue;
      const within = (JSON.parse(row.body) as TransactionOut[]).filter((t) => {
        const day = t.booking_date ?? t.value_date;
        // Undated ones (pending) belong to the end of the range they came with.
        return day ? day >= from && day <= to : to >= cachedTo;
      });
      return { at: row.fetched_at, body: within };
    }
    return null;
  }

  /** Why a live fetch can't happen now (cooling down after a 429, or no budget left), or null. */
  private blocked(account: string, config: BankConfig, need: number): string | null {
    const cooling = this.coolingUntil(account);
    if (cooling) return `The bank limited background fetches; not asking again before ${new Date(cooling).toISOString()}. Showing the cache.`;
    if (this.remaining(account, config.budgetPerDay) < need) return `The budget of ${config.budgetPerDay} background fetches per account per 24 hours is exhausted. Showing the cache.`;
    return null;
  }

  /** A 429: no retry; cool down, and serve what's cached. */
  private rateLimited<T>(error: unknown, account: string, tool: string, hit: { at: number; body: T } | null): UntrustedBankData<T> | null {
    if (!(error instanceof EnableBankingError) || (error.status !== 429 && error.code !== "ASPSP_RATE_LIMIT_EXCEEDED")) return null;
    this.cache().query("INSERT INTO cooldown (account, until) VALUES (?, ?) ON CONFLICT (account) DO UPDATE SET until = excluded.until").run(account, this.now() + COOLDOWN_MS);
    this.audit(tool, account, "rate-limited");
    const note = "The bank refused: too many background fetches. Not asking again for 6 hours; showing the cache.";
    return hit ? this.wrap(hit.body, "cache", hit.at, note) : this.wrap([] as unknown as T, "cache", null, `${note} Nothing is cached yet.`);
  }

  /* ---------- authorising: yours alone (fleet:admin) ---------- */

  async connect(): Promise<{ url: string; aspsp: string; validUntil: string }> {
    const { config, client } = this.ready();
    const { aspsps } = await client.aspsps(config.country).catch((error) => {
      throw new BankError(502, `couldn't list the banks: ${error instanceof EnableBankingError ? error.message : "Enable Banking unreachable"}`);
    });
    const exact = aspsps.find((a) => a.name === config.aspsp) ?? aspsps.find((a) => a.name.toLowerCase() === config.aspsp.toLowerCase());
    if (!exact) {
      const near = aspsps.filter((a) => a.name.toLowerCase().includes(config.aspsp.toLowerCase().slice(0, 4))).map((a) => a.name);
      throw new BankError(404, `no bank named ${config.aspsp} in ${config.country}${near.length ? ` (close: ${near.slice(0, 5).join(", ")})` : ""}`);
    }
    // 89 days, or what the bank allows if that's less (with an hour's margin).
    const wanted = config.consentDays * DAY_MS;
    const bankMax = typeof exact.maximum_consent_validity === "number" && exact.maximum_consent_validity > 0 ? exact.maximum_consent_validity * 1000 - 60 * 60_000 : wanted;
    const validUntil = new Date(this.now() + Math.min(wanted, bankMax)).toISOString();
    const state = randomBytes(32).toString("base64url");
    const { url } = await client
      .startAuthorization({ validUntil, aspsp: { name: exact.name, country: config.country }, state, redirectUrl: config.redirectUrl, psuType: "personal" })
      .catch((error) => {
        throw new BankError(502, `the bank didn't start authorisation: ${error instanceof EnableBankingError ? error.message : "Enable Banking unreachable"}`);
      });
    if (typeof url !== "string" || !/^https:\/\//.test(url)) throw new BankError(502, "the bank's authorisation URL isn't https");
    this.ensureDir();
    rmSync(this.path("pending.json"), { force: true });
    writePrivate(this.path("pending.json"), JSON.stringify({ state: sha256(state).toString("hex"), expires: this.now() + PENDING_TTL_MS, valid_until: validUntil }));
    this.audit("bank_connect", null, "started");
    return { url, aspsp: exact.name, validUntil };
  }

  async complete(input: { code: string; state: string }): Promise<{ accounts: number; ibans: string[]; validUntil: string }> {
    const { client } = this.ready();
    const pendingPath = this.path("pending.json");
    if (!existsSync(pendingPath)) throw new BankError(409, "no authorisation is under way: start again (Bank → Connect)");
    const pending = JSON.parse(readFileSync(pendingPath, "utf8")) as { state: string; expires: number; valid_until?: string };
    // One attempt per authorisation, matching or not.
    rmSync(pendingPath, { force: true });
    if (pending.expires < this.now()) throw new BankError(410, "that authorisation took too long (15 minutes): start again");
    const expected = Buffer.from(pending.state, "hex");
    const given = sha256(input.state);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      this.audit("bank_complete", null, "state-mismatch");
      throw new BankError(400, "the callback's state doesn't match the authorisation that was started: refused");
    }
    let created: Awaited<ReturnType<EnableBankingClient["createSession"]>>;
    try {
      created = await client.createSession(input.code);
    } catch (error) {
      this.audit("bank_complete", null, "error");
      throw new BankError(502, `the bank didn't confirm the authorisation${error instanceof EnableBankingError ? ` (${error.status}${error.code ? ` ${error.code}` : ""})` : ""}`);
    }
    const accounts = (created.accounts ?? []).filter((a) => typeof a?.uid === "string" && /^[A-Za-z0-9-]{8,64}$/.test(a.uid));
    if (!accounts.length) {
      this.audit("bank_complete", null, "no-accounts");
      throw new BankError(422, "the bank returned no accounts: a restricted production app sees only the accounts linked to it in Enable Banking's Control Panel");
    }
    // What the bank granted; if it doesn't say, what was asked for (never assumed longer).
    const validUntil = typeof created.access?.valid_until === "string" && !Number.isNaN(Date.parse(created.access.valid_until)) ? created.access.valid_until : (pending.valid_until ?? new Date(this.now()).toISOString());
    this.saveSession({
      session_id: created.session_id,
      aspsp: created.aspsp?.name ?? "the bank",
      accounts: accounts.map((a) => ({ uid: a.uid, name: cleanText(a.name, 60), iban: typeof a.account_id?.iban === "string" ? a.account_id.iban : null, currency: typeof a.currency === "string" && /^[A-Z]{3}$/.test(a.currency) ? a.currency : null })),
      valid_until: validUntil,
      created_at: new Date(this.now()).toISOString(),
    });
    // A new consent starts a new day's worth of cached data.
    this.cache().exec("DELETE FROM cache; DELETE FROM cooldown;");
    this.audit("bank_complete", null, `ok-${accounts.length}`);
    return { accounts: accounts.length, ibans: accounts.map((a) => maskIban(a.account_id?.iban) ?? "(no IBAN)"), validUntil };
  }

  async disconnect(): Promise<{ ended: boolean }> {
    let session: Session | null = null;
    try {
      session = this.session();
    } catch {
      session = null; // a broken file is forgotten like any other
    }
    let ended = false;
    if (session && !this.problem()) {
      try {
        await this.ready().client.deleteSession(session.session_id);
        ended = true;
      } catch {
        ended = false;
      }
    }
    rmSync(this.path("session.json"), { force: true });
    rmSync(this.path("pending.json"), { force: true });
    if (this.db || existsSync(this.path("cache.db"))) this.cache().exec("DELETE FROM cache; DELETE FROM calls; DELETE FROM cooldown;");
    this.audit("bank_disconnect", null, ended ? "ended" : "forgotten");
    return { ended };
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}
