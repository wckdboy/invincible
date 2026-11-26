import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  type BuiltMcpCall,
  canonical,
  ConnectorError,
  type ConnectorManifest,
  findSecrets,
  isMcpTool,
  type Json,
  libraryClass,
  localToolName,
  type McpTool,
  proposedClass,
  redact,
  sha256B64u,
} from "@galahad/core";
import type { Vault } from "@galahad/mind";
import { authFor, type ConnectorResult, keyState, MAX_RESPONSE_BYTES } from "./connectors.ts";
import { accessToken, type OAuthContext } from "./oauth.ts";

/*
 * Remote MCP servers as connectors. The node is the MCP client: it connects for one
 * job (list the tools, or call one), injects the key the way every connector does
 * (only if it was pinned to this origin, for this connector), and closes again.
 *
 * Same fences as request templates: every request stays on the pinned origin,
 * redirects are refused, answers are size-capped and redacted. The client declares
 * no capabilities but one, so a server can't ask Galahad to run a model or list
 * files: it can only answer, and, in a call made where you can be asked (`elicit`),
 * ask you a question in a form (elicitation's form mode alone), which waits in your
 * Inbox and is answered by you, never a model.
 */

export interface McpContext {
  vault: Vault;
  fetch?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** For a server you sign in to (mcp-oauth.ts): how a rotated sign-in is kept. */
  oauth?: Omit<OAuthContext, "vault" | "fetch">;
  /**
   * Where a question its server asks in the middle of a call goes (the node's questions.ts): to you, and its answer
   * back. Absent: the client says it takes none, and a server asks nothing.
   */
  elicit?: (params: { message?: unknown; requestedSchema?: unknown }, signal?: AbortSignal) => Promise<{ action: "accept" | "decline" | "cancel"; content?: Record<string, string | number | boolean | string[]> }>;
}

/** How long a call that may ask you a question is held at most: the question's wait, and the call's own time beside it. */
export const MCP_ELICIT_TIMEOUT_MS = 8 * 60_000;

/** A server you signed in to: a short-lived access token for this one job, never the sign-in itself. */
async function signedIn(ctx: McpContext, manifest: ConnectorManifest): Promise<{ headers: Record<string, string>; key: string }> {
  if (keyState(ctx.vault, manifest) === "wrong-origin") throw new ConnectorError(`the secret "${manifest.auth!.secret}" is pinned to another origin; it is never sent to ${manifest.origin}`);
  const key = await accessToken({ vault: ctx.vault, ...(ctx.fetch ? { fetch: ctx.fetch } : {}), ...ctx.oauth }, manifest).catch((error: Error) => {
    throw new ConnectorError(error.message);
  });
  return { headers: { authorization: `Bearer ${key}` }, key };
}

export interface DiscoveredTool {
  remote: string;
  description: string;
  params: Record<string, { type: string; description?: string; required?: boolean; enum?: string[] }>;
  hints: { readOnly?: boolean; destructive?: boolean };
  /** Digest of the server's definition: name, description and input schema. */
  schema: string;
}

