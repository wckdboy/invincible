import { describe, expect, test } from "bun:test";
import { NOTIFY_DEFAULTS, type NotifyView } from "@invincible/core";
import { statusLines } from "../src/notify-cli.ts";

/** What `invincible notify` prints of a node's notifications: here, its tasks' Live Activities on an iPhone (I10). */
const view: NotifyView = {
  node: "ultra",
  key: "k",
  prefs: NOTIFY_DEFAULTS,
  devices: [],
  subscribed: null,
  lost: null,
  reachable: 0,
  today: { day: "2026-11-26", sent: [], count: 0, limit: 12 },
  quiet: false,
  held: 0,
};
const plain = (lines: string[]) => lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

describe("invincible notify", () => {
  test("says the tasks whose proof it keeps up on an iPhone's Lock Screen, when there are any", () => {
    expect(plain(statusLines({ ...view, activities: 2 }))).toContain("Live Activities  2 tasks' proof on an iPhone's Lock Screen, kept up from here");
    expect(plain(statusLines({ ...view, activities: 1 }))).toContain("Live Activities  1 task's proof on an iPhone's Lock Screen, kept up from here");
    expect(plain(statusLines({ ...view, activities: 0 })).some((line) => line.startsWith("Live Activities"))).toBe(false);
    // (An older node says nothing of them.)
    expect(plain(statusLines(view)).some((line) => line.startsWith("Live Activities"))).toBe(false);
  });
});
