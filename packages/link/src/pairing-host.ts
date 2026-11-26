import {
  approvalProof,
  encodeInvite,
  INVITE_TTL_MS,
  type Invite,
  isClientId,
  isNodeId,
  newInvite,
  type NodeIdentity,
  type PairingView,
  pairProof,
  PairRequest,
  proofMatches,
  sasCode,
  type Scope,
  statusProof,
} from "@galahad/core";
import { enrollDevice, type MindStore } from "@galahad/mind";

interface PendingRequest {
  device: string;
  name: string;
  kind: "node" | "client";
  box?: string;
  endpoint?: string;
  sas: string;
  requestedAt: number;
  status: "pending" | "approved" | "rejected";
}

interface InviteRecord {
  invite: Invite;
  secret: Uint8Array;
  scopes?: Scope[];
  expiresAt: number;
  requests: Map<string, PendingRequest>;
  /** A second device used the same invite: possible interception. Nothing on it can be approved. */
  conflict: boolean;
  done: boolean;
}

export class PairingError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/**
 * The approving side of pairing. Invites live only in this process's memory:
 * restarting the daemon invalidates every outstanding invite.
 */
export class PairingHost {
  private readonly invites = new Map<string, InviteRecord>();

  constructor(
    private readonly store: MindStore,
    private readonly identity: NodeIdentity,
    private readonly endpoint: string,
    private readonly now: () => number = Date.now,
    private readonly onEnrolled: (device: string) => void = () => {},
  ) {}

  createInvite(kind: "node" | "client", opts: { scopes?: Scope[]; origin?: string } = {}) {
    const fleet = this.store.fleet;
    if (!fleet) throw new PairingError("no fleet yet");
    this.sweep();
    const { invite, secret } = newInvite(this.endpoint, fleet, kind);
    const expiresAt = this.now() + INVITE_TTL_MS;
    this.invites.set(invite.i, { invite, secret, scopes: opts.scopes, expiresAt, requests: new Map(), conflict: false, done: false });
    const text = encodeInvite(invite);
    const url = opts.origin ? `${opts.origin.replace(/\/$/, "")}/#pair=${text}` : null;
    return { invite: text, url, expiresAt, id: invite.i };
  }

  private record(inviteId: string): InviteRecord {
    const record = this.invites.get(inviteId);
    if (!record || record.expiresAt <= this.now()) throw new PairingError("invite unknown or expired", 404);
    return record;
  }

  /** Unauthenticated endpoint: the joiner proves possession of the invite secret. */
  request(raw: unknown): { status: "pending"; sas: string } {
    const req = PairRequest.parse(raw);
    const record = this.record(req.invite);
    if (record.done) throw new PairingError("invite already used", 409);
    const { proof, ...fields } = req;
    if (!proofMatches(pairProof(record.secret, fields), proof)) throw new PairingError("invalid invite proof", 403);
    if (req.kind !== record.invite.k) throw new PairingError(`this invite is for a ${record.invite.k}`);
    if (req.kind === "node" && (!isNodeId(req.device) || !req.box)) throw new PairingError("nodes must present an ed25519 id and box key");
    if (req.kind === "client" && !isClientId(req.device)) throw new PairingError("clients must present a P-256 id");
    if (this.store.device(req.device)) throw new PairingError("device already enrolled", 409);

    const existing = record.requests.get(req.device);
    // A second device, or the same device id presenting different keys or details,
    // means someone else is holding this invite. Lock it.
    const changed =
      existing &&
      (existing.name !== req.name || existing.kind !== req.kind || existing.box !== req.box || existing.endpoint !== req.endpoint);
    if ((!existing && record.requests.size > 0) || changed) {
      record.conflict = true;
      for (const pending of record.requests.values()) pending.status = "rejected";
      throw new PairingError("invite was used by two devices: possible interception; create a new invite", 409);
    }
    const sas = sasCode(record.secret, record.invite.f, req.device);
    if (!existing) {
      record.requests.set(req.device, {
        device: req.device,
        name: req.name,
        kind: req.kind,
        ...(req.box ? { box: req.box } : {}),
        ...(req.endpoint ? { endpoint: req.endpoint } : {}),
        sas,
        requestedAt: this.now(),
        status: "pending",
      });
    }
    return { status: "pending", sas };
  }

  /** Unauthenticated endpoint: the joiner polls with a proof bound to its device id. */
  status(inviteId: string, device: string, proof: string) {
    const record = this.record(inviteId);
    if (!proofMatches(statusProof(record.secret, inviteId, device), proof)) throw new PairingError("invalid status proof", 403);
    const pending = record.requests.get(device);
    if (!pending) throw new PairingError("no such request", 404);
    if (pending.status !== "approved") return { status: pending.status };
    return {
      status: "approved" as const,
      fleet: record.invite.f,
      approval: approvalProof(record.secret, inviteId, device, record.invite.f),
    };
  }

  pending(): PairingView[] {
    this.sweep();
    const out: PairingView[] = [];
    for (const record of this.invites.values()) {
      for (const r of record.requests.values()) {
        if (r.status !== "pending") continue;
        out.push({
          invite: record.invite.i,
          device: r.device,
          name: r.name,
          kind: r.kind,
          sas: r.sas,
          requestedAt: r.requestedAt,
          conflict: record.conflict,
        });
      }
    }
    return out;
  }

  approve(inviteId: string, device: string): void {
    const record = this.record(inviteId);
    const pending = record.requests.get(device);
    if (!pending || pending.status !== "pending") throw new PairingError("nothing to approve", 404);
    if (record.conflict) throw new PairingError("invite is in conflict; it cannot be approved", 409);
    enrollDevice(this.store, this.identity, {
      device,
      name: pending.name,
      kind: pending.kind,
      ...(pending.box ? { box: pending.box } : {}),
      ...(record.scopes ? { scopes: record.scopes } : {}),
    });
    pending.status = "approved";
    record.done = true;
    this.onEnrolled(device);
  }

  reject(inviteId: string, device: string): void {
    const pending = this.record(inviteId).requests.get(device);
    if (pending) pending.status = "rejected";
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, record] of this.invites) if (record.expiresAt + 60_000 < now) this.invites.delete(id);
  }
}
