import type { ConnectorResult } from "@galahad/brain";
import type { NativeTool } from "./connectors.ts";

/*
 * Cloudflare's token check, as one of Galahad's own tools (a native): an API token is a user's (My Profile → API Tokens)
 * or an account's (Manage Account → Account API Tokens), and Cloudflare checks each at its own address. A user's
 * address refuses an account's token (401, "Invalid API Token") although every call it may make works, so the user's
 * address is asked first, then each account the token can see; the answer says which it is. Read only.
 */

const ACCOUNT_ID = /^[a-f0-9]{32}$/;

const answer = (status: number, value: unknown, started: number): ConnectorResult => ({
  ok: status >= 200 && status < 300,
  status,
  contentType: "application/json",
  body: JSON.stringify(value),
  truncated: false,
  durationMs: Math.round(performance.now() - started),
});

/** What a token's check says of it, without the envelope. */
const tokenOf = (result: any) => ({
  id: typeof result?.id === "string" ? result.id : null,
  status: typeof result?.status === "string" ? result.status : null,
  ...(typeof result?.expires_on === "string" ? { expires: result.expires_on } : {}),
  ...(typeof result?.not_before === "string" ? { notBefore: result.not_before } : {}),
});

export const cloudflareNatives: Record<"cloudflare.verify", NativeTool> = {
  "cloudflare.verify": async (manifest, _args, send) => {
    const started = performance.now();
    const origin = new URL(manifest.origin).origin;
    const get = async (path: string) => {
      const url = new URL(`${manifest.basePath ?? ""}${path}`, origin);
      const said = await send({ kind: "http", method: "GET", url: url.toString(), headers: { ...(manifest.headers ?? {}) }, class: "read", target: `GET ${url.pathname}` });
      let json: any = null;
      try {
        json = JSON.parse(said.body);
      } catch {
        /* not JSON: the status says enough */
      }
      return { status: said.status, ok: said.ok && json?.success !== false, json };
    };
    const user = await get("/user/tokens/verify");
    if (user.ok) return answer(200, { owner: "user", ...tokenOf(user.json?.result) }, started);
    // Not a user's token: perhaps an account's, checked at each account it can see.
    const accounts = await get("/accounts?per_page=50");
    for (const account of accounts.ok && Array.isArray(accounts.json?.result) ? accounts.json.result : []) {
      if (typeof account?.id !== "string" || !ACCOUNT_ID.test(account.id)) continue;
      const own = await get(`/accounts/${account.id}/tokens/verify`);
      if (own.ok) return answer(200, { owner: "account", account: { id: account.id, name: String(account.name ?? "") }, ...tokenOf(own.json?.result) }, started);
    }
    return answer(
      user.status >= 400 ? user.status : 401,
      { error: "Cloudflare knows this token neither as a user's nor as one of an account it can see", said: user.json?.errors ?? null },
      started,
    );
  },
};
