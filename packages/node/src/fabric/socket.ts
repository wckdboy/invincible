import { CBOR_BUDGET, cborDecode, cborEncode } from "@invincible/core";

/*
 * The node's side of Q-AMP's sidecar socket (Q-AMP's docs/SIDECAR.md, API 1): the daemon is the host, and the sidecar is
 * the node's endpoint on the network. Each message is a 4-byte big-endian length and that many bytes of CBOR, one map
 * whose "t" is its type. Through it the node calls its peers' tools (their chunks streamed back, input streamed to them,
 * a cancel that stops the remote work), serves its own to them (each call reaches it with the caller's key as the
 * handshake proved it, and the chain that authorized it), and mints, renews and revokes grants from its transport key.
 *
 * Nothing here decides who may do what: the sidecar checks every chain before the node hears of a call, and the node's
 * door (fabric/service.ts) decides what an authenticated caller may have.
 */

/** The socket API this speaks (the sidecar says its own in `hello`). */
export const SIDECAR_API = 1;
/** The largest message either side may send: room for the largest chunk Q-AMP allows. */
export const MAX_MESSAGE_BYTES = 65 * 1024 * 1024;
/** What this host holds of one call's chunks or one task's input before it asks the sidecar to hold the rest. */
const HOLD_BYTES = 1 << 20;
/**
 * The most it holds of them unread, whatever it asked: past it, the peer sent past the pause it was asked for (room for
 * two of Q-AMP's largest frames beyond the budget), and the call is cancelled, or the task failed.
 */
const HOLD_MAX = 32 << 20;
/** Each message's encoded length, as the frame reader read it: what a chunk is counted at. */
const frameBytes = new WeakMap<object, number>();
/** What it holds of its own output for a task the sidecar asked it to pause, before it gives that task up. */
const QUEUE_BYTES = 16 << 20;

export type Chunk = { text: string } | { bytes: Uint8Array } | { value: unknown };

/**
 * `work`, or what `late` gives if `work` takes longer than `ms`. The timer is cleared whichever comes first, so nothing is
 * left pending after the answer (an uncancellable sleep raced against it would hold a forwarded call's 75 minutes).
 */
