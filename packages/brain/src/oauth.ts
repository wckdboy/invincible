import type { ConnectorManifest } from "@galahad/core";
import type { Vault } from "@galahad/mind";

/*
 * Signing in to a service as you (Gmail, Outlook): OAuth, with an app you registered yourself, so nobody else's app
 * stands between you and your mail and no token leaves your nodes. The vault keeps, under the connector's secret, the
 * app (its client id, and for Google its secret) and, once you've signed in, the sign-in (a refresh token) and whose
 * account it is. An agent never sees any of it: the node trades the sign-in for a short-lived access token when a call
 * needs one, keeps that in this process only, and puts it on the call (connectors.ts).
 *
 *   Google: the authorization code flow with PKCE, back to the node at <your app's address>/oauth/callback.
 *   Microsoft: the device code flow (a public client, no secret): you type a short code at microsoft.com/devicelogin.
 */

export const OAUTH_PROVIDERS = {
  google: {
    label: "Google",
    flow: "code",
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
  },
  microsoft: {
    label: "Microsoft",
    flow: "device",
    device: "https://login.microsoftonline.com/common/oauth2/v2.0/devicecode",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  },
} as const;
export type OAuthProvider = keyof typeof OAUTH_PROVIDERS;

/** Where each provider is reached: the real ones, or a test's. */
export type OAuthEndpoints = { [P in OAuthProvider]: Partial<{ authorize: string; token: string; device: string }> };

export const endpointsOf = (provider: OAuthProvider, overrides?: Partial<OAuthEndpoints>): { authorize?: string; token: string; device?: string } => ({
  ...OAUTH_PROVIDERS[provider],
  ...(overrides?.[provider] ?? {}),
});

/** What the vault keeps for a connector that signs in. */
export interface OAuthKeep {
  /** The client id of the app you registered. */
  client: string;
  /** Its secret (Google's web apps have one; Microsoft's public client doesn't). */
  secret?: string;
  /** The sign-in, once you've signed in. */
  refresh?: string;
  /** Whose account it is (an email address), to say so. */
  account?: string;
  /** An MCP server's sign-in (mcp-oauth.ts): where it is renewed, pinned when you signed in, and the server it is for. */
  token?: string;
  resource?: string;
  /** An MCP server's access token when it gave no lasting sign-in, and when it lapses (ms since the epoch). */
  access?: string;
  expires?: number;
  /** Its secret goes in the token request's header, as the server took it when Galahad registered (client_secret_basic). */
  basic?: boolean;
}

export function readKeep(value: string): OAuthKeep | null {
  try {
    const keep = JSON.parse(value) as Record<string, unknown>;
    if (typeof keep.client !== "string" || !keep.client) return null;
    const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    const out: OAuthKeep = { client: keep.client };
    for (const field of ["secret", "refresh", "account", "token", "resource", "access"] as const) {
      const v = text(keep[field]);
      if (v) out[field] = v;
    }
    if (typeof keep.expires === "number" && Number.isFinite(keep.expires)) out.expires = keep.expires;
    if (keep.basic === true) out.basic = true;
    return out;
  } catch {
    return null;
  }
}

/** As the vault seals it. Its last field is a version, so the vault's plaintext hint (a value's last 4 characters) holds none of a token. */
export const writeKeep = (keep: OAuthKeep): string => JSON.stringify({ ...keep, v: 1 });

export class OAuthError extends Error {}

export interface OAuthContext {
  vault: Vault;
  fetch?: typeof fetch;
  endpoints?: Partial<OAuthEndpoints>;
  /** Keep a changed sign-in (a provider that rotates its refresh token), sealed as before. */
  save?: (name: string, value: string) => void;
  now?: () => number;
}

/** Access tokens this process holds, by connector and the sign-in they came from. Never written anywhere. */
const held = new Map<string, { token: string; until: number }>();

export function forgetAccess(connector: string): void {
  for (const key of held.keys()) if (key.startsWith(`${connector}\n`)) held.delete(key);
}

