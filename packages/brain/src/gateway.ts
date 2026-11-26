import type { Database } from "bun:sqlite";
import { randomId, redact, sha256B64u, type Usage } from "@galahad/core";
import type { MindStore, Vault } from "@galahad/mind";
import { usageReader } from "./gateway-usage.ts";
import { gatewaySession, keyHeaders, planOf, resolveProvider } from "./providers.ts";
import { refusedKeysOf } from "./refused-keys.ts";
import { clockUtc, retryAfterAt, spanWords, windowScope, windowsOf, type SpentWindow, type SpentWindows } from "./windows.ts";

/*
 * The model gateway: how arms (OpenCode, Claude Code, Codex, Hermes, sandboxes)
 * use your API keys without ever seeing them.
 *
 *   OPENAI_BASE_URL    = http://127.0.0.1:<port>/gw/deepseek
 *   ANTHROPIC_BASE_URL = http://127.0.0.1:<port>/gw/anthropic
 *   *_API_KEY          = gw_…  (scoped to providers, expires, capped, revocable)
 *
 * The gateway injects the real key on the way out. A prompt-injected arm can at
 * worst burn its own capped token; it can never exfiltrate the provider key.
 * Tokens are node-local (never replicated) and stored only as hashes.
 */

export interface TokenScope {
  label: string;
  providers?: string[];
  /** The models it is good for alone, as `provider/model`, whatever its providers serve (a lease for work in sensitive mode). */
  models?: string[];
  ttlMinutes: number;
  maxRequests: number;
}

export interface TokenInfo {
  hash: string;
  label: string;
  providers: string[] | null;
  models: string[] | null;
  expiresAt: number;
  maxRequests: number;
  used: number;
}