export async function within<T, U>(work: Promise<T>, ms: number, late: () => U | Promise<U>): Promise<T | U> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<U>((resolve, reject) => {
    timer = setTimeout(() => {
      Promise.resolve().then(late).then(resolve, reject);
    }, ms);
  });
  try {
    return await Promise.race([work, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** The sidecar's kinds (SIDECAR.md), and this node's own: `closed`, its socket to the sidecar is; `unsent`, a call never left
 * this node (the sidecar's socket couldn't take it). */
export type SidecarErrorKind = "remote" | "cancelled" | "deadline" | "unavailable" | "invalid" | "internal" | "closed" | "unsent";

/** A call that ended without a result, or a request the sidecar refused. `code` is the peer's Q-AMP error code (SPEC 5.5). */
export class SidecarError extends Error {
  override name = "SidecarError";
  constructor(
    readonly kind: SidecarErrorKind,
    message: string,
    readonly code: number | null = null,
    readonly retryable = false,
    readonly data: unknown = undefined,
  ) {
    super(message);
  }
}

export interface SidecarHello {
  did: string;
  keyType: "ed25519" | "p256";
  /** qamp://<did>@<host>:<port> when it listens. */
  address: string | null;
  version: string;
}

/** A tool as MANIFEST lists it (Q-AMP SPEC 5.1). */
export interface ToolSpec {
  name: string;
  title?: string;
  description?: string;
  input_schema?: unknown;
  annotations?: { read_only?: boolean; destructive?: boolean; idempotent?: boolean; open_world?: boolean; streaming?: boolean };
}

/** One link of the chain that authorized a call, root first (SIDECAR.md, Serving tools). */
export interface ChainLink {
  id: string;
  iss: string;
  aud: string;
  sub?: string | null;
  cmd: string;
  exp: number;
  nbf?: number | null;
  pol?: unknown[] | null;
  meta?: Record<string, unknown> | null;
}

/** A call of one of this node's tools, as the sidecar hands it over once it has checked the caller's chain. */
export interface Invocation {
  task: number;
  tool: string;
  args: unknown;
  /** The caller's did:key, as its key proved it in the handshake. */
  caller: string;
  authorization: { kind: "root" | "public" | "delegated"; root?: string; links?: number };
  chain: ChainLink[];
  meta: Record<string, unknown> | null;
  deadlineMs: number | null;
  input: boolean;
  /** Aborted when the call ends before this node answered: the caller cancelled or went away, or its deadline passed. */
  signal: AbortSignal;
  /** Its input, when the caller streams some: chunks in order, ending with the caller's end. */
  inputs: AsyncIterable<Chunk>;
  emit(chunk: Chunk): void;
  progress(progress: number, total?: number, message?: string): void;
  complete(result: unknown): void;
  fail(code: number, message: string, retryable?: boolean, data?: unknown): void;
}

export interface CallOptions {
  /** The chain, as text (`qdt1.…`) or as encoded tokens root first. */
  chain?: string;
  proofs?: Uint8Array[];
  deadlineMs?: number;
  priority?: number;
  meta?: Record<string, unknown>;
  /** Keep the call's input open for `send` and `end`. */
  input?: boolean;
  /** It takes its result alone (sync, push, a forwarded route): the chunks it is sent are dropped as they come. */
  discard?: boolean;
  signal?: AbortSignal;
}

export interface Call {
  readonly id: number;
  /** Its chunks, in order, as they come: ends when the call does. */
  chunks: AsyncIterable<Chunk>;
  /** Its result, or why it had none (a SidecarError). */
  result: Promise<unknown>;
  send(chunk: Chunk): void;
  end(): void;
  cancel(): void;
}

export interface MintRequest {
  aud: string;
  tools?: string[];
  cmds?: string[];
  sub?: string;
  pol?: unknown[];
  ttlSecs?: number;
  nbf?: number;
  meta?: Record<string, unknown>;
  renewable?: boolean;
  proof?: string;
}

export interface Minted {
  grant: string;
  tokens: { cmd: string; tokenId: string; exp: number; chain: string }[];
}

export interface PeerInfo {
  did: string;
  address: string | null;
  version: string | null;
  transport: string | null;
  rttUs: number | null;
  draining: boolean;
  usable: boolean;
  name: string | null;
}

export type Msg = Record<string, unknown> & { t: string };

/**
 * A FIFO of chunks a reader takes from as they come; `bytes` is what it holds and the reader hasn't taken, each chunk
 * counted at its message's encoded length (structured ones too: never a guess).
 */
class Stream {
  private readonly items: { chunk: Chunk; size: number }[] = [];
  private readonly waiters: ((r: IteratorResult<Chunk>) => void)[] = [];
  private ended: Error | true | null = null;
  bytes = 0;
  constructor(private readonly taken: (bytes: number) => void = () => {}) {}

  push(chunk: Chunk, size = chunkBytes(chunk)): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: chunk, done: false });
      return;
    }
    this.items.push({ chunk, size });
    this.bytes += size;
  }

  end(error?: Error): void {
    if (this.ended) return;
    this.ended = error ?? true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<Chunk> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) {
          this.bytes -= item.size;
          this.taken(item.size);
          return Promise.resolve({ value: item.chunk, done: false });
        }
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

const chunkBytes = (chunk: Chunk): number => ("text" in chunk ? chunk.text.length : "bytes" in chunk ? chunk.bytes.length : 64);

function chunkOf(m: Msg): Chunk | null {
  const kinds = [m.text !== undefined && m.text !== null, m.bytes !== undefined && m.bytes !== null, m.value !== undefined && m.value !== null];
  if (kinds.filter(Boolean).length !== 1) return null;
  if (typeof m.text === "string") return { text: m.text };
  if (m.bytes instanceof Uint8Array) return { bytes: m.bytes };
  if (kinds[2]) return { value: m.value };
  return null;
}

/** Values the sidecar sends in the JSON data model come as CBOR: an integer past 2^53 is a bigint, never wanted here. */
function jsonish(v: unknown): unknown {
  if (typeof v === "bigint") return Number(v);
  if (Array.isArray(v)) return v.map(jsonish);
  if (v && typeof v === "object" && !(v instanceof Uint8Array)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonish(x)]));
  return v;
}

