import { describe, expect, test } from "bun:test";
import { grownAt, guestMemory, leftOver, type MemoryLine, restartCycles } from "./measure.ts";
import type { Ran } from "./vm.ts";

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

/** The VM's processes before its desktop first started: its init, its `sleep`, and the bench's page server. */
const BEFORE = ["docker-init", "sleep", "python3"];

/**
 * A VM whose desktop each `desktop open` starts and the bench's next look finds stopped, as deskd's idle stop leaves it:
 * from its `from`th stop on, each leaves its deskd (python3) a zombie, as a VM whose first process never reaps keeps it.
 */
function cycling(from = Infinity) {
  let running = false;
  let stops = 0;
  let zombies = 0;
  const ran = (stdout = "", stderr = ""): Ran => ({ code: 0, stdout, stderr, ms: 1 });
  const vm = {
    raw: async (argv: string[]): Promise<Ran> => {
      const command = argv.join(" ");
      if (command.startsWith("desktop open ")) {
        running = true;
        return ran("", "desktop: the desktop was stopped after 8 s unused; this screen is a fresh one\n");
      }
      if (command === "desktop text") return ran("Full name\n");
      if (command.startsWith("test -e ")) {
        if (running) {
          running = false;
          stops++;
          if (stops >= from) zombies++;
        }
        return ran();
      }
      if (command === "ps -eo comm=") return ran([...BEFORE, ...(running ? ["python3", "Xvfb"] : []), ...Array<string>(zombies).fill("python3")].join("\n"));
      if (command === "ps -eo args=") return ran(running ? "python3 /usr/local/lib/invincible/deskd.py\n" : "sleep infinity\n");
      throw new Error(`the bench asked what no VM here answers: ${command}`);
    },
  };
  return { vm, stops: () => stops };
}

describe("started again after each idle stop, and stopped again each time", () => {
  test("every restart is stopped again, the last one too, and what each stop left is kept: a deskd never reaped is left from its stop on", async () => {
    const { vm, stops } = cycling(3);
    const rows = await restartCycles(vm, BEFORE.join("\n"), 5, () => {}, 0);
    expect(stops()).toBe(5);
    expect(rows.map((row) => row.left)).toEqual([[], [], ["python3"], ["python3", "python3"], ["python3", "python3", "python3"]]);
  });

  test("where the VM reaps what deskd leaves, no stop leaves anything, and every start was read and told", async () => {
    const { vm, stops } = cycling();
    const rows = await restartCycles(vm, BEFORE.join("\n"), 5, () => {}, 0);
    expect(stops()).toBe(5);
    expect(rows.map((row) => [row.usable, row.told, row.left])).toEqual(Array(5).fill([true, true, []]));
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