const clip = (text: string, max: number) => {
  // Control characters out (a tool description is shown to people and models), whitespace collapsed.
  const clean = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

function guardedFetch(manifest: ConnectorManifest, base: typeof fetch, signal?: AbortSignal): (url: string | URL, init?: RequestInit) => Promise<Response> {
  const origin = new URL(manifest.origin).origin;
  return async (url, init) => {
    const target = new URL(String(url));
    // Belt and braces: whatever a server says (an endpoint event, a redirect), we only ever talk to the pinned origin.
    if (target.origin !== origin) throw new ConnectorError("refusing a request off the connector's origin");
    const signals = [init?.signal, signal].filter((s): s is AbortSignal => !!s);
    const response = await base(target, { ...init, redirect: "manual", ...(signals.length ? { signal: AbortSignal.any(signals) } : {}) });
    if (response.status >= 300 && response.status < 400) throw new ConnectorError(`the server redirected (${response.status}); redirects are never followed`);
    if (!response.body) return response;
    let size = 0;
    const capped = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          size += chunk.byteLength;
          if (size > MAX_RESPONSE_BYTES) controller.error(new ConnectorError(`the answer was over ${MAX_RESPONSE_BYTES / 1024} KB`));
          else controller.enqueue(chunk);
        },
      }),
    );
    return new Response(capped, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

async function withMcp<T>(ctx: McpContext, manifest: ConnectorManifest, work: (client: Client, timeout: number) => Promise<T>): Promise<{ value: T; key: string | null }> {
  if (!manifest.mcp) throw new ConnectorError(`${manifest.id} is not an MCP server`);
  const { headers, key } = manifest.auth?.scheme === "oauth" ? await signedIn(ctx, manifest) : authFor(ctx.vault, manifest);
  const transport = new StreamableHTTPClientTransport(new URL(`${manifest.origin}${manifest.mcp.path}`), {
    fetch: guardedFetch(manifest, ctx.fetch ?? fetch, ctx.signal),
    requestInit: { headers: { "user-agent": "galahad/0.1 (+https://galahad.bot)", ...(manifest.headers ?? {}), ...headers } },
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
  });
  const elicit = ctx.elicit;
  const client = new Client({ name: "galahad", version: "0.1.0" }, { capabilities: elicit ? { elicitation: {} } : {} });
  // A question mid-call, in a form (its URL mode, which would send you to a page of the server's, is declined).
  if (elicit) client.setRequestHandler(ElicitRequestSchema, async (request, extra) => (request.params.mode === "url" ? { action: "decline" as const } : await elicit(request.params, extra.signal)));
  // MCP tools are often model-backed and slow: two minutes for the call (connecting gets 30 s).
  const timeout = ctx.timeoutMs ?? 120_000;
  try {
    await client.connect(transport, { timeout: Math.min(timeout, 30_000), ...(ctx.signal ? { signal: ctx.signal } : {}) });
    return { value: await work(client, timeout), key };
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    const message = redact(String((error as Error)?.message ?? error), key ? [key] : []);
    if (/\b401\b|unauthori[sz]ed/i.test(message)) throw new ConnectorError(`${manifest.label} refused the request without a valid key (401)`);
    if (/\b403\b|forbidden/i.test(message)) throw new ConnectorError(`${manifest.label} refused: the key isn't allowed to do that (403)`);
    throw error;
  } finally {
    await transport.terminateSession().catch(() => {});
    await client.close().catch(() => {});
  }
}

function summarizeSchema(schema: unknown): { params: DiscoveredTool["params"] } {
  const params: DiscoveredTool["params"] = {};
  const s = (schema && typeof schema === "object" ? schema : {}) as { properties?: Record<string, unknown>; required?: unknown };
  const required = new Set(Array.isArray(s.required) ? s.required.filter((r): r is string => typeof r === "string") : []);
  for (const [name, raw] of Object.entries(s.properties ?? {}).slice(0, 64)) {
    if (!/^.{1,64}$/u.test(name)) continue;
    const p = (raw && typeof raw === "object" ? raw : {}) as { type?: unknown; anyOf?: unknown; oneOf?: unknown; description?: unknown; enum?: unknown };
    const types = new Set<string>();
    const add = (t: unknown) => {
      if (typeof t === "string") types.add(t);
      else if (Array.isArray(t)) for (const x of t) add(x);
    };
    add(p.type);
    for (const alt of [p.anyOf, p.oneOf]) if (Array.isArray(alt)) for (const a of alt) add((a as { type?: unknown })?.type);
    types.delete("null");
    const enumValues = Array.isArray(p.enum) ? p.enum.filter((v): v is string => typeof v === "string").slice(0, 64).map((v) => v.slice(0, 100)) : [];
    params[name] = {
      type: types.size ? [...types].sort().join("|").slice(0, 40) : "any",
      ...(typeof p.description === "string" && p.description.trim() ? { description: clip(p.description, 300) } : {}),
      ...(required.has(name) ? { required: true } : {}),
      ...(enumValues.length ? { enum: enumValues } : {}),
    };
  }
  return { params };
}

/** What a tool is pinned by: the digest of its server's definition (its name, description and input schema). */
const pinOf = (tool: { name: string; description?: string; inputSchema?: unknown }): string => sha256B64u(canonical({ name: tool.name, description: tool.description ?? null, inputSchema: (tool.inputSchema ?? null) as Json }));

/** List the server's tools (all pages, at most 500). */
export async function discoverMcpTools(ctx: McpContext, manifest: ConnectorManifest): Promise<{ server: string | null; tools: DiscoveredTool[] }> {
  const { value } = await withMcp(ctx, manifest, async (client, timeout) => {
    const tools: DiscoveredTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20 && tools.length < 500; page++) {
      const listed = await client.listTools(cursor ? { cursor } : undefined, { timeout });
      for (const tool of listed.tools) {
        const annotations = (tool.annotations ?? {}) as { readOnlyHint?: unknown; destructiveHint?: unknown };
        tools.push({
          remote: tool.name.slice(0, 128),
          description: clip(tool.description ?? tool.title ?? tool.name, 1000),
          ...summarizeSchema(tool.inputSchema),
          hints: {
            ...(typeof annotations.readOnlyHint === "boolean" ? { readOnly: annotations.readOnlyHint } : {}),
            ...(typeof annotations.destructiveHint === "boolean" ? { destructive: annotations.destructiveHint } : {}),
          },
          schema: pinOf(tool),
        });
      }
      cursor = listed.nextCursor;
      if (!cursor) break;
    }
    const info = client.getServerVersion();
    return { server: info ? `${info.name} ${info.version}`.slice(0, 128) : null, tools };
  });
  return value;
}