/** The provider's answer to a token request, read strictly. */
export async function tokenRequest(ctx: OAuthContext, url: string, form: Record<string, string>, headers: Record<string, string> = {}): Promise<{ access: string; refresh?: string; expiresIn: number; idToken?: string; scope?: string }> {
  const response = await (ctx.fetch ?? fetch)(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", ...headers },
    body: new URLSearchParams(form).toString(),
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || typeof body.access_token !== "string") {
    const error = typeof body.error === "string" ? body.error : `status ${response.status}`;
    throw new OAuthError(error);
  }
  return {
    access: body.access_token,
    ...(typeof body.refresh_token === "string" ? { refresh: body.refresh_token } : {}),
    expiresIn: typeof body.expires_in === "number" ? body.expires_in : 3600,
    ...(typeof body.id_token === "string" ? { idToken: body.id_token } : {}),
    // (What was allowed, which can be less than was asked: Google's page has a box for each.)
    ...(typeof body.scope === "string" ? { scope: body.scope } : {}),
  };
}

/**
 * An access token for a connector that signs in: the one this process holds while it's good, else a new one for the
 * sign-in in the vault (and the vault's sign-in replaced when the provider rotates it). Throws when nobody has signed in.
 */
export async function accessToken(ctx: OAuthContext, manifest: ConnectorManifest): Promise<string> {
  const auth = manifest.auth;
  if (auth?.scheme !== "oauth" || !auth.oauth) throw new OAuthError(`${manifest.label} doesn't sign in`);
  const keep = ctx.vault.has(auth.secret) ? readKeep(ctx.vault.reveal(auth.secret)) : null;
  if (!keep) throw new OAuthError(`${manifest.label} ${auth.oauth.provider === "mcp" ? "isn't signed in yet: sign in from its card in Connectors" : "needs the app you registered: its client id"}`);
  const now = (ctx.now ?? Date.now)();
  // An MCP server that gave no lasting sign-in: its access token, while it's good.
  if (auth.oauth.provider === "mcp" && !keep.refresh && keep.access) {
    if ((keep.expires ?? Number.POSITIVE_INFINITY) > now) return keep.access;
    throw new OAuthError(`${manifest.label}'s sign-in has ended: sign in again from its card in Connectors`);
  }
  if (!keep.refresh) throw new OAuthError(`${manifest.label} isn't signed in yet: sign in from its card in Connectors`);
  const key = `${manifest.id}\n${keep.refresh.slice(-16)}`;
  const kept = held.get(key);
  if (kept && kept.until > now) return kept.token;
  const provider = auth.oauth.provider;
  // (An MCP server's sign-in is renewed only where it was pinned when you signed in, for that server alone.)
  if (provider === "mcp" && !keep.token) throw new OAuthError(`${manifest.label}'s sign-in has no address to be renewed at: sign in again from its card in Connectors`);
  // (Its secret in the body, or, where the server took it so when Galahad registered, in the header: RFC 6749 2.3.1.)
  const basic = keep.secret && keep.basic ? { authorization: `Basic ${Buffer.from(`${encodeURIComponent(keep.client)}:${encodeURIComponent(keep.secret)}`).toString("base64")}` } : null;
  const answer = await tokenRequest(ctx, provider === "mcp" ? keep.token! : endpointsOf(provider, ctx.endpoints).token, {
    grant_type: "refresh_token",
    refresh_token: keep.refresh,
    client_id: keep.client,
    ...(keep.secret && !basic ? { client_secret: keep.secret } : {}),
    ...(provider === "microsoft" ? { scope: auth.oauth.scopes.join(" ") } : {}),
    ...(provider === "mcp" && keep.resource ? { resource: keep.resource } : {}),
  }, basic ?? {}).catch((error: Error) => {
    // Revoked, or expired after months unused: say so plainly, so you sign in again.
    throw new OAuthError(error.message === "invalid_grant" ? `${manifest.label}'s sign-in has ended: sign in again from its card in Connectors` : `${manifest.label}'s sign-in couldn't be renewed (${error.message})`);
  });
  if (answer.refresh && answer.refresh !== keep.refresh) ctx.save?.(auth.secret, writeKeep({ ...keep, refresh: answer.refresh }));
  held.set(answer.refresh ? `${manifest.id}\n${answer.refresh.slice(-16)}` : key, { token: answer.access, until: now + Math.max(60, answer.expiresIn - 60) * 1000 });
  return answer.access;
}
