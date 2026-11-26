import { describe, expect, test } from "bun:test";
import { bodyFingerprint, type Calibration, type ComputeBody, type ComputeNodeView, type ComputeView, deriveCapacity, derivePlan, KERNEL, REFERENCE_SINGLE, whatMoreBuys } from "@galahad/core";
import { ago, computeCommand, describeCompute, limitLine, measuredLine, parseEffort } from "../src/compute-cli.ts";

/* The terminal's census: every number a node measured, its ceiling and why, what's in use and waiting. */

const NOW = Date.parse("2026-11-11T12:00:00Z");
const body: ComputeBody = { cores: 32, memoryGb: 182, gpu: [], sandboxHost: true, microVMs: true, localModels: [] };
const calibration: Calibration = {
  at: NOW - 3 * 86_400_000,
  tookMs: 3400,
  reason: "joined",
  body: bodyFingerprint(body, null),
  cpu: { single: REFERENCE_SINGLE * 0.98, multi: REFERENCE_SINGLE * 0.98 * 14.2, threads: 16, kernel: KERNEL },
  memoryGbps: 9.5,
  disk: { writeMbps: 1200, readMbps: 1800 },
  sandbox: [{ kind: "container", startMs: 640 }, { kind: "vm", startMs: 1710 }],
  models: [{ runtime: "ollama", model: "qwen3:8b", tps: 41.3 }],
};
const capacity = deriveCapacity(body, calibration, null);
const ultra: ComputeNodeView = {
  id: "n_ultra",
  name: "ultra",
  self: true,
  online: true,
  body,
  calibration,
  due: null,
  limit: null,
  capacity,
  use: { sandboxes: 2, cores: 8, memoryGb: 16, queued: 1, modelCalls: 3, modelQueued: 0 },
  free: 0,
  queue: [{ quest: "q-abc123", cpus: 4, memoryGb: 8, since: NOW - 60_000, why: "8.0 of the 14 threads he may use are taken" }],
};
const plan = derivePlan([{ id: ultra.id, name: ultra.name, body, capacity }]);
const view: ComputeView = {
  self: "n_ultra",
  nodes: [ultra, { id: "n_new", name: "rack", self: false, online: true, body, calibration: null, due: "joined", limit: { cores: 8 }, capacity: deriveCapacity(body, null, { cores: 8 }), use: null, free: null, queue: [] }],
  policy: { effort: "auto", attemptsPerDay: 12 },
  budget: { perDay: 12, usedToday: 2 },
  plan,
  adapted: { at: NOW - 3_600_000, changes: ["ultra: 2 → 3 sandbox slots."] },
  work: [{ quest: "q-xyz789", label: "compute the tip deflection", effort: 3, asked: "auto", by: "you", since: NOW, reasons: [], attempts: [{ index: 2, doing: "The engineer is thinking", station: "forge", model: "deepseek/deepseek-chat", sandbox: "0123456789", active: true, last: NOW }] }],
  more: whatMoreBuys([{ name: "ultra", body, capacity, limit: null }], plan),
  suggestions: [{ key: "compute-suggest:hire-local:n_ultra", title: "Galahad suggests: hire ollama/qwen3:8b for the swift role", body: "…galahad roster set swift ollama/qwen3:8b" }],
};