export class GatewayTokens {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS gw_tokens (
      hash TEXT PRIMARY KEY, label TEXT NOT NULL, providers TEXT, expires_at INTEGER NOT NULL,
      max_requests INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, models TEXT)`);
    // (A token from before a lease could be held to models has none: good for any model of its providers, as it was.)
    if (!db.query<{ name: string }, []>("PRAGMA table_info(gw_tokens)").all().some((column) => column.name === "models")) db.exec("ALTER TABLE gw_tokens ADD COLUMN models TEXT");
  }

  mint(scope: TokenScope): { token: string; info: TokenInfo } {
    const token = `gw_${randomId(32)}`;
    const hash = sha256B64u(token);
    const expiresAt = this.now() + scope.ttlMinutes * 60_000;
    this.db
      .query("INSERT INTO gw_tokens (hash, label, providers, models, expires_at, max_requests, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(hash, scope.label, scope.providers ? JSON.stringify(scope.providers) : null, scope.models?.length ? JSON.stringify(scope.models) : null, expiresAt, scope.maxRequests, this.now());
    return { token, info: this.info(hash)! };
  }

  /** Atomically checks scope and consumes one request. */
  consume(token: string, provider: string): { ok: true } | { ok: false; reason: string } {
    if (!/^gw_[A-Za-z0-9_-]{43}$/.test(token)) return { ok: false, reason: "not a gateway token" };
    const hash = sha256B64u(token);
    const info = this.info(hash);
    if (!info) return { ok: false, reason: "unknown token" };
    if (info.expiresAt <= this.now()) return { ok: false, reason: "token expired" };
    if (info.providers && !info.providers.includes(provider)) return { ok: false, reason: `token not valid for ${provider}` };
    const updated = this.db
      .query("UPDATE gw_tokens SET used = used + 1 WHERE hash = ? AND used < max_requests")
      .run(hash).changes;
    return updated ? { ok: true } : { ok: false, reason: "token request budget exhausted" };
  }

  revoke(hash: string): boolean {
    return this.db.query("DELETE FROM gw_tokens WHERE hash = ?").run(hash).changes > 0;
  }

  /**
   * The same token, valid `ttlMinutes` more from now and with `maxRequests` more than it has used: a lease kept while its
   * work runs, so whatever holds it works on. Never one that has lapsed or was revoked (false).
   */
  extend(hash: string, scope: { ttlMinutes: number; maxRequests: number }): boolean {
    const now = this.now();
    return this.db.query("UPDATE gw_tokens SET expires_at = ?, max_requests = used + ? WHERE hash = ? AND expires_at > ?").run(now + scope.ttlMinutes * 60_000, scope.maxRequests, hash, now).changes > 0;
  }

  list(): TokenInfo[] {
    return this.db
      .query<TokenRow, []>("SELECT * FROM gw_tokens ORDER BY created_at DESC")
      .all()
      .map(toInfo);
  }

  /** The label a token was minted with (e.g. "sandbox:<id>"), without spending it; null if it isn't one. */
  labelOf(token: string): string | null {
    if (!/^gw_[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return this.info(sha256B64u(token))?.label ?? null;
  }

  /** Everything a token is scoped to (its providers, a repository's git:…, a key's key:…); null: not a token, or one good for any. */
  scopesOf(token: string): string[] | null {
    if (!/^gw_[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return this.info(sha256B64u(token))?.providers ?? null;
  }

  /** The models a token is good for alone (a lease for work in sensitive mode); null: any of its providers'. */
  modelsOf(token: string): string[] | null {
    if (!/^gw_[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return this.info(sha256B64u(token))?.models ?? null;
  }

  private info(hash: string): TokenInfo | null {
    const row = this.db.query<TokenRow, [string]>("SELECT * FROM gw_tokens WHERE hash = ?").get(hash);
    return row ? toInfo(row) : null;
  }
}

interface TokenRow {
  hash: string;
  label: string;
  providers: string | null;
  models: string | null;
  expires_at: number;
  max_requests: number;
  used: number;
}

const toInfo = (row: TokenRow): TokenInfo => ({
  hash: row.hash,
  label: row.label,
  providers: row.providers ? (JSON.parse(row.providers) as string[]) : null,
  models: row.models ? (JSON.parse(row.models) as string[]) : null,
  expiresAt: row.expires_at,
  maxRequests: row.max_requests,
  used: row.used,
});

const FORWARDED_HEADERS = ["content-type", "accept", "anthropic-version", "anthropic-beta", "openai-beta", "user-agent"];

export interface GatewayContext {
  store: MindStore;
  vault: Vault;
  tokens: GatewayTokens;
  fetch?: typeof fetch;
  /**
   * Each model call a tool made through the gateway, once its answer has ended: who called (its token's label), the
   * provider and the model it asked for, and its tokens as the answer said them (null: it said none). Read as the
   * answer is forwarded (gateway-usage.ts), never changing or holding back a byte of it.
   */
  onUsage?(call: { label: string; provider: string; model: string; usage: Usage | null }): void;
}

/** The model a call asks for, from its body (JSON with a `model`), or "unknown". */
function modelOf(body: ArrayBuffer | undefined): string {
  if (!body || body.byteLength > 4 << 20) return "unknown";
  try {
    const model = (JSON.parse(new TextDecoder().decode(body)) as { model?: unknown }).model;
    return typeof model === "string" && /^[\x21-\x7e]{1,200}$/.test(model) ? model : "unknown";
  } catch {
    return "unknown";
  }
}

const json = (status: number, error: string) =>
  Response.json({ error: { type: "galahad_gateway", message: error } }, { status });

/*
 * A plan's allowance spent, as a tool hears it. Told by its provider to try again in a day and a half, OpenCode 2.3.0
 * waits fifteen minutes and asks again, for as long as that lasts, and Codex 0.169.0 waits all of it; told 402, each ends
 * within seconds, as Claude Code does either way, and the next model on a knight's list takes over (measured 21 Nov
 * 2026). So a window that ends later than WAIT_OUT_MS is said as a spent quota, with no time to wait for, in words that
 * Hermes too takes as final (it reads "usage limit" or "quota" beside "resets in" as a wait). A shorter one stays the
 * provider's 429 and retry-after, for the tool's own retry on the same model.
 */
const WAIT_OUT_MS = 60_000;
const spent = (provider: string, window: SpentWindow, windows: SpentWindows) =>
  json(402, `${provider}'s allowance is spent until ${clockUtc(window.until)} UTC (${spanWords(window.until - windows.now())} from now), as its provider said: Galahad's gateway passes it over until then.`);

/** Handles `/gw/<provider>/<rest>` by forwarding to the provider with the real key. */
export async function handleGateway(request: Request, ctx: GatewayContext): Promise<Response> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/gw\/([A-Za-z0-9._:-]+)\/(.+)$/);
  if (!match) return json(404, "use /gw/<provider>/<path>");
  const [, providerId, rest] = match as unknown as [string, string, string];
  if (rest.split("/").some((segment) => segment === ".." || segment === ".")) return json(400, "bad path");

  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  const token = bearer ?? request.headers.get("x-api-key") ?? "";
  const verdict = ctx.tokens.consume(token, providerId);
  if (!verdict.ok) return json(401, verdict.reason);

  // A plan for interactive use only is lent to a tool you run yourself (galahad run), never to unattended work.
  if (planOf(providerId)?.allows.tools === "interactive" && !(ctx.tokens.labelOf(token) ?? "").startsWith("run:")) {
    return json(403, `${providerId} is a coding plan for interactive use only (its vendor's terms): it is lent to a tool you run yourself (galahad run), never to a knight's or a quest's unattended work`);
  }
  // The one place a coding plan's key is handed over: to a tool, calling as itself.
  const provider = resolveProvider(ctx.store, ctx.vault, providerId, "tool");
  if (!provider) return json(404, `provider ${providerId} is not configured`);
  if (!provider.apiKey && !provider.local) return json(424, `provider ${providerId} has no key on this fleet`);

  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  // A plan that routes a conversation by its session refuses a call without one: the tool's own goes on as it
  // sent it, and a tool that sent none is given its VM's.
  const session = planOf(providerId)?.session;
  if (session) {
    const own = request.headers.get(session);
    headers.set(session, own && /^[\x21-\x7e]{1,128}$/.test(own) ? own : gatewaySession(token));
  }
  for (const [name, value] of Object.entries(keyHeaders(provider))) headers.set(name, value);
  const target = `${provider.baseUrl.replace(/\/$/, "")}/${rest}${url.search}`;
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  // A lease for work in sensitive mode is good for its models alone: any other, on this provider or another, is refused
  // before a byte of the call leaves (a provider that serves others' models too, as NEAR AI's does, serves only those).
  const held = ctx.tokens.modelsOf(token);
  if (held && body && !held.includes(`${providerId}/${modelOf(body)}`)) return json(403, `this lease is for work in sensitive mode, on ${held.join(", ")} alone`);
  // A plan whose allowance is spent past the next minute (windows.ts) isn't asked a model call again until it resets;
  // nor is a model of any other provider's that was told to wait that long (its others are asked as ever).
  const windows = windowsOf(ctx.store);
  const ref = `${providerId}/${modelOf(body)}`;
  const open = request.method === "POST" ? windows.spentFor(ref) : null;
  if (open && open.until - windows.now() > WAIT_OUT_MS) return spent(open.provider, open, windows);
  const upstream = await (ctx.fetch ?? fetch)(target, {
    method: request.method,
    headers,
    body,
    // The key is pinned to this provider's origin: it never chases a Location header to another host.
    redirect: "manual",
    signal: request.signal,
  });
  const responseHeaders = new Headers();
  for (const name of ["content-type", "cache-control", "request-id", "x-request-id", "retry-after"]) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  if (!upstream.ok) {
    // Error bodies are small; scrub them in case the provider echoes the key back.
    const text = redact(await upstream.text(), [provider.apiKey]);
    // A refusal that says the allowance is spent, and until when (in its words, or a 429's retry-after), is remembered
    // as chat's are: the node's other calls pass it over, and its usage meter says it.
    // (A listing names no model: only a plan's refusal of one says anything of its window.)
    const scope = request.method === "POST" || planOf(providerId) ? windowScope(ref) : null;
    const window = scope ? windows.note(scope, `${providerId} → ${upstream.status} ${text}`, upstream.status === 429 ? retryAfterAt(upstream.headers.get("retry-after"), windows.now()) : null) : null;
    // A provider that refused its key (a 401, or a 403 that says so) is remembered, as a spent allowance is: the doctor
    // and the Inbox say it.
    // (A local runtime has no key to refuse: its 401 is said of it, not remembered here.)
    if (request.method === "POST" && !provider.local) refusedKeysOf(ctx.store).note(providerId, `${upstream.status} ${text}`);
    if (window && window.until - windows.now() > WAIT_OUT_MS) return spent(window.provider, window, windows);
    return new Response(text, { status: upstream.status, headers: responseHeaders });
  }
  // A model call that got through means the key works: a refusal of it is forgotten. (Not a listing: some providers
  // list their models to anyone, with a key or none.)
  if (request.method === "POST") refusedKeysOf(ctx.store).forget(providerId);
  // A model call (a POST) is counted as its answer goes by; a listing or a lookup isn't one.
  const report = ctx.onUsage;
  if (!report || request.method !== "POST" || !upstream.body) return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  const reader = usageReader(provider.kind);
  const call = { label: ctx.tokens.labelOf(token) ?? "unknown", provider: providerId, model: modelOf(body) };
  const counted = upstream.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        try {
          reader.feed(chunk);
        } catch {
          /* counting never gets in the answer's way */
        }
      },
      flush() {
        try {
          report({ ...call, usage: reader.end() });
        } catch {
          /* nor does the one told of it */
        }
      },
    }),
  );
  return new Response(counted, { status: upstream.status, headers: responseHeaders });
}
