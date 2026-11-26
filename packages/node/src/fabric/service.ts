import {
  AUTH,
  type DeviceId,
  FABRIC,
  type GEvent,
  LINK_METHOD,
  LINK_PATHS,
  LinkCall,
  LinkForwardPath,
  NonceCache,
  type NodeIdentity,
  onTailnetOrLoopback,
  OWNER_SCOPES,
  type PeerPath,
  type Presence,
  PushRequest,
  type QampEndpoint,
  qampEndpointOf,
  type Scope,
  signRequest,
  type SyncPage,
  SyncRequest,
  utf8,
  verifyRequestSignature,
} from "@invincible/core";
import type { Device, LedgerStore } from "@invincible/ledger";
import { answerPush, answerSync, type SyncTransport } from "@invincible/link";
import type { Sidecar } from "./sidecar.ts";
import { type CallOptions, type Chunk, type Invocation, SidecarError, type SidecarClient, type ToolSpec, within } from "./socket.ts";

/*
 * The node's fabric (docs/ARCHITECTURE.md §3): its peers over Q-AMP, through its sidecar.
 *
 *  - It serves its peers the link (sync, push, forwarded work) and the hand-off of tasks, and for runs it handed to
 *    another node, its tools (handoff.ts).
 *  - Its door: the sidecar proves the caller's key in the handshake; the node takes that key for the active node whose
 *    own signed profile names it, and for nothing else. Who is active is read afresh on every call, never cached, so a
 *    node revoked here is refused from its very next call.
 *  - It calls them, and says for each peer which path it is on: Q-AMP when its sidecar is up and the peer's answers,
 *    HTTP with signed requests otherwise, and why (never in clear off the tailnet to a peer that speaks Q-AMP).
 */

/** Who calls, as the server's principal is (server.ts): a node of the fleet, owner-equivalent when it is a full one. */
export interface FabricPrincipal {
  device: string;
  kind: "node";
  scopes: Scope[];
}

const principals = new WeakMap<Request, FabricPrincipal>();

/**
 * A request for this node's own API on behalf of a node that called over Q-AMP: the same route, scope and checks as
 * over HTTP, with the principal its key proved (server.ts reads it on the "fabric" listener, and nowhere else).
 */
