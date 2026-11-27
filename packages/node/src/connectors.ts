import type { Database } from "bun:sqlite";
import {
  type ActionView,
  approvalSendBy,
  argStrings,
  type ArgValue,
  type BuiltRequest,
  buildCall,
  buildMcpCall,
  ConnectorArgs,
  ConnectorError,
  ConnectorManifest,
  type ConnectorRequest,
  type ConnectorToolDefinition,
  decide,
  decodeHlc,
  findSecrets,
  isMcpTool,
  MAX_CLOCK_DRIFT_MS,
  MAIL_SENDS,
  MAX_ORDER_DAYS,
  mayCall,
  type NativeName,
  type NodeIdentity,
  orderCovers,
  orderProblems,
  type OrderTerms,
  type OrderView,
  type GitHubFacts,
  givenRepository,
  heldClass,
  judgedBranch,
  type OwnCall,
  ownApproval,
  primaryCaller,
  randomId,
  redact,
  sendCovered,
  supposedFacts,
  toolDigest,
} from "@invincible/core";
import {
  callMcpTool,
  type ConnectorResult,
  describeMcpTool,
  discoverMcpTools,
  excerpt,
  fitMcpTools,
  privateConnector,
  publicIds,
  installedConnector,
  keyState,
  type MergeReport,
  mergeMcpTools,
  type OAuthEndpoints,
  sendConnectorRequest,
  sized,
} from "@invincible/models";
import type { LedgerStore, Vault } from "@invincible/ledger";
import type { LedgerEntryInput } from "@invincible/sandbox";

/*
 * Connector calls, through approvals:
 *
 *   read, create, modify   run now, ledgered
 *   outward, delete        you asking = the approval: run now, ledgered as approved
 *                          an agent asking (arm, loop, run): an action request in your
 *                          inbox; nothing is sent until you approve it
 *
 * Approved actions leave through an outbox. The node that filed the request is the
 * only one that sends it, it marks the send in local storage before the request
 * goes out, and writes the receipt to the mind afterwards. A crash in between is
 * reported as "outcome unknown", never retried: an approval sends at most once.
 *
 * A standing order is your answer given in advance. An agent's call that one covers
 * is still filed as an action (so you see it), answered by the order on the spot,
 * and sent through the same outbox. So is one that is the primary's own to approve (your
 * word, 23 November 2026: policy.ts ownApproval): its, or its agents' or loops', and
 * none of monetary, legal or destructive; it is answered as its, and says so.
 */

/** Who calls: you, or an agent; `yours` is an agent's call made on your word (you tapped Ship it), which you approve, never it. */
export type Caller = { kind: "owner"; device: string } | { kind: "agent"; by: string; run?: string; yours?: true };

export type CallOutcome =
  | { status: "done"; class: string; target: string; result: ConnectorResult; order?: { id: string; label: string }; own?: string; action?: string; private?: true }
  | { status: "asked"; action: string; class: string; target: string; expires: number };

type StoredOrder = OrderTerms & { id: string; revoked: boolean; signedHlc: string; via?: string };
const DAY_MS = 24 * 60 * 60_000;

export class ConnectorCallError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A native tool (see NATIVE_TOOLS): carried out by the node, its requests sent through
 * `send`, which holds the connector's pinned origin and key.
 */
export type NativeTool = (manifest: ConnectorManifest, args: Record<string, ArgValue>, send: (request: BuiltRequest) => Promise<ConnectorResult>) => Promise<ConnectorResult>;

export interface ConnectorServiceOptions {
  store: LedgerStore;
  vault: Vault;
  identity: NodeIdentity;
  local: Database;
  ledger: (entry: LedgerEntryInput) => void;
  log: (message: string) => void;
  fetch?: typeof fetch;
  now?: () => number;
  /** The native tools this node can carry out (a call to another is refused). */
  natives?: Partial<Record<NativeName, NativeTool>>;
  /** The repositories you gave your agents (as you gave them): its and their work there is its to approve (ownApproval). Absent: none. */
  repositories?: () => readonly string[];
  /** What a kept shipment changes and the commit it is built on (its ship/manifest.json), so a push is known before it
   * could be its own to approve. Null, or absent: not known, and such a push is yours. */
  shipment?: (artifact: string) => { files: readonly string[]; base: string } | null;
  /** Where Google's and Microsoft's sign-ins are reached (tests: a stand-in). */
  oauthEndpoints?: Partial<OAuthEndpoints>;
  /**
   * Where a question an MCP server asks in the middle of a call goes (questions.ts: your Inbox), and its answer back.
   * Absent: its calls take none, and a server asks nothing.
   */
  ask?: (connector: { id: string; label: string }, params: { message?: unknown; requestedSchema?: unknown }, signal?: AbortSignal) => Promise<{ action: "accept" | "decline" | "cancel"; content?: Record<string, string | number | boolean | string[]> }>;
}

/** How long an action waits for you. No answer means no. */
export const ACTION_TTL_MS = 24 * 60 * 60_000;
/** GitHub's API; whose a key is, it says once in this long (said or not) for each version of the key, and is asked again
 * after. Everything else it is asked afresh before each act: a repository renamed, transferred or made public, a thread's,
 * a branch moved, are said at once. */
const GITHUB_API = "https://api.github.com";
const FACTS_MS = 10 * 60_000;
/** What GitHub says, read as it gives it: a person's account (never an organization's or an app's), a repository, a
 * thread, a branch's head. */
const readUser = (b: any): GitHubFacts["user"] | null => (b?.type === "User" && Number.isSafeInteger(b.id) && b.id > 0 ? { id: b.id } : null);
const readRepo = (b: any): GitHubFacts["repo"] | null =>
  typeof b?.full_name === "string" && typeof b.private === "boolean" && typeof b.fork === "boolean" && Number.isSafeInteger(b.owner?.id) && typeof b.owner?.type === "string"
    ? { name: b.full_name, private: b.private, fork: b.fork, ownerId: b.owner.id, ownerType: b.owner.type, ...(typeof b.default_branch === "string" ? { defaultBranch: b.default_branch } : {}) }
    : null;
const readThread = (b: any): GitHubFacts["thread"] | null => (Number.isSafeInteger(b?.number) && Number.isSafeInteger(b.user?.id) ? { number: b.number, authorId: b.user.id } : null);
/** A branch's head, from GitHub's ref for it: facts of another ref, or of no commit, are none. */
const readHead =
  (branch: string) =>
  (b: any): GitHubFacts["head"] | null =>
    b?.ref === `refs/heads/${branch}` && b.object?.type === "commit" && typeof b.object.sha === "string" && /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(b.object.sha) ? { branch, sha: b.object.sha } : null;