/** One tool as its server defines it now: its whole description, its input schema and its pin; null if it has none by that name. */
export async function describeMcpTool(ctx: McpContext, manifest: ConnectorManifest, remote: string): Promise<{ description: string; inputSchema: unknown; schema: string } | null> {
  const { value } = await withMcp(ctx, manifest, async (client, timeout) => {
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const listed = await client.listTools(cursor ? { cursor } : undefined, { timeout });
      const tool = listed.tools.find((t) => t.name === remote);
      if (tool) return { description: tool.description ?? tool.title ?? tool.name, inputSchema: tool.inputSchema ?? null, schema: pinOf(tool) };
      cursor = listed.nextCursor;
      if (!cursor) break;
    }
    return null;
  });
  return value;
}

type Content = { type: string; text?: string; mimeType?: string; data?: string; uri?: string; resource?: { uri?: string; text?: string } };

/** One tools/call. A tool that reports an error comes back as a result that isn't ok, not as a failure to reach it. */
export async function callMcpTool(ctx: McpContext, manifest: ConnectorManifest, call: BuiltMcpCall): Promise<ConnectorResult> {
  const started = performance.now();
  let key: string | null = null;
  let ok: boolean;
  let text: string;
  // A call that may ask you is held to its own time while it works, and that time stops while its question waits on you:
  // a server that hangs is cut off as soon as ever, and one that asks you isn't for the minutes you take to answer.
  const own = ctx.timeoutMs ?? 120_000;
  const held = new AbortController();
  let clock: ReturnType<typeof setTimeout> | undefined;
  const run = () => void (clock = setTimeout(() => held.abort(new McpError(ErrorCode.RequestTimeout, "Request timed out")), own));
  const asks = ctx.elicit;
  const elicit: McpContext["elicit"] = asks
    ? async (params, signal) => {
        clearTimeout(clock);
        try {
          return await asks(params, signal);
        } finally {
          if (!held.signal.aborted) run();
        }
      }
    : undefined;
  try {
    run();
    const done = await withMcp({ ...ctx, ...(elicit ? { elicit } : {}) }, manifest, (client, timeout) =>
      client.callTool({ name: call.remote, arguments: call.args as Record<string, unknown> }, undefined, elicit ? { timeout: Math.max(timeout, MCP_ELICIT_TIMEOUT_MS), signal: held.signal } : { timeout }),
    );
    key = done.key;
    const result = done.value as { content?: Content[]; structuredContent?: unknown; isError?: boolean; toolResult?: unknown };
    ok = !result.isError;
    const parts = (result.content ?? []).map((c) => {
      if (c.type === "text") return c.text ?? "";
      if (c.type === "resource") return c.resource?.text ?? `[resource ${c.resource?.uri ?? ""}]`;
      if (c.type === "resource_link") return `[link ${c.uri ?? ""}]`;
      return `[${c.type}${c.mimeType ? ` ${c.mimeType}` : ""}${c.data ? `, ${Math.round((c.data.length * 3) / 4)} bytes` : ""}]`;
    });
    text = parts.join("\n").trim();
    if (!text && result.structuredContent !== undefined) text = JSON.stringify(result.structuredContent);
    if (!text && result.toolResult !== undefined) text = JSON.stringify(result.toolResult);
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    const name = (error as Error)?.constructor?.name ?? "";
    // The server answered, but refused the call (unknown tool, bad arguments): that is its answer.
    if (name === "McpError" || /MCP error/.test(String((error as Error)?.message))) {
      ok = false;
      text = String((error as Error).message);
    } else throw error;
  } finally {
    clearTimeout(clock);
  }
  const clean = redact(text, key ? [key, Buffer.from(key).toString("base64")] : []);
  const clipped = clean.length > 60_000;
  return {
    ok,
    status: 200,
    contentType: "text/plain",
    body: clipped ? clean.slice(0, 60_000) : clean,
    truncated: clipped,
    durationMs: Math.round(performance.now() - started),
    mcp: true,
  };
}

