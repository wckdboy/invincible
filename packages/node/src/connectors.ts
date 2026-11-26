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
  MCP_ALONE,
  MCP_TOOL_CLASSES,
  MAX_ORDER_DAYS,
  mayCall,
  type NativeName,
  type NodeIdentity,
  orderCovers,
  orderProblems,
  type OrderTerms,
  type OrderView,
  ownApproval,
  randomId,
  redact,
  reviewedMcp,
  toolDigest,
} from "@galahad/core";
import {
  callMcpTool,
  type ConnectorResult,
  describeMcpTool,
  discoverMcpTools,
  excerpt,
  fitMcpTools,
  publicIds,
  installedConnector,
  keyState,
  type MergeReport,
  mergeMcpTools,
  type OAuthEndpoints,
  sendConnectorRequest,
  type Transferred,
  transferConnectorBytes,
} from "@galahad/brain";
import type { MindStore, Vault } from "@galahad/mind";
import type { LedgerEntryInput } from "@galahad/sandbox";
import { GALAHAD_ARM } from "./arms.ts";

/*
 * Connector calls, through the oath gate:
 *
 *   read, create, modify   run now, ledgered
 *   outward, delete        you asking = the approval: run now, ledgered as approved
 *                          an agent asking (arm, loop, quest): an action request in your
 *                          inbox; nothing is sent until you approve it
 *
 * Approved actions leave through an outbox. The node that filed the request is the
 * only one that sends it, it marks the send in local storage before the request
 * goes out, and writes the receipt to the mind afterwards. A crash in between is
 * reported as "outcome unknown", never retried: an approval sends at most once.
 *
 * A standing order is your answer given in advance. An agent's call that one covers
 * is still filed as an action (so you see it), answered by the order on the spot,
 * and sent through the same outbox. So is one that is Galahad's own to approve (your
 * word, 23 November 2026: oath.ts ownApproval): his, or his knights' or loops', and
 * none of monetary, legal or destructive; it is answered as his, and says so.
 */

/** Who calls: you, or an agent; `yours` is an agent's call made on your word (you tapped Ship it), which you approve, never he. */
export type Caller = { kind: "owner"; device: string } | { kind: "agent"; by: string; quest?: string; yours?: true };

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
  store: MindStore;
  vault: Vault;
  identity: NodeIdentity;
  local: Database;
  ledger: (entry: LedgerEntryInput) => void;
  log: (message: string) => void;
  fetch?: typeof fetch;
  now?: () => number;
  /** The native tools this node can carry out (a call to another is refused). */
  natives?: Partial<Record<NativeName, NativeTool>>;
  /** The repositories you gave your knights (as you gave them): his and their work there is his to approve (ownApproval). Absent: none. */
  repositories?: () => readonly string[];
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

/**
 * Galahad's own callers, whose calls he may approve himself: him (his chat's tools, and the node's work for him), his
 * knights' work as the node carries it out, and his loops; no token you mint can take these names (arms.ts). Not a
 * tool you run with a token of its own (arm:…), another node, or you asking to be asked (quest).
 */
