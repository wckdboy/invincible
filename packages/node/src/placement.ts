import type { ComputeNodeView, NodeCapacity, PeerStatus, PlacementNeeds, Presence } from "@galahad/core";
import { cannotMake, CONTAINER_IMAGES, FIRST_IMAGES, OWN_IMAGES, type SandboxAsk } from "@galahad/sandbox";
import { type Capabilities, isAlwaysOn } from "./capabilities.ts";

/*
 * Where should a piece of work run? Hard constraints filter, soft preferences
 * score, and every decision carries its reasons so you can see why.
 *
 * Rules of thumb the scorer encodes:
 *  - untrusted work (web content, unknown code) only runs where it can be sandboxed
 *  - long work prefers always-on machines and avoids laptops on battery
 *  - interactive work prefers the machine you are using
 *  - local-model work prefers GPUs; heavy work prefers free memory and idle cores
 *  - a node's strength is what it measured (its calibration), not its core count
 *  - a node with a slot free is preferred; a full one is ranked behind (work would wait there)
 *  - a Mac with Apple's container hosts sandboxes, each a VM of its own; what it can't make goes elsewhere
 */

/** A sandbox as placement reads it: what it asks of a host, and whether it is kept (a knight's own VM, which may be given more). */
export type SandboxNeeds = SandboxAsk & { kept?: boolean };

/** A Mac whose sandboxes are Apple's container's: every one a VM of its own. */
const containerHost = (caps: Capabilities): boolean => caps.sandbox?.engine === "container";

export interface Candidate {
  device: string;
  name: string;
  caps: Capabilities | null;
  online: boolean;
  self: boolean;
  presence: Presence | null;
  /**
   * What the node may carry (from its calibration and the owner's ceiling), how many standard sandboxes
   * fit now (null: not known) and how many wait. Absent: scored from the core count, as before compute.
   */
  compute?: { capacity: NodeCapacity; free: number | null; queued: number; /** Tokens a second its best local model measured. */ localTps?: number } | null;
}

/** A device of the fleet, as far as placement reads it (the mind's Device). */
export interface PlacementDevice {
  id: string;
  name: string;
  kind: string;
  profile: { caps: Record<string, unknown> } | null;
}

/**
 * What this node itself did on other hosts since each last reported its slots: sandboxes it sent there (+1) and
 * sandboxes of its own it ended there (-1). Another host's slots are known only as of its last sync, a few
 * seconds old: without this, every sandbox asked for in those seconds is placed by the same picture, all go to
 * the best-ranked host, and they queue there while the others stand idle.
 */
export class Dispatched {
  private entries: { node: string; at: number; delta: 1 | -1 }[] = [];

  /** A sandbox sent to `node` (+1), or one ended there (-1), at `at` (ms). Returns how to take it back (a sandbox that was never made). */
  note(node: string, delta: 1 | -1, at: number): () => void {
    const entry = { node, at, delta };
    this.entries.push(entry);
    if (this.entries.length > 4096) this.entries.splice(0, this.entries.length - 4096);
    return () => {
      const i = this.entries.indexOf(entry);
      if (i >= 0) this.entries.splice(i, 1);
    };
  }

  /**
   * The net of what `node` hasn't reported yet: everything noted since its last report was asked for
   * (`reportedAt`, ms). What's older is in that report, and is forgotten here.
   */
  since(node: string, reportedAt: number): number {
    this.entries = this.entries.filter((e) => e.node !== node || e.at >= reportedAt);
    let net = 0;
    for (const e of this.entries) if (e.node === node) net += e.delta;
    return net;
  }
}

/**
 * A host's room as it last reported it, corrected by what this node did there since: `net` more sandboxes than
 * the report knows (fewer, when negative). More sandboxes take the free slots, then queue; fewer serve its
 * queue first, then free slots.
 */
export function withDispatched<C extends { capacity: NodeCapacity; free: number | null; queued: number }>(room: C, net: number): C {
  if (room.free === null || net === 0) return room;
  if (net > 0) return { ...room, free: Math.max(0, room.free - net), queued: room.queued + Math.max(0, net - room.free) };
  const served = Math.min(-net, room.queued);
  return { ...room, queued: room.queued - served, free: Math.min(room.capacity.sandboxes, room.free - net - served) };
}

/**
 * Every node of the fleet as a candidate: its body, whether it answers, its live load, and what it measured
 * and has free now (the census). This node's own numbers are live; another's are as its last sync said,
 * corrected by what this node itself did there since (`dispatched`).
 */