export function fabricRequest(path: string, body: Record<string, unknown>, principal: FabricPrincipal, signal: AbortSignal): Request {
  const req = new Request(`http://fabric.invalid${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" }, signal });
  principals.set(req, principal);
  return req;
}

/** The principal a fabric request was made for (null for any other request). */
export const fabricPrincipalOf = (req: Request): FabricPrincipal | null => principals.get(req) ?? null;

/** A peer's path as this node last found it, and why it isn't Q-AMP when it isn't. */
export interface PathState {
  path: PeerPath;
  why: string | null;
  at: number;
}

export interface FabricDeps {
  store: LedgerStore;
  identity: NodeIdentity;
  sidecar: Sidecar;
  log(message: string): void;
  presence(): Promise<Presence>;
  /** One of this node's API routes, as a node called it: its status and its JSON answer (the daemon's app, on "fabric"). */
  route?(path: string, body: Record<string, unknown>, principal: FabricPrincipal, signal: AbortSignal): Promise<{ status: number; body: unknown }>;
  now?(): number;
}

/** What serves the hand-off's tools (handoff.ts), attached once it exists. */
export interface FabricTools {
  specs(): { tools: ToolSpec[]; public: string[] };
  /** Whether this tool is its; then it answers the invocation (its own door). */
  owns(tool: string): boolean;
  invoked(inv: Invocation, caller: Device | null): void;
  /** A node was revoked here: whatever of its is under way ends now. */
  revoked(device: string): void;
}

/**
 * How long a peer is reached over HTTP before Q-AMP is tried again, by why it wasn't had. A peer that couldn't be
 * reached costs a timeout each try: 5 s, longer each time, to a minute. One that answered "not over this path" costs a
 * round trip: refused (UNAUTHORIZED: its door doesn't know this node's key yet, which its next pull of this node's profile
 * cures), 2 s; busy or draining (OVERLOADED, GOING_AWAY), 5 s; a node from before the fabric (UNKNOWN_TOOL), a minute.
 */
const RETRY_MS = { first: 5_000, max: 60_000 } as const;
const NOT_HERE = new Map<number, number>([
  [3, 2_000],
  [6, 5_000],
  [7, 5_000],
  [1, 60_000],
]);

/** The link tools whose every call is signed by its node's device key (LinkCall), and the path each one is signed for. */
const SIGNED = new Map<string, (path: string) => boolean>([
  [FABRIC.sync, (path) => path === LINK_PATHS.sync],
  [FABRIC.push, (path) => path === LINK_PATHS.push],
  [FABRIC.forward, (path) => LinkForwardPath.safeParse(path).success],
  [FABRIC.hand, (path) => path === LINK_PATHS.hand],
]);

export class Fabric implements SyncTransport {
  private readonly now: () => number;
  private readonly paths = new Map<string, PathState>();
  private readonly backoff = new Map<string, { until: number; ms: number }>();
  private callers: Map<string, string | null> | null = null;
  /** Peers' endpoints as their profiles prove them (their transport keys' own signatures), until a profile changes. */
  private readonly endpoints = new Map<string, QampEndpoint | null>();
  /** Link calls' nonces, for their signatures' window: a call sent twice is refused the second time. */
  private readonly nonces = new NonceCache();
  private readonly running = new Map<string, Set<Invocation>>();
  private tools: FabricTools | null = null;
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: FabricDeps) {
    this.now = deps.now ?? Date.now;
    // A node revoked, or a profile changed: who each key is is read again; a revoked node's calls end at once.
    this.unsubscribe = deps.store.onApplied((events, rebuilt) => {
      if (rebuilt || events.some((e) => e.kind === "node.profile" || e.kind.startsWith("device."))) {
        this.callers = null;
        this.endpoints.clear();
      }
      for (const event of events) {
        if (event.kind !== "device.revoked") continue;
        const body = event.body as { device?: unknown };
        if (typeof body.device === "string" && !deps.store.activeDevice(body.device)) this.cutOff(body.device);
      }
    });
  }

  close(): void {
    this.unsubscribe();
  }

  /** The hand-off's tools, served beside the link's. */
  attach(tools: FabricTools): void {
    this.tools = tools;
  }

  get sidecar(): Sidecar {
    return this.deps.sidecar;
  }

  /** This node's own endpoint, for its profile: once its sidecar has said where it listens, with its key's proof that it is this node's. */
  endpoint(): QampEndpoint | null {
    const { did, address, pop } = this.deps.sidecar;
    return did && address && pop ? { did, address, pop } : null;
  }

  // ---- who is calling ----

  /**
   * The active node a transport key belongs to, by the profiles nodes signed; none when no node, or more than one, says
   * it. A profile's claim counts only with the key's own signature for that node (`pop`), and a key a revoked node ever
   * held is nobody's from then on, whoever names it after.
   */
  nodeOfKey(did: string): Device | null {
    if (!this.callers) {
      const map = new Map<string, string | null>();
      const burned = new Set<string>();
      for (const d of this.deps.store.devices(true)) {
        if (d.kind !== "node" || d.id === this.deps.identity.id) continue;
        if (d.revokedHlc) {
          for (const caps of this.deps.store.profilesOf(d.id)) {
            const held = qampEndpointOf(caps, d.id);
            if (held) burned.add(held.did);
          }
          continue;
        }
        const endpoint = qampEndpointOf(d.profile?.caps, d.id);
        if (!endpoint) continue;
        // Two nodes naming one key (both holding it): neither is taken for it.
        map.set(endpoint.did, map.has(endpoint.did) ? null : d.id);
      }
      for (const did of burned) map.set(did, null);
      this.callers = map;
    }
    const id = this.callers.get(did);
    // Never cached: a node revoked a moment ago is refused now.
    const device = id ? this.deps.store.activeDevice(id) : null;
    return device && device.kind === "node" ? device : null;
  }

  /**
   * A link call for `path`, signed by this node's device key as its HTTPS request would be (LinkCall): what each of the
   * link's calls and each hand-off carries, so that a transport key alone carries nothing.
   */
  async seal(path: string, body: unknown): Promise<LinkCall> {
    const text = JSON.stringify(body);
    const headers = await signRequest(this.deps.identity.id as DeviceId, (message) => this.deps.identity.sign(message), LINK_METHOD, path, utf8(text), this.now());
    return { path, body: text, auth: { device: headers[AUTH.device]!, ts: headers[AUTH.ts]!, nonce: headers[AUTH.nonce]!, sig: headers[AUTH.sig]! } };
  }

  /**
   * A link call's own signature, checked exactly as an HTTPS request's is (request-auth.ts): by the node the transport
   * key belongs to, active, within the time window, its nonce not seen before, for the path its tool signs. Its body,
   * or why it is refused.
   */
  private opened(inv: Invocation, caller: Device, signedFor: (path: string) => boolean): { path: string; body: unknown } | { refused: string } {
    const call = LinkCall.safeParse(inv.args);
    if (!call.success) return { refused: "a link call is signed by its node's device key, as its HTTPS request would be" };
    const { path, body, auth } = call.data;
    if (!signedFor(path)) return { refused: `that call isn't signed for ${inv.tool}` };
    const headers = new Headers({ [AUTH.device]: auth.device, [AUTH.ts]: auth.ts, [AUTH.nonce]: auth.nonce, [AUTH.sig]: auth.sig });
    const proof = verifyRequestSignature(headers, LINK_METHOD, path, utf8(body), this.now());
    if (!proof) return { refused: "its signature doesn't verify, or it is outside its time window" };
    if (proof.device !== caller.id) return { refused: "it is signed by another device than the node whose transport key called" };
    if (!this.deps.store.activeDevice(proof.device)) return { refused: "it is signed by a node that isn't active" };
    if (!this.nonces.claim(proof.device, proof.nonce, this.now())) return { refused: "it was sent before: its nonce is spent" };
    try {
      return { path, body: JSON.parse(body) as unknown };
    } catch {
      return { refused: "its body isn't JSON" };
    }
  }

  private principalOf(device: Device): FabricPrincipal {
    return { device: device.id, kind: "node", scopes: device.role === "full" ? OWNER_SCOPES : device.scopes };
  }

  /** Serves the link and the hand-off on a sidecar that just came up. */
  async serve(client: SidecarClient): Promise<void> {
    const extra = this.tools?.specs() ?? { tools: [], public: [] };
    const link: ToolSpec[] = [
      { name: FABRIC.sync, description: "The ledger's events after a frontier: an enrolled node's pull", annotations: { read_only: true } },
      { name: FABRIC.push, description: "Fresh events an enrolled node wrote" },
      { name: FABRIC.forward, description: "One of this node's routes, forwarded by an enrolled node (a sandbox here)" },
    ];
    // Public at Q-AMP's door (any authenticated key may call them), and the node's own decides: an enrolled node, or nothing.
    await client.serve([...link, ...extra.tools], [...link.map((t) => t.name), ...extra.public], (inv) => this.door(inv));
  }

  /**
   * The node's door, for an invocation its sidecar delivered (the caller's transport key proved by the handshake): the
   * active node that key belongs to, and for each link call and hand-off, that node's own signature over it.
   */
  door(inv: Invocation): void {
    const caller = this.nodeOfKey(inv.caller);
    const signedFor = SIGNED.get(inv.tool);
    if (signedFor) {
      if (!caller) return inv.fail(3, "this node takes link calls from the active nodes of its fleet alone, by the key each one's signed profile names");
      const opened = this.opened(inv, caller, signedFor);
      if ("refused" in opened) return inv.fail(3, `refused: ${opened.refused}`);
      inv.args = inv.tool === FABRIC.forward ? { path: opened.path, body: opened.body } : opened.body;
    }
    if (this.tools?.owns(inv.tool)) {
      this.track(caller, inv);
      this.tools.invoked(inv, caller);
      return;
    }
    if (!caller) {
      inv.fail(3, "this node takes link calls from the active nodes of its fleet alone, by the key each one's signed profile names");
      return;
    }
    this.track(caller, inv);
    const answer = async (): Promise<unknown> => {
      switch (inv.tool) {
        case FABRIC.sync:
          return { ...answerSync(this.deps.store, SyncRequest.parse(inv.args)), presence: await this.deps.presence() };
        case FABRIC.push:
          return answerPush(this.deps.store, PushRequest.parse(inv.args).events);
        case FABRIC.forward: {
          if (!this.deps.route) throw Object.assign(new Error("this node forwards no routes"), { code: 1 });
          const { path, body } = inv.args as { path: string; body: unknown };
          if (!body || typeof body !== "object" || Array.isArray(body)) throw Object.assign(new Error("a forwarded route's body is a JSON object"), { code: 2 });
          return this.deps.route(path, body as Record<string, unknown>, this.principalOf(caller), inv.signal);
        }
        default:
          throw Object.assign(new Error(`no tool ${inv.tool}`), { code: 1 });
      }
    };
    answer().then(
      (result) => inv.complete(result),
      (error: Error & { code?: number }) => {
        if (inv.signal.aborted) return;
        const invalid = error.name === "ZodError";
        inv.fail(invalid ? 2 : (error.code ?? 8), invalid ? "invalid arguments" : String(error.message ?? error).slice(0, 500));
      },
    );
  }

  /** What a caller has under way here, so a node revoked here loses it at once: held from its invoke to its end. */
  private track(caller: Device | null, inv: Invocation): void {
    if (!caller) return;
    let set = this.running.get(caller.id);
    if (!set) this.running.set(caller.id, (set = new Set()));
    const held = set;
    held.add(inv);
    const { complete, fail } = inv;
    inv.complete = (result) => {
      held.delete(inv);
      complete(result);
    };
    inv.fail = (code, message, retryable, data) => {
      held.delete(inv);
      fail(code, message, retryable, data);
    };
    inv.signal.addEventListener("abort", () => held.delete(inv), { once: true });
  }

  private cutOff(device: string): void {
    const calls = this.running.get(device);
    this.running.delete(device);
    for (const inv of calls ?? []) inv.fail(3, "this node was revoked");
    this.tools?.revoked(device);
    this.paths.delete(device);
    this.deps.log(`fabric: ${device.slice(0, 12)} was revoked: its calls here ended, and it is refused from the next one`);
  }

  // ---- calling peers ----

  /** A peer's endpoint, by its signed profile, when its transport key signed for it (checked once per profile). */
  peerEndpoint(peer: Device): QampEndpoint | null {
    const claim = (peer.profile?.caps as { qamp?: { pop?: unknown } } | undefined)?.qamp?.pop;
    const key = `${peer.id} ${typeof claim === "string" ? claim : ""}`;
    if (!this.endpoints.has(key)) {
      if (this.endpoints.size > 256) this.endpoints.clear();
      this.endpoints.set(key, qampEndpointOf(peer.profile?.caps, peer.id));
    }
    return this.endpoints.get(key) ?? null;
  }

  /**
   * Why this peer may not be reached over plain HTTP now: it speaks Q-AMP (its profile names an endpoint its key signed
   * for), this node runs its sidecar (its fabric is on), and the peer's HTTP endpoint is off the tailnet, so a link's
   * requests and answers would travel in clear. Null: HTTP, signed, as before (the tailnet, this machine, a peer without
   * Q-AMP, or a node whose fabric is off).
   */
  httpRefused(peer: Device): string | null {
    if (this.deps.sidecar.state === "off" || !this.peerEndpoint(peer)) return null;
    let host: string;
    try {
      host = new URL(peer.profile?.endpoint ?? "").hostname;
    } catch {
      return null;
    }
    if (onTailnetOrLoopback(host)) return null;
    return `${peer.name} speaks Q-AMP, and its HTTP endpoint (${host}) is off the tailnet: its requests and answers would travel in clear, so it waits for Q-AMP (invincible fabric off on this node goes back to HTTP knowingly)`;
  }

  /** The path a peer was last reached on, and why not Q-AMP (null: not reached yet). */
  pathOf(peer: string): PathState | null {
    return this.paths.get(peer) ?? null;
  }

  /** It goes over HTTP for now, and why; Q-AMP is tried again after `fixedMs`, or a while longer each time (null). */
  private notHere(peer: string, why: string, fixedMs: number | null): { unavailable: string } {
    this.paths.set(peer, { path: "https", why, at: this.now() });
    const prior = this.backoff.get(peer);
    const ms = fixedMs ?? (prior ? Math.min(prior.ms * 2, RETRY_MS.max) : RETRY_MS.first);
    this.backoff.set(peer, { until: this.now() + ms, ms: fixedMs === null ? ms : 0 });
    return { unavailable: why };
  }

  /** Why Q-AMP can't be used for this peer now, or null when it can. */
  unusable(peer: Device): string | null {
    const client = this.deps.sidecar.client;
    if (!client?.open) return `this node's sidecar isn't up (${this.deps.sidecar.why ?? this.deps.sidecar.state})`;
    if (!this.peerEndpoint(peer)) return `${peer.name} has no Q-AMP endpoint in its profile (no sidecar there, or a node from before it)`;
    const off = this.backoff.get(peer.id);
    if (off && off.until > this.now()) return `${this.paths.get(peer.id)?.why ?? "Q-AMP failed"} (tried again in ${Math.ceil((off.until - this.now()) / 1000)} s)`;
    return null;
  }

  /**
   * Calls a peer's tool over Q-AMP: its value, or why it couldn't be had this way (the caller then goes over HTTP). A
   * peer that answered with an error of its own throws it, as an HTTPS peer's error would be.
   */
  async call(peer: Device, tool: string, args: unknown, opts: CallOptions & { timeoutMs?: number; chunks?: (chunk: Chunk) => void } = {}): Promise<{ value: unknown } | { unavailable: string }> {
    const why = this.unusable(peer);
    if (why) {
      // (Its own path is said only once it has been tried: a peer with no endpoint is simply on HTTPS.)
      if (!this.peerEndpoint(peer) || !this.deps.sidecar.client?.open) this.paths.set(peer.id, { path: "https", why, at: this.now() });
      return { unavailable: why };
    }
    const client = this.deps.sidecar.client!;
    const endpoint = this.peerEndpoint(peer)!;
    const timeout = opts.timeoutMs ?? 15_000;
    // A call nobody reads chunks of (sync, push, a forwarded route) holds none: they are dropped as they come.
    const call = client.call(endpoint.address, tool, args, { ...opts, deadlineMs: opts.deadlineMs ?? timeout, discard: !opts.chunks });
    const reading = opts.chunks
      ? (async () => {
          for await (const chunk of call.chunks) opts.chunks!(chunk);
        })()
      : null;
    try {
      const value = await within(call.result, timeout + 2_000, () => Promise.reject(new SidecarError("deadline", `no answer in ${timeout} ms`)));
      await reading;
      this.backoff.delete(peer.id);
      this.paths.set(peer.id, { path: "qamp", why: null, at: this.now() });
      return { value };
    } catch (error) {
      call.cancel();
      if (!(error instanceof SidecarError)) throw error;
      if (error.kind === "remote" && error.code !== null && !NOT_HERE.has(error.code)) {
        // The peer answered, over Q-AMP: its answer is the error.
        this.paths.set(peer.id, { path: "qamp", why: null, at: this.now() });
        throw error;
      }
      if (error.kind === "cancelled") throw error;
      const refused = error.kind === "remote" && error.code !== null ? (NOT_HERE.get(error.code) ?? null) : null;
      return this.notHere(peer.id, `Q-AMP to ${peer.name} failed: ${error.message.slice(0, 160)}`, refused);
    }
  }

  // ---- the link, as the sync engine asks for it ----

  async sync(peer: Device, request: SyncRequest): Promise<SyncPage | null> {
    const answer = await this.call(peer, FABRIC.sync, await this.seal(LINK_PATHS.sync, request), { timeoutMs: 8_000 });
    return "value" in answer ? (answer.value as SyncPage) : null;
  }

  async push(peer: Device, events: GEvent[]): Promise<boolean> {
    const answer = await this.call(peer, FABRIC.push, await this.seal(LINK_PATHS.push, { events }), { timeoutMs: 5_000 });
    return "value" in answer;
  }

  /** A route forwarded to a peer over Q-AMP: its status and JSON answer, or null when it must go over HTTP. */
  async forward(peer: Device, path: string, body: Record<string, unknown>, timeoutMs: number): Promise<{ status: number; body: unknown } | null> {
    const answer = await this.call(peer, FABRIC.forward, await this.seal(path, body), { timeoutMs });
    if (!("value" in answer)) return null;
    const value = answer.value as { status?: unknown; body?: unknown };
    return { status: typeof value?.status === "number" ? value.status : 502, body: value?.body ?? null };
  }
}
