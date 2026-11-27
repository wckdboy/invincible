import { type BuiltRequest, ConnectorError, ConnectorManifest, redact } from "@invincible/core";
import type { LedgerStore, Vault } from "@invincible/ledger";
import { privateConnector, publicIds } from "./connector-catalog.ts";
import { accessToken, type OAuthContext, readKeep } from "./oauth.ts";

/*
 * The connector broker's outbound half: send one built request with the key
 * injected, and bring back a bounded, redacted answer. The key is used only if
 * the vault pinned it to this connector's origin when you entered it; redirects
 * are never followed (a key must not chase a Location header to another host).
 */

export interface InstalledConnector {
  id: string;
  /** null when the stored manifest no longer validates (written by a newer node, or tampered). */
  manifest: ConnectorManifest | null;
  problem: string | null;
  installedAt: string;
  installedBy: string;
}

export function installedConnectors(store: LedgerStore): InstalledConnector[] {
  return store.lwwPrefix<unknown>("connector:").map((entry) => {
    const parsed = ConnectorManifest.safeParse(entry.value);
    return {
      id: entry.key.slice("connector:".length),
      manifest: parsed.success ? held(entry.key.slice("connector:".length), parsed.data) : null,
      problem: parsed.success ? null : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 300),
      installedAt: entry.hlc,
      installedBy: entry.device,
    };
  });
}

export function installedConnector(store: LedgerStore, id: string): ConnectorManifest | null {
  const parsed = ConnectorManifest.safeParse(store.lww(`connector:${id}`)?.value);
  return parsed.success ? held(id, parsed.data) : null;
}

/** An installed manifest as it is held: private where the catalog says its answers are your private data (by its id). */
function held(id: string, manifest: ConnectorManifest): ConnectorManifest {
  return manifest.private !== true && (privateConnector(id) || privateConnector(manifest.id)) ? { ...manifest, private: true } : manifest;
}

export type KeyState = "none-needed" | "ready" | "missing" | "optional-missing" | "wrong-origin" | "signed-out";

/**
 * Whether the connector's key is in the vault and pinned to the connector's origin. One that signs in (oauth) is
 * ready once you've signed in; with only the app you registered it's signed-out.
 */
export function keyState(vault: Vault, manifest: ConnectorManifest): KeyState {
  if (!manifest.auth) return "none-needed";
  const info = vault.info(manifest.auth.secret);
  if (!info) return manifest.auth.optional ? "optional-missing" : "missing";
  // Pinned to this origin *and* entered for this connector: a manifest can't borrow another service's key.
  if (info.origin !== new URL(manifest.origin).origin || info.provider !== manifest.id) return "wrong-origin";
  if (manifest.auth.scheme !== "oauth") return "ready";
  const keep = vault.unlocked() ? readKeep(vault.reveal(manifest.auth.secret)) : null;
  // (An MCP server's sign-in may be an access token alone, good until it lapses.)
  return !keep ? "missing" : keep.refresh || (keep.access && (keep.expires ?? Number.POSITIVE_INFINITY) > Date.now()) ? "ready" : "signed-out";
}

export interface ConnectorResult {
  ok: boolean;
  status: number;
  contentType: string | null;
  /** Redacted, clipped. */
  body: string;
  truncated: boolean;
  durationMs: number;
  /** An MCP tool's answer: there is no status of its own, only ok or a tool error. */
  mcp?: boolean;
}

export const MAX_RESPONSE_BYTES = 512 * 1024;
const RETURNED_CHARS = 60_000;

async function readCapped(response: Response, cap: number): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > cap) {
      chunks.push(value.subarray(0, cap - size));
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks)), truncated };
}

export interface SendContext {
  vault: Vault;
  fetch?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** For a connector that signs in: where its provider is, and how a rotated sign-in is kept (oauth.ts). */
  oauth?: Omit<OAuthContext, "vault" | "fetch">;
}

/**
 * The auth header for this connector, if its key may be used: only when the vault
 * pinned it to this connector's origin, for this connector. Throws otherwise.
 */
