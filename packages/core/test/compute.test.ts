import { describe, expect, test } from "bun:test";
import {
  admit,
  admitGrowth,
  bodyFingerprint,
  type Calibration,
  calibrationDue,
  ceilingThreads,
  clampNeed,
  MAC_VM_OVERHEAD,
  VM_OVERHEAD,
  type ComputeBody,
  computeBody,
  type ComputePlan,
  computeSuggestions,
  decideEffort,
  deriveCapacity,
  derivePlan,
  EFFORT_BUDGET_DEFAULT,
  effortReport,
  freeSlots,
  type HostLoad,
  KERNEL,
  MODEL_CALLS_DEFAULT,
  planChanges,
  planDigest,
  REFERENCE_SINGLE,
  whatMoreBuys,
} from "../src/index.ts";

/*
 * Compute, as pure functions: what a node may carry (its ceiling, what it measured),
 * whether one more piece of work fits now, how much effort a quest may spend, and
 * what changes when the fleet does. Nothing here touches a machine.
 */

/** A server like ultra: 32 threads, 182 GB, Docker and KVM, no GPU. */
const ultra: ComputeBody = { cores: 32, memoryGb: 182, gpu: [], sandboxHost: true, microVMs: true, localModels: [{ runtime: "ollama", models: ["qwen3-embedding:0.6b"] }] };

/** A calibration that measured `delivered` cores' worth on `threads` threads. */
const measured = (body: ComputeBody, threads: number, delivered: number, extra: Partial<Calibration> = {}): Calibration => ({
  at: 1_000,
  tookMs: 3_200,
  reason: "joined",
  body: bodyFingerprint(body, null),
  cpu: { single: REFERENCE_SINGLE, multi: REFERENCE_SINGLE * delivered, threads, kernel: KERNEL },
  ...extra,
});

const idle = (body: ComputeBody): HostLoad => ({ load: 0, cores: body.cores, freeMemoryGb: body.memoryGb * 0.9, totalMemoryGb: body.memoryGb, oursRecently: 0 });

