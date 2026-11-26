import type { ChatStreamEvent } from "@galahad/core";
import { utf8 } from "@galahad/core/bytes";
import { signRequest, ZONE_HEADER } from "@galahad/core/request-auth";
import { type BrowserIdentity, signerFor } from "./identity.ts";

/*
 * Every /api request is signed with this browser's device key over
 * (method, path, time, nonce, body hash) and sent with exactly those bytes.
 * Requests always go to this page's own origin (HTTPS via tailscale serve).
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The node's clock (from its Date header), to tell a skewed device clock from a revoked key. */
    readonly serverTime: number | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** True when the node doesn't have this feature (yet): unknown route, or a capability it lacks. */
export const isUnavailable = (error: unknown): boolean => error instanceof ApiError && (error.status === 404 || error.status === 424 || error.status === 501);

export const isAbort = (error: unknown): boolean => error instanceof DOMException && error.name === "AbortError";

type Handler = (error: ApiError) => void;
let onUnauthorized: Handler = () => {};
let onNetwork: (ok: boolean) => void = () => {};
export const setUnauthorizedHandler = (handler: Handler): void => {
  onUnauthorized = handler;
};
/** Called with false when a request fails at the network layer, true when one succeeds. */
export const setNetworkHandler = (handler: (ok: boolean) => void): void => {
  onNetwork = handler;
};

/** A gateway error that isn't the node's own (the node always answers in JSON): the proxy in front of it. */
const fromProxy = (response: Response): boolean =>
  (response.status === 502 || response.status === 503 || response.status === 504) && !(response.headers.get("content-type") ?? "").includes("application/json");

/** This device's time zone as the node reads it (core's ZONE_HEADER), or nothing where the browser doesn't say. */
function zoneHeader(): Record<string, string> {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone ? { [ZONE_HEADER]: zone } : {};
  } catch {
    return {};
  }
}

async function signedFetch(identity: BrowserIdentity, method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
  const bytes = body === undefined ? new Uint8Array() : utf8(JSON.stringify(body));
  const headers = await signRequest(identity.device, signerFor(identity), method, path, bytes);
  let response: Response;
  try {
    response = await fetch(`${location.origin}${path}`, {
      method,
      // This device's time zone, for the time he says it is in an answer to you (beside the signature: only a hint).
      headers: { ...headers, ...zoneHeader(), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: method === "GET" ? undefined : bytes,
      signal,
      cache: "no-store",
    });
  } catch (error) {
    if (!isAbort(error)) onNetwork(false);
    throw error;
  }
  if (fromProxy(response)) {
    // `tailscale serve` answering for a node that's restarting or down: the node is away, not refusing.
    onNetwork(false);
    await response.body?.cancel().catch(() => {});
    throw new ApiError(response.status, `Galahad's node isn't answering (${response.status}). It may be restarting.`);
  }
  onNetwork(true);
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    const date = Date.parse(response.headers.get("date") ?? "");
    const error = new ApiError(response.status, payload.error ?? `${response.status} ${response.statusText}`, Number.isFinite(date) ? date : null);
    if (response.status === 401) onUnauthorized(error);
    throw error;
  }
  return response;
}

/** A file the node sent as bytes, with how it said to treat them. */
export interface Bytes {
  data: Uint8Array;
  /** The node's content type (it decides what may be shown inline). */
  type: string;
}

/**
 * The POSTs that change nothing: they leave what the places showed as it was (and keep their own answers), where any
 * other POST forgets it all. Every route whose scope is a reading one, and these few that read under another scope:
 * the doctor (it changes nothing), watching a turn, opening a kept chat, listing sandboxes, a task's trail and its steps,
 * and a room.
 * api.test.ts holds the list to the routes. Kept here, not read from the routes, so the app's bundle carries no schema.
 */