const isHis = (by: string): boolean => by === GALAHAD_ARM || by === `arm:${GALAHAD_ARM}` || by.startsWith("team.") || by.startsWith("loop:");

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

  private manifest(id: string): ConnectorManifest {
    const manifest = installedConnector(this.o.store, id);
    if (!manifest) throw new ConnectorCallError(404, `no connector "${id}" is installed (galahad connector add ${id})`);
    return manifest;
  }

  async call(input: { connector: string; tool: string; args?: Record<string, ArgValue>; why?: string }, caller: Caller): Promise<CallOutcome> {
    const manifest = this.manifest(input.connector);
    // One that's Galahad's alone (mail): him, you, your loops and quests, and the agents you allowed; any other asks first.
    if (caller.kind === "agent" && !mayCall(manifest.access, caller.by)) {
      throw new ConnectorCallError(403, `${manifest.label} is Galahad's alone: ask your liege to let you use it (connector_request), and use it once they do`);
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
    const quest = caller.kind === "agent" ? caller.quest : undefined;
    const decision = decide({ class: request.class, resource, target: request.target, ...(quest ? { quest } : {}) });
    if (decision.verdict === "deny") throw new ConnectorCallError(403, decision.reason);

    if (decision.verdict === "ask" && caller.kind === "agent") {
      const id = `a_${randomId(16)}`;
      const expires = this.now() + ACTION_TTL_MS;
      const digest = toolDigest(manifest, input.tool);
      const order = this.activeOrders().find((o) =>
        orderCovers(o, { connector: manifest.id, tool: input.tool, class: request.class, args, by: caller.by, digest }, this.now()),
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
      const tool = manifest.tools[input.tool];
      const own = tool && !isMcpTool(tool) && isHis(caller.by) && !caller.yours ? ownApproval({ class: request.class, origin: manifest.origin, ...(tool.native ? { native: tool.native } : {}), method: tool.method, path: tool.path, args }, this.o.repositories?.() ?? []) : null;
      if (own) {
        this.o.store.emit(this.o.identity, "action.decided", { id, verdict: "approved", note: `Galahad approved it himself: ${own}`.slice(0, 500) }, { trust: "agent" });
        const filed = this.actions(10_000).find((a) => a.id === id);
        if (filed?.state === "approved") {
          const sent = await this.sendApproved(filed, `on Galahad's own approval: ${own}`);
          if (!sent.result) throw new ConnectorCallError(sent.status ?? 502, sent.receipt);
          return { status: "done", class: request.class, target: request.target, result: sent.result, own, action: id };
        }
      }
      this.o.ledger({ class: request.class, resource, target: request.target, verdict: "ask", reason: decision.reason, quest, detail: `action ${id}, asked by ${caller.by}` });
      return { status: "asked", action: id, class: request.class, target: request.target, expires };
    }

    const approved = decision.verdict === "ask"; // the owner asked: that is the approval
    const result = await this.send(manifest, request);
    this.o.ledger({
      class: request.class,
      resource,
      target: request.target,
      verdict: approved ? "approved" : "allow",
      reason: approved ? "you asked for it" : decision.reason,
      quest,
      detail: `${caller.kind === "owner" ? "by you" : `by ${caller.by}`} · ${excerpt(result, 300)}`.slice(0, 2000),
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
      throw new ConnectorCallError(403, `${manifest.label} is Galahad's alone: ask your liege to let you use it (connector_request), and use it once they do`);
    }
    const tool = Object.hasOwn(manifest.tools, input.tool) ? manifest.tools[input.tool]! : null;
    if (!tool) throw new ConnectorCallError(404, `${manifest.id} has no tool "${input.tool}" (it has: ${Object.keys(manifest.tools).join(", ") || "none yet"})`);
    const view = { connector: manifest.id, tool: input.tool, class: tool.class, asks: tool.class === "outward" || tool.class === "delete" };
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
    if (!live) throw new ConnectorCallError(404, `${manifest.label} no longer has ${tool.remote}: galahad connector refresh ${manifest.id} lists what it has now`);
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

  /**
   * A file into an MCP server's tool, for the node's own work that no model sees (books.ts: a bilag from Drive into
   * Dinero). Its bytes are more than a call's arguments carry (32 KB, because an approval's replicate), and no model
   * types them out. Only a tool classed create, through the oath like any call, the request a line in the ledger
   * without the bytes. Never an agent's: no route or tool reaches this.
   */
  async handFile(connector: string, tool: string, args: Record<string, ArgValue>, why: string): Promise<ConnectorResult> {
    const manifest = this.manifest(connector);
    let built: ReturnType<typeof buildMcpCall>;
    try {
      built = buildMcpCall(manifest, tool, args);
    } catch (error) {
      throw new ConnectorCallError(400, (error as Error).message);
    }
    if (built.class !== "create") throw new ConnectorCallError(403, `${manifest.label}'s ${tool} is ${built.class}: the node hands a file only to a tool that creates`);
    // A key in the small arguments is refused as anywhere; the file's own bytes are no one's words.
    if (argStrings(args).some((text) => text.length <= 8000 && findSecrets(text).length)) {
      throw new ConnectorCallError(422, "an argument looks like a credential; connectors take keys from the vault, never from arguments");
    }
    const resource = `connector.${manifest.id}`;
    const target = `mcp ${built.remote}`;
    const decision = decide({ class: built.class, resource, target });
    if (decision.verdict !== "allow") throw new ConnectorCallError(403, decision.verdict === "deny" ? decision.reason : `${manifest.label}: ${built.class} would ask`);
    const result = await this.send(manifest, { ...built, target });
    this.o.ledger({ class: built.class, resource, target, verdict: "allow", reason: decision.reason, detail: `by the node: ${why} · ${excerpt(result, 300)}`.slice(0, 2000) });
    return result;
  }

  /**
   * Bytes to or from a connector, for the node's own work that no model sees (bilag.ts): a read, a create, or a change
   * to what it made (a bilag's name), through the oath like any call, and each one a line in the ledger. Never an
   * agent's: no tool reaches this.
   */
  async transfer(connector: string, step: { method: "GET" | "POST" | "PUT" | "PATCH"; path: string; headers?: Record<string, string>; body?: Uint8Array | string; class: "read" | "create" | "modify"; why: string; max: number }): Promise<Transferred> {
    const manifest = this.manifest(connector);
    const origin = new URL(manifest.origin).origin;
    // A path on the connector's own origin (its base path first), or a whole address there (a resumable upload's).
    const url = step.path.startsWith("https://") ? new URL(step.path) : new URL(`${manifest.basePath ?? ""}${step.path}`, origin);
    if (url.origin !== origin) throw new ConnectorCallError(400, `refusing a request off ${manifest.label}'s origin`);
    const resource = `connector.${manifest.id}`;
    const target = `${step.method} ${url.pathname}`.slice(0, 256);
    const decision = decide({ class: step.class, resource, target });
    if (decision.verdict !== "allow") throw new ConnectorCallError(403, decision.verdict === "deny" ? decision.reason : `${manifest.label}: ${step.class} would ask`);
    const ctx = { vault: this.o.vault, ...(this.o.fetch ? { fetch: this.o.fetch } : {}), oauth: { save: this.keepRotated, ...(this.o.oauthEndpoints ? { endpoints: this.o.oauthEndpoints } : {}) } };
    let moved: Transferred;
    try {
      moved = await transferConnectorBytes(ctx, manifest, { method: step.method, url: url.toString(), ...(step.headers ? { headers: step.headers } : {}), ...(step.body === undefined ? {} : { body: step.body }), max: step.max });
    } catch (error) {
      if (error instanceof ConnectorError) throw new ConnectorCallError(424, error.message);
      throw new ConnectorCallError(502, `${manifest.label} unreachable: ${(error as Error).name === "TimeoutError" ? "timed out" : redact(String((error as Error).message ?? error))}`);
    }
    this.o.ledger({ class: step.class, resource, target, verdict: "allow", reason: decision.reason, detail: `by the node: ${step.why} · ${moved.status}, ${moved.bytes.length} bytes`.slice(0, 2000) });
    return moved;
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
      target: action.target,
      verdict: approve ? "approved" : "deny",
      reason: approve ? "you approved it" : "you declined",
      detail: `action ${id}`,
    });
    if (approve) void this.drain();
    return this.actions(10_000).find((a) => a.id === id)!;
  }

  /**
   * Your yes to your own version of a request: text it already has replaced by yours, checked as any call's arguments
   * are (the tool's own terms, no key in them, what the oath allows). Yours is filed anew under the same asker and
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
      target: request.target,
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
        target: action.target,
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
    try {
      const manifest = this.manifest(action.connector);
      const request = buildCall(manifest, action.tool, ConnectorArgs.parse(action.args));
      if (request.target !== action.target) throw new ConnectorCallError(409, "the connector changed since you approved this; not sent");
      result = await this.send(manifest, request);
      ok = result.ok;
      status = result.status;
      receipt = excerpt(result, 1500);
    } catch (error) {
      if (error instanceof ConnectorCallError) status = error.status;
      receipt = `not sent: ${(error as Error).message}`.slice(0, 2000);
    }
    this.o.local.query("UPDATE outbox SET state = 'sent' WHERE id = ?").run(action.id);
    this.inFlight.delete(action.id);
    this.receipt(action.id, ok, result?.status, receipt);
    this.o.ledger({
      class: action.class as LedgerEntryInput["class"],
      resource: `connector.${action.connector}`,
      target: action.target,
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
      /** The reviewed library's proposal for its tools (core MCP_TOOL_CLASSES). */
      proposed?: readonly (readonly [string, ConnectorManifest["tools"][string]["class"]])[];
      /** Galahad's alone and private (core MCP_ALONE): only he and the agents you allow may call it. */
      alone?: boolean;
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
    // A server on the reviewed list is held to its review however it comes in: by its id or its address, listed again,
    // or listed by itself once you've signed in (its classes after yours; Galahad's alone where the list says so).
    const reviewed = reviewedMcp(url.toString());
    const proposed = input.proposed ?? (reviewed && Object.hasOwn(MCP_TOOL_CLASSES, reviewed.id) ? MCP_TOOL_CLASSES[reviewed.id] : undefined);
    const alone = input.alone ?? (reviewed ? MCP_ALONE.has(reviewed.id) : false);
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
      ...(previous?.access ? { access: previous.access } : alone ? { access: { only: "galahad" as const, allowed: [] } } : {}),
      ...(alone || previous?.private ? { private: true } : {}),
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
    const { tools: merged, report } = mergeMcpTools(discovered.tools, same ? previous!.tools : {}, { ...(only ? { only } : {}), ...(input.classes ? { classes: input.classes } : {}), ...(proposed ? { proposed } : {}) });
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
      class: tool.class as OrderTerms["class"],
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
      resource: "oath.order",
      target: `${manifest.id}.${input.tool}`,
      verdict: "allow",
      reason: "you signed a standing order",
      detail: `${id} · ${label} · until ${new Date(terms.until).toISOString().slice(0, 10)}`,
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
      resource: "oath.order",
      target: `${order.connector}.${order.tool}`,
      verdict: "allow",
      reason: "you revoked a standing order",
      detail: `${id} · ${order.label}`,
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