/** A ref's path segment by segment, as GitHub's git/ref route takes a branch with slashes. */
const refPath = (branch: string) => branch.split("/").map(encodeURIComponent).join("/");
/** The commit a done shipment's or fix's receipt says it pushed, whole ("… commit <40 hex, or 64> …"): a receipt that
 * names fewer digits names no commit of its (one written before receipts named them whole). */
const PUSHED_COMMIT = /\bcommit ([0-9a-f]{64}|[0-9a-f]{40})\b/;

/** The primary's own callers, whose calls it may approve itself (core's policy.ts primaryCaller, the rule every replica holds it to). */
const isHis = primaryCaller;

export class ConnectorService {
  private readonly now: () => number;
  private draining: Promise<void> | null = null;
  /** Sends under way in this process; an outbox row marked "sending" that isn't here is a crash. */
  private readonly inFlight = new Set<string>();
  /** Said once in the log while this node's clock reads behind what it holds (clockGoneBack). */
  private clockWarned = false;

  constructor(private readonly o: ConnectorServiceOptions) {
    this.now = o.now ?? Date.now;
    o.local.exec("CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, state TEXT NOT NULL, at INTEGER NOT NULL)");
  }

  /** Whose each key is, as GitHub said it, by connector and key version: kept FACTS_MS, said or not. */
  private readonly githubSaid = new Map<string, { at: number; value: unknown }>();

  /**
   * GitHub's answer to a fixed read of its own (never a tool of the manifest's), with the connector's key at its pinned
   * origin, null when it didn't say; each one asked is said in the ledger. Asked afresh each time, but for whose the key
   * is (`keep`), which is kept FACTS_MS for this connector and this version of its key.
   */
  private async githubRead<T>(manifest: ConnectorManifest, path: string, read: (body: unknown) => T | null, keep = false): Promise<T | null> {
    const secret = manifest.auth?.secret;
    const info = secret ? this.o.vault.info(secret) : null;
    if (manifest.origin !== GITHUB_API || !secret || !info) return null;
    const key = JSON.stringify([manifest.id, secret, info.hlc, path]);
    const kept = keep ? this.githubSaid.get(key) : undefined;
    if (kept && this.now() - kept.at < FACTS_MS) return kept.value as T | null;
    let value: T | null = null;
    try {
      const result = await this.send(manifest, { kind: "http", method: "GET", url: `${GITHUB_API}${path}`, headers: { ...(manifest.headers ?? {}) }, class: "read", target: `GET ${path}` });
      value = result.ok ? read(JSON.parse(result.body)) : null;
    } catch (error) {
      this.o.log(`${manifest.label}: GET ${path} wasn't said (${(error as Error).message})`);
    }
    if (keep) this.githubSaid.set(key, { at: this.now(), value });
    this.o.ledger({ class: "read", resource: `connector.${manifest.id}`, target: `GET ${path}`, verdict: "allow", reason: "what GitHub says of your key, a repository, a thread or a branch, before your agent may answer its own call there", detail: value === null ? "not said: nothing there is its to approve" : JSON.stringify(value) });
    return value;
  }

  /**
   * What GitHub says of a call that could be its own (GitHubFacts), asked of what the call needs and nothing more: whose
   * your key is (for who opened a thread, and whose a repository is), the repository the call names (whose it is, its
   * default branch), the issue or pull request its words go on, and where the branch it is judged on stands. `given`: the
   * repository is one you gave an agent, where only its threads and its branches are asked of.
   */
  private async githubFacts(manifest: ConnectorManifest, call: OwnCall, given: boolean): Promise<GitHubFacts> {
    const { owner, repo, number } = call.args;
    if (typeof owner !== "string" || typeof repo !== "string") return {};
    const at = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const onThread = call.native === undefined && typeof number === "number";
    const facts: GitHubFacts = {};
    if (!given || onThread) {
      const user = await this.githubRead(manifest, "/user", readUser, true);
      if (!user) return {};
      facts.user = user;
    }
    // Its default branch, for a shipment or a pull request into it (a template judged on a branch is one); and outside the
    // repositories you gave an agent, whether it is yours: nothing more is asked of one that isn't.
    const intoDefault = call.native === "github.ship" || (call.native === undefined && judgedBranch(call, undefined) !== undefined);
    if (!given || intoDefault) {
      const named = await this.githubRead(manifest, at, readRepo);
      if (!named) return facts;
      facts.repo = named;
      if (!given && !(named.private && !named.fork && named.ownerType === "User" && named.ownerId === facts.user!.id)) return facts;
    }
    if (onThread) {
      const thread = await this.githubRead(manifest, `${at}/issues/${number}`, readThread);
      if (thread) facts.thread = thread;
    }
    const branch = judgedBranch(call, facts.repo?.defaultBranch);
    if (branch !== undefined) {
      const head = await this.githubRead(manifest, `${at}/git/ref/heads/${refPath(branch)}`, readHead(branch));
      if (head) facts.head = head;
    }
    return facts;
  }

  /**
   * The commit your agent last pushed onto a branch: the latest of its done shipments and fixes there, as each one's
   * receipt says it, whole. Undefined: it never pushed there, so the branch isn't one it shipped.
   */
  private lastPushed(owner: string, repo: string, branch: string): string | undefined {
    const pushes = new Map<string, boolean>();
    const pushesWith = (connector: string, tool: string) => {
      const key = `${connector}\u0000${tool}`;
      if (!pushes.has(key)) {
        const definition = installedConnector(this.o.store, connector)?.tools[tool];
        pushes.set(key, !!definition && !isMcpTool(definition) && (definition.native === "github.ship" || definition.native === "github.ship.update"));
      }
      return pushes.get(key)!;
    };
    let last: { hlc: string; sha: string } | undefined;
    for (const entry of this.o.store.lwwPrefix<{ id: string; connector: string; tool: string; args: Record<string, unknown> }>("action:")) {
      const asked = entry.value;
      if (asked?.args?.branch !== branch || String(asked.args.owner).toLowerCase() !== owner.toLowerCase() || String(asked.args.repo).toLowerCase() !== repo.toLowerCase()) continue;
      if (!pushesWith(asked.connector, asked.tool)) continue;
      const done = this.o.store.lww<{ ok: boolean; receipt: string }>(`action-done:${asked.id}`);
      const sha = done?.value?.ok ? PUSHED_COMMIT.exec(String(done.value.receipt))?.[1] : undefined;
      if (sha && (!last || done!.hlc > last.hlc)) last = { hlc: done!.hlc, sha };
    }
    return last?.sha;
  }