export const READS_UNDER_OTHER_SCOPES = ["/api/doctor", "/api/turns/attach", "/api/conversations/get", "/api/sandboxes/list", "/api/team/trail", "/api/team/steps", "/api/team/room"] as const;
export const READING_POSTS: ReadonlySet<string> = new Set([
  ...READS_UNDER_OTHER_SCOPES,
  "/api/team/overview",
  "/api/memories/search",
  "/api/providers/models",
  "/api/place",
  "/api/loops/runs",
  "/api/away",
  "/api/heartbeat",
  "/api/usage",
  "/api/bank/balances",
  "/api/bank/transactions",
  "/api/artifacts/file",
  "/api/archive/search",
  "/api/connectors/library",
  "/api/archive/entry",
  "/api/archive/file",
  "/api/skills/get",
  "/api/notify/subscribe",
  "/api/notify/apple",
  "/api/notify/collect/on",
  "/api/notify/collect",
  "/api/notify/unsubscribe",
  "/api/notify/test",
]);

/** At most this many places' last answers are kept. */
const KEPT_ANSWERS = 64;

export interface Api {
  get<T>(path: string, signal?: AbortSignal): Promise<T>;
  /**
   * What this address answered last this session, for a GET or a POST that changes nothing (by what it was asked):
   * undefined when nothing yet, or something changed since. A place shows it at once on a revisit and asks again;
   * anything you change through a POST forgets it all.
   */
  peek<T>(path: string, body?: unknown): T | undefined;
  post<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T>;
  /** A POST whose answer is bytes (an artifact's file), not JSON. */
  bytes(path: string, body: unknown, signal?: AbortSignal): Promise<Bytes>;
  chat(body: unknown, signal: AbortSignal): AsyncGenerator<ChatStreamEvent>;
  /** A POST that answers with a turn's events (watching a turn the node runs, a side question). Aborting the signal ends the watching, never the turn. */
  events(path: string, body: unknown, signal: AbortSignal): AsyncGenerator<ChatStreamEvent>;
  /** A POST that answers with events of another kind (a terminal's screen). Aborting the signal ends the watching. */
  stream<T>(path: string, body: unknown, signal: AbortSignal): AsyncGenerator<T>;
  /**
   * A GET that answers with events as they come (the node's live stream): `alive` is told of everything that arrives,
   * its keep-alives too, so a stream gone quiet can be told from a dead one. Aborting the signal ends it.
   */
  listen<T>(path: string, signal: AbortSignal, alive?: () => void): AsyncGenerator<T>;
}

/**
 * A long-running answer (creating a sandbox, keeping its work) has already sent
 * 200 when the work fails, so the failure arrives as exactly `{ error, status }`.
 */
function lateError(payload: unknown): ApiError | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { error?: unknown; status?: unknown };
  return Object.keys(p).length === 2 && typeof p.error === "string" && typeof p.status === "number" ? new ApiError(p.status, p.error) : null;
}

