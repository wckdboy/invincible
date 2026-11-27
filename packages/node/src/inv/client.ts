import { type DeviceId, judgeNodeProof, nodeChallenge, type NodeProven, type RouteName, routes, signRequest, type Signer, utf8, ZONE_HEADER } from "@invincible/core";
import { CliError, EXIT } from "./exit.ts";

/*
 * inv's way to its node: the same routes, scopes and checks as every client's (packages/core/src/api.ts), over HTTP.
 * Paired, every request is signed with this device's P-256 key over (method, path, time, nonce, the body's hash), as the
 * apps sign theirs. On a node's own machine, unpaired, it carries that node's admin token, over loopback only, as
 * `invincible` does. Either way, what went wrong is said with the exit code docs/CLI.md gives it: 31 when nothing (or
 * not the node) answered, 30 when the node refused this device, 1 for anything else it refused.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface NodeClient {
  /** What inv calls the node it talks to, in what it says: its name, or its address. */
  readonly label: string;
  call<T = unknown>(name: RouteName, input?: unknown, signal?: AbortSignal): Promise<T>;
  /** A route that answers with server-sent events (the live stream, a chat's turn): each event's data, as it comes. */
  events(name: RouteName, input?: unknown, signal?: AbortSignal): AsyncGenerator<string>;
}

/** How long a request may take before the node counts as not answering. */
export const CALL_TIMEOUT_MS = 60_000;
/** How long a stream's answer may take to begin (once it has, it goes on for as long as it has something to say). */
export const CONNECT_TIMEOUT_MS = 15_000;

/** This machine's time zone, a hint beside the signature (core's ZONE_HEADER): what time it is where you are. */
function zone(): Record<string, string> {
  try {
    const name = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return name ? { [ZONE_HEADER]: name } : {};
  } catch {
    return {};
  }
}

/** A gateway's answer for a node that is down (tailscale serve, a proxy): not the node, which always answers in JSON. */
const fromProxy = (response: Response): boolean =>
  (response.status === 502 || response.status === 503 || response.status === 504) && !(response.headers.get("content-type") ?? "").includes("application/json");

/** What the node said went wrong, with the code docs/CLI.md gives it. `unknown`: what a 401 means for this client. */
export function refusal(status: number, said: string | undefined, label: string, unknown: string): CliError {
  const why = said?.trim() || `${status}`;
  if (status === 401) return new CliError(unknown, EXIT.refused);
  if (status === 403) return new CliError(`${label} refused: ${why}${/scope/.test(why) ? " (this device was paired without it: invincible grant <device> <scope> on the node gives it)" : ""}`, EXIT.refused);
  return new CliError(why, EXIT.error);
}

/** An answer that came as whitespace and then JSON (a long-running route): the error it ended with, if any. */
function streamedError(body: unknown): { error: string; status: number } | null {
  if (body && typeof body === "object" && "error" in body && "status" in body) {
    const { error, status } = body as { error: unknown; status: unknown };
    if (typeof error === "string" && typeof status === "number") return { error, status };
  }
  return null;
}

/** Server-sent events: each event's `data`, its lines joined (a comment, the stream's beat, is no event). */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n?/g, "\n");
    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) yield data;
    }
  }
}

interface Way {
  base: string;
  label: string;
  /** What a 401 from this node means for this client, in words. */
  unknown: string;
  headers(method: string, path: string, body: Uint8Array): Promise<Record<string, string>>;
  fetch: FetchLike;
}

