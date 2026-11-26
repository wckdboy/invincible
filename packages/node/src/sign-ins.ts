import { createHash, randomBytes } from "node:crypto";
import { endpointsOf, finishMcpSignIn, forgetAccess, type McpPending, OAuthError, type OAuthEndpoints, type OAuthKeep, readKeep, startMcpSignIn, tokenRequest, writeKeep } from "@galahad/brain";
import type { ConnectorManifest } from "@galahad/core";
import type { Vault } from "@galahad/mind";

/*
 * Signing in to a connector as you (brain oauth.ts says what the vault keeps). Google: the authorization code flow
 * with PKCE, back to the node at your app's own /oauth/callback, as you registered it; the page that opens there
 * says whether it worked. Microsoft: the device code flow, a code you type at its page while the node waits for it.
 * What the flows hold while they wait (a state, a verifier, a device code) is in this process only, for ten minutes.
 */

const WAIT_MS = 10 * 60_000;

export class SignInError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface SignInDeps {
  vault: Vault;
  /** The installed connector by id. */
  manifest(id: string): ConnectorManifest | null;
  fetch?: typeof fetch;
  endpoints?: Partial<OAuthEndpoints>;
  log(message: string): void;
  now?: () => number;
  /** A sign-in just kept (an MCP server's tools are listed then). */
  signedIn?(connector: string): void;
  /** The wait between asks, ended early when the sign-in is stopped (tests: none). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const sleeping = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

export type Started = { flow: "code"; url: string } | { flow: "device"; code: string; url: string; expires: number };

const b64u = (bytes: Uint8Array | Buffer): string => Buffer.from(bytes).toString("base64url");

/** The email address an ID token names. It came from the provider's own token endpoint, over TLS: read, not verified. */
export function emailFrom(idToken: string | undefined): string | null {
  const payload = idToken?.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    const email = [claims.email, claims.preferred_username, claims.upn].find((v): v is string => typeof v === "string" && /^[^\s@]{1,64}@[^\s@]{1,190}$/.test(v));
    return email ?? null;
  } catch {
    return null;
  }
}