/** As much of one connector as the mind keeps (an event is at most 64 KB): its manifest's JSON, in characters. */
export const MCP_TOOLS_BUDGET = 48 * 1024;

/**
 * A big server's tools as the mind can keep them: their descriptions shortened, step by step, until the whole fits in
 * `budget` (as `size` measures it). Names, classes, pins and arguments stay as they are, and connector_tool reads any
 * tool in full from its server. Null when even the shortest won't fit.
 */
export function fitMcpTools(tools: Record<string, McpTool>, size: (tools: Record<string, McpTool>) => number, budget = MCP_TOOLS_BUDGET): Record<string, McpTool> | null {
  if (size(tools) <= budget) return tools;
  for (const [about, each] of [[400, 160], [240, 80], [160, 0], [100, 0]] as const) {
    const fitted: Record<string, McpTool> = {};
    for (const [name, tool] of Object.entries(tools)) {
      const params = tool.params && Object.fromEntries(Object.entries(tool.params).map(([k, { description, ...param }]) => [k, each && description ? { ...param, description: clip(description, each) } : param]));
      fitted[name] = { ...tool, description: clip(tool.description, about), ...(params ? { params } : {}) };
    }
    if (size(fitted) <= budget) return fitted;
  }
  return null;
}

export interface MergeOptions {
  /** Install only these (server names). */
  only?: string[];
  /** Your class for a tool (by server or local name); "*" for every tool you don't name, including ones classified before. */
  classes?: Record<string, ConnectorManifest["tools"][string]["class"]>;
  /** The reviewed library's proposal by tool name (core MCP_TOOL_CLASSES): after your choices, before the server's hints. */
  proposed?: readonly (readonly [string, ConnectorManifest["tools"][string]["class"]])[];
}

export interface MergeReport {
  added: string[];
  changed: string[];
  removed: string[];
  skipped: number;
}

/**
 * Discovered tools → manifest tools. What you decided before stays: a tool keeps
 * its local name and the class you gave it. New tools start from the server's hints
 * (read-only → read, destructive → delete, otherwise outward, which asks you).
 */
export function mergeMcpTools(
  discovered: DiscoveredTool[],
  previous: ConnectorManifest["tools"],
  opts: MergeOptions = {},
): { tools: Record<string, McpTool>; report: MergeReport } {
  const before = new Map(Object.entries(previous).flatMap(([local, tool]) => (isMcpTool(tool) ? [[tool.remote, { local, tool }] as const] : [])));
  const only = opts.only?.length ? new Set(opts.only) : null;
  const wanted = discovered.filter((tool) => !only || only.has(tool.remote));
  const taken = new Set<string>();
  const tools: Record<string, McpTool> = {};
  const report: MergeReport = { added: [], changed: [], removed: [], skipped: discovered.length - wanted.length };
  // Names we already gave stay put, so standing orders and loops keep pointing at the same tool.
  for (const tool of wanted) {
    const old = before.get(tool.remote);
    if (old) taken.add(old.local);
  }
  for (const tool of wanted) {
    const old = before.get(tool.remote);
    const local = old?.local ?? localToolName(tool.remote, taken);
    taken.add(local);
    // Yours, in order: this tool by name, "*" given now, what you chose before; else the reviewed library's, else the hints'.
    const chosen = opts.classes?.[tool.remote] ?? opts.classes?.[local] ?? opts.classes?.["*"] ?? old?.tool.class ?? libraryClass(opts.proposed, tool.remote) ?? proposedClass(tool.hints);
    const description = findSecrets(tool.description).length ? "(the server's description was withheld: it looked like a key)" : tool.description;
    const hints = Object.keys(tool.hints).length ? { hints: tool.hints } : {};
    tools[local] = {
      remote: tool.remote,
      description,
      ...(Object.keys(tool.params).length ? { params: tool.params } : {}),
      class: chosen,
      schema: tool.schema,
      ...hints,
    };
    if (!old) report.added.push(local);
    else if (old.tool.schema !== tool.schema) report.changed.push(local);
  }
  for (const [remote, { local }] of before) if (!wanted.some((t) => t.remote === remote)) report.removed.push(local);
  return { tools, report };
}