export function fleetCandidates(fleet: {
  devices: readonly PlacementDevice[];
  self: string;
  selfCaps: Capabilities | null;
  statuses: readonly PeerStatus[];
  compute: readonly ComputeNodeView[];
  dispatched?: Dispatched;
}): Candidate[] {
  const statuses = new Map(fleet.statuses.map((s) => [s.device, s]));
  const compute = new Map(fleet.compute.map((n) => [n.id, n]));
  return fleet.devices
    .filter((d) => d.kind === "node")
    .map((d) => {
      const self = d.id === fleet.self;
      const status = statuses.get(d.id);
      const known = compute.get(d.id);
      const localTps = Math.max(0, ...(known?.calibration?.models ?? []).map((m) => m.tps));
      const room = known?.capacity ? { capacity: known.capacity, free: known.free, queued: known.use?.queued ?? 0, ...(localTps ? { localTps } : {}) } : null;
      // Another host's report is as old as its last sync: when that sync was asked for is the moment it speaks for.
      const reportedAt = status?.lastSeen ? status.lastSeen - (status.rttMs ?? 0) : null;
      return {
        device: d.id,
        name: d.name,
        caps: self ? fleet.selfCaps : ((d.profile?.caps as unknown as Capabilities) ?? null),
        online: self || !!status?.online,
        self,
        presence: status?.presence ?? null,
        // What it measured and what's free there now: placement's reasons name both.
        compute: room && !self && fleet.dispatched && reportedAt !== null ? withDispatched(room, fleet.dispatched.since(d.id, reportedAt)) : room,
      };
    });
}

/**
 * The host for a sandbox nobody pinned to a node: the best-ranked candidate that hosts sandboxes at all and can make
 * this one (a Mac makes no isolated sandbox, no desktop, no Lab, no Gazebo: its `cannot`), the one with room, by what
 * each measured; when every host is full, the one with the shortest queue. A knight's own VM leans a little to a host
 * whose VMs grow while they run (a Mac's pause to), and its reasons say which. Null: none online can.
 */
/**
 * Why a host doesn't make the image of Galahad's own a sandbox names, or null: what it said it makes, or, its release
 * older than saying, what every release made (a Mac's, the workshop's). An image not his is pulled where it's made.
 */
function unmadeImage(needs: SandboxNeeds, sandbox: NonNullable<Capabilities["sandbox"]>): string | null {
  if (!needs.image || !OWN_IMAGES[needs.image]) return null;
  const made = sandbox.images ?? (sandbox.engine === "container" ? CONTAINER_IMAGES : FIRST_IMAGES);
  return made.includes(needs.image) ? null : `it doesn't make ${needs.image}${sandbox.images ? "" : ": its release is older than that image"}`;
}

/** Why a host can't make this sandbox (what it can't give, or an image it doesn't make), or null. */
const cannotHost = (needs: SandboxNeeds, sandbox: NonNullable<Capabilities["sandbox"]>): string | null => cannotMake(needs, sandbox.cannot ?? []) ?? unmadeImage(needs, sandbox);

export function sandboxHost(candidates: readonly Candidate[], needs: SandboxNeeds = {}): Placement | null {
  const { ranked } = place({ docker: true, untrusted: true }, [...candidates]);
  const hosts = new Map(candidates.filter((c) => !!c.caps?.sandbox && !cannotHost(needs, c.caps.sandbox)).map((c) => [c.device, c.caps!.sandbox!]));
  const able = ranked.filter((p) => hosts.has(p.device));
  if (!needs.kept) return able[0] ?? null;
  const leaning = able.map((p) => {
    const grows = hosts.get(p.device)!.grows !== false;
    return { ...p, score: p.score + (grows ? 5 : 0), reasons: [...p.reasons, grows ? "its VMs grow while they run" : "its VMs pause to grow (a Mac's can't grow while they run)"] };
  });
  return leaning.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))[0] ?? null;
}

/** The sandbox hosts online that can't make this sandbox, each with why (what placement says when none can). */
export function sandboxRefusals(candidates: readonly Candidate[], needs: SandboxNeeds): { name: string; reason: string }[] {
  return candidates.flatMap((c) => {
    const why = (c.online || c.self) && c.caps?.sandbox ? cannotHost(needs, c.caps.sandbox) : null;
    return why ? [{ name: c.name, reason: why }] : [];
  });
}

export interface Placement {
  device: string;
  name: string;
  score: number;
  reasons: string[];
}

export interface PlacementResult {
  ranked: Placement[];
  rejected: { device: string; name: string; reason: string }[];
}