/** Where Google may send you back: your app's own /oauth/callback, over https (plain http only on this machine). */
export function callbackOf(redirect: string): string {
  let url: URL;
  try {
    url = new URL(redirect);
  } catch {
    throw new SignInError(400, "the address to come back to isn't one");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new SignInError(400, "Google returns only to https (or this machine)");
  if (url.pathname !== "/oauth/callback" || url.search || url.hash || url.username || url.password) throw new SignInError(400, "the address to come back to is your app's /oauth/callback, nothing more");
  return `${url.origin}/oauth/callback`;
}

export class SignIns {
  private readonly waiting = new Map<string, { connector: string; verifier: string; redirect: string; until: number; mcp?: McpPending }>();
  private readonly polls = new Map<string, AbortController>();
  private readonly now: () => number;

  constructor(private readonly d: SignInDeps) {
    this.now = d.now ?? Date.now;
  }

  private oauthOf(id: string): { manifest: ConnectorManifest; provider: "google" | "microsoft" | "mcp"; scopes: string[] } {
    const manifest = this.d.manifest(id);
    if (!manifest) throw new SignInError(404, `${id} isn't installed`);
    if (manifest.auth?.scheme !== "oauth" || !manifest.auth.oauth) throw new SignInError(400, `${manifest.label} doesn't sign in: it takes a key`);
    return { manifest, provider: manifest.auth.oauth.provider, scopes: manifest.auth.oauth.scopes };
  }

  /** What the vault keeps for it, or null. */
  keep(manifest: ConnectorManifest): OAuthKeep | null {
    const name = manifest.auth?.secret;
    return name && this.d.vault.unlocked() && this.d.vault.has(name) ? readKeep(this.d.vault.reveal(name)) : null;
  }

  private seal(manifest: ConnectorManifest, keep: OAuthKeep): void {
    // Pinned, like any connector's key: to its origin, for it (a manifest can't borrow another's).
    this.d.vault.set(manifest.auth!.secret, writeKeep(keep), { origin: new URL(manifest.origin).origin, provider: manifest.id, label: `${manifest.label} sign-in` });
    forgetAccess(manifest.id);
  }

  /** The app you registered: its client id (and for Google its secret). A new client id ends the sign-in it had. */
  setApp(id: string, client: string, secret?: string): void {
    const { manifest, provider } = this.oauthOf(id);
    if (provider === "mcp") throw new SignInError(400, `${manifest.label} needs no app of yours: Galahad registers itself when you sign in`);
    if (provider === "google" && !secret) throw new SignInError(400, "Google's web app has a client secret too: give both");
    const before = this.keep(manifest);
    const same = before?.client === client;
    this.seal(manifest, { client, ...(secret ? { secret } : {}), ...(same && before?.refresh ? { refresh: before.refresh } : {}), ...(same && before?.account ? { account: before.account } : {}) });
  }

  async start(id: string, redirect: string | undefined): Promise<Started> {
    const { manifest, provider, scopes } = this.oauthOf(id);
    if (provider === "mcp") return this.startMcp(manifest, scopes, redirect);
    const keep = this.keep(manifest);
    if (!keep) throw new SignInError(424, `${manifest.label} needs the app you registered first: its client id${provider === "google" ? " and secret" : ""}`);
    const ends = endpointsOf(provider, this.d.endpoints);
    if (provider === "google") {
      if (!redirect) throw new SignInError(400, "give the address Google returns to: your app's /oauth/callback, as you registered it");
      const back = callbackOf(redirect);
      for (const [state, w] of this.waiting) if (w.until <= this.now()) this.waiting.delete(state);
      const state = b64u(randomBytes(32));
      const verifier = b64u(randomBytes(32));
      this.waiting.set(state, { connector: manifest.id, verifier, redirect: back, until: this.now() + WAIT_MS });
      const url = new URL(ends.authorize!);
      for (const [k, v] of Object.entries({
        client_id: keep.client,
        redirect_uri: back,
        response_type: "code",
        scope: scopes.join(" "),
        // A lasting sign-in, asked for each time: Google gives one only on consent.
        access_type: "offline",
        prompt: "consent",
        state,
        code_challenge: b64u(createHash("sha256").update(verifier).digest()),
        code_challenge_method: "S256",
      })) url.searchParams.set(k, v);
      return { flow: "code", url: url.toString() };
    }
    const response = await (this.d.fetch ?? fetch)(ends.device!, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: keep.client, scope: scopes.join(" ") }).toString(),
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    const device = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok || typeof device.device_code !== "string" || typeof device.user_code !== "string") {
      throw new SignInError(502, `Microsoft didn't start a sign-in (${typeof device.error === "string" ? device.error : `status ${response.status}`}): check the app's client id, and that it allows public client flows`);
    }
    const lasts = (typeof device.expires_in === "number" ? device.expires_in : 900) * 1000;
    this.poll(manifest, keep, device.device_code, typeof device.interval === "number" ? device.interval : 5, this.now() + lasts);
    return { flow: "device", code: device.user_code, url: typeof device.verification_uri === "string" ? device.verification_uri : "https://microsoft.com/devicelogin", expires: this.now() + lasts };
  }

  /**
   * An MCP server's sign-in (brain mcp-oauth.ts): its authorization server found from it, Galahad registered there, and
   * your browser sent to allow it, back to your app's /oauth/callback, as a Google sign-in is.
   */
  private async startMcp(manifest: ConnectorManifest, scopes: string[], redirect: string | undefined): Promise<Started> {
    if (!redirect) throw new SignInError(400, "give the address the sign-in returns to: your app's /oauth/callback");
    const back = callbackOf(redirect);
    for (const [state, w] of this.waiting) if (w.until <= this.now()) this.waiting.delete(state);
    const state = b64u(randomBytes(32));
    let started: Awaited<ReturnType<typeof startMcpSignIn>>;
    try {
      started = await startMcpSignIn({ server: `${manifest.origin}${manifest.mcp?.path ?? ""}`, redirect: back, state, scopes, ...(this.d.fetch ? { fetch: this.d.fetch } : {}) });
    } catch (error) {
      throw new SignInError(502, `${manifest.label}'s sign-in couldn't start: ${error instanceof OAuthError ? error.message : String((error as Error)?.message ?? error).slice(0, 200)}`);
    }
    this.waiting.set(state, { connector: manifest.id, verifier: started.verifier, redirect: back, until: this.now() + WAIT_MS, mcp: started.pending });
    return { flow: "code", url: started.url };
  }

  /** The return to /oauth/callback (Google's, or an MCP server's): the code traded for a sign-in, kept in the vault. What the page says. */
  async callback(params: URLSearchParams): Promise<{ ok: boolean; message: string }> {
    const state = params.get("state") ?? "";
    const waited = this.waiting.get(state);
    this.waiting.delete(state);
    if (!waited || waited.until <= this.now()) return { ok: false, message: "This sign-in has expired or was already used. Start it again from Galahad." };
    const error = params.get("error");
    const who = waited.mcp ? (this.d.manifest(waited.connector)?.label ?? waited.connector) : "Google";
    if (error) return { ok: false, message: `${who} said ${error.slice(0, 80)}. Nothing was kept.` };
    if (waited.mcp) return this.finishMcp(waited.connector, waited.mcp, params.get("code"), waited.verifier, waited.redirect);
    const code = params.get("code");
    const { manifest, provider, scopes } = this.oauthOf(waited.connector);
    const keep = this.keep(manifest);
    // (Changed into an MCP server's between the start and now: that sign-in is its own.)
    if (!code || !keep || provider === "mcp") return { ok: false, message: "Nothing came back to sign in with. Start it again from Galahad." };
    try {
      const answer = await tokenRequest({ vault: this.d.vault, ...(this.d.fetch ? { fetch: this.d.fetch } : {}) }, endpointsOf(provider, this.d.endpoints).token, {
        grant_type: "authorization_code",
        code,
        redirect_uri: waited.redirect,
        client_id: keep.client,
        ...(keep.secret ? { client_secret: keep.secret } : {}),
        code_verifier: waited.verifier,
      });
      if (!answer.refresh) return { ok: false, message: "Google gave no lasting sign-in. Remove the app's access in your Google Account's security settings, then sign in again." };
      // Google's page has a box for each thing asked, and a box left unticked is a sign-in without it: say which.
      const asked = scopes.filter((s) => s.startsWith("https://"));
      const allowed = answer.scope === undefined ? asked : answer.scope.split(" ");
      const without = asked.filter((s) => !allowed.includes(s)).map((s) => s.slice(s.lastIndexOf("/") + 1));
      if (asked.length && without.length === asked.length) return { ok: false, message: `Google allowed none of what ${manifest.label} asks for (${without.join(", ")}). Sign in again and tick each box. Nothing was kept.` };
      const account = emailFrom(answer.idToken);
      this.seal(manifest, { ...keep, refresh: answer.refresh, ...(account ? { account } : {}) });
      this.d.log(`signed in to ${manifest.id}${without.length ? `, without ${without.join(", ")}` : ""}`);
      const one = without.length === 1;
      const short = without.length ? `, but without ${without.join(" and ")}: sign in again and tick ${one ? "its box" : "their boxes"} to give ${one ? "it" : "them"}` : "";
      return { ok: true, message: `Signed in to ${manifest.label}${account ? ` as ${account}` : ""}${short}. You can close this page and go back to Galahad.` };
    } catch (e) {
      return { ok: false, message: `Google didn't take the sign-in (${e instanceof OAuthError ? e.message : "it couldn't be reached"}). Nothing was kept.` };
    }
  }

  private async finishMcp(id: string, pending: McpPending, code: string | null, verifier: string, redirect: string): Promise<{ ok: boolean; message: string }> {
    const { manifest } = this.oauthOf(id);
    if (!code) return { ok: false, message: "Nothing came back to sign in with. Start it again from Galahad." };
    try {
      const keep = await finishMcpSignIn(pending, { code, verifier, redirect, now: this.now(), ...(this.d.fetch ? { fetch: this.d.fetch } : {}) });
      this.seal(manifest, keep);
      this.d.log(`signed in to ${manifest.id}`);
      this.d.signedIn?.(manifest.id);
      return { ok: true, message: `Signed in to ${manifest.label}. Its tools are being listed now: you can close this page and go back to Galahad.` };
    } catch (e) {
      return { ok: false, message: `${manifest.label} didn't take the sign-in (${e instanceof OAuthError ? e.message : String((e as Error)?.message ?? e).slice(0, 160)}). Nothing was kept.` };
    }
  }

  /** Forget the sign-in; the app you registered stays. */
  signOut(id: string): void {
    const { manifest } = this.oauthOf(id);
    this.polls.get(manifest.id)?.abort();
    this.polls.delete(manifest.id);
    const keep = this.keep(manifest);
    if (keep) this.seal(manifest, { client: keep.client, ...(keep.secret ? { secret: keep.secret } : {}) });
  }

  /** Microsoft's side: ask until you've typed the code (or it lapses), at the pace it sets. */
  private poll(manifest: ConnectorManifest, keep: OAuthKeep, deviceCode: string, interval: number, until: number): void {
    this.polls.get(manifest.id)?.abort();
    const stop = new AbortController();
    this.polls.set(manifest.id, stop);
    const sleep = this.d.sleep ?? sleeping;
    const done = () => {
      if (this.polls.get(manifest.id) === stop) this.polls.delete(manifest.id);
    };
    void (async () => {
      let every = Math.max(1, interval) * 1000;
      for (;;) {
        await sleep(every, stop.signal);
        if (stop.signal.aborted) return void done();
        if (this.now() >= until) return void (done(), this.d.log(`${manifest.id} sign-in lapsed: the code wasn't entered in time`));
        try {
          const answer = await tokenRequest({ vault: this.d.vault, ...(this.d.fetch ? { fetch: this.d.fetch } : {}) }, endpointsOf("microsoft", this.d.endpoints).token, {
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            client_id: keep.client,
            device_code: deviceCode,
          });
          if (stop.signal.aborted) return void done();
          done();
          if (!answer.refresh) return void this.d.log(`${manifest.id} sign-in gave no lasting sign-in (is offline_access asked for?)`);
          const account = emailFrom(answer.idToken);
          this.seal(manifest, { ...(this.keep(manifest) ?? keep), refresh: answer.refresh, ...(account ? { account } : {}) });
          return void this.d.log(`signed in to ${manifest.id}`);
        } catch (e) {
          const why = e instanceof OAuthError ? e.message : "unreachable";
          // Asked too often: it says so, and the pace slows by five seconds. Not yet, or not reached: ask again.
          if (why === "slow_down") every += 5000;
          else if (why !== "authorization_pending" && why !== "unreachable") return void (done(), this.d.log(`${manifest.id} sign-in ended: ${why}`));
        }
      }
    })();
  }

  /** Whether a device code sign-in is waiting for you to type its code. */
  waitingFor(id: string): boolean {
    return this.polls.has(id);
  }

  /** Nothing keeps waiting once the node stops. */
  stop(): void {
    for (const poll of this.polls.values()) poll.abort();
    this.polls.clear();
    this.waiting.clear();
  }
}
