import { authFor, type GatewayTokens, installedConnector } from "@galahad/brain";
import type { MindStore, Vault } from "@galahad/mind";
import type { LedgerEntryInput } from "@galahad/sandbox";

/*
 * The git read gateway: how a sandbox clones a private repository without ever
 * holding a GitHub key. It speaks git's smart HTTP, fetch only:
 *
 *   git -c http.extraHeader="Authorization: Bearer gw_…" clone http://<gateway>/git/<connector>/<owner>/<repo>.git
 *
 * The token is minted for one repository through one connector (provider
 * `git:<connector>:<owner>:<repo>`), for the quest's lifetime, only through gateway:mint
 * (a sandbox's providers can't name one: the contract reserves git:…); the node adds the
 * connector's key on the way to github.com. Pushing is refused: changes leave as a
 * shipment, through the oath gate (github.ship).
 */

/** Where each connector origin's repositories are served over git (fixed in code: a manifest can't point a key elsewhere). */
export const GIT_HOSTS: Record<string, string> = { "https://api.github.com": "https://github.com" };

const PATH = /^\/git\/([a-z][a-z0-9-]{0,39})\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\.git\/(info\/refs|git-upload-pack)$/;

export const gitScope = (connector: string, owner: string, repo: string) => `git:${connector}:${owner}:${repo}`;

export interface GitGatewayContext {
  store: MindStore;
  vault: Vault;
  tokens: GatewayTokens;
  ledger?: (entry: LedgerEntryInput) => void;
  fetch?: typeof fetch;
}

const text = (status: number, message: string) => new Response(`${message}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

export async function handleGitGateway(req: Request, ctx: GitGatewayContext): Promise<Response> {
  const url = new URL(req.url);
  if (/receive-pack/.test(url.pathname) || url.searchParams.get("service") === "git-receive-pack") {
    return text(403, "this gateway only reads: changes leave as a shipment, through your approval (github.ship)");
  }
  const match = url.pathname.match(PATH);
  if (!match) return text(404, "use /git/<connector>/<owner>/<repo>.git");
  const [, connector, owner, repo, rest] = match as unknown as [string, string, string, string, string];
  if (rest === "info/refs" && (req.method !== "GET" || url.searchParams.get("service") !== "git-upload-pack")) return text(400, "only git-upload-pack");
  if (rest === "git-upload-pack" && req.method !== "POST") return text(405, "POST");

  const token = req.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? "";
  const verdict = ctx.tokens.consume(token, gitScope(connector, owner, repo));
  if (!verdict.ok) return text(401, verdict.reason);

  const manifest = installedConnector(ctx.store, connector);
  const host = manifest ? GIT_HOSTS[new URL(manifest.origin).origin] : undefined;
  if (!manifest || !host) return text(404, `no git host for the connector ${connector}`);
  let key: string | null;
  try {
    key = authFor(ctx.vault, manifest).key;
  } catch (error) {
    return text(424, (error as Error).message);
  }

  const headers = new Headers({ "user-agent": "git/2 (galahad)" });
  for (const name of ["accept", "content-type", "content-encoding", "git-protocol"]) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (key) headers.set("authorization", `Basic ${Buffer.from(`x-access-token:${key}`).toString("base64")}`);
  if (rest === "info/refs") {
    ctx.ledger?.({ class: "read", resource: `connector.${connector}`, target: `git fetch ${owner}/${repo}`, verdict: "allow", reason: "a sandbox reads a repository through the git gateway" });
  }
  const upstream = await (ctx.fetch ?? fetch)(`${host}/${owner}/${repo}.git/${rest}${url.search}`, {
    method: req.method,
    headers,
    body: req.method === "POST" ? await req.arrayBuffer() : undefined,
    redirect: "manual",
  });
  const out = new Headers();
  for (const name of ["content-type", "cache-control", "expires", "pragma"]) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  if (!upstream.ok) return text(upstream.status === 401 || upstream.status === 403 ? 403 : upstream.status, `${owner}/${repo}: ${upstream.status} from ${host} (does the token for ${connector} read this repository?)`);
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
