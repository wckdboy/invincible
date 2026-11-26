import { expect, test } from "bun:test";
import { noticeFrom } from "./notices.ts";

test("where a notice came from, in words; one this app doesn't know, as it is", () => {
  expect(noticeFrom("rule:pushes")).toBe("Your rule pushes");
  expect(noticeFrom("loop:morning")).toBe("The loop morning");
  expect(noticeFrom("heartbeat")).toBe("The heartbeat");
  expect(noticeFrom("ci")).toBe("CI");
  expect(noticeFrom("compute")).toBe("His compute");
  expect(noticeFrom("rule:a:b")).toBe("Your rule a:b");
  for (const odd of ["rule:", ":x", "constructor:x", "toString", "something-new", ""]) expect(noticeFrom(odd)).toBe(odd);
});
