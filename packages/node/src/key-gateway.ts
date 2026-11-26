import { redact, type TeamKeyGrant } from "@galahad/core";
import type { GatewayTokens } from "@galahad/brain";
import type { Vault } from "@galahad/mind";
import type { LedgerEntryInput } from "@galahad/sandbox";

/*
 * Keys a knight uses but never sees (PLAN #17). A knight's script calls an API you gave it a key for through the
 * gateway, with its VM's gateway token where the key would go:
 *
 *   curl -H "Authorization: Bearer $GALAHAD_TOKEN" "$GALAHAD_KEYS/stripe/v1/charges"
 *
 * and the call leaves for the key's pinned address with the vault's key put in, in the header you chose. The key never
 * enters the VM. The token is good for the keys you gave its knight alone (scope `key:<secret>:<header>:<read|write>`),
 * for reads alone unless you said writes too, and only at the key's own address: no other host, no redirect followed.
 * Every call is a line in the ledger.
 */

/** A key's scope on a VM's lease: which secret, the header it goes in, and whether writes may go. */
export const keyScope = (grant: TeamKeyGrant): string => `key:${grant.secret}:${grant.header}:${grant.write ? "write" : "read"}`;

const PATH = /^\/key\/([A-Za-z0-9._-]{1,64})(\/[^?#]*)?$/;
const SCOPE = /^key:([A-Za-z0-9._-]{1,64}):([a-z][a-z0-9-]{0,63}):(read|write)$/;
const TOKEN = /^gw_[A-Za-z0-9_-]{43}$/;
/** What a read is: what changes nothing at the API. */
const READS = new Set(["GET", "HEAD", "OPTIONS"]);
/** What of a call goes on to the API (never another credential, a cookie, or how the VM reached the gateway). */
const FORWARDED = /^(accept|accept-language|content-type|user-agent|idempotency-key|if-match|if-none-match|if-modified-since|range|[a-z]+-version|[a-z]+-beta|x-[a-z0-9-]+)$/;
/** What of an answer comes back. */
const RETURNED = /^(content-type|content-language|cache-control|etag|last-modified|location|retry-after|link|request-id|x-request-id|x-ratelimit-[a-z-]+|ratelimit-[a-z-]+)$/;

export interface KeyGatewayContext {
  vault: Vault;
  tokens: GatewayTokens;
  ledger?: (entry: LedgerEntryInput) => void;
  fetch?: typeof fetch;
}

/**
 * Whether a secret can be given to a knight: in the vault, pinned to an https address, and nobody else's purpose. A
 * model provider's key goes through the model gateway (its metering, its plan's terms, sensitive mode), and a
 * connector's through Galahad's own calls (a push waits for your approval): a script never takes them past those.
 * Null: it can be; else why not.
 */
export function ungivable(vault: Pick<Vault, "info">, secret: string): string | null {
  const info = vault.info(secret);
  if (!info) return `there is no secret ${secret} in the vault: galahad secret set ${secret} --base-url https://api.example.com`;
  if (info.provider) return `${secret} is ${info.provider}'s key, used where Galahad holds its terms (the model gateway, a connector's calls): make a key of its own for the knight`;
  if (!info.origin) return `${secret} is pinned to no address, so there is nowhere it may go: set it again with its API's address (galahad secret set ${secret} --base-url https://…)`;
  if (!info.origin.startsWith("https://")) return `${secret} is pinned to ${info.origin}: a key a knight uses goes over https only`;
  return null;
}

const json = (status: number, message: string) => Response.json({ error: { type: "galahad_key_gateway", message } }, { status });

export async function handleKeyGateway(req: Request, ctx: KeyGatewayContext): Promise<Response> {
  const url = new URL(req.url);
  const match = url.pathname.match(PATH);
  if (!match) return json(404, "use /key/<name>/<path>");
  const [, name, rest = "/"] = match as unknown as [string, string, string | undefined];
  if (rest.split("/").some((part) => part === ".." || part === ".")) return json(400, "bad path");

  // The token, where the key would go: as a bearer, or in an API's own header.
  let carrier = "authorization";
  let token = req.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? "";
  if (!TOKEN.test(token)) {
    token = "";
    for (const [header, value] of req.headers) {
      if ((header.startsWith("x-") || header === "api-key") && TOKEN.test(value.trim())) {
        [carrier, token] = [header, value.trim()];
        break;
      }
    }
  }
  const scope = (ctx.tokens.scopesOf(token) ?? []).find((s) => s.startsWith(`key:${name}:`) && SCOPE.test(s));
  if (!scope) return json(401, token ? `this knight was given no key ${name}` : "no gateway token: send $GALAHAD_TOKEN where the key would go");
  const verdict = ctx.tokens.consume(token, scope);
  if (!verdict.ok) return json(401, verdict.reason);
  const [, , header, mode] = scope.match(SCOPE)!;
  if (mode !== "write" && !READS.has(req.method)) return json(403, `your liege gave this knight the key ${name} to read with: a ${req.method} changes something, and waits for leave to write (galahad roundtable keys <knight> add ${name} --write)`);

  // Its address and its value, as the vault holds them now: a key unpinned, or given to a provider since, goes nowhere.
  const why = ungivable(ctx.vault, name);
  if (why) return json(424, why);
  const origin = ctx.vault.info(name)!.origin!;
  let key: string;
  try {
    key = ctx.vault.reveal(name);
  } catch {
    return json(424, `the key ${name} can't be opened on this node`);
  }

  const headers = new Headers();
  for (const [field, value] of req.headers) if (FORWARDED.test(field) && field !== carrier) headers.set(field, value);
  headers.set(header!, header === "authorization" ? `Bearer ${key}` : key);
  const target = `${origin}${rest}${url.search}`;
  const body = READS.has(req.method) ? undefined : await req.arrayBuffer();
  // (Which VM's lease called it: a knight's page counts its uses by that.)
  const by = ctx.tokens.labelOf(token);
  ctx.ledger?.({ class: READS.has(req.method) ? "read" : "modify", resource: `key.${name}`, target: `${req.method} ${origin}${rest}`, verdict: "allow", reason: "a knight's script used a key you gave it, through the key gateway", ...(by ? { detail: by } : {}) });
  let upstream: Response;
  try {
    // The key is pinned to its address: never a Location header followed to another.
    upstream = await (ctx.fetch ?? fetch)(target, { method: req.method, headers, body, redirect: "manual", signal: req.signal });
  } catch (error) {
    return json(502, redact(`${origin} could not be reached: ${(error as Error).message}`, [key]).slice(0, 300));
  }
  const out = new Headers();
  for (const [field, value] of upstream.headers) if (RETURNED.test(field)) out.set(field, value);
  if (!upstream.ok) {
    // An error's words are small: read whole, scrubbed in case the API echoes the key back.
    return new Response(redact(await upstream.text(), [key]), { status: upstream.status, headers: out });
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
