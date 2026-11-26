import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

/*
 * Enable Banking's API, read-only (account information). The only code in Galahad that
 * opens the application's private key: it reads the key from disk for each signature
 * and keeps it nowhere else, never logs it, never returns it.
 *
 * Every request carries a fresh RS256 JWT (header typ, alg, kid = the application ID;
 * claims iss enablebanking.com, aud api.enablebanking.com, iat, exp = iat + 10 min; the
 * API accepts up to 24 h). Requests go only to https://api.enablebanking.com, only on
 * the paths below (no payment endpoint exists here, nor any way to name a path), with a
 * timeout, no redirects followed and a size cap on the answer.
 */

export const EB_ORIGIN = "https://api.enablebanking.com";
const TOKEN_TTL_S = 600;
const TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 8 * 2 ** 20;

/** The only requests this client can make. */
const ALLOWED = [
  /^GET \/aspsps$/,
  /^POST \/auth$/,
  /^POST \/sessions$/,
  /^GET \/sessions\/[A-Za-z0-9-]{1,64}$/,
  /^DELETE \/sessions\/[A-Za-z0-9-]{1,64}$/,
  /^GET \/accounts\/[A-Za-z0-9-]{1,64}\/balances$/,
  /^GET \/accounts\/[A-Za-z0-9-]{1,64}\/transactions$/,
];

/** An API error, reduced to what's safe to act on: the status and Enable Banking's error code. Never the body. */
export class EnableBankingError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
  ) {
    super(`Enable Banking answered ${status}${code ? ` (${code})` : ""}`);
  }
}

/** PSU headers: only when you (the account holder) are actually present; agents' fetches never carry them. */
export interface PsuHeaders {
  "Psu-Ip-Address"?: string;
  "Psu-User-Agent"?: string;
}

export interface ClientOptions {
  appId: string;
  keyPath: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** How the key is read (tests use a throwaway key). */
  readKey?: (path: string) => string;
}

const b64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

export class EnableBankingClient {
  constructor(private readonly o: ClientOptions) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(o.appId)) throw new Error("the application ID is a UUID");
  }

  /** A fresh JWT for one request. The key is read, used and dropped. */
  jwt(): string {
    const iat = Math.floor((this.o.now ?? Date.now)() / 1000);
    const header = b64url(JSON.stringify({ typ: "JWT", alg: "RS256", kid: this.o.appId }));
    const claims = b64url(JSON.stringify({ iss: "enablebanking.com", aud: "api.enablebanking.com", iat, exp: iat + TOKEN_TTL_S }));
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${claims}`);
    const signature = signer.sign((this.o.readKey ?? ((p) => readFileSync(p, "utf8")))(this.o.keyPath));
    return `${header}.${claims}.${b64url(signature)}`;
  }

  private async request<T>(method: "GET" | "POST" | "DELETE", path: string, options: { query?: Record<string, string>; body?: unknown; psu?: PsuHeaders } = {}): Promise<T> {
    if (!ALLOWED.some((rule) => rule.test(`${method} ${path}`))) throw new Error(`refusing ${method} ${path.split("/")[1] ?? ""}: not an allowed endpoint`);
    const url = new URL(path, EB_ORIGIN);
    for (const [k, v] of Object.entries(options.query ?? {})) url.searchParams.set(k, v);
    if (url.origin !== EB_ORIGIN) throw new Error("refusing a request off api.enablebanking.com");
    const headers: Record<string, string> = { authorization: `Bearer ${this.jwt()}`, accept: "application/json" };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    for (const [k, v] of Object.entries(options.psu ?? {})) if (v) headers[k] = v;
    const response = await (this.o.fetch ?? fetch)(url.toString(), {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) throw new EnableBankingError(response.status, "REDIRECT_REFUSED");
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_RESPONSE_BYTES) throw new EnableBankingError(response.status, "RESPONSE_TOO_LARGE");
    let json: unknown = null;
    try {
      json = buffer.byteLength ? JSON.parse(new TextDecoder().decode(buffer)) : null;
    } catch {
      json = null;
    }
    if (!response.ok) {
      const code = json && typeof json === "object" ? (json as { error?: unknown }).error : null;
      throw new EnableBankingError(response.status, typeof code === "string" && /^[A-Z_]{2,64}$/.test(code) ? code : null);
    }
    return json as T;
  }

  aspsps(country: string, psuType: "personal" | "business" = "personal") {
    return this.request<{ aspsps: { name: string; country: string; maximum_consent_validity?: number; psu_types?: string[]; required_psu_headers?: string[] }[] }>("GET", "/aspsps", {
      query: { country, psu_type: psuType },
    });
  }

  /** Account information only: there is no payment scope in this request, and no payment endpoint in this client. */
  startAuthorization(body: { validUntil: string; aspsp: { name: string; country: string }; state: string; redirectUrl: string; psuType: "personal" | "business" }) {
    return this.request<{ url: string; authorization_id?: string }>("POST", "/auth", {
      body: { access: { valid_until: body.validUntil }, aspsp: body.aspsp, state: body.state, redirect_url: body.redirectUrl, psu_type: body.psuType },
    });
  }

  createSession(code: string) {
    return this.request<{
      session_id: string;
      accounts: { uid: string; name?: string | null; currency?: string | null; account_id?: { iban?: string | null } | null }[];
      aspsp?: { name: string; country: string };
      access?: { valid_until?: string };
    }>("POST", "/sessions", { body: { code } });
  }

  getSession(sessionId: string) {
    return this.request<{ status: string; access?: { valid_until?: string } }>("GET", `/sessions/${encodeURIComponent(sessionId)}`);
  }

  deleteSession(sessionId: string) {
    return this.request<unknown>("DELETE", `/sessions/${encodeURIComponent(sessionId)}`);
  }

  balances(account: string, psu?: PsuHeaders) {
    return this.request<{ balances: unknown[] }>("GET", `/accounts/${encodeURIComponent(account)}/balances`, { ...(psu ? { psu } : {}) });
  }

  transactions(account: string, query: { date_from: string; date_to: string; continuation_key?: string }, psu?: PsuHeaders) {
    return this.request<{ transactions: unknown[]; continuation_key?: string | null }>("GET", `/accounts/${encodeURIComponent(account)}/transactions`, {
      query: { date_from: query.date_from, date_to: query.date_to, ...(query.continuation_key ? { continuation_key: query.continuation_key } : {}) },
      ...(psu ? { psu } : {}),
    });
  }
}
