import { expect, test } from "bun:test";
import { ROUND_SOURCE } from "@invincible/core/routing";
import { noticeFrom } from "./notices.ts";

test("where a notice came from, in words; one this app doesn't know, as it is", () => {
  expect(noticeFrom("rule:pushes")).toBe("Your rule pushes");
  expect(noticeFrom("loop:morning")).toBe("The loop morning");
  expect(noticeFrom("heartbeat")).toBe("The heartbeat");
  expect(noticeFrom("ci")).toBe("CI");
  expect(noticeFrom("compute")).toBe("Its compute");
  expect(noticeFrom("routing")).toBe("Routing");
  expect(noticeFrom("rule:a:b")).toBe("Your rule a:b");
  for (const odd of ["rule:", ":x", "constructor:x", "toString", "something-new", ""]) expect(noticeFrom(odd)).toBe(odd);
});

test("work going round on both tiers comes from the node's routing, said as a word: the same in every app (the vectors)", () => {
  expect(noticeFrom(ROUND_SOURCE)).toBe("Routing");
});