function client(way: Way): NodeClient {
  const root = way.base.replace(/\/+$/, "");
  const unreachable = (why: string) => new CliError(`${way.label} isn't answering at ${root} (${why})`, EXIT.unreachable);

  /** The answer, once it has begun; `limit` bounds how long that may take (and, unless `streaming`, the whole of it). */
  async function begin(name: RouteName, input: unknown, signal: AbortSignal | undefined, limit: AbortController): Promise<Response> {
    const route = routes[name];
    const body = route.method === "POST" ? utf8(JSON.stringify(input ?? {})) : new Uint8Array();
    let response: Response;
    try {
      response = await way.fetch(`${root}${route.path}`, {
        method: route.method,
        headers: { ...(await way.headers(route.method, route.path, body)), ...zone(), "content-type": "application/json" },
        body: route.method === "POST" ? body : undefined,
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, limit.signal]) : limit.signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw unreachable(limit.signal.aborted ? "no answer in time" : (error as Error).message);
    }
    if (fromProxy(response)) {
      await response.body?.cancel().catch(() => {});
      throw new CliError(`${way.label} isn't answering at ${root}: what answered (${response.status}) wasn't the node, which may be restarting`, EXIT.unreachable);
    }
    if (!response.ok) {
      const said = (await response.json().catch(() => ({}))) as { error?: string };
      throw refusal(response.status, said.error, way.label, way.unknown);
    }
    return response;
  }

  return {
    label: way.label,
    async call<T>(name: RouteName, input?: unknown, signal?: AbortSignal): Promise<T> {
      const limit = new AbortController();
      const timer = setTimeout(() => limit.abort(), CALL_TIMEOUT_MS);
      let text: string;
      try {
        const response = await begin(name, input, signal, limit);
        text = await response.text().catch((error: Error) => {
          if (signal?.aborted) throw error;
          throw unreachable(limit.signal.aborted ? "no answer in time" : error.message);
        });
      } finally {
        clearTimeout(timer);
      }
      let body: unknown;
      try {
        body = text.trim() ? JSON.parse(text) : {};
      } catch {
        throw new CliError(`${way.label} answered ${name} with something that isn't JSON`);
      }
      const failed = streamedError(body);
      if (failed) throw refusal(failed.status, failed.error, way.label, way.unknown);
      return body as T;
    },
    async *events(name: RouteName, input?: unknown, signal?: AbortSignal): AsyncGenerator<string> {
      const limit = new AbortController();
      const timer = setTimeout(() => limit.abort(), CONNECT_TIMEOUT_MS);
      let response: Response;
      try {
        response = await begin(name, input, signal, limit);
      } finally {
        clearTimeout(timer);
      }
      if (response.body) yield* sseData(response.body);
    },
  };
}

/** A paired device's client: every request signed with its key, for its node (`node`, as it proved: none, as before). */
export function signedClient(base: string, device: string, sign: Signer, opts: { label?: string; fetch?: FetchLike; node?: string } = {}): NodeClient {
  const label = opts.label ?? base;
  return client({
    base,
    label,
    unknown: `${label} doesn't know this device now (revoked, or never approved): pair it again with inv pair <invite>`,
    headers: (method, path, body) => signRequest(device, sign, method, path, body, Date.now(), opts.node as DeviceId | undefined),
    fetch: opts.fetch ?? fetch,
  });
}

/**
 * Whoami, proven: asked with a fresh challenge, which the node answers by signing it with the key its id is (the slice
 * 8 note's item 11), and judged against the node this device pinned (core's judgeNodeProof). Signed for no node, as
 * whoami's always is taken, so another node at this address still says which it is.
 */
export async function provenWhoami<T extends object>(base: string, device: string, sign: Signer, pinned: string | undefined, opts: { label?: string; fetch?: FetchLike } = {}): Promise<{ whoami: T & { proof?: string }; proven: NodeProven }> {
  const label = opts.label ?? base;
  const root = base.replace(/\/+$/, "");
  const challenge = nodeChallenge();
  const path = `${routes.whoami.path}?challenge=${challenge}`;
  let response: Response;
  try {
    response = await (opts.fetch ?? fetch)(`${root}${path}`, { method: "GET", headers: { ...(await signRequest(device, sign, "GET", path, new Uint8Array())), ...zone() }, redirect: "error", signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  } catch (error) {
    throw new CliError(`${label} isn't answering at ${root} (${(error as Error).message})`, EXIT.unreachable);
  }
  if (!response.ok) {
    const said = (await response.json().catch(() => ({}))) as { error?: string };
    throw refusal(response.status, said.error, label, `${label} doesn't know this device now (revoked, or never approved): pair it again with inv pair <invite>`);
  }
  const whoami = (await response.json()) as T & { node?: unknown; proof?: string };
  return { whoami, proven: judgeNodeProof(pinned, whoami, challenge) };
}

/** The words for a node that proved to be another than the one this device paired with, or whose proof failed. */
export function notTheNode(label: string, proven: NodeProven): CliError | null {
  if (proven.kind === "other") return new CliError(`${label} proved to be another node (${proven.node.slice(2, 10)}) than the one inv paired with: nothing more is sent to it. If your node moved, pair again: inv pair <invite>`, EXIT.refused);
  if (proven.kind === "false") return new CliError(`${label}'s proof of which node it is didn't hold: nothing more is sent to it`, EXIT.refused);
  return null;
}

/** The local node's client: its admin token, over loopback (the node refuses it anywhere else). */
export function adminClient(base: string, token: string, opts: { label?: string; fetch?: FetchLike } = {}): NodeClient {
  const label = opts.label ?? "this machine's node";
  return client({
    base,
    label,
    unknown: `${label} refused its own admin token: run inv as the user the node runs as, or pair it (inv pair <invite>)`,
    headers: async () => ({ authorization: `Bearer ${token}` }),
    fetch: opts.fetch ?? fetch,
  });
}
