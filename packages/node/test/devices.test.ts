import { describe, expect, test } from "bun:test";
import type { DeviceView } from "@galahad/core";
import { activeDevicesMatching } from "../src/devices.ts";

/*
 * `galahad revoke <device>` takes a name, an id or the start of an id. A phone that was
 * revoked and paired again keeps its name ("Safari on iPhone"), and the fleet lists the
 * revoked one first: the name must reach the phone that's still active, or a lost phone
 * can't be revoked by name at all.
 */

const device = (id: string, name: string, revokedAt: string | null = null): DeviceView => ({
  id,
  name,
  kind: id.startsWith("n_") ? "node" : "client",
  role: id.startsWith("n_") ? "full" : "client",
  scopes: [],
  enrolledAt: "001700000000000.000000",
  revokedAt,
  endpoint: null,
  caps: null,
});

const fleet = [
  device("n_ultra0000000000000000000000000000000000000", "ultra"),
  device("c_oldphone00000000000000000000000000000000000", "Safari on iPhone", "001700000000001.000000"),
  device("c_newphone00000000000000000000000000000000000", "Safari on iPhone"),
  device("c_tablet0000000000000000000000000000000000000", "Safari on iPad"),
  device("c_spare00000000000000000000000000000000000000", "Safari on iPad"),
];

describe("which device a name or id means", () => {
  test("a revoked device never matches: its name reaches the one that's still active", () => {
    expect(activeDevicesMatching(fleet, "Safari on iPhone").map((d) => d.id)).toEqual(["c_newphone00000000000000000000000000000000000"]);
    expect(activeDevicesMatching(fleet, "c_oldphone")).toEqual([]);
  });

  test("by name, by id, or by the start of an id", () => {
    expect(activeDevicesMatching(fleet, "ultra").map((d) => d.name)).toEqual(["ultra"]);
    expect(activeDevicesMatching(fleet, "c_newphone00000000000000000000000000000000000").map((d) => d.name)).toEqual(["Safari on iPhone"]);
    expect(activeDevicesMatching(fleet, "c_tablet").map((d) => d.name)).toEqual(["Safari on iPad"]);
    expect(activeDevicesMatching(fleet, "nobody")).toEqual([]);
  });

  test("several active devices under one name all come back, so the caller asks which", () => {
    expect(activeDevicesMatching(fleet, "Safari on iPad")).toHaveLength(2);
  });
});