  /**
   * Whether an agent's call is its own to approve, and why (ownApproval), judged before it is filed: nothing awaits
   * between filing it and its own yes, so your answer never meets it half made. What a push changes and is built on is
   * read from its kept shipment, and the commit it last pushed onto a branch from the log; GitHub is asked only of a call
   * that could be its own were GitHub to say so, and only what that call needs.
   */
  private async ownAnswer(manifest: ConnectorManifest, name: string, cls: ConnectorRequest["class"], args: Record<string, ArgValue>, caller: Extract<Caller, { kind: "agent" }>): Promise<string | null> {
    const tool = Object.hasOwn(manifest.tools, name) ? manifest.tools[name] : undefined;
    if (!tool || isMcpTool(tool) || !isHis(caller.by) || caller.yours) return null;
    const pushes = tool.native === "github.ship" || tool.native === "github.ship.update";
    const shipment = pushes && typeof args.artifact === "string" ? (this.o.shipment?.(args.artifact) ?? null) : null;
    // A merge lands every push this node sent onto the pull request's branch: their files, from their kept shipments.
    const merged = tool.native === "github.merge" ? this.pulledFiles(args.owner, args.repo, args.number) : undefined;
    const call: OwnCall = { class: cls, origin: manifest.origin, ...(tool.native ? { native: tool.native } : {}), method: tool.method, path: tool.path, args, by: caller.by, ...(shipment ? { changes: shipment.files, base: shipment.base } : merged ? { changes: merged } : {}) };
    // A fix's own branch, a pull request's head: what it last pushed there.
    const onto = tool.native === "github.ship" ? undefined : judgedBranch(call, undefined);
    if (onto !== undefined && typeof args.owner === "string" && typeof args.repo === "string") {
      const pushed = this.lastPushed(args.owner, args.repo, onto);
      if (pushed) call.pushed = pushed;
    }
    const repositories = this.o.repositories?.() ?? [];
    // Its own with nothing of GitHub said (an issue in a repository you gave an agent), or not its own whatever it says.
    const now = ownApproval(call, repositories);
    if (now) return now;
    if (ownApproval(call, repositories, supposedFacts(call)) === null) return null;
    return ownApproval(call, repositories, await this.githubFacts(manifest, call, givenRepository(call, repositories)));
  }

  /**
   * What a pull request this node shipped changes, as a merge of it would land it: the files of each push it sent there
   * (its ship, and every fix since onto its branch), from their kept shipments. Undefined when this node shipped no such
   * pull request, or a push's files can't be read: then such a merge is yours.
   */
  private pulledFiles(owner: unknown, repo: unknown, number: unknown): readonly string[] | undefined {
    if (typeof owner !== "string" || typeof repo !== "string" || typeof number !== "number") return undefined;
    const there = (a: ActionView) => String(a.args.owner).toLowerCase() === owner.toLowerCase() && String(a.args.repo).toLowerCase() === repo.toLowerCase();
    const pushed = this.actions(10_000).filter((a) => a.state === "done" && a.node === this.o.identity.id && (a.tool === "ship" || a.tool === "ship.update") && there(a));
    // (A receipt opens with the status GitHub answered: "201 pull request #7: …".)
    const ship = pushed.find((a) => a.tool === "ship" && new RegExp(`^(\\d{3} )?pull request #${number}:`).test(a.receipt ?? ""));
    if (!ship) return undefined;
    const files = new Set<string>();
    for (const push of pushed.filter((a) => a.args.branch === ship.args.branch)) {
      const kept = typeof push.args.artifact === "string" ? this.o.shipment?.(push.args.artifact) : null;
      if (!kept) return undefined;
      for (const file of kept.files) files.add(file);
    }
    return [...files];
  }

  private manifest(id: string): ConnectorManifest {
    const manifest = installedConnector(this.o.store, id);
    if (!manifest) throw new ConnectorCallError(404, `no connector "${id}" is installed (invincible connector add ${id})`);
    return manifest;
  }

  /** Whether a connector's answers are your private data (PRIVATE_CONNECTORS, or its manifest says so), installed or not. */
  isPrivate(id: string): boolean {
    return privateConnector(id, installedConnector(this.o.store, id));
  }

  /** What a call's line in the ledger names it by: its request, or a private connector's tool alone (no path, no word of its arguments). */
  private said(connector: string, tool: string, target: string): string {
    return this.isPrivate(connector) ? `${connector}.${tool}` : target;
  }