describe("galahad compute", () => {
  test("the census says what each node measured, its ceiling and why, slots in use and waiting, the work in hand, and what more would buy", () => {
    const text = describeCompute(view, NOW);
    expect(text).toContain("2 of 4 sandbox slots in use");
    expect(text).toContain("1 waiting");
    expect(text).toContain("effort auto (up to 3)");
    expect(text).toContain("2 of 12 extra attempts used in the last day");
    // What it measured, every number.
    expect(text).toContain("13.9 reference cores' worth on 16 threads (one thread: 0.98× the reference)");
    expect(text).toContain("memory 9.5 GB/s");
    expect(text).toContain("disk 1,200 MB/s written, 1,800 read");
    expect(text).toContain("a container sandbox ready in 0.6 s");
    expect(text).toContain("a microVM sandbox ready in 1.7 s");
    expect(text).toContain("ollama/qwen3:8b 41.3 tokens/s");
    expect(text).toContain("3 days ago");
    // The ceiling, whose it is, and every reason.
    expect(text).toContain("14 of 32 threads and 91 of 182 GB are his to use");
    expect(text).toContain("the defaults (half of the machine)");
    expect(text).toContain("The default ceiling: 16 of 32 threads (half; the rest stays with whatever else this machine runs).");
    expect(text).toContain("Measured: 16 threads did 14.2 cores' worth of work at once, so he counts 14.");
    // The queue is visible, with why.
    expect(text).toContain("waiting: q-abc123 (4 threads, 8 GB)");
    expect(text).toContain("8.0 of the 14 threads he may use are taken");
    // A node that hasn't measured itself, with your ceiling.
    expect(text).toContain("due to measure itself (it never has)");
    expect(text).toContain("not yet: galahad compute calibrate rack");
    expect(text).toContain("yours: 8 threads");
    expect(text).toContain("(in use: not known)");
    // Work in hand, what more would buy, what he suggests, and when he last adapted.
    expect(text).toContain("q-xyz789  effort 3 (auto)");
    expect(text).toContain("attempt 2  at the forge");
    expect(text).toContain("What more compute would buy");
    expect(text).toContain("galahad compute limit ultra --cores 24");
    expect(text).toContain("hire ollama/qwen3:8b for the swift role");
    expect(text).toContain("His defaults were last re-derived 60 minutes ago: ultra: 2 → 3 sandbox slots.");
  });

  test("words for the pieces", () => {
    expect(limitLine(null)).toBe("the defaults (half of the machine)");
    expect(limitLine({ cores: 24, memoryGb: 96, sandboxes: 0, modelCalls: 2 })).toBe("yours: 24 threads, 96 GB, 0 sandboxes, 2 model calls");
    expect(measuredLine({ ...calibration, memoryGbps: undefined, disk: undefined, sandbox: undefined, models: undefined }, capacity)).toBe("13.9 reference cores' worth on 16 threads (one thread: 0.98× the reference)");
    expect(ago(NOW - 10_000, NOW)).toBe("just now");
    expect(ago(NOW - 5 * 3_600_000, NOW)).toBe("5 hours ago");
  });

  test("--effort is auto, 1, 2 or 3", () => {
    expect(parseEffort(undefined)).toBeUndefined();
    expect(parseEffort("auto")).toBe("auto");
    expect(parseEffort("3")).toBe(3);
    expect(() => parseEffort("4")).toThrow(/auto, 1, 2 or 3/);
    expect(() => parseEffort("max")).toThrow(/auto, 1, 2 or 3/);
  });

  test("the commands ask the node for exactly what was typed, and refuse what makes no sense", async () => {
    const calls: { name: string; input: unknown }[] = [];
    const api = {
      async call<T>(name: string, input?: unknown): Promise<T> {
        calls.push({ name, input });
        if (name === "setComputeLimit") return { node: "ultra", limit: { cores: 24, memoryGb: 96 }, capacity } as T;
        if (name === "setComputePolicy") return { policy: { effort: 2, attemptsPerDay: 6 }, budget: { perDay: 6, usedToday: 0 } } as T;
        if (name === "calibrateCompute") return { node: "ultra", calibration, capacity } as T;
        return view as T;
      },
    };
    const quiet = console.log;
    console.log = () => {};
    try {
      await computeCommand(api, "limit", ["ultra"], { cores: "24", mem: "96" });
      await computeCommand(api, "limit", ["ultra"], { reset: true });
      await computeCommand(api, "effort", ["2"], { budget: "6" });
      await computeCommand(api, "calibrate", ["ultra"], {});
      await computeCommand(api, undefined, [], {});
      await expect(computeCommand(api, "limit", [], {})).rejects.toThrow(/usage/);
      await expect(computeCommand(api, "limit", ["ultra"], { cores: "0" })).rejects.toThrow(/--cores must be a whole number from 1/);
      await expect(computeCommand(api, "effort", ["9"], {})).rejects.toThrow(/auto, 1, 2 or 3/);
      await expect(computeCommand(api, "rent", [], {})).rejects.toThrow(/unknown compute command/);
    } finally {
      console.log = quiet;
    }
    expect(calls).toEqual([
      { name: "setComputeLimit", input: { node: "ultra", cores: 24, memoryGb: 96 } },
      { name: "setComputeLimit", input: { node: "ultra", reset: true } },
      { name: "setComputePolicy", input: { effort: 2, attemptsPerDay: 6 } },
      { name: "calibrateCompute", input: { on: "ultra" } },
      { name: "compute", input: undefined },
    ]);
  });
});
