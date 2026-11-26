import { expect, test } from "bun:test";
import { afterPush, badgeCount, badgeMessage, NO_BADGE, readBadgeMessage, readBadgeState, showBadge } from "./badge.ts";

test("while the app is closed, each push about something new that waits for you adds one to what the page last set", () => {
  let state = { base: 2, tags: [] as string[] };
  state = afterPush(state, { kind: "approval", tag: "t-a" });
  state = afterPush(state, { kind: "question", tag: "t-b" });
  expect(badgeCount(state)).toBe(4);
  // The same thing told again adds nothing.
  state = afterPush(state, { kind: "approval", tag: "t-a" });
  expect(badgeCount(state)).toBe(4);
  // Several at once is at least one more; news that doesn't wait for you is none.
  state = afterPush(state, { kind: "summary", tag: "t-c" });
  for (const kind of ["finished", "limit", "test"] as const) state = afterPush(state, { kind, tag: `t-${kind}` });
  expect(badgeCount(state)).toBe(5);
});

test("what the worker stored, and what a page tells it, are read strictly", () => {
  expect(readBadgeState({ base: 3, tags: ["t-a"] })).toEqual({ base: 3, tags: ["t-a"] });
  for (const strange of [null, 7, "3", { base: -1, tags: [] }, { base: 1.5, tags: [] }, { base: 1e9, tags: [] }, { base: 1, tags: [1] }, { base: 1, tags: ["x".repeat(65)] }]) {
    expect(readBadgeState(strange)).toEqual(NO_BADGE);
  }
  expect(readBadgeMessage(badgeMessage(4))).toBe(4);
  expect(readBadgeMessage(badgeMessage(-3))).toBe(0);
  for (const strange of [null, { type: "galahad:badge" }, { type: "galahad:badge", count: "4" }, { type: "galahad:open", count: 4 }, { type: "galahad:badge", count: 1e6 }]) {
    expect(readBadgeMessage(strange)).toBeNull();
  }
});

test("the icon shows the count, is cleared at none, and a browser without badges or that refuses them is no error", async () => {
  const calls: string[] = [];
  const badging = { setAppBadge: async (n?: number) => void calls.push(`set ${n}`), clearAppBadge: async () => void calls.push("clear") };
  await showBadge(badging, 3);
  await showBadge(badging, 0);
  expect(calls).toEqual(["set 3", "clear"]);
  await showBadge({}, 3);
  await showBadge({ setAppBadge: async () => { throw new DOMException("no", "NotAllowedError"); } }, 3);
});
