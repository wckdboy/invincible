import type { DeviceView } from "@galahad/core";

/**
 * The active devices a name, an id or the start of an id refers to. A revoked device
 * never matches: a phone paired again keeps its name, and the revoked one (listed first,
 * being older) must not stand in the way of the one that's still active. An exact id
 * wins over everything else; several matches are the caller's to tell apart.
 */
export function activeDevicesMatching(devices: DeviceView[], ref: string): DeviceView[] {
  const active = devices.filter((d) => !d.revokedAt);
  const exact = active.filter((d) => d.id === ref);
  return exact.length ? exact : active.filter((d) => d.name === ref || d.id.startsWith(ref));
}