const num = (v: unknown): number | null => (typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * The socket's framing, as it comes in: a 4-byte big-endian length, then that many bytes of CBOR, one map whose "t" is
 * its type. A length past MAX_MESSAGE_BYTES is refused before anything of it is buffered; a body is decoded under
 * Q-AMP's decode budget. Throws on anything that isn't a message: the connection is broken from there on.
 */
export class FrameReader {
  private inbox: Uint8Array[] = [];
  private inboxBytes = 0;

  /** What this chunk completes, in order (none while a message is still coming). */
  push(chunk: Uint8Array): Msg[] {
    this.inbox.push(Uint8Array.from(chunk));
    this.inboxBytes += chunk.length;
    const out: Msg[] = [];
    while (this.inboxBytes >= 4) {
      const head = this.take(4, false);
      const length = new DataView(head.buffer, head.byteOffset).getUint32(0);
      // Bounded before it is buffered: a length past the limit is a broken socket, never memory to hold.
      if (length > MAX_MESSAGE_BYTES) throw new SidecarError("internal", `the sidecar sent a message of ${length} bytes, past ${MAX_MESSAGE_BYTES}`);
      if (this.inboxBytes < 4 + length) break;
      this.take(4, true);
      const body = this.take(length, true);
      let decoded: unknown;
      try {
        decoded = cborDecode(body, { budget: CBOR_BUDGET });
      } catch (error) {
        throw new SidecarError("internal", `the sidecar sent what isn't a message: ${(error as Error).message}`);
      }
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded) || decoded instanceof Uint8Array || typeof (decoded as Msg).t !== "string") throw new SidecarError("internal", "the sidecar sent what isn't a message: not a map with a type");
      frameBytes.set(decoded, 4 + length);
      out.push(decoded as Msg);
    }
    return out;
  }

  /** What it holds of a message still coming. */
  get held(): number {
    return this.inboxBytes;
  }

  /** The first `n` bytes held (consumed, or only looked at). */
  private take(n: number, consume: boolean): Uint8Array {
    const out = new Uint8Array(n);
    let at = 0;
    let i = 0;
    while (at < n) {
      const part = this.inbox[i]!;
      const used = Math.min(part.length, n - at);
      out.set(part.subarray(0, used), at);
      at += used;
      if (consume) {
        if (used === part.length) {
          this.inbox.shift();
          continue;
        }
        this.inbox[0] = part.subarray(used);
      } else i++;
    }
    if (consume) this.inboxBytes -= n;
    return out;
  }
}

interface CallState {
  stream: Stream;
  resolve(v: unknown): void;
  reject(e: Error): void;
  /** The sidecar asked this host to hold the call's input. */
  inputHeld: boolean;
  outbox: Msg[];
  /** This host asked the sidecar to hold the call's chunks. */
  paused: boolean;
  /** It takes its result alone: its chunks are dropped as they come. */
  discard: boolean;
  done: boolean;
}

interface TaskState {
  inv: Invocation;
  flush(): void;
  abort: AbortController;
  input: Stream;
  /** The sidecar asked this host to hold the task's output. */
  held: boolean;
  outbox: Msg[];
  outboxBytes: number;
  paused: boolean;
  done: boolean;
}

/**
 * A connection to the sidecar's socket. One per node is the rule (the calls and tools it starts belong to it); a host
 * may open more, each its own.
 */
export class SidecarClient {
  private nextId = 1;
  private readonly requests = new Map<number, { want: string; resolve(m: Msg): void; reject(e: Error): void }>();
  private readonly calls = new Map<number, CallState>();
  private readonly tasks = new Map<number, TaskState>();
  private handler: ((inv: Invocation) => void) | null = null;
  private readonly reader = new FrameReader();
  private outbound: Uint8Array[] = [];
  private closedWith: Error | null = null;
  private readonly closeListeners: ((why: Error) => void)[] = [];
  private socket!: Bun.Socket<undefined>;
  hello!: SidecarHello;
  private helloWaiter: { resolve(): void; reject(e: Error): void } | null = null;

  private constructor() {}

  /** Connects, and waits for the sidecar's hello (refusing an API this host doesn't speak). */
  static async connect(path: string, opts: { timeoutMs?: number } = {}): Promise<SidecarClient> {
    const client = new SidecarClient();
    const hello = new Promise<void>((resolve, reject) => (client.helloWaiter = { resolve, reject }));
    client.socket = await Bun.connect<undefined>({
      unix: path,
      socket: {
        data: (_s, chunk) => client.received(chunk),
        drain: () => client.flush(),
        close: () => client.closed(new SidecarError("closed", "the sidecar's socket closed")),
        error: (_s, error) => client.closed(new SidecarError("closed", `the sidecar's socket failed: ${error.message}`)),
      },
    });
    try {
      await within(hello, opts.timeoutMs ?? 5_000, () => {
        throw new SidecarError("unavailable", "the sidecar said no hello");
      });
    } catch (error) {
      client.close();
      throw error;
    }
    return client;
  }

