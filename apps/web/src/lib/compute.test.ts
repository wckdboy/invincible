import { describe, expect, test } from "bun:test";
import type { Calibration, ComputeNodeView, NodeCapacity } from "@galahad/core";
import { attemptLine, budgetText, ceilingChange, ceilingOwner, ceilingText, effortText, fleetSlots, limitRanges, measuredFacts, modelCallsText, slotsText, strengthText } from "./compute.ts";

/* Compute in words, as the Fleet page says it. */

const capacity = (over: Partial<NodeCapacity> = {}): NodeCapacity => ({ cores: 14, memoryGb: 91, sandboxes: 3, modelCalls: 8, strength: 13.92, speed: 0.98, measured: true, reasons: [], ...over });
const body = { cores: 32, memoryGb: 182, gpu: [], sandboxHost: true, microVMs: true, localModels: [] };
const use = (sandboxes: number, queued = 0) => ({ sandboxes, cores: sandboxes * 4, memoryGb: sandboxes * 8, queued, modelCalls: 2, modelQueued: 0 });
const node = (over: Partial<ComputeNodeView> = {}): ComputeNodeView => ({ id: "n_ultra", name: "ultra", self: true, online: true, body, calibration: null, due: null, limit: null, capacity: capacity(), use: use(1), free: 2, queue: [], ...over });
const calibration: Calibration = {
  at: 1,
  tookMs: 3400,
  reason: "joined",
  body: "AAAAAAAAAAAAAAAA",
  cpu: { single: 68_600, multi: 974_120, threads: 16 },
  memoryGbps: 9.5,
  disk: { writeMbps: 1200, readMbps: 1800 },
  sandbox: [{ kind: "container", startMs: 640 }, { kind: "vm", startMs: 1710 }],
  models: [{ runtime: "ollama", model: "qwen3:8b", tps: 41.3 }],
};

describe("what a node measured", () => {
  test("its strength in a few words, or that it isn't measured", () => {
    expect(strengthText(node())).toBe("13.9 cores' worth");
    expect(strengthText(node({ capacity: capacity({ strength: null }) }))).toBe("Not measured yet");
    expect(strengthText(node({ capacity: null }))).toBe("Not measured yet");
  });

  test("a fact for each thing measured, with the long way of saying it", () => {
    const facts = measuredFacts(calibration, node());
    expect(facts.map((f) => `${f.label}: ${f.value}`)).toEqual([
      "At once: 14.2× on 16 threads",
      "One thread: 0.98×",
      "Memory: 9.5 GB/s",
      "Disk: 1,200 / 1,800 MB/s",
      "Sandbox (container): 0.6 s",
      "Sandbox (microVM): 1.7 s",
      "qwen3:8b: 41.3 tok/s",
    ]);
    expect(facts[0]!.title).toBe("16 threads did 14.2 cores' worth of work at once");
    expect(facts.at(-1)!.title).toBe("ollama/qwen3:8b wrote 41.3 tokens a second");
    // Only what was measured.
    expect(measuredFacts({ ...calibration, memoryGbps: undefined, disk: undefined, sandbox: undefined, models: undefined }, node({ capacity: capacity({ speed: null }) }))).toHaveLength(1);
  });
});