  async call(input: { connector: string; tool: string; args?: Record<string, ArgValue>; why?: string }, caller: Caller): Promise<CallOutcome> {
    const manifest = this.manifest(input.connector);
    // One that's the primary's alone (mail): it, you, your loops and runs, and the agents you allowed; any other asks first.
    if (caller.kind === "agent" && !mayCall(manifest.access, caller.by)) {
      throw new ConnectorCallError(403, `${manifest.label} is your agent's alone: ask the owner to let you use it (connector_request), and use it once they do`);
    }
    const args = ConnectorArgs.parse(input.args ?? {});
    // Arguments leave this machine (and approvals replicate in plaintext): no keys in them, however deep. The service's
    // own ids aren't keys (a Drive file's, an Outlook message's), where the catalog says what they look like.
    const ids = publicIds(manifest);
    if (argStrings(args).some((text) => findSecrets(text, ids ? { isPublic: ids } : {}).length)) {
      throw new ConnectorCallError(422, "an argument looks like a credential; connectors take keys from the vault, never from arguments");
    }
    let request: ConnectorRequest;
    try {
      request = buildCall(manifest, input.tool, args);
    } catch (error) {
      throw new ConnectorCallError(400, (error as Error).message);
    }
    const resource = `connector.${manifest.id}`;
    const run = caller.kind === "agent" ? caller.run : undefined;
    const decision = decide({ class: request.class, resource, target: request.target, ...(run ? { run } : {}) });
    if (decision.verdict === "deny") throw new ConnectorCallError(403, decision.reason);

    if (decision.verdict === "ask" && caller.kind === "agent") {
      const id = `a_${randomId(16)}`;
      const expires = this.now() + ACTION_TTL_MS;
      const digest = toolDigest(manifest, input.tool);
      // Whether it is its own, judged before it is filed (ownAnswer); and whether an order of yours covers it, as your
      // orders stand once that is known. From here to its answer nothing awaits.
      const own = await this.ownAnswer(manifest, input.tool, request.class, args, caller);
      const defined = manifest.tools[input.tool];
      const native = defined && !isMcpTool(defined) ? defined.native : undefined;
      // A send of mail goes only where its order names, from now on here (sendCovered), whatever the date the replicas
      // read it by: what this node applies is so on every replica, before SENDS_NAME_RECIPIENTS_FROM and after.
      const order = this.activeOrders().find(
        (o) => orderCovers(o, { connector: manifest.id, tool: input.tool, class: request.class, args, by: caller.by, digest, ...(native ? { native } : {}) }, this.now()) && (native === undefined || !MAIL_SENDS.has(native) || sendCovered(o, args)),
      );
      this.o.store.emit(this.o.identity, "action.requested", {
        id,
        connector: manifest.id,
        tool: input.tool,
        args,
        class: request.class,
        target: request.target,
        by: caller.by,
        ...(input.why ? { why: redact(input.why).slice(0, 500) } : {}),
        expires,
      });
      if (order) {
        try {
          this.o.store.emit(this.o.identity, "order.applied", { order: order.id, action: id });
        } catch (error) {
          this.o.log(`order ${order.id} not applied to ${id}: ${(error as Error).message}`);
        }
        const filed = this.actions(10_000).find((a) => a.id === id);
        if (filed?.state === "approved") {
          const sent = await this.sendApproved(filed, `under your standing order "${order.label}"`);
          if (!sent.result) throw new ConnectorCallError(sent.status ?? 502, sent.receipt);
          return { status: "done", class: request.class, target: request.target, result: sent.result, order: { id: order.id, label: order.label }, action: id };
        }
      }
      if (own) {
        this.o.store.emit(this.o.identity, "action.decided", { id, verdict: "approved", note: `Your agent approved it itself: ${own}`.slice(0, 500) }, { trust: "agent" });
        const filed = this.actions(10_000).find((a) => a.id === id);
        if (filed?.state === "approved") {
          const sent = await this.sendApproved(filed, `on your agent's own approval: ${own}`);
          if (!sent.result) throw new ConnectorCallError(sent.status ?? 502, sent.receipt);
          return { status: "done", class: request.class, target: request.target, result: sent.result, own, action: id };
        }
      }
      this.o.ledger({ class: request.class, resource, target: this.said(manifest.id, input.tool, request.target), verdict: "ask", reason: decision.reason, run, detail: `action ${id}, asked by ${caller.by}` });
      return { status: "asked", action: id, class: request.class, target: request.target, expires };
    }

    const approved = decision.verdict === "ask"; // the owner asked: that is the approval
    const result = await this.send(manifest, request);
    // What a private connector answered stays in the answer that read it: its line says only how it went, and its size.
    const secret = privateConnector(manifest.id, manifest);
    this.o.ledger({
      class: request.class,
      resource,
      target: this.said(manifest.id, input.tool, request.target),
      verdict: approved ? "approved" : "allow",
      reason: approved ? "you asked for it" : decision.reason,
      run,
      detail: `${caller.kind === "owner" ? "by you" : `by ${caller.by}`} · ${secret ? sized(result) : excerpt(result, 300)}`.slice(0, 2000),
    });
    return { status: "done", class: request.class, target: request.target, result, ...(manifest.private ? { private: true as const } : {}) };
  }

  /**
   * One tool's whole definition, before a call: an MCP server's read from it now (its full description and its nested
   * argument schema, which connectors lists only in short) and held to the pin it was installed with; a template's as
   * installed. Only the connector and the tool go to the server, and the request is a line in the ledger.
   */
  async describe(input: { connector: string; tool: string }, caller: Caller): Promise<ConnectorToolDefinition> {
    const manifest = this.manifest(input.connector);
    if (caller.kind === "agent" && !mayCall(manifest.access, caller.by)) {
      throw new ConnectorCallError(403, `${manifest.label} is your agent's alone: ask the owner to let you use it (connector_request), and use it once they do`);
    }
    const tool = Object.hasOwn(manifest.tools, input.tool) ? manifest.tools[input.tool]! : null;
    if (!tool) throw new ConnectorCallError(404, `${manifest.id} has no tool "${input.tool}" (it has: ${Object.keys(manifest.tools).join(", ") || "none yet"})`);
    const held = isMcpTool(tool) ? tool.class : heldClass(manifest, tool);
    const view = { connector: manifest.id, tool: input.tool, class: held, asks: held === "outward" || held === "delete" };
    if (!isMcpTool(tool)) {
      const properties = Object.fromEntries(Object.entries(tool.params ?? {}).map(([name, p]) => [name, { type: p.type, ...(p.description ? { description: p.description } : {}), ...(p.enum ? { enum: p.enum } : {}), ...(p.pattern ? { pattern: p.pattern } : {}) }]));
      const required = Object.entries(tool.params ?? {}).filter(([name, p]) => p.required || tool.path.includes(`{${name}}`)).map(([name]) => name);
      return { ...view, description: tool.description, input: { type: "object", properties, ...(required.length ? { required } : {}) }, changed: false };
    }
    let live: Awaited<ReturnType<typeof describeMcpTool>>;
    try {
      live = await describeMcpTool({ vault: this.o.vault, ...(this.o.fetch ? { fetch: this.o.fetch } : {}), oauth: { save: this.keepRotated } }, manifest, tool.remote);
    } catch (error) {
      if (error instanceof ConnectorError) throw new ConnectorCallError(424, error.message);
      throw new ConnectorCallError(502, `${manifest.label} unreachable: ${redact(String((error as Error).message ?? error))}`);
    }
    if (!live) throw new ConnectorCallError(404, `${manifest.label} no longer has ${tool.remote}: invincible connector refresh ${manifest.id} lists what it has now`);
    this.o.ledger({ class: "read", resource: `connector.${manifest.id}`, target: `tools/list ${tool.remote}`.slice(0, 256), verdict: "allow", reason: "a tool's whole definition, before a call", detail: caller.kind === "owner" ? "by you" : `by ${caller.by}` });
    const text = live.description.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim();
    const schema = JSON.stringify(live.inputSchema ?? {});
    return {
      ...view,
      description: text.length > 8000 ? `${text.slice(0, 7999)}…` : text,
      input: schema.length > 24_000 ? { note: `its schema is ${schema.length} characters; the first 24,000 follow`, schema: schema.slice(0, 24_000) } : (live.inputSchema ?? {}),
      changed: live.schema !== tool.schema,
    };
  }