  get open(): boolean {
    return this.closedWith === null;
  }

  onClose(listener: (why: Error) => void): void {
    if (this.closedWith) listener(this.closedWith);
    else this.closeListeners.push(listener);
  }

  close(): void {
    try {
      this.socket?.end();
    } catch {
      // Already gone.
    }
    this.closed(new SidecarError("closed", "closed by the node"));
  }

  // ---- the wire ----

  private send(m: Msg): void {
    if (this.closedWith) throw this.closedWith;
    const body = cborEncode(m);
    if (body.length > MAX_MESSAGE_BYTES) throw new SidecarError("invalid", `a message of ${body.length} bytes is past the socket's ${MAX_MESSAGE_BYTES}`);
    const frame = new Uint8Array(4 + body.length);
    new DataView(frame.buffer).setUint32(0, body.length);
    frame.set(body, 4);
    this.outbound.push(frame);
    this.flush();
  }

  /** What the socket took so far is gone; the rest waits for its drain (Bun writes what fits, and says how much). */
  private flush(): void {
    while (this.outbound.length && !this.closedWith) {
      const head = this.outbound[0]!;
      const wrote = this.socket.write(head);
      if (wrote >= head.length) {
        this.outbound.shift();
        continue;
      }
      if (wrote > 0) this.outbound[0] = head.subarray(wrote);
      return;
    }
  }

  private received(chunk: Uint8Array): void {
    let messages: Msg[];
    try {
      messages = this.reader.push(chunk);
    } catch (error) {
      this.closed(new SidecarError("internal", (error as Error).message));
      this.socket.end();
      return;
    }
    for (const message of messages) {
      if (this.closedWith) return;
      this.dispatch(message);
    }
  }

  private closed(why: Error): void {
    if (this.closedWith) return;
    this.closedWith = why;
    this.helloWaiter?.reject(why);
    this.helloWaiter = null;
    for (const r of this.requests.values()) r.reject(why);
    this.requests.clear();
    for (const c of this.calls.values()) {
      c.done = true;
      c.reject(new SidecarError("unavailable", `the sidecar went away during the call: ${why.message}`));
      c.stream.end();
    }
    this.calls.clear();
    for (const t of this.tasks.values()) {
      t.done = true;
      t.abort.abort(why);
      t.input.end();
    }
    this.tasks.clear();
    for (const listener of this.closeListeners.splice(0)) listener(why);
  }