describe("the ceiling", () => {
  test("by default he may use half of a machine, and says why", () => {
    expect(ceilingThreads(ultra, null)).toBe(16);
    const capacity = deriveCapacity(ultra, measured(ultra, 16, 15.6), null);
    expect(capacity).toMatchObject({ cores: 16, memoryGb: 91, sandboxes: 4, modelCalls: MODEL_CALLS_DEFAULT, measured: true });
    expect(capacity.reasons.join("\n")).toContain("half");
    expect(capacity.reasons.join("\n")).toContain("16 of 32 threads");
  });

  test("the owner's ceiling is never exceeded, whatever was measured", () => {
    const limit = { cores: 8, memoryGb: 24 };
    const capacity = deriveCapacity(ultra, measured(ultra, 16, 15.6), limit);
    expect(capacity.cores).toBe(8);
    expect(capacity.memoryGb).toBe(24);
    expect(capacity.sandboxes).toBe(2);
    expect(capacity.reasons.join("\n")).toContain("your ceiling");
    // A ceiling above the machine is the machine.
    expect(deriveCapacity(ultra, measured(ultra, 16, 15.6), { cores: 4096, memoryGb: 65_536 }).memoryGb).toBe(182);
    expect(ceilingThreads(ultra, { cores: 4096 })).toBe(32);
    // The owner can say how many sandboxes and model calls, too; zero sandboxes means none.
    expect(deriveCapacity(ultra, measured(ultra, 16, 15.6), { sandboxes: 1, modelCalls: 2 })).toMatchObject({ sandboxes: 1, modelCalls: 2 });
    expect(deriveCapacity(ultra, measured(ultra, 16, 15.6), { sandboxes: 0 }).sandboxes).toBe(0);
  });

  test("slots come from what was measured, not from the core count", () => {
    // 16 threads that only did 9.2 cores' worth (hyperthreads, a throttled or shared machine): he counts 9.
    const shared = deriveCapacity(ultra, measured(ultra, 16, 9.2), null);
    expect(shared.cores).toBe(9);
    expect(shared.sandboxes).toBe(2);
    expect(shared.reasons.join("\n")).toMatch(/16 threads did 9\.2 cores' worth/);
    expect(shared.strength).toBeCloseTo(9.2, 5);
    expect(shared.speed).toBeCloseTo(1, 5);
  });

  test("not measured yet: one sandbox's worth, and he says so", () => {
    const capacity = deriveCapacity(ultra, null, null);
    expect(capacity).toMatchObject({ cores: 4, sandboxes: 1, measured: false, strength: null });
    expect(capacity.reasons.join("\n")).toMatch(/not measured yet/i);
  });

  test("a small machine carries one small sandbox; a machine without Docker none", () => {
    const pi: ComputeBody = { cores: 4, memoryGb: 8, gpu: [], sandboxHost: true, microVMs: false, localModels: [] };
    expect(deriveCapacity(pi, measured(pi, 2, 2), null)).toMatchObject({ cores: 2, memoryGb: 4, sandboxes: 1 });
    expect(deriveCapacity({ ...pi, sandboxHost: false }, measured(pi, 2, 2), null).sandboxes).toBe(0);
  });

  test("a ceiling raised since the last measurement counts only what was measured", () => {
    const raised = deriveCapacity(ultra, measured(ultra, 16, 15.6), { cores: 24 });
    expect(raised.cores).toBe(16);
    // Lowered: the same share of what was measured.
    expect(deriveCapacity(ultra, measured(ultra, 16, 12), { cores: 8 }).cores).toBe(6);
  });

  test("a node's capabilities are read defensively", () => {
    expect(computeBody(null)).toBeNull();
    expect(computeBody({ cores: "many" })).toBeNull();
    expect(computeBody({ cores: 8, memoryGb: 16, gpu: [{ name: "RTX", memoryGb: 16 }], docker: true, sandbox: { image: true, networks: true, vm: true }, localModels: [{ runtime: "ollama", models: ["a", 7] }] })).toEqual({
      cores: 8,
      memoryGb: 16,
      gpu: [{ name: "RTX", memoryGb: 16 }],
      sandboxHost: true,
      microVMs: true,
      localModels: [{ runtime: "ollama", models: ["a"] }],
    });
  });
});

describe("when to calibrate", () => {
  test("a node that never measured itself, or whose body or ceiling changed, is due", () => {
    expect(calibrationDue(ultra, null, null)).toBe("joined");
    const calibration = measured(ultra, 16, 15.6);
    expect(calibrationDue(ultra, calibration, null)).toBeNull();
    expect(calibrationDue({ ...ultra, memoryGb: 256 }, calibration, null)).toBe("changed");
    expect(calibrationDue({ ...ultra, gpu: [{ name: "RTX 5090", memoryGb: 32 }] }, calibration, null)).toBe("changed");
    expect(calibrationDue({ ...ultra, localModels: [{ runtime: "ollama", models: ["qwen3:8b"] }] }, calibration, null)).toBe("changed");
    // A ceiling that changes how many threads he may use is measured again; one that only limits memory isn't.
    expect(calibrationDue(ultra, calibration, { cores: 24 })).toBe("changed");
    expect(calibrationDue(ultra, calibration, { memoryGb: 64 })).toBeNull();
    // Measured on fewer threads than he may use (the machine was busy): again, when it's quieter.
    expect(calibrationDue(ultra, measured(ultra, 5, 4.8), null)).toBe("changed");
  });

  test("a measurement by another benchmark kernel is taken again; until then it's read against its own kernel's reference", () => {
    // What ultra recorded with the first kernel (no version on it): a Ryzen 9 9950X at 0.44× an i7-11700, because that
    // kernel's remainder was a C library call, 2.5× slower under Linux than under Windows on the same hardware.
    const first: Calibration = { ...measured(ultra, 16, 13.4), cpu: { single: 30_800, multi: 30_800 * 13.4, threads: 16 } };
    expect(calibrationDue(ultra, first, null)).toBe("changed");
    expect(calibrationDue(ultra, measured(ultra, 16, 13.4), null)).toBeNull();
    // Its slots hold (they come from how the threads scaled, whatever the kernel); its speed is the first kernel's, not this one's.
    const was = deriveCapacity(ultra, first, null);
    expect(was).toMatchObject({ cores: 13, sandboxes: 3, measured: true });
    expect(was.speed).toBeCloseTo(0.44, 2);
    expect(was.strength).toBeCloseTo(5.9, 1);
    // A kernel this node doesn't know (a newer node's): counted the same, its speed against the reference not known here.
    const now = measured(ultra, 16, 13.4);
    const newer = deriveCapacity(ultra, { ...now, cpu: { ...now.cpu, kernel: KERNEL + 1 } }, null);
    expect(newer).toMatchObject({ cores: 13, sandboxes: 3, measured: true, speed: null });
    expect(newer.strength).toBeCloseTo(13.4, 5);
    expect(newer.reasons.join("\n")).toMatch(/newer benchmark/);
    expect(calibrationDue(ultra, { ...now, cpu: { ...now.cpu, kernel: KERNEL + 1 } }, null)).toBe("changed");
  });
});

describe("admission: work fits, or it waits", () => {
  const capacity = deriveCapacity(ultra, measured(ultra, 16, 15.6), null); // 16 cores, 91 GB, 4 sandboxes
  const slot = { cpus: 4, memoryGb: 8 };

  test("within the ceiling it's admitted; past it, it isn't, with the reason", () => {
    expect(admit(capacity, { sandboxes: 0, cores: 0, memoryGb: 0 }, slot, idle(ultra))).toEqual({ ok: true });
    expect(admit(capacity, { sandboxes: 3, cores: 12, memoryGb: 24 }, slot, idle(ultra))).toEqual({ ok: true });
    const full = admit(capacity, { sandboxes: 4, cores: 16, memoryGb: 32 }, slot, idle(ultra));
    expect(full).toMatchObject({ ok: false, busy: false });
    expect(!full.ok && full.why).toContain("4 of 4");
    // Two big sandboxes use every core he may use: a third waits though a slot is free.
    expect(admit(capacity, { sandboxes: 2, cores: 16, memoryGb: 16 }, slot, idle(ultra))).toMatchObject({ ok: false });
    expect(admit(capacity, { sandboxes: 1, cores: 4, memoryGb: 88 }, slot, idle(ultra))).toMatchObject({ ok: false });
  });

  test("a sandbox that grows needs room for what it adds, not a slot: every slot taken doesn't stop it, the ceiling does", () => {
    // Four sandboxes hold every slot, but only half the threads and a third of the memory he may use.
    const full = { sandboxes: 4, cores: 8, memoryGb: 30 };
    expect(admit(capacity, full, slot, idle(ultra))).toMatchObject({ ok: false });
    expect(admitGrowth(capacity, full, { cpus: 4, memoryGb: 8 }, idle(ultra))).toEqual({ ok: true });
    const past = admitGrowth(capacity, full, { cpus: 9, memoryGb: 0 }, idle(ultra));
    expect(past).toMatchObject({ ok: false, busy: false });
    expect(!past.ok && past.why).toContain("8.0 of the 16 threads");
    expect(admitGrowth(capacity, full, { cpus: 0, memoryGb: 62 }, idle(ultra))).toMatchObject({ ok: false });
    // The machine busy with other work holds it back as it would a new one.
    expect(admitGrowth(capacity, full, { cpus: 4, memoryGb: 0 }, { ...idle(ultra), load: 27 })).toMatchObject({ ok: false, busy: true });
  });

  test("he backs off while the machine is busy with other work", () => {
    // 27 threads of other load: only 1.8 of the machine's threads are left under the reserve.
    const busy = admit(capacity, { sandboxes: 0, cores: 0, memoryGb: 0 }, slot, { ...idle(ultra), load: 27 });
    expect(busy).toMatchObject({ ok: false, busy: true });
    // Load that is his own (four sandboxes he ran a moment ago) doesn't count against him.
    expect(admit(capacity, { sandboxes: 0, cores: 0, memoryGb: 0 }, slot, { ...idle(ultra), load: 27, oursRecently: 16 })).toEqual({ ok: true });
    // The machine's memory nearly gone: he waits.
    expect(admit(capacity, { sandboxes: 0, cores: 0, memoryGb: 0 }, slot, { ...idle(ultra), freeMemoryGb: 12 })).toMatchObject({ ok: false, busy: true });
  });

  test("even with the whole machine as his ceiling, a tenth stays the host's", () => {
    const whole = deriveCapacity(ultra, measured(ultra, 32, 20), { cores: 32, memoryGb: 182 });
    expect(whole.cores).toBe(20);
    const all = { ...whole, cores: 32, sandboxes: 8 };
    expect(admit(all, { sandboxes: 7, cores: 28, memoryGb: 56 }, slot, idle(ultra))).toMatchObject({ ok: false, busy: true });
  });

  test("a request larger than the ceiling is cut to it; a microVM's overhead is counted", () => {
    expect(clampNeed(capacity, { cpus: 64, memoryGb: 512 }, null)).toEqual({ cpus: 16, memoryGb: 91, clamped: true });
    expect(clampNeed(capacity, slot, null)).toEqual({ cpus: 4, memoryGb: 8, clamped: false });
    expect(clampNeed(capacity, slot, VM_OVERHEAD)).toEqual({ cpus: 5, memoryGb: 10, clamped: false });
    // A Mac's VM (Apple's container) takes the half GB measured there, not Kata's two.
    expect(clampNeed(capacity, slot, MAC_VM_OVERHEAD)).toEqual({ cpus: 5, memoryGb: 8.5, clamped: false });
  });

  test("free slots: how many more standard sandboxes fit now", () => {
    expect(freeSlots(capacity, { sandboxes: 0, cores: 0, memoryGb: 0 }, idle(ultra))).toBe(4);
    expect(freeSlots(capacity, { sandboxes: 3, cores: 12, memoryGb: 24 }, idle(ultra))).toBe(1);
    expect(freeSlots(capacity, { sandboxes: 1, cores: 4, memoryGb: 8 }, { ...idle(ultra), load: 22, oursRecently: 4 })).toBe(1);
    expect(freeSlots(capacity, { sandboxes: 4, cores: 16, memoryGb: 32 }, idle(ultra))).toBe(0);
  });
});

describe("effort: how many attempts a quest may run at once", () => {
  const policy = { effort: "auto" as const, attemptsPerDay: EFFORT_BUDGET_DEFAULT };
  const base = { policy, usedToday: 0, freeSlots: 4, slots: 4, freeModelCalls: 8, explicitOwner: false, host: "ultra" };

  test("auto takes what's free, up to three", () => {
    expect(decideEffort({ ...base, asked: "auto" }).attempts).toBe(3);
    expect(decideEffort({ ...base, asked: "auto", freeSlots: 2 }).attempts).toBe(2);
    const one = decideEffort({ ...base, asked: "auto", freeSlots: 0 });
    expect(one.attempts).toBe(1);
    expect(one.reasons.join("\n")).toContain("no slot is free");
  });

  test("auto never exceeds the day's budget", () => {
    expect(decideEffort({ ...base, asked: "auto", usedToday: 11 }).attempts).toBe(2);
    const spent = decideEffort({ ...base, asked: "auto", usedToday: 12 });
    expect(spent.attempts).toBe(1);
    expect(spent.reasons.join("\n")).toContain("budget");
    expect(decideEffort({ ...base, asked: "auto", policy: { effort: "auto", attemptsPerDay: 0 } }).attempts).toBe(1);
  });

  test("auto stays within the owner's default level and the model calls that are free", () => {
    expect(decideEffort({ ...base, asked: "auto", policy: { effort: 2, attemptsPerDay: 12 } }).attempts).toBe(2);
    expect(decideEffort({ ...base, asked: "auto", policy: { effort: 1, attemptsPerDay: 12 } }).attempts).toBe(1);
    expect(decideEffort({ ...base, asked: "auto", freeModelCalls: 1 }).attempts).toBe(1);
  });

  test("your explicit level stands (the extra attempts wait their turn); an agent's is held to capacity and budget", () => {
    const yours = decideEffort({ ...base, asked: 3, freeSlots: 1, usedToday: 12, explicitOwner: true });
    expect(yours.attempts).toBe(3);
    expect(yours.reasons.join("\n")).toMatch(/wait/);
    expect(yours.reasons.join("\n")).toMatch(/budget/);
    expect(decideEffort({ ...base, asked: 3, freeSlots: 1, explicitOwner: false }).attempts).toBe(1);
    expect(decideEffort({ ...base, asked: 3, usedToday: 12, explicitOwner: false }).attempts).toBe(1);
    // Never more attempts than the host has slots at all: they would only queue behind each other.
    expect(decideEffort({ ...base, asked: 3, slots: 2, freeSlots: 2, explicitOwner: true }).attempts).toBe(2);
    expect(decideEffort({ ...base, asked: 1 }).attempts).toBe(1);
  });
});

describe("the plan he derives, and what changed", () => {
  const node = (id: string, name: string, body: ComputeBody, delivered: number | null, limit: { cores?: number } | null = null) => {
    const calibration = delivered === null ? null : measured(body, ceilingThreads(body, limit), delivered);
    return { id, name, body, capacity: deriveCapacity(body, calibration, limit) };
  };

  test("one server: its slots, the default effort it can carry", () => {
    const plan = derivePlan([node("n_ultra", "ultra", ultra, 15.6)]);
    expect(plan).toEqual({ nodes: { n_ultra: { name: "ultra", sandboxes: 4, modelCalls: 8, cores: 16, memoryGb: 91, strength: 15.6 } }, sandboxHost: "n_ultra", effort: 3 });
    expect(planDigest(plan)).toBe(planDigest(derivePlan([node("n_ultra", "ultra", ultra, 15.6)])));
    expect(planChanges(null, plan)[0]).toContain("ultra");
  });

  test("a node joins: more slots, a stronger host takes sandboxes first, and he says each in a line", () => {
    const small: ComputeBody = { cores: 8, memoryGb: 32, gpu: [], sandboxHost: true, microVMs: false, localModels: [] };
    const before = derivePlan([node("n_small", "nuc", small, 4)]);
    expect(before.effort).toBe(1);
    const after = derivePlan([node("n_small", "nuc", small, 4), node("n_ultra", "ultra", ultra, 15.6)]);
    expect(after).toMatchObject({ sandboxHost: "n_ultra", effort: 3 });
    const changes = planChanges(before, after);
    expect(changes.some((c) => /^ultra joined: 4 sandbox slots/.test(c))).toBe(true);
    expect(changes).toContain("Default effort 1 → 3: auto may now run up to 3 attempts at a quest at once.");
    expect(changes).toContain("Sandboxes go to ultra first now (the stronger host).");
    expect(planDigest(before)).not.toBe(planDigest(after));
  });

  test("a node leaves, a ceiling changes, a node is measured again", () => {
    const both = derivePlan([node("n_a", "alpha", ultra, 15.6), node("n_b", "beta", ultra, 15.6)]);
    const one = derivePlan([node("n_a", "alpha", ultra, 15.6)]);
    expect(planChanges(both, one)).toContain("beta left the fleet: its 4 sandbox slots are gone.");
    const raised = derivePlan([node("n_a", "alpha", ultra, 23, { cores: 24 })]);
    expect(planChanges(one, raised)).toContain("alpha: 4 → 5 sandbox slots.");
    const again = derivePlan([node("n_a", "alpha", ultra, 13.9)]);
    expect(planChanges(one, again)).toContain("alpha: 4 → 3 sandbox slots.");
    expect(planChanges(one, one)).toEqual([]);
  });

  test("the plan is the same whatever order the nodes come in", () => {
    const a = node("n_a", "alpha", ultra, 15.6);
    const b = node("n_b", "beta", ultra, 9);
    expect(planDigest(derivePlan([a, b]))).toBe(planDigest(derivePlan([b, a])));
  });
});

describe("what more compute would buy, and what he suggests (never does)", () => {
  const capacity = deriveCapacity(ultra, measured(ultra, 16, 15.6), null);

  test("raising a default ceiling, and a second machine", () => {
    const lines = whatMoreBuys([{ name: "ultra", body: ultra, capacity, limit: null }], { effort: 3 } as ComputePlan);
    expect(lines.some((l) => l.includes("galahad compute limit ultra"))).toBe(true);
    expect(lines.some((l) => /another machine/i.test(l))).toBe(true);
  });

  test("a raised ceiling is said as the most it could carry, never as what it will: threads that share a core add less than a core each", () => {
    // What ultra measured on 14 November 2026 (16 cores, two threads each): 13.2 cores' worth on its default 16 threads.
    const half = deriveCapacity(ultra, measured(ultra, 16, 13.2), null);
    expect(half.sandboxes).toBe(3);
    const line = whatMoreBuys([{ name: "ultra", body: ultra, capacity: half, limit: null }], { effort: 3 } as ComputePlan).find((l) => l.includes("galahad compute limit ultra --cores 24"))!;
    // A straight line from that is 5 slots on 24 threads: the most there could be, and said as that…
    expect(line).toMatch(/could carry up to 5 sandbox slots instead of 3/);
    expect(line).not.toMatch(/would carry|about 5/);
    expect(line).toMatch(/he measures again on the new ceiling/);
    // …because what it then measured there was 16.2 cores' worth: 4.
    const yours = { cores: 24 };
    expect(deriveCapacity(ultra, measured(ultra, 24, 16.2, { body: bodyFingerprint(ultra, yours) }), yours).sandboxes).toBe(4);
  });

  test("it doesn't promise what model calls won't carry: past the asked node's ceiling, more slots wait on model calls", () => {
    // Two machines of four slots each, eight model calls at once on the node asked (the default): a third would make twelve slots.
    const fleet = [
      { name: "keep", body: ultra, capacity, limit: null },
      { name: "rack", body: ultra, capacity, limit: null },
    ];
    expect(capacity.sandboxes * 2).toBe(8);
    const lines = whatMoreBuys(fleet, { effort: 3 } as ComputePlan);
    const warning = lines.find((l) => /model calls/.test(l));
    expect(warning).toMatch(/8 at once on keep/);
    expect(warning).toMatch(/12 slots/);
    expect(warning).toMatch(/galahad compute limit keep --model-calls/);
    // One machine: another would make eight slots for eight model calls. Nothing to warn of.
    expect(whatMoreBuys([fleet[0]!], { effort: 3 } as ComputePlan).some((l) => /model calls/.test(l))).toBe(false);
    // A ceiling you raised is yours: with room for them, nothing to warn of either.
    const raised = [{ ...fleet[0]!, capacity: { ...capacity, modelCalls: 32 }, limit: { modelCalls: 32 } }, fleet[1]!];
    expect(whatMoreBuys(raised, { effort: 3 } as ComputePlan).some((l) => /model calls/.test(l))).toBe(false);
  });

  test("a GPU with no local runtime: he suggests one, and says the installing is yours", () => {
    const gpu: ComputeBody = { cores: 16, memoryGb: 64, gpu: [{ name: "RTX A4000", memoryGb: 16 }], sandboxHost: true, microVMs: false, localModels: [] };
    const suggestions = computeSuggestions([{ id: "n_gpu", name: "forge", body: gpu, calibration: null }], { swift: ["anthropic/claude-haiku-5-5"] });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ key: "compute-suggest:local-runtime:n_gpu" });
    expect(suggestions[0]!.body).toMatch(/won't install or download anything himself/);
  });

  test("a machine that's away gets no suggestion: it can't be set up, measured or answer until it's back", () => {
    const gpu: ComputeBody = { cores: 16, memoryGb: 32, gpu: [{ name: "RTX A4000", memoryGb: 16 }], sandboxHost: false, microVMs: false, localModels: [] };
    expect(computeSuggestions([{ id: "n_laptop", name: "laptop", body: gpu, calibration: null, online: false }], { swift: [] })).toEqual([]);
    // Its local model, measured before it went away, isn't offered for hire either.
    const body: ComputeBody = { ...ultra, localModels: [{ runtime: "ollama", models: ["qwen3:8b"] }] };
    const calibration = measured(body, 16, 15.6, { models: [{ runtime: "ollama", model: "qwen3:8b", tps: 41.3 }] });
    expect(computeSuggestions([{ id: "n_away", name: "away", body, calibration, online: false }], { swift: [] })).toEqual([]);
    // Back online (or with nothing said about it): suggested as before.
    expect(computeSuggestions([{ id: "n_laptop", name: "laptop", body: gpu, calibration: null, online: true }], { swift: [] })).toHaveLength(1);
  });

  test("a local model that measured well and isn't hired: he suggests the roster change, never makes it", () => {
    const body: ComputeBody = { ...ultra, localModels: [{ runtime: "ollama", models: ["qwen3:8b"] }] };
    const calibration = measured(body, 16, 15.6, { models: [{ runtime: "ollama", model: "qwen3:8b", tps: 41.3 }] });
    const suggested = computeSuggestions([{ id: "n_ultra", name: "ultra", body, calibration }], { swift: ["anthropic/claude-haiku-5-5"] });
    expect(suggested[0]).toMatchObject({ key: "compute-suggest:hire-local:n_ultra" });
    expect(suggested[0]!.body).toContain("galahad roster set swift ollama/qwen3:8b");
    // Already hired (by name or by wildcard): nothing to suggest.
    expect(computeSuggestions([{ id: "n_ultra", name: "ultra", body, calibration }], { swift: ["ollama/*"] })).toEqual([]);
    // Too slow to be worth hiring: nothing.
    const slow = measured(body, 16, 15.6, { models: [{ runtime: "ollama", model: "qwen3:8b", tps: 2 }] });
    expect(computeSuggestions([{ id: "n_ultra", name: "ultra", body, calibration: slow }], { swift: [] })).toEqual([]);
  });
});