  /** One that signs in keeps a rotated sign-in sealed and pinned as before. */
  private readonly keepRotated = (name: string, value: string): void => {
    const info = this.o.vault.info(name);
    this.o.vault.set(name, value, { ...(info?.origin ? { origin: info.origin } : {}), ...(info?.provider ? { provider: info.provider } : {}), ...(info?.label ? { label: info.label } : {}) });
  };

  private async send(manifest: ConnectorManifest, request: ConnectorRequest): Promise<ConnectorResult> {
    try {
      const ctx = { vault: this.o.vault, ...(this.o.fetch ? { fetch: this.o.fetch } : {}), oauth: { save: this.keepRotated, ...(this.o.oauthEndpoints ? { endpoints: this.o.oauthEndpoints } : {}) } };
      if (request.kind === "native") {
        const native = this.o.natives?.[request.native];
        if (!native) throw new ConnectorCallError(501, `${request.native} isn't available on this node`);
        // Whatever a native asks to send goes to the connector's own origin, or nowhere: its key is pinned there.
        const own = new URL(manifest.origin).origin;
        return await native(manifest, request.args, (step) => {
          if (new URL(step.url).origin !== own) throw new ConnectorError(`refusing a request off ${manifest.label}'s origin`);
          return sendConnectorRequest(ctx, manifest, step);
        });
      }
      // An MCP server may ask you a question mid-call: it waits in your Inbox (questions.ts), answered by you alone.
      const ask = this.o.ask;
      if (request.kind === "mcp") return await callMcpTool({ ...ctx, ...(ask ? { elicit: (params, signal) => ask({ id: manifest.id, label: manifest.label }, params, signal) } : {}) }, manifest, request);
      return await sendConnectorRequest(ctx, manifest, request);
    } catch (error) {
      if (error instanceof ConnectorCallError) throw error;
      if (error instanceof ConnectorError) {
        // Missing key: ask for it once, in the vault, never in chat.
        if (manifest.auth && keyState(this.o.vault, manifest) === "missing" && !this.o.vault.requests().some((r) => r.name === manifest.auth!.secret)) {
          try {
            this.o.vault.request(manifest.auth.secret, `The ${manifest.label} connector needs its key (for ${manifest.origin}).`, manifest.id);
          } catch {
            /* a request is a courtesy, not a requirement */
          }
        }
        throw new ConnectorCallError(424, error.message);
      }
      const message = (error as Error).name === "TimeoutError" ? "timed out" : redact(String((error as Error).message ?? error));
      throw new ConnectorCallError(502, `${manifest.label} unreachable: ${message}`);
    }
  }