export function authFor(vault: Vault, manifest: ConnectorManifest): { headers: Record<string, string>; key: string | null } {
  const state = keyState(vault, manifest);
  if (state === "missing") throw new ConnectorError(`${manifest.id} needs its key: add the secret "${manifest.auth!.secret}" for ${manifest.origin}`);
  if (state === "wrong-origin") throw new ConnectorError(`the secret "${manifest.auth!.secret}" is pinned to another origin; it is never sent to ${manifest.origin}`);
  if (state !== "ready" || !manifest.auth) return { headers: {}, key: null };
  if (manifest.auth.scheme === "oauth") throw new ConnectorError(`${manifest.id} signs in: its calls carry an access token (sendConnectorRequest)`);
  const key = vault.reveal(manifest.auth.secret);
  if (manifest.auth.scheme === "bearer") return { headers: { authorization: `Bearer ${key}` }, key };
  if (manifest.auth.scheme === "basic") return { headers: { authorization: `Basic ${Buffer.from(key).toString("base64")}` }, key };
  return { headers: { [manifest.auth.header!]: key }, key };
}

/** The connector's key on a request's headers, as the vault allows it: an access token where it signs in. Returns the key. */
async function signRequest(ctx: SendContext, manifest: ConnectorManifest, headers: Headers): Promise<string | null> {
  if (manifest.auth?.scheme === "oauth") {
    // Signed in as you: a short-lived access token for this call, never the sign-in itself.
    if (keyState(ctx.vault, manifest) === "wrong-origin") throw new ConnectorError(`the secret "${manifest.auth.secret}" is pinned to another origin; it is never sent to ${manifest.origin}`);
    const key = await accessToken({ vault: ctx.vault, ...(ctx.fetch ? { fetch: ctx.fetch } : {}), ...ctx.oauth }, manifest).catch((error: Error) => {
      throw new ConnectorError(error.message);
    });
    headers.set("authorization", `Bearer ${key}`);
    return key;
  }
  const auth = authFor(ctx.vault, manifest);
  for (const [name, value] of Object.entries(auth.headers)) headers.set(name, value);
  return auth.key;
}

export async function sendConnectorRequest(ctx: SendContext, manifest: ConnectorManifest, request: BuiltRequest): Promise<ConnectorResult> {
  const headers = new Headers({ accept: "application/json", "user-agent": "invincible/0.1 (+https://invincible.sh)" });
  for (const [name, value] of Object.entries(request.headers)) headers.set(name, value);
  if (request.body !== undefined) headers.set("content-type", "application/json");
  const key = await signRequest(ctx, manifest, headers);

  const started = performance.now();
  const timeout = AbortSignal.timeout(ctx.timeoutMs ?? 30_000);
  const response = await (ctx.fetch ?? fetch)(request.url, {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
    signal: ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout,
  });
  const { text, truncated } = await readCapped(response, MAX_RESPONSE_BYTES);
  const known = key ? [key, Buffer.from(key).toString("base64")] : [];
  const ids = publicIds(manifest);
  const clean = redact(text, known, ids ? { isPublic: ids } : {});
  const clipped = clean.length > RETURNED_CHARS;
  return {
    ok: response.ok,
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: clipped ? clean.slice(0, RETURNED_CHARS) : clean,
    truncated: truncated || clipped,
    durationMs: Math.round(performance.now() - started),
  };
}

/** A short, human-sized excerpt of a result for ledgers, receipts and run summaries. */
/** What an answer was without a word of it (a private connector's: PRIVATE_CONNECTORS): ok or failed and why, and its size. */
export function sized(result: ConnectorResult): string {
  const kind = result.mcp ? (result.ok ? "a tool's answer" : "a tool error") : String(result.status);
  return `${result.ok ? "ok" : "failed"} (${kind}${result.truncated ? ", truncated" : ""}), ${new TextEncoder().encode(result.body).length} bytes`;
}

export function excerpt(result: ConnectorResult, max = 600): string {
  let body = result.body.trim();
  let json = false;
  if (result.contentType?.includes("json")) {
    try {
      body = JSON.stringify(JSON.parse(body));
      json = true;
    } catch {
      /* not JSON after all */
    }
  }
  // HTML becomes its text, and text collapses to one line: summaries, receipts and ledger rows stay readable.
  if (!json && result.contentType?.includes("html")) {
    body = body
      .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
  }
  if (!json) body = body.replace(/\s+/g, " ").trim();
  const head = `${result.mcp ? (result.ok ? "ok" : "tool error") : result.status}${result.truncated ? " (truncated)" : ""}`;
  return `${head} ${body.length > max ? `${body.slice(0, max)}…` : body}`.trim();
}
