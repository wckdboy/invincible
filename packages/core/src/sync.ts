import { z } from "zod";
import type { Presence } from "./api.ts";
import type { GEvent } from "./events.ts";

/*
 * Node-to-node sync (/link/sync, /link/push): signed by the calling node's key,
 * answered only to enrolled nodes. See MindStore.eventsSince and PullState.
 */

const DeviceRef = z.string().max(100);
/** One device's log as a replica holds it: how many events, and their set hash (SetHash). */
export const LogDigest = z.strictObject({ n: z.number().int().min(0), h: z.string().max(64) });

export const SyncRequest = z.strictObject({
  /** Per device, the newest hlc held: answer what's dated after it. */
  have: z.record(DeviceRef, z.string().max(32)),
  /**
   * Per device, the id of the event at `have` a walk has reached: answer what comes after that
   * event in (hlc, id) order, so an event dated the same instant isn't skipped. Sent only to a
   * node that compares `sets` (older ones refuse the field); without it, `have` alone.
   */
  after: z.record(DeviceRef, z.string().max(64)).optional(),
  /** Sent by nodes from before set hashes (a hash of sorted ids): accepted, and ignored. */
  digests: z.record(DeviceRef, LogDigest).optional(),
  /** Per device, LogDigest of everything held: lets the peer find holes below `have`. */
  sets: z.record(DeviceRef, LogDigest).optional(),
});
export type SyncRequest = z.infer<typeof SyncRequest>;

export const PushRequest = z.strictObject({ events: z.array(z.unknown()).max(500) });

export interface SyncPage {
  /** At most one page, oldest first. */
  events: GEvent[];
  more: boolean;
  presence?: Presence | null;
  /** This node compares `sets`: send them (an older node would refuse the field). */
  sets?: true;
  /** Devices whose log below your frontier differs from ours, and we hold at least as much: walk them. */
  repair?: string[];
}
