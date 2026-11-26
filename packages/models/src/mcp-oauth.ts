import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { AuthorizationServerMetadata, OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { OAuthError, type OAuthKeep } from "./oauth.ts";

/*
 * Signing in to a remote MCP server as you, by MCP's authorization spec: its authorization server is found from the
 * server itself (its protected resource metadata, else its own origin), Galahad registers there as a client of its own
 * (dynamic client registration: no app of yours to make), and your browser is sent to allow it, with PKCE, back to the
 * node's /oauth/callback. What comes back is kept as any sign-in is (oauth.ts): the lasting sign-in, where it is renewed
 * (pinned now, and never anywhere else) and the server its tokens are for (each asked for that server alone, RFC 8707).
 */

/** A sign-in under way: what finishing it needs, held by the node until you come back (never in the mind). */
export interface McpPending {
  server: string;
  authServer: string;
  metadata: AuthorizationServerMetadata;
  client: OAuthClientInformationFull;
}

/** An address a sign-in may use: https, or plain http on this machine alone (a server on your network signs in over https). */
function secure(address: string | undefined, what: string): string {
  let url: URL;
  try {
    url = new URL(address ?? "");
  } catch {
    throw new OAuthError(`it gave no ${what} to sign in at`);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new OAuthError(`its ${what} isn't on https (${url.origin}): Galahad signs in over https alone`);
  if (url.username || url.password) throw new OAuthError(`its ${what} carries credentials in its address`);
  return url.toString();
}

/**
 * How Galahad says it will prove itself at the token address when it registers: with no secret (PKCE alone) where the
 * server allows that, as most do; else with the secret the server hands back (sealed with the sign-in), sent in the
 * request's body as a renewal sends it (oauth.ts), or in its header where that is all the server takes. A server that
 * lists no methods is asked for none, as Galahad always has: the servers it signs in to take that.
 */
export function clientAuthMethod(supported: readonly string[] | undefined): "none" | "client_secret_post" | "client_secret_basic" {
  if (!supported?.length || supported.includes("none")) return "none";
  return supported.includes("client_secret_post") || !supported.includes("client_secret_basic") ? "client_secret_post" : "client_secret_basic";
}

/** Starts a sign-in to the MCP server at `server`: where your browser goes, and what finishing it needs. */
export async function startMcpSignIn(opts: { server: string; redirect: string; state: string; scopes: readonly string[]; fetch?: typeof fetch }): Promise<{ url: string; verifier: string; pending: McpPending }> {
  const fetchFn = opts.fetch;
  // Its authorization server, as its protected resource metadata names it; a server from before that, its own origin.
  let authServer = new URL(opts.server).origin;
  let scopes = [...opts.scopes];
  try {
    const resource = await discoverOAuthProtectedResourceMetadata(opts.server, {}, fetchFn);
    if (resource.authorization_servers?.[0]) authServer = resource.authorization_servers[0];
    if (!scopes.length && resource.scopes_supported?.length) scopes = [...resource.scopes_supported];
  } catch {
    /* it says none: its own origin answers for it */
  }
  secure(authServer, "authorization server");
  const metadata = await discoverAuthorizationServerMetadata(authServer, fetchFn ? { fetchFn } : {});
  if (!metadata) throw new OAuthError("it names no authorization server Galahad can sign in with: give it a key instead");
  secure(metadata.authorization_endpoint, "sign-in page");
  secure(metadata.token_endpoint, "token address");
  if (!metadata.registration_endpoint) throw new OAuthError("its authorization server doesn't let a client register itself: give it a key instead");
  secure(metadata.registration_endpoint, "registration address");
  const client = await registerClient(authServer, {
    metadata,
    clientMetadata: { client_name: "Galahad", redirect_uris: [opts.redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: clientAuthMethod(metadata.token_endpoint_auth_methods_supported) },
    ...(fetchFn ? { fetchFn } : {}),
  });
  const { authorizationUrl, codeVerifier } = await startAuthorization(authServer, {
    metadata,
    clientInformation: client,
    redirectUrl: opts.redirect,
    ...(scopes.length ? { scope: scopes.join(" ") } : {}),
    state: opts.state,
    resource: new URL(opts.server),
  });
  return { url: authorizationUrl.toString(), verifier: codeVerifier, pending: { server: opts.server, authServer, metadata, client } };
}

/** Finishes a sign-in with the code your browser brought back: what the vault keeps of it. */
export async function finishMcpSignIn(pending: McpPending, opts: { code: string; verifier: string; redirect: string; fetch?: typeof fetch; now?: number }): Promise<OAuthKeep> {
  const tokens = await exchangeAuthorization(pending.authServer, {
    metadata: pending.metadata,
    clientInformation: pending.client,
    authorizationCode: opts.code,
    codeVerifier: opts.verifier,
    redirectUri: opts.redirect,
    resource: new URL(pending.server),
    ...(opts.fetch ? { fetchFn: opts.fetch } : {}),
  });
  const now = opts.now ?? Date.now();
  return {
    client: pending.client.client_id,
    ...(pending.client.client_secret ? { secret: pending.client.client_secret } : {}),
    ...(pending.client.client_secret && pending.client.token_endpoint_auth_method === "client_secret_basic" ? { basic: true } : {}),
    token: pending.metadata.token_endpoint,
    resource: pending.server,
    // A lasting sign-in when it gives one; else the access token it gave, kept sealed until it lapses.
    ...(tokens.refresh_token ? { refresh: tokens.refresh_token } : { access: tokens.access_token, ...(tokens.expires_in ? { expires: now + tokens.expires_in * 1000 } : {}) }),
  };
}