  private dispatch(m: Msg): void {
    const id = num(m.id);
    const task = num(m.task);
    switch (m.t) {
      case "hello": {
        if (num(m.api) !== SIDECAR_API) {
          this.helloWaiter?.reject(new SidecarError("invalid", `the sidecar speaks API ${String(m.api)}, this node ${SIDECAR_API}`));
          this.helloWaiter = null;
          return;
        }
        this.hello = { did: str(m.did) ?? "", keyType: m.key_type === "p256" ? "p256" : "ed25519", address: str(m.address), version: str(m.version) ?? "" };
        this.helloWaiter?.resolve();
        this.helloWaiter = null;
        return;
      }
      case "chunk": {
        const call = id !== null ? this.calls.get(id) : undefined;
        const chunk = chunkOf(m);
        if (!call || !chunk || call.discard) return;
        call.stream.push(chunk, frameBytes.get(m) ?? chunkBytes(chunk));
        if (call.stream.bytes > HOLD_MAX) {
          // Past its pause and more: the call ends here, and the sidecar is told to end it there.
          this.calls.delete(id!);
          call.done = true;
          this.trySend({ t: "cancel", id: id! });
          call.reject(new SidecarError("internal", `its peer sent past what this node holds for a call (${HOLD_MAX} bytes unread), though asked to hold`));
          call.stream.end();
          return;
        }
        if (!call.paused && call.stream.bytes > HOLD_BYTES) {
          call.paused = true;
          this.trySend({ t: "pause", id: id! });
        }
        return;
      }
      case "result":
      case "error": {
        if (id === null) return;
        const call = this.calls.get(id);
        if (call) {
          this.calls.delete(id);
          call.done = true;
          if (m.t === "result") call.resolve(jsonish(m.result));
          else call.reject(errorOf(m));
          call.stream.end();
          return;
        }
        const request = this.requests.get(id);
        if (!request) {
          // An error for the connection itself (id 0): the sidecar closes it after saying why.
          if (m.t === "error" && id === 0) this.closed(errorOf(m));
          return;
        }
        this.requests.delete(id);
        if (m.t === "error") request.reject(errorOf(m));
        else request.resolve(m);
        return;
      }
      case "invoke":
        return this.invoked(m);
      case "input": {
        const t = task !== null ? this.tasks.get(task) : undefined;
        const chunk = chunkOf(m);
        if (!t || !chunk) return;
        t.input.push(chunk, frameBytes.get(m) ?? chunkBytes(chunk));
        if (t.input.bytes > HOLD_MAX) {
          t.inv.fail(9, `its caller sent past what this node holds of a task's input (${HOLD_MAX} bytes unread), though asked to hold`);
          return;
        }
        if (!t.paused && t.input.bytes > HOLD_BYTES) {
          t.paused = true;
          this.trySend({ t: "pause", task: task! });
        }
        return;
      }
      case "input_end": {
        const t = task !== null ? this.tasks.get(task) : undefined;
        t?.input.end();
        return;
      }
      case "cancelled": {
        const t = task !== null ? this.tasks.get(task) : undefined;
        if (!t) return;
        this.tasks.delete(task!);
        t.done = true;
        t.outbox.length = 0;
        t.abort.abort(new SidecarError("cancelled", `the call ended before this node answered (${String(m.reason)})`));
        t.input.end();
        return;
      }
      case "pause":
      case "resume": {
        const hold = m.t === "pause";
        if (task !== null) {
          const t = this.tasks.get(task);
          if (!t) return;
          t.held = hold;
          if (!hold) t.flush();
          return;
        }
        if (id !== null) {
          const c = this.calls.get(id);
          if (!c) return;
          c.inputHeld = hold;
          if (!hold) this.release(c.outbox, () => c.inputHeld);
        }
        return;
      }
      default: {
        // A reply to a request (pong, ok, minted, revoked, grants, peers, peer, probed, webtransport).
        if (id === null) return;
        const request = this.requests.get(id);
        if (!request) return;
        this.requests.delete(id);
        if (request.want !== m.t) request.reject(new SidecarError("internal", `the sidecar answered ${m.t} to what wanted ${request.want}`));
        else request.resolve(m);
      }
    }
  }

  private release(outbox: Msg[], held: () => boolean): void {
    while (outbox.length && !held()) this.trySend(outbox.shift()!);
  }

  /** Sends, unless the socket is gone (then there is nobody left to tell). */
  private trySend(m: Msg): void {
    try {
      this.send(m);
    } catch {
      // Closed: what was under way has been ended already.
    }
  }