export function apiFor(identity: BrowserIdentity): Api {
  async function* stream<T>(path: string, body: unknown, signal: AbortSignal): AsyncGenerator<T> {
    const response = await signedFetch(identity, "POST", path, body, signal);
    if (!response.body) return;
    for await (const data of sseData(response.body)) {
      try {
        yield JSON.parse(data) as T;
      } catch {
        /* ignore malformed frames */
      }
    }
  }
  // What each address answered last (api.peek), forgotten whole by anything that changes something.
  const kept = new Map<string, unknown>();
  const keyOf = (path: string, body?: unknown) => (body === undefined ? path : `${path} ${JSON.stringify(body)}`);
  const keep = (key: string, answer: unknown) => {
    kept.delete(key);
    kept.set(key, answer);
    if (kept.size > KEPT_ANSWERS) kept.delete(kept.keys().next().value!);
  };
  const reading = (path: string) => READING_POSTS.has(path.split("?")[0]!);
  const changing = (path: string) => {
    if (!reading(path)) kept.clear();
  };
  // A read asked for with no signal (ahead of a tap: lib/prefetch.ts) while it's on its way is shared by whoever asks
  // for the same; one asked for with a signal, which may end it, is never shared.
  const flying = new Map<string, Promise<unknown>>();
  const share = <T>(key: string, signal: AbortSignal | undefined, ask: () => Promise<T>): Promise<T> => {
    const on = flying.get(key);
    if (on) return on as Promise<T>;
    const asking = ask();
    if (!signal) {
      flying.set(key, asking);
      void asking.finally(() => flying.get(key) === asking && flying.delete(key)).catch(() => {});
    }
    return asking;
  };
  const events = (path: string, body: unknown, signal: AbortSignal) => {
    changing(path);
    return stream<ChatStreamEvent>(path, body, signal);
  };
  async function* listen<T>(path: string, signal: AbortSignal, alive?: () => void): AsyncGenerator<T> {
    const response = await signedFetch(identity, "GET", path, undefined, signal);
    if (!response.body) return;
    for await (const data of sseData(response.body, alive)) {
      try {
        yield JSON.parse(data) as T;
      } catch {
        /* ignore malformed frames */
      }
    }
  }
  return {
    get<T>(path: string, signal?: AbortSignal) {
      const key = keyOf(path);
      return share(key, signal, async () => {
        const answer = (await (await signedFetch(identity, "GET", path, undefined, signal)).json()) as T;
        keep(key, answer);
        return answer;
      });
    },
    peek: <T>(path: string, body?: unknown) => kept.get(keyOf(path, body)) as T | undefined,
    post<T>(path: string, body: unknown = {}, signal?: AbortSignal) {
      const send = async () => {
        const payload = await (await signedFetch(identity, "POST", path, body, signal)).json();
        const late = lateError(payload);
        if (late) throw late;
        if (reading(path)) keep(keyOf(path, body), payload);
        return payload as T;
      };
      if (reading(path)) return share(keyOf(path, body), signal, send);
      changing(path);
      return send();
    },
    async bytes(path: string, body: unknown, signal?: AbortSignal) {
      changing(path);
      const response = await signedFetch(identity, "POST", path, body, signal);
      return { data: new Uint8Array(await response.arrayBuffer()), type: response.headers.get("content-type") ?? "application/octet-stream" };
    },
    chat: (body: unknown, signal: AbortSignal) => events("/api/chat", body, signal),
    events,
    stream,
    listen,
  };
}

/** Server-sent events reader; skips ": keep-alive" comments, though `alive` hears of everything that arrives. */
export async function* sseData(body: ReadableStream<Uint8Array>, alive?: () => void): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      alive?.();
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of block.split("\n")) {
          if (line.startsWith("data:")) yield line.slice(5).trimStart();
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** How long a pairing request may take before the page says it can't reach the node. */
export const PAIR_TIMEOUT_MS = 12_000;

/**
 * Unauthenticated pairing endpoints (the invite proof is the credential). Never waits
 * forever: a stalled connection (Tailscale reconnecting, a phone changing networks) or
 * an unreachable node becomes ApiError(0), which callers treat as "retry, and say so".
 */
export async function pairPost<T>(path: "/link/pair/request" | "/link/pair/status", body: unknown, timeoutMs = PAIR_TIMEOUT_MS): Promise<T> {
  let response: Response;
  let payload: T & { error?: string };
  try {
    response = await fetch(`${location.origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  } catch (error) {
    const timedOut = error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new ApiError(0, timedOut ? `No answer from ${location.host} within ${Math.round(timeoutMs / 1000)} s` : `Can't reach ${location.host}`);
  }
  if (!response.ok) throw new ApiError(response.status, payload.error ?? `${response.status}`);
  return payload;
}

/**
 * Can this device reach the node right now? A deliberately empty status request: any
 * answer at all (it's refused as malformed) proves the path works. Never cached (POST),
 * so a page the service worker served from cache can't pretend to be connected.
 */
export async function nodeReachable(timeoutMs = 6000): Promise<boolean> {
  try {
    await pairPost("/link/pair/status", {}, timeoutMs);
    return true;
  } catch (error) {
    return !(error instanceof ApiError && error.status === 0);
  }
}