describe("the ceiling and the slots", () => {
  test("what he may use, and whose ceiling it is", () => {
    expect(ceilingText(node())).toBe("14 of 32 threads · 91 of 182 GB");
    expect(ceilingText(node({ body: null }))).toBe("Not known yet");
    expect(ceilingOwner(node())).toBe("The default: half of the machine");
    expect(ceilingOwner(node({ limit: {} }))).toBe("The default: half of the machine");
    // What you set is said; what you left out is still the default.
    expect(ceilingOwner(node({ limit: { cores: 24, memoryGb: 96 } }))).toBe("Your ceiling: 24 threads, 96 GB");
    expect(ceilingOwner(node({ limit: { cores: 24 } }))).toBe("Your ceiling: 24 threads (memory: the default half)");
    expect(ceilingOwner(node({ limit: { memoryGb: 48 } }))).toBe("Your ceiling: 48 GB (threads: the default half)");
    // A ceiling on the sandboxes alone doesn't make the threads yours.
    expect(ceilingOwner(node({ limit: { sandboxes: 2 } }))).toBe("The default: half of the machine");
    // Not measured yet: he counts less than the ceiling, and says so.
    expect(ceilingOwner(node({ limit: { cores: 12 }, capacity: capacity({ measured: false, cores: 4 }) }))).toBe("Your ceiling: 12 threads (memory: the default half) · he counts one sandbox's worth until it's measured");
  });

  test("slots in use, waiting, unknown, none", () => {
    expect(slotsText(node())).toEqual({ text: "1 of 3 slots in use", waiting: 0, fraction: 1 / 3 });
    expect(slotsText(node({ use: use(3, 2) }))).toEqual({ text: "3 of 3 slots in use", waiting: 2, fraction: 1 });
    expect(slotsText(node({ use: null }))).toEqual({ text: "3 slots · in use: not known", waiting: 0, fraction: null });
    expect(slotsText(node({ body: { ...body, sandboxHost: false }, capacity: capacity({ sandboxes: 0 }) })).text).toBe("No sandboxes: not a sandbox host");
    expect(slotsText(node({ capacity: capacity({ sandboxes: 0 }) })).text).toBe("No sandboxes: your ceiling");
    expect(slotsText(node({ capacity: capacity({ sandboxes: 1 }), use: use(0) })).text).toBe("0 of 1 slot in use");
    expect(slotsText(node({ capacity: capacity({ sandboxes: 2 }), limit: { sandboxes: 2 }, use: use(2, 1) })).text).toBe("2 of 2 slots in use (your ceiling)");
    expect(slotsText(node({ use: { ...use(1), kept: 4 } })).text).toBe("1 of 3 slots in use · 4 knights' VMs besides");
    expect(slotsText(node({ use: { ...use(0), kept: 1 } })).text).toBe("0 of 3 slots in use · 1 knight's VM besides");
    expect(modelCallsText(node())).toBe("2 of 8 model calls");
    expect(modelCallsText(node({ use: null }))).toBe("8 model calls");
  });

  test("the fleet's totals count only what's known", () => {
    const view = { nodes: [node({ use: use(2, 1), free: 0 }), node({ id: "n_b", name: "rack", self: false, use: use(0), free: 3 }), node({ id: "n_c", name: "attic", self: false, online: false, use: null, free: null }), node({ id: "n_d", name: "laptop", capacity: capacity({ sandboxes: 0 }) })] };
    expect(fleetSlots(view)).toEqual({ slots: 9, inUse: 2, free: 3, waiting: 1, unknown: 1 });
  });

  test("the ceiling sheet's ranges suit the machine, and the default half is always one of the values", () => {
    expect(limitRanges({ cores: 32, memoryGb: 182 })).toEqual({ cores: { min: 1, max: 32, step: 1 }, memory: { min: 1, max: 182, step: 1 } });
    expect(limitRanges({ cores: 4, memoryGb: 7.6 })).toEqual({ cores: { min: 1, max: 4, step: 1 }, memory: { min: 1, max: 7, step: 1 } });
  });

  test("the ceiling sheet sends only what you set", () => {
    const opened = { cores: 16, memoryGb: 91 };
    // Opened on the default and saved untouched: still the default.
    expect(ceilingChange(null, opened, { ...opened, sandboxes: true })).toEqual({ reset: true });
    // One slider moved: that one is yours, the other stays the default.
    expect(ceilingChange(null, opened, { cores: 24, memoryGb: 91, sandboxes: true })).toEqual({ reset: true, cores: 24 });
    // What was yours stays yours, moved or not; sandboxes off is a ceiling of none.
    expect(ceilingChange({ cores: 8, memoryGb: 24 }, { cores: 8, memoryGb: 24 }, { cores: 8, memoryGb: 32, sandboxes: false })).toEqual({ reset: true, cores: 8, memoryGb: 32, sandboxes: 0 });
    // Ceilings set from a terminal that the sheet doesn't show are kept.
    expect(ceilingChange({ sandboxes: 2, modelCalls: 4 }, opened, { ...opened, sandboxes: true })).toEqual({ reset: true, sandboxes: 2, modelCalls: 4 });
  });
});

describe("effort and the budget", () => {
  test("in words", () => {
    expect(effortText({ policy: { effort: "auto", attemptsPerDay: 12 }, plan: { nodes: {}, sandboxHost: null, effort: 3 } })).toBe("Auto, up to 3 attempts");
    expect(effortText({ policy: { effort: "auto", attemptsPerDay: 12 }, plan: { nodes: {}, sandboxHost: null, effort: 1 } })).toBe("Auto: one attempt");
    expect(effortText({ policy: { effort: 2, attemptsPerDay: 12 }, plan: { nodes: {}, sandboxHost: null, effort: 3 } })).toBe("Up to 2 attempts");
    expect(effortText({ policy: { effort: 1, attemptsPerDay: 12 }, plan: { nodes: {}, sandboxHost: null, effort: 3 } })).toBe("One attempt");
    expect(budgetText({ perDay: 12, usedToday: 2 })).toBe("2 of 12 used today");
  });

  test("an attempt in a line", () => {
    expect(attemptLine({ index: 2, doing: "The engineer is thinking", station: "forge", model: "m", sandbox: "0123456789", active: true, last: 1 })).toBe("Attempt 2 · at the forge · The engineer is thinking");
    expect(attemptLine({ index: 1, doing: "Running a command", station: "observatory", model: null, sandbox: null, active: false, last: 1 })).toBe("Attempt 1 · at the observatory · between steps");
  });
});