  private request(m: Msg, want: string, timeoutMs = 15_000): Promise<Msg> {
    const id = this.nextId++;
    return new Promise<Msg>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.requests.delete(id)) reject(new SidecarError("unavailable", `the sidecar didn't answer ${m.t} in ${timeoutMs} ms`));
      }, timeoutMs);
      this.requests.set(id, {
        want,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.send({ ...m, id });
      } catch (error) {
        this.requests.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  // ---- calling peers ----

  /** Calls a peer's tool: its chunks as they come, its result or why not. The first call to a peer dials it. */
  call(peer: string, tool: string, args: unknown, opts: CallOptions = {}): Call {
    const id = this.nextId++;
    let resolve!: (v: unknown) => void;
    let reject!: (e: Error) => void;
    const result = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // A result nobody waits for is no unhandled rejection.
    result.catch(() => {});
    const state: CallState = {
      stream: new Stream(() => {
        if (state.paused && state.stream.bytes < HOLD_BYTES / 4) {
          state.paused = false;
          this.trySend({ t: "resume", id });
        }
      }),
      resolve,
      reject,
      inputHeld: false,
      outbox: [],
      paused: false,
      discard: opts.discard === true,
      done: false,
    };
    const message: Msg = { t: "call", id, peer, tool, args: args ?? null };
    if (opts.chain) message.chain = opts.chain;
    if (opts.proofs?.length) message.proofs = opts.proofs;
    if (opts.deadlineMs !== undefined) message.deadline_ms = opts.deadlineMs;
    if (opts.priority !== undefined) message.priority = opts.priority;
    if (opts.meta) message.meta = opts.meta;
    if (opts.input) message.input = true;
    const cancel = () => {
      if (state.done) return;
      this.trySend({ t: "cancel", id });
    };
    if (opts.signal?.aborted) {
      state.done = true;
      reject(new SidecarError("cancelled", "cancelled before it began"));
      state.stream.end();
    } else {
      this.calls.set(id, state);
      try {
        this.send(message);
      } catch (error) {
        this.calls.delete(id);
        state.done = true;
        reject(error instanceof SidecarError ? new SidecarError("unsent", error.message) : (error as Error));
        state.stream.end();
      }
      opts.signal?.addEventListener("abort", cancel, { once: true });
      void result.finally(() => opts.signal?.removeEventListener("abort", cancel)).catch(() => {});
    }
    const queue = (m: Msg) => {
      if (state.done) return;
      if (state.inputHeld) state.outbox.push(m);
      else this.trySend(m);
    };
    return {
      id,
      chunks: state.stream,
      result,
      send: (chunk) => queue({ t: "input", id, ...chunk } as Msg),
      end: () => {
        // input_end is never held (SIDECAR.md): it follows what was queued, in order.
        if (state.done) return;
        if (state.outbox.length) state.outbox.push({ t: "input_end", id });
        else this.trySend({ t: "input_end", id });
      },
      cancel,
    };
  }

  // ---- serving tools ----

  /** Serves these tools (`public`: those any authenticated peer may call with no chain); each call goes to `handler`. */
  async serve(tools: ToolSpec[], publicTools: string[], handler: (inv: Invocation) => void): Promise<void> {
    this.handler = handler;
    await this.request({ t: "serve", tools, public: publicTools }, "ok");
  }

  async unserve(names: string[]): Promise<void> {
    await this.request({ t: "unserve", tools: names }, "ok");
  }

  private invoked(m: Msg): void {
    const task = num(m.task);
    if (task === null) return;
    const abort = new AbortController();
    const input = new Stream(() => {
      if (state.paused && input.bytes < HOLD_BYTES / 4) {
        state.paused = false;
        this.trySend({ t: "resume", task });
      }
    });
    if (!m.input) input.end();
    // What it sends goes at once unless the sidecar asked it to hold the task's output: then it waits, in order, its
    // complete or fail behind it, until resume (or the task's end). A task that would hold more than QUEUE_BYTES is given up.
    const flush = () => {
      while (state.outbox.length && !state.held) {
        const next = state.outbox.shift()!;
        this.trySend(next);
        if (next.t === "complete" || next.t === "fail") this.tasks.delete(task);
      }
      if (!state.outbox.length) state.outboxBytes = 0;
    };
    const out = (msg: Msg, terminal: boolean) => {
      if (state.done) return;
      if (terminal) {
        state.done = true;
        input.end();
      }
      state.outbox.push(msg);
      state.outboxBytes += msg.t === "emit" ? chunkBytes(msg as unknown as Chunk) : 16;
      if (state.held && !terminal && state.outboxBytes > QUEUE_BYTES) {
        state.outbox.length = 0;
        state.outboxBytes = 0;
        state.done = true;
        this.tasks.delete(task);
        this.trySend({ t: "fail", task, code: 10, message: "its caller took nothing for too long", retryable: true });
        abort.abort(new SidecarError("cancelled", "its caller took none of its output"));
        return;
      }
      flush();
    };
    const inv: Invocation = {
      task,
      tool: str(m.tool) ?? "",
      args: jsonish(m.args ?? null),
      caller: str(m.caller) ?? "",
      authorization: (jsonish(m.authorization) as Invocation["authorization"]) ?? { kind: "public" },
      chain: Array.isArray(m.chain) ? (jsonish(m.chain) as ChainLink[]) : [],
      meta: m.meta && typeof m.meta === "object" ? (jsonish(m.meta) as Record<string, unknown>) : null,
      deadlineMs: num(m.deadline_ms),
      input: m.input === true,
      signal: abort.signal,
      inputs: input,
      emit: (chunk) => out({ t: "emit", task, ...chunk } as Msg, false),
      progress: (progress, total, message) => out({ t: "progress", task, progress, ...(total !== undefined ? { total } : {}), ...(message !== undefined ? { message } : {}) }, false),
      complete: (result) => out({ t: "complete", task, result: result ?? null }, true),
      fail: (code, message, retryable, data) => out({ t: "fail", task, code, message, ...(retryable !== undefined ? { retryable } : {}), ...(data !== undefined ? { data } : {}) }, true),
    };
    const state: TaskState = { inv, flush, abort, input, held: false, outbox: [], outboxBytes: 0, paused: false, done: false };
    this.tasks.set(task, state);
    if (!this.handler) {
      inv.fail(1, "this node serves no tools");
      return;
    }
    try {
      this.handler(inv);
    } catch (error) {
      inv.fail(10, `the node failed the call: ${(error as Error).message}`.slice(0, 500));
    }
  }

  // ---- grants ----

  async mint(req: MintRequest): Promise<Minted> {
    const m: Msg = { t: "mint", aud: req.aud };
    if (req.tools) m.tools = req.tools;
    if (req.cmds) m.cmds = req.cmds;
    if (req.sub) m.sub = req.sub;
    if (req.pol) m.pol = req.pol;
    if (req.ttlSecs !== undefined) m.ttl_secs = req.ttlSecs;
    if (req.nbf !== undefined) m.nbf = req.nbf;
    if (req.meta) m.meta = req.meta;
    if (req.renewable) m.renewable = true;
    if (req.proof) m.proof = req.proof;
    return mintedOf(await this.request(m, "minted"));
  }

  async renew(grant: string, ttlSecs?: number): Promise<Minted> {
    return mintedOf(await this.request({ t: "renew", grant, ...(ttlSecs !== undefined ? { ttl_secs: ttlSecs } : {}) }, "minted"));
  }

  /** Revokes a grant (every token under it, and its renewals), or one token by its id: refused from the next call on. */
  async revoke(what: { grant: string } | { tokenId: string }): Promise<string[]> {
    const reply = await this.request("grant" in what ? { t: "revoke", grant: what.grant } : { t: "revoke", token_id: what.tokenId }, "revoked");
    return Array.isArray(reply.token_ids) ? reply.token_ids.filter((x): x is string => typeof x === "string") : [];
  }

  async grants(): Promise<unknown[]> {
    const reply = await this.request({ t: "grants" }, "grants");
    return Array.isArray(reply.grants) ? (jsonish(reply.grants) as unknown[]) : [];
  }

  // ---- peers and health ----

  async peers(): Promise<PeerInfo[]> {
    const reply = await this.request({ t: "peers" }, "peers");
    return (Array.isArray(reply.peers) ? reply.peers : []).map((p) => peerOf(p as Msg));
  }

  /** Dials a peer ahead of its first call. */
  async connect(peer: string, timeoutMs = 10_000): Promise<PeerInfo> {
    const reply = await this.request({ t: "connect", peer }, "peer", timeoutMs);
    return peerOf((reply.peer ?? {}) as Msg);
  }

  /** A PROBE datagram to a connected peer: whether its QUIC stack answered, and in how long. */
  async probe(did: string, timeoutMs?: number): Promise<{ alive: boolean; ms: number }> {
    const reply = await this.request({ t: "probe", did, ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}) }, "probed", (timeoutMs ?? 5_000) + 5_000);
    return { alive: reply.alive === true, ms: num(reply.ms) ?? 0 };
  }

  async ping(timeoutMs = 5_000): Promise<void> {
    await this.request({ t: "ping" }, "pong", timeoutMs);
  }
}

function errorOf(m: Msg): SidecarError {
  const kind = (["remote", "cancelled", "deadline", "unavailable", "invalid", "internal"] as const).find((k) => k === m.kind) ?? "internal";
  return new SidecarError(kind, str(m.message) ?? kind, num(m.code), m.retryable === true, m.data === undefined ? undefined : jsonish(m.data));
}

function mintedOf(m: Msg): Minted {
  const tokens = (Array.isArray(m.tokens) ? m.tokens : []).map((raw) => {
    const t = raw as Msg;
    return { cmd: str(t.cmd) ?? "", tokenId: str(t.token_id) ?? "", exp: num(t.exp) ?? 0, chain: str(t.chain) ?? "" };
  });
  return { grant: str(m.grant) ?? "", tokens };
}

function peerOf(p: Msg): PeerInfo {
  return {
    did: str(p.did) ?? "",
    address: str(p.address),
    version: str(p.version),
    transport: str(p.transport),
    rttUs: num(p.rtt_us),
    draining: p.draining === true,
    usable: p.usable === true,
    name: str(p.name),
  };
}
