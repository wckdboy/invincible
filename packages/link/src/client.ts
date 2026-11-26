import {
  approvalProof,
  decodeInvite,
  fromB64u,
  type Invite,
  type NodeIdentity,
  pairProof,
  type PairRequestFields,
  proofMatches,
  sasCode,
  signRequest,
  statusProof,
  utf8,
} from "@invincible/core";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * POST JSON to a peer, signed by this node's device key; the answer as it came (bytes, say). `signal`: the caller's own,
 * in place of the timeout (an answer streamed for as long as it takes).
 */
export async function signedFetch(
  identity: NodeIdentity,
  endpoint: string,
  path: string,
  payload: unknown,
  opts: { fetch?: FetchLike; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Response> {
  const body = utf8(JSON.stringify(payload));
  const headers = await signRequest(identity.id, identity.sign, "POST", path, body);
  return (opts.fetch ?? fetch)(`${endpoint.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body,
    redirect: "error",
    signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });
}

/**
 * The most of a peer's answer a node reads: room for the largest sync page (500 events of 64 KiB each) and a forwarded
 * route's answer, never a node's memory to fill.
 */
export const MAX_ANSWER_BYTES = 64 * 1024 * 1024;

/** An answer's text, read as it comes up to `max` bytes: past them (said or found), refused. */
async function boundedText(response: Response, max: number): Promise<string> {
  const said = response.headers.get("content-length");
  const tooLong = () => new Error(`its answer is past the ${max} bytes this node reads`);
  if (said && /^\d{1,16}$/.test(said) && Number(said) > max) {
    await response.body?.cancel().catch(() => {});
    throw tooLong();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw tooLong();
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

/** POST JSON to a peer, signed by this node's device key; its answer read up to MAX_ANSWER_BYTES. */
export async function signedPost<T>(
  identity: NodeIdentity,
  endpoint: string,
  path: string,
  payload: unknown,
  opts: { fetch?: FetchLike; timeoutMs?: number } = {},
): Promise<T> {
  const response = await signedFetch(identity, endpoint, path, payload, opts);
  if (!response.ok) throw new Error(`${path} → ${response.status} ${await boundedText(response, 64 * 1024).catch(() => "")}`.trim());
  return JSON.parse(await boundedText(response, MAX_ANSWER_BYTES)) as T;
}

export type { SyncPage } from "@invincible/core";

// ---- joining a fleet ---------------------------------------------------------

export interface JoinRequest {
  invite: Invite;
  secret: Uint8Array;
  device: string;
  sas: string;
}

/** Step 1 on the joining device: prove possession of the invite; returns the code to show. */
export async function requestPairing(
  inviteText: string,
  fields: Omit<PairRequestFields, "invite">,
  opts: { fetch?: FetchLike } = {},
): Promise<JoinRequest> {
  const invite = decodeInvite(inviteText);
  if (fields.kind !== invite.k) throw new Error(`this invite is for a ${invite.k}, not a ${fields.kind}`);
  const secret = fromB64u(invite.s);
  const request: PairRequestFields = { ...fields, invite: invite.i };
  const response = await (opts.fetch ?? fetch)(`${invite.e}/link/pair/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...request, proof: pairProof(secret, request) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`pairing refused: ${response.status} ${await response.text()}`);
  const { sas } = (await response.json()) as { sas: string };
  const expected = sasCode(secret, invite.f, fields.device);
  if (sas !== expected) throw new Error("the inviting node computed a different code; aborting");
  return { invite, secret, device: fields.device, sas };
}

/** Step 2: wait until you approve on the inviting side. Verifies the approval is authentic. */
export async function waitForApproval(
  join: JoinRequest,
  opts: { fetch?: FetchLike; timeoutMs?: number; intervalMs?: number } = {},
): Promise<{ fleet: string }> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
  const proof = statusProof(join.secret, join.invite.i, join.device);
  while (Date.now() < deadline) {
    const response = await (opts.fetch ?? fetch)(`${join.invite.e}/link/pair/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invite: join.invite.i, device: join.device, proof }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`pairing status failed: ${response.status} ${await response.text()}`);
    const status = (await response.json()) as { status: string; fleet?: string; approval?: string };
    if (status.status === "rejected") throw new Error("pairing was rejected");
    if (status.status === "approved") {
      const expected = approvalProof(join.secret, join.invite.i, join.device, join.invite.f);
      if (status.fleet !== join.invite.f || !status.approval || !proofMatches(expected, status.approval)) {
        throw new Error("approval could not be authenticated; aborting");
      }
      return { fleet: join.invite.f };
    }
    await Bun.sleep(opts.intervalMs ?? 1500);
  }
  throw new Error("timed out waiting for approval");
}