describe("the Index per effort level", () => {
  const trial = (run: string, score: number, status = "scored") => ({ run, status, score });

  test("more effort that clears the interval is said to help; one that doesn't is said not to", () => {
    const low = Array.from({ length: 14 }, (_, i) => trial("r-one", i < 4 ? 1 : 0));
    const high = Array.from({ length: 14 }, (_, i) => trial("r-three", i < 13 ? 1 : 0));
    const helped = effortReport([...low, ...high], { "r-three": 3 });
    expect(helped.levels.map((l) => [l.effort, l.n, l.runs])).toEqual([[1, 14, 1], [3, 14, 1]]);
    expect(helped.helps).toBe(true);
    expect(helped.verdict).toMatch(/measurably helps/);

    const same = Array.from({ length: 14 }, (_, i) => trial("r-three", i < 5 ? 1 : 0));
    const flat = effortReport([...low, ...same], { "r-three": 3 });
    expect(flat.helps).toBe(false);
    expect(flat.verdict).toMatch(/no measurable difference/i);
  });

  test("crashed trials aren't counted, and one level alone is no comparison", () => {
    const only = effortReport([trial("r-a", 1), trial("r-a", 0), trial("r-a", 0, "crashed")], {});
    expect(only.levels).toHaveLength(1);
    expect(only.levels[0]).toMatchObject({ effort: 1, n: 2 });
    expect(only.helps).toBeNull();
    expect(only.verdict).toMatch(/galahad trial run --effort/);
  });
});