  actions(limit = 100): ActionView[] {
    const now = this.now();
    return this.o.store
      .lwwPrefix<Record<string, unknown>>("action:")
      .map((entry) => {
        const body = entry.value as {
          id: string;
          connector: string;
          tool: string;
          args: Record<string, unknown>;
          class: string;
          target: string;
          by: string;
          why?: string;
          expires: number;
        };
        const decision = this.o.store.lww<{ verdict: "approved" | "denied"; via?: string; order?: string; note?: string; self?: boolean }>(`action-decision:${body.id}`);
        const orderId = decision?.value?.order;
        const order = orderId ? this.o.store.lww<StoredOrder>(`order:${orderId}`)?.value : null;
        const done = this.o.store.lww<{ ok: boolean; receipt: string }>(`action-done:${body.id}`)?.value ?? null;
        // From recorded times only: the approval's own hlc, the request's own deadline.
        const sendBy = decision?.value?.verdict === "approved" ? approvalSendBy(decodeHlc(decision.hlc).ms, body.expires) : null;
        let state: ActionView["state"];
        if (done) state = done.ok ? "done" : "failed";
        else if (sendBy !== null && now > sendBy) state = "lapsed";
        else if (decision?.value) state = decision.value.verdict;
        else state = body.expires <= now ? "expired" : "waiting";
        return {
          id: body.id,
          connector: body.connector,
          tool: body.tool,
          args: body.args,
          class: body.class,
          target: body.target,
          by: body.by,
          why: body.why ?? null,
          node: entry.device,
          requestedAt: entry.hlc,
          expires: body.expires,
          state,
          sendBy,
          decidedVia: decision?.value?.via ?? decision?.device ?? null,
          order: orderId ? { id: orderId, label: order?.label ?? orderId } : null,
          receipt: done?.receipt ?? null,
          note: decision?.value?.note ?? null,
          self: decision?.value?.self === true,
        };
      })
      .sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1))
      .slice(0, limit);
  }

  /** Your answer to an action request. `via` is the device you answered from; `edits`, your own words in it, with a yes (amend). */
  decide(id: string, approve: boolean, via: string | null, note?: string, edits?: Record<string, string>): ActionView {
    const action = this.actions(10_000).find((a) => a.id === id);
    if (!action) throw new ConnectorCallError(404, "no such action");
    if (action.state === "expired") throw new ConnectorCallError(409, "that request expired unanswered (no answer means no)");
    if (action.state !== "waiting") throw new ConnectorCallError(409, `already ${action.state}`);
    if (edits) {
      if (!approve) throw new ConnectorCallError(400, "an edit goes with a yes: decline it as it is, or edit it and approve");
      return this.amend(action, edits, via, note);
    }
    this.o.store.emit(
      this.o.identity,
      "action.decided",
      { id, verdict: approve ? "approved" : "denied", ...(note ? { note: redact(note).slice(0, 500) } : {}) },
      { trust: "owner", ...(via ? { via } : {}) },
    );
    this.o.ledger({
      class: action.class as LedgerEntryInput["class"],
      resource: `connector.${action.connector}`,
      target: this.said(action.connector, action.tool, action.target),
      verdict: approve ? "approved" : "deny",
      reason: approve ? "you approved it" : "you declined",
      detail: `action ${id}`,
    });
    if (approve) void this.drain();
    return this.actions(10_000).find((a) => a.id === id)!;
  }

  /**
   * Your yes to your own version of a request: text it already has replaced by yours, checked as any call's arguments
   * are (the tool's own terms, no key in them, what the policy allows). Yours is filed anew under the same asker and
   * approved in the same step; the one it was asked as is declined, saying which it became. All in kinds every
   * replica knows, and only for a request this node filed, so the node that sends yours is the one that would have
   * sent the first (one filed elsewhere is edited there).
   */
  private amend(action: ActionView, edits: Record<string, string>, via: string | null, note?: string): ActionView {
    if (action.node !== this.o.identity.id) throw new ConnectorCallError(409, "another node asked for this: edit it from there, or decline it and ask again");
    for (const key of Object.keys(edits)) {
      if (typeof action.args[key] !== "string") throw new ConnectorCallError(400, `only text it already has can be edited, and ${key} isn't`);
    }
    const manifest = this.manifest(action.connector);
    const parsed = ConnectorArgs.safeParse({ ...action.args, ...edits });
    if (!parsed.success) throw new ConnectorCallError(400, parsed.error.issues[0]?.message ?? "those arguments can't be sent");
    const args = parsed.data;
    const ids = publicIds(manifest);
    if (argStrings(args).some((text) => findSecrets(text, ids ? { isPublic: ids } : {}).length)) {
      throw new ConnectorCallError(422, "an argument looks like a credential; connectors take keys from the vault, never from arguments");
    }
    let request: ConnectorRequest;
    try {
      request = buildCall(manifest, action.tool, args);
    } catch (error) {
      throw new ConnectorCallError(400, (error as Error).message);
    }
    const resource = `connector.${manifest.id}`;
    const allowed = decide({ class: request.class, resource, target: request.target });
    if (allowed.verdict === "deny") throw new ConnectorCallError(403, allowed.reason);
    const id = `a_${randomId(16)}`;
    const said = ` (edited by you from ${action.id})`;
    const why = `${action.why ? action.why.slice(0, 500 - said.length) : ""}${said}`.trim();
    const yours = { trust: "owner" as const, ...(via ? { via } : {}) };
    this.o.store.emit(this.o.identity, "action.requested", { id, connector: action.connector, tool: action.tool, args, class: request.class, target: request.target, by: action.by, why, expires: this.now() + ACTION_TTL_MS });
    this.o.store.emit(this.o.identity, "action.decided", { id: action.id, verdict: "denied", note: `you edited it: sent as ${id}` }, yours);
    this.o.store.emit(this.o.identity, "action.decided", { id, verdict: "approved", ...(note ? { note: redact(note).slice(0, 500) } : {}) }, yours);
    this.o.ledger({
      class: request.class as LedgerEntryInput["class"],
      resource,
      target: this.said(action.connector, action.tool, request.target),
      verdict: "approved",
      reason: "you approved it as you edited it",
      detail: `action ${id}, edited from ${action.id}`,
    });
    void this.drain();
    return this.actions(10_000).find((a) => a.id === id)!;
  }

  /** Send every approved action this node filed that hasn't been sent. Safe to call any time. */
  drain(): Promise<void> {
    if (!this.draining) {
      this.draining = this.drainOnce().finally(() => {
        this.draining = null;
      });
    }
    return this.draining;
  }

  private async drainOnce(): Promise<void> {
    const mine = this.actions(10_000).filter((a) => a.node === this.o.identity.id && (a.state === "approved" || a.state === "lapsed"));
    for (const action of mine) {
      if (this.inFlight.has(action.id)) continue;
      const row = this.o.local.query<{ state: string }, [string]>("SELECT state FROM outbox WHERE id = ?").get(action.id);
      if (row) {
        // Marked before sending and never cleared: the node stopped mid-send. Don't guess, don't resend.
        if (row.state === "sending") this.receipt(action.id, false, undefined, "outcome unknown: this node stopped while sending it, so it was not retried");
        continue;
      }
      await this.sendApproved(action, "after your approval");
    }
  }

  /** An approval past its send deadline: never sent, and said so in the ledger, once. */
  private lapse(action: ActionView): { ok: false; status: number; receipt: string } {
    const receipt = `not sent: your approval expired at ${new Date(action.sendBy!).toISOString()} before this node could send it, so it never will`;
    if (!this.o.local.query("SELECT 1 FROM outbox WHERE id = ?").get(action.id)) {
      this.o.ledger({
        class: action.class as LedgerEntryInput["class"],
        resource: `connector.${action.connector}`,
        target: this.said(action.connector, action.tool, action.target),
        verdict: "deny",
        reason: "the approval expired before it could be sent",
        detail: `action ${action.id}, asked by ${action.by} · ${receipt}`.slice(0, 2000),
      });
      this.o.local.query("INSERT OR IGNORE INTO outbox (id, state, at) VALUES (?, 'expired', ?)").run(action.id, this.now());
    }
    return { ok: false, status: 410, receipt };
  }

  /**
   * This node's clock has gone back (a dead clock battery, a restored snapshot, a boot before
   * the time is set): it reads earlier than the newest event it holds, by more than any clock
   * may lead another (no event dated further ahead is ever accepted, so no other node can make
   * this true). Such a clock would read a deadline that has passed as one still to come.
   */
  private clockGoneBack(): boolean {
    let newest = 0;
    for (const hlc of Object.values(this.o.store.frontier())) newest = Math.max(newest, decodeHlc(hlc).ms);
    const behind = newest - this.now() > MAX_CLOCK_DRIFT_MS;
    if (behind && !this.clockWarned) this.o.log(`outbox: this node's clock reads ${new Date(this.now()).toISOString()}, before events it holds from ${new Date(newest).toISOString()}; nothing is sent until it's right`);
    this.clockWarned = behind;
    return behind;
  }

  /** Send one approved action at most once, through the outbox, and write its receipt. */
  private async sendApproved(action: ActionView, why: string): Promise<{ ok: boolean; status?: number; receipt: string; result?: ConnectorResult }> {
    if (this.inFlight.has(action.id) || this.o.local.query("SELECT 1 FROM outbox WHERE id = ?").get(action.id)) {
      return { ok: false, status: 409, receipt: "already sent or being sent" };
    }
    // Checked again here, at the moment of sending: an approval is good for APPROVAL_TTL_MS,
    // by a clock that hasn't gone back. Nothing is marked, so it's judged again once it's right.
    if (action.sendBy === null) return { ok: false, status: 409, receipt: "not approved" };
    if (this.clockGoneBack()) return { ok: false, status: 503, receipt: "not sent yet: this node's clock is behind the events it holds; it's sent (or lapses) once the clock is right" };
    if (this.now() > action.sendBy) return this.lapse(action);
    this.inFlight.add(action.id);
    this.o.local.query("INSERT INTO outbox (id, state, at) VALUES (?, 'sending', ?)").run(action.id, this.now());
    let ok = false;
    let status: number | undefined;
    let receipt: string;
    let result: ConnectorResult | undefined;
    // A private connector's receipt, and its line in the ledger, say how it went and nothing it said (PRIVATE_CONNECTORS).
    const secret = this.isPrivate(action.connector);
    let sending = false;
    try {
      const manifest = this.manifest(action.connector);
      const request = buildCall(manifest, action.tool, ConnectorArgs.parse(action.args));
      if (request.target !== action.target) throw new ConnectorCallError(409, "the connector changed since you approved this; not sent");
      sending = true;
      result = await this.send(manifest, request);
      ok = result.ok;
      status = result.status;
      receipt = secret ? sized(result) : excerpt(result, 1500);
    } catch (error) {
      if (error instanceof ConnectorCallError) status = error.status;
      // (Before it went, the words are this node's own; from the service, a private one's are kept out.)
      receipt = (secret && sending ? `not sent: failed (${status ?? "an error"})` : `not sent: ${(error as Error).message}`).slice(0, 2000);
    }
    this.o.local.query("UPDATE outbox SET state = 'sent' WHERE id = ?").run(action.id);
    this.inFlight.delete(action.id);
    this.receipt(action.id, ok, result?.status, receipt);
    this.o.ledger({
      class: action.class as LedgerEntryInput["class"],
      resource: `connector.${action.connector}`,
      target: this.said(action.connector, action.tool, action.target),
      verdict: "approved",
      reason: ok ? `sent ${why}` : `failed ${why}`,
      detail: `action ${action.id}, asked by ${action.by} · ${receipt}`.slice(0, 2000),
    });
    return { ok, ...(status !== undefined ? { status } : {}), receipt, ...(result ? { result } : {}) };
  }

  // ---- MCP servers ----------------------------------------------------------

  /**
   * Install (or refresh) a remote MCP server as a connector: list its tools now and
   * keep what you decided before. Without its key yet, it installs with no tools and
   * asks for the key; refresh once the key is in.
   */
  async installMcp(
    id: string,
    input: {
      url: string;
      label?: string;
      description?: string;
      auth?: "none" | "bearer" | "header" | "oauth";
      header?: string;
      only?: string[];
      classes?: Record<string, ConnectorManifest["tools"][string]["class"]>;
    },
  ): Promise<{ server: string | null; tools: number; needsKey: boolean; needsSignIn?: boolean } & MergeReport> {
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw new ConnectorCallError(400, "not a URL");
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new ConnectorCallError(400, "give the server's address without a query or credentials: keys go in the vault, never in a URL");
    }
    const previous = installedConnector(this.o.store, id);
    if (previous && !previous.mcp) throw new ConnectorCallError(409, `${id} is a request-template connector, not an MCP server`);
    const same = previous && previous.origin === url.origin && previous.mcp!.path === (url.pathname || "/");
    const auth =
      input.auth === "none"
        ? undefined
        : input.auth === "oauth"
          ? // You sign in to it as yourself: its own sign-in, found from the server (brain mcp-oauth.ts).
            { secret: id, scheme: "oauth" as const, oauth: { provider: "mcp" as const, scopes: [] } }
          : input.auth
            ? { secret: id, scheme: input.auth, ...(input.auth === "header" ? { header: input.header ?? "x-api-key" } : {}) }
            : previous?.auth;
    const only = input.only ?? previous?.mcp?.only;
    const draft = {
      id,
      label: input.label ?? previous?.label ?? id,
      ...((input.description ?? previous?.description) ? { description: input.description ?? previous?.description } : {}),
      origin: url.origin,
      ...(auth ? { auth } : {}),
      ...(previous?.headers ? { headers: previous.headers } : {}),
      mcp: { path: url.pathname || "/", ...(only?.length ? { only } : {}) },
      // Another address is another server: nothing carries over.
      tools: same ? previous!.tools : {},
      // Yours alone stays so, with the agents you allowed, however it is installed again.
      ...(previous?.access ? { access: previous.access } : {}),
      ...(previous?.private ? { private: true } : {}),
    };
    const base = ConnectorManifest.safeParse(draft);
    if (!base.success) throw new ConnectorCallError(400, base.error.issues.map((i) => `${i.path.join(".") || "connector"}: ${i.message}`).join("; "));

    const state = keyState(this.o.vault, base.data);
    if (auth?.scheme === "oauth" && state !== "ready") {
      // Listing tools needs you signed in: install what we have; its tools are listed once you've signed in.
      this.o.store.emit(this.o.identity, "connector.set", { id, manifest: base.data as unknown as Record<string, unknown> });
      return { server: null, tools: Object.keys(base.data.tools).length, needsKey: false, needsSignIn: true, added: [], changed: [], removed: [], skipped: 0 };
    }
    if (state === "missing") {
      // Listing tools usually needs the key too: install what we have, ask for the key.
      this.o.store.emit(this.o.identity, "connector.set", { id, manifest: base.data as unknown as Record<string, unknown> });
      if (!this.o.vault.requests().some((r) => r.name === auth!.secret)) {
        try {
          this.o.vault.request(auth!.secret, `The ${base.data.label} MCP server needs its key (for ${url.origin}).`, id);
        } catch {
          /* a request is a courtesy */
        }
      }
      return { server: null, tools: Object.keys(base.data.tools).length, needsKey: true, added: [], changed: [], removed: [], skipped: 0 };
    }

    let discovered: Awaited<ReturnType<typeof discoverMcpTools>>;
    try {
      discovered = await discoverMcpTools({ vault: this.o.vault, ...(this.o.fetch ? { fetch: this.o.fetch } : {}), oauth: { save: this.keepRotated } }, base.data);
    } catch (error) {
      if (error instanceof ConnectorError) {
        const hint = !auth && /401/.test(error.message) ? " It wants a key or a sign-in: install it again saying which (bearer or a header for a key, then add the key; oauth to sign in as yourself)." : "";
        throw new ConnectorCallError(424, `${error.message}.${hint}`);
      }
      throw new ConnectorCallError(502, `${base.data.label} unreachable: ${redact(String((error as Error).message ?? error))}`);
    }
    const { tools: merged, report } = mergeMcpTools(discovered.tools, same ? previous!.tools : {}, { ...(only ? { only } : {}), ...(input.classes ? { classes: input.classes } : {}) });
    if (Object.keys(merged).length > 64) {
      throw new ConnectorCallError(413, `${base.data.label} has ${Object.keys(merged).length} tools; install up to 64 with only (the ones you need)`);
    }
    // A big server's tools in short, so they fit in the mind: connector_tool reads each one whole from its server.
    const tools = fitMcpTools(merged, (t) => JSON.stringify({ ...base.data, tools: t }).length);
    if (!tools) throw new ConnectorCallError(413, `${base.data.label}'s tool list is too large to keep in the mind, even in short; install fewer with only`);
    const manifest = ConnectorManifest.safeParse({ ...base.data, tools });
    if (!manifest.success) throw new ConnectorCallError(400, manifest.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).slice(0, 5).join("; "));
    this.o.store.emit(this.o.identity, "connector.set", { id, manifest: manifest.data as unknown as Record<string, unknown> });
    this.o.ledger({
      class: "modify",
      resource: "connector.mcp",
      target: id,
      verdict: "allow",
      reason: previous ? "refreshed an MCP server's tools" : "installed an MCP server",
      detail: `${url.origin}${url.pathname} · ${Object.keys(tools).length} tools${tools !== merged ? ", in short" : ""}${report.changed.length ? ` · changed: ${report.changed.join(", ")}` : ""}`.slice(0, 2000),
    });
    return { server: discovered.server, tools: Object.keys(tools).length, needsKey: false, ...report };
  }

  // ---- standing orders ------------------------------------------------------

  /** Orders that can answer a call right now: unrevoked, unexpired, and pinned to the tool as it is. */
  private activeOrders(): StoredOrder[] {
    const active = new Set(this.orders().filter((o) => o.state === "active").map((o) => o.id));
    return this.o.store
      .lwwPrefix<StoredOrder>("order:")
      .map((entry) => entry.value!)
      .filter((order) => active.has(order.id));
  }

  orders(): OrderView[] {
    const now = this.now();
    const uses = new Map<string, { count: number; last: number }>();
    for (const entry of this.o.store.lwwPrefix<{ order?: string }>("action-decision:")) {
      const id = entry.value?.order;
      if (!id) continue;
      const seen = uses.get(id) ?? { count: 0, last: 0 };
      uses.set(id, { count: seen.count + 1, last: Math.max(seen.last, decodeHlc(entry.hlc).ms) });
    }
    return this.o.store
      .lwwPrefix<StoredOrder>("order:")
      .map((entry): OrderView => {
        const order = entry.value!;
        const manifest = installedConnector(this.o.store, order.connector);
        const digest = manifest ? toolDigest(manifest, order.tool) : null;
        const state: OrderView["state"] = order.revoked ? "revoked" : order.until <= now ? "expired" : digest !== order.digest ? "stale" : "active";
        const used = uses.get(order.id);
        return {
          id: order.id,
          label: order.label,
          connector: order.connector,
          tool: order.tool,
          class: order.class,
          args: order.args,
          callers: order.callers ?? null,
          until: order.until,
          state,
          signedAt: decodeHlc(order.signedHlc ?? entry.hlc).ms,
          signedVia: order.via ?? null,
          uses: used?.count ?? 0,
          lastUsed: used?.last ?? null,
        };
      })
      .sort((a, b) => b.signedAt - a.signedAt);
  }

  /** Sign a standing order (you, from a terminal or a paired device). `approve` also answers the action it was made from. */
  sign(
    input: { connector: string; tool: string; args: Record<string, string>; callers?: string[]; days?: number; label: string; approve?: string },
    via: string | null,
  ): { order: OrderView; action?: ActionView } {
    const manifest = this.manifest(input.connector);
    const tool = Object.hasOwn(manifest.tools, input.tool) ? manifest.tools[input.tool] : undefined;
    if (!tool) throw new ConnectorCallError(400, `${manifest.id} has no tool "${input.tool}"`);
    const now = this.now();
    const terms = {
      connector: manifest.id,
      tool: input.tool,
      class: (isMcpTool(tool) ? tool.class : heldClass(manifest, tool)) as OrderTerms["class"],
      args: input.args,
      ...(input.callers?.length ? { callers: input.callers } : {}),
      until: now + Math.min(input.days ?? 30, MAX_ORDER_DAYS) * DAY_MS,
    };
    const problems = orderProblems(terms, manifest, now);
    if (problems.length) throw new ConnectorCallError(400, problems.join("; "));
    for (const text of [input.label, ...Object.values(input.args), ...(input.callers ?? [])]) {
      if (findSecrets(text).length) throw new ConnectorCallError(422, "that looks like a credential; orders replicate in plaintext, keys belong in the vault");
    }
    const waiting = input.approve ? this.actions(10_000).find((a) => a.id === input.approve) : undefined;
    if (input.approve && waiting?.state !== "waiting") throw new ConnectorCallError(409, "that action isn't waiting for an answer");
    if (waiting && (waiting.connector !== manifest.id || waiting.tool !== input.tool)) throw new ConnectorCallError(400, "that action is for another tool");
    const id = `o_${randomId(16)}`;
    const label = input.label.slice(0, 128);
    this.o.store.emit(this.o.identity, "order.set", { id, ...terms, digest: toolDigest(manifest, input.tool)!, label }, { trust: "owner", ...(via ? { via } : {}) });
    this.o.ledger({
      class: "modify",
      resource: "policy.order",
      target: `${manifest.id}.${input.tool}`,
      verdict: "allow",
      reason: "you signed a standing order",
      // (An order over a private connector is named in your words: its line says which order, not them.)
      detail: `${id}${this.isPrivate(manifest.id) ? "" : ` · ${label}`} · until ${new Date(terms.until).toISOString().slice(0, 10)}`,
    });
    const order = this.orders().find((o) => o.id === id)!;
    if (!waiting) return { order };
    return { order, action: this.decide(waiting.id, true, via, `and signed the standing order "${label}"`) };
  }

  revoke(id: string): OrderView {
    const order = this.orders().find((o) => o.id === id);
    if (!order) throw new ConnectorCallError(404, "no such order");
    if (order.state === "revoked") throw new ConnectorCallError(409, "already revoked");
    this.o.store.emit(this.o.identity, "order.revoked", { id });
    this.o.ledger({
      class: "modify",
      resource: "policy.order",
      target: `${order.connector}.${order.tool}`,
      verdict: "allow",
      reason: "you revoked a standing order",
      detail: this.isPrivate(order.connector) ? id : `${id} · ${order.label}`,
    });
    return this.orders().find((o) => o.id === id)!;
  }

  private receipt(id: string, ok: boolean, status: number | undefined, receipt: string): void {
    try {
      this.o.store.emit(this.o.identity, "action.done", { id, ok, ...(status !== undefined ? { status } : {}), receipt: redact(receipt).slice(0, 2000) });
    } catch (error) {
      this.o.log(`action ${id}: receipt not recorded: ${(error as Error).message}`);
    }
  }
}
