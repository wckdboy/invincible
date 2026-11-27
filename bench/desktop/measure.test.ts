import { describe, expect, test } from "bun:test";
import { grownAt, guestMemory, leftOver, type MemoryLine } from "./measure.ts";

/* What C1 step 10's numbers are read from, in the VM: its memory, what a stopped desktop left running, and when it grew. */

const MEMINFO = ["MemTotal:        4027412 kB", "MemFree:         3301220 kB", "MemAvailable:    3584112 kB", "Buffers:           10240 kB", "Shmem:              2048 kB", ""].join("\n");

describe("the guest's memory, from its /proc/meminfo", () => {
  test("all of it, what it has available, and what is in use, MB", () => {
    const m = guestMemory(MEMINFO);
    expect(m.totalMb).toBeCloseTo(4027412 / 1024, 6);
    expect(m.availableMb).toBeCloseTo(3584112 / 1024, 6);
    expect(m.usedMb).toBeCloseTo((4027412 - 3584112) / 1024, 6);
  });

  test("in use is what isn't available, never what isn't free: a page cache it can drop isn't counted", () => {
    expect(guestMemory(MEMINFO).usedMb).toBeLessThan((4027412 - 3301220) / 1024);
  });

  test("one without what it is read from is said, never read as nothing", () => {
    expect(() => guestMemory("MemTotal:        4027412 kB\n")).toThrow(/MemAvailable/);
  });
});

describe("what a stopped desktop left running", () => {
  const before = ["python3", "sleep", "ps", ""].join("\n");

  test("what runs after that didn't before, by name, as often as it runs", () => {
    const after = ["python3", "sleep", "chromium", "Xvfb", "chromium", "ps"].join("\n");
    expect(leftOver(before, after)).toEqual(["Xvfb", "chromium", "chromium"]);
  });

  test("what ran before and still does is nothing left, and nor is ps itself", () => {
    expect(leftOver(before, ["sleep", "python3", "ps", "ps"].join("\n"))).toEqual([]);
  });

  test("a second of a name that ran once before is left", () => {
    expect(leftOver(before, ["python3", "python3", "sleep"].join("\n"))).toEqual(["python3"]);
  });
});

describe("when the guest had the memory it was grown by", () => {
  const GB = 1024 ** 3;
  const added = 2 * 1024 * 1024; // 2 GB, in kB
  const line = (at: number, totalKb: number, limit: number): MemoryLine => ({ at, totalKb, limit });

  test("the first line with all of it and the limit raised", () => {
    const lines = [line(0, 4_000_000, 2 * GB), line(5, 4_000_000, 4 * GB), line(9, 4_000_000 + added, 4 * GB), line(12, 4_000_000 + added, 4 * GB)];
    expect(grownAt(lines, added, 4 * GB)?.at).toBe(9);
  });

  test("the memory without the limit, where the guest can read one, isn't grown yet", () => {
    expect(grownAt([line(0, 4_000_000, 2 * GB), line(7, 4_000_000 + added, 2 * GB)], added, 4 * GB)).toBeNull();
  });

  test("part of the memory isn't all of it", () => {
    expect(grownAt([line(0, 4_000_000, 2 * GB), line(7, 4_000_000 + added / 2, 4 * GB), line(8, 4_000_000 + added * 0.85, 4 * GB)], added, 4 * GB)).toBeNull();
  });

  test("what the kernel keeps of what was added for its own is still all of it", () => {
    expect(grownAt([line(0, 4_000_000, 2 * GB), line(7, 4_000_000 + added * 0.98, 4 * GB)], added, 4 * GB)?.at).toBe(7);
  });

  test("with no limit it can read, or none at all, its memory alone says", () => {
    expect(grownAt([line(0, 4_000_000, -1), line(6, 4_000_000 + added, -1)], added, 4 * GB)?.at).toBe(6);
    expect(grownAt([line(0, 4_000_000, 0), line(6, 4_000_000 + added, 0)], added, 4 * GB)?.at).toBe(6);
  });

  test("nothing said yet is nothing grown", () => {
    expect(grownAt([], added, 4 * GB)).toBeNull();
    expect(grownAt([line(0, 4_000_000, 2 * GB)], added, 4 * GB)).toBeNull();
  });
});