function hardCheck(needs: PlacementNeeds, c: Candidate): string | null {
  if (!c.online && !c.self) return "offline";
  const caps = c.caps;
  if (!caps) return "no capability profile yet";
  // (A Mac's container runs containers, each in a VM of its own: Docker's need, and a VM's, are met there.)
  if (needs.docker && !caps.docker && !containerHost(caps)) return "no docker";
  if (needs.vm && !(caps.vm.kvm || caps.vm.tools.length || containerHost(caps))) return "no VM support";
  if (needs.gpu && !caps.gpu.length) return "no GPU";
  if (needs.minMemoryGb && caps.memoryGb < needs.minMemoryGb) return `only ${caps.memoryGb} GB RAM`;
  const missing = (needs.tools ?? []).filter((t) => !caps.tools.includes(t));
  if (missing.length) return `missing ${missing.join(", ")}`;
  if (needs.localModels && !caps.localModels.some((r) => r.models.length)) return "no local models running";
  if (needs.untrusted && !caps.docker && !(caps.vm.kvm || caps.vm.tools.length) && !containerHost(caps)) return "cannot sandbox untrusted work";
  // The owner's ceiling: a node told to carry no sandboxes takes none.
  if ((needs.docker || needs.untrusted) && caps.sandbox && c.compute && c.compute.capacity.sandboxes <= 0) return "its ceiling takes no sandboxes";
  return null;
}

export function place(needs: PlacementNeeds, candidates: Candidate[]): PlacementResult {
  const ranked: Placement[] = [];
  const rejected: PlacementResult["rejected"] = [];
  for (const c of candidates) {
    const reason = hardCheck(needs, c);
    if (reason) {
      rejected.push({ device: c.device, name: c.name, reason });
      continue;
    }
    const caps = c.caps!;
    const reasons: string[] = [];
    let score = 50;
    const onBattery = c.presence?.onBattery ?? false;
    const alwaysOn = isAlwaysOn(caps);

    if (needs.longRunning) {
      if (alwaysOn) {
        score += 25;
        reasons.push("always-on");
      }
      if (onBattery) {
        score -= 40;
        reasons.push("on battery");
      }
    } else if (onBattery) {
      score -= 10;
      reasons.push("on battery");
    }
    if (needs.interactive && c.self) {
      score += 20;
      reasons.push("you are here");
    }
    if (needs.untrusted) {
      const microVMs = !!caps.sandbox?.vm;
      score += microVMs ? 15 : caps.vm.kvm ? 10 : 5;
      reasons.push(containerHost(caps) ? "a VM of its own for each (Apple's container)" : microVMs ? "KVM microVMs" : caps.vm.kvm ? "VM isolation available" : "container isolation");
      if (caps.sandbox?.image && caps.sandbox.networks) {
        score += 15;
        reasons.push("sandbox host ready");
      }
    }
    if (needs.localModels && caps.gpu.length) {
      score += 15;
      reasons.push(`GPU: ${caps.gpu[0]!.name}`);
    }
    if (c.presence) {
      const busy = c.presence.cores ? c.presence.load / c.presence.cores : 0;
      if (busy > 0.75) {
        score -= 20;
        reasons.push("busy");
      }
      const freeShare = caps.memoryGb ? c.presence.freeMemoryGb / caps.memoryGb : 0;
      score += Math.round(freeShare * 10);
    }
    const compute = c.compute;
    if (!compute) score += Math.min(10, Math.round(caps.cores / 4));
    else {
      // Strength: what it measured, in reference cores' worth; a guess from its threads until it has.
      if (compute.capacity.strength !== null) {
        score += Math.min(10, Math.round(compute.capacity.strength / 4));
        reasons.push(`measured ${compute.capacity.strength.toFixed(1)} reference cores' worth`);
      } else {
        score += Math.min(10, Math.round(caps.cores / 8));
        reasons.push(`not measured yet: guessing from ${caps.cores} threads`);
      }
      // Room: a slot free now counts for it; a full node is ranked behind, the longer its queue the further.
      const slots = compute.capacity.sandboxes;
      if (slots > 0) {
        if (compute.free === null) reasons.push(`${slots} slot${slots === 1 ? "" : "s"} (in use: not known)`);
        else if (compute.free > 0) {
          score += Math.min(10, compute.free * 2);
          reasons.push(`${compute.free} of ${slots} slot${slots === 1 ? "" : "s"} free`);
        } else {
          score -= 20 + Math.min(10, compute.queued * 2);
          reasons.push(`full: work waits for a slot (${compute.queued} ahead)`);
        }
      }
      if (needs.localModels && compute.localTps) {
        score += Math.min(10, Math.round(compute.localTps / 6));
        reasons.push(`its local model wrote ${Math.round(compute.localTps)} tokens a second`);
      }
    }
    if (needs.prefer && (c.name === needs.prefer || c.device === needs.prefer)) {
      score += 50;
      reasons.push("preferred");
    }
    ranked.push({ device: c.device, name: c.name, score, reasons });
  }
  ranked.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return { ranked, rejected };
}
