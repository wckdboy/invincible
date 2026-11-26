import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bodyFingerprint, Calibration, calibrationDue, type ComputeBody, deriveCapacity, KERNEL } from "@galahad/core";
import { type BenchOptions, type BenchResult, kernelDigest } from "../src/compute/bench.ts";
import { calibrate, spawnBench } from "../src/compute/calibrate.ts";

/*
 * Calibration: a node measures itself, within its ceiling and for a few seconds.
 * The measuring is injected here (a real run is at the end), so what's checked is
 * what he asks of the machine and what he makes of the answer.
 */

const ultra: ComputeBody = { cores: 32, memoryGb: 182, gpu: [], sandboxHost: true, microVMs: true, localModels: [] };

function harness(over: { load?: number; limit?: { cores?: number } | null; bench?: (o: BenchOptions) => Promise<BenchResult> } = {}) {
  const asked: BenchOptions[] = [];
  let now = 10_000;
  const run = (reason: "joined" | "changed" | "asked", extra: Partial<Parameters<typeof calibrate>[1]> = {}) =>
    calibrate(reason, {
      body: ultra,
      limit: over.limit ?? null,
      dir: "/home/galahad/.galahad",
      load: () => over.load ?? 0.4,
      now: () => (now += 1_500),
      bench:
        over.bench ??
        (async (options) => {
          asked.push(options);
          return { single: 70_000, multi: 70_000 * options.threads * 0.95, threads: options.threads, memoryGbps: 9.5, disk: { writeMbps: 1200, readMbps: 1800 } };
        }),
      ...extra,
    });
  return { run, asked };
}

describe("a calibration", () => {
  test("measures on no more threads than the ceiling, and records what it is a measurement of", async () => {
    const { run, asked } = harness();
    const c = await run("joined");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ threads: 16, dir: "/home/galahad/.galahad" });
    expect(Calibration.parse(c)).toEqual(c);
    expect(c).toMatchObject({ reason: "joined", cpu: { single: 70_000, threads: 16, kernel: KERNEL }, memoryGbps: 9.5, disk: { writeMbps: 1200 }, body: bodyFingerprint(ultra, null) });
    // It says which kernel measured it, so it isn't taken again until the body, the ceiling or the kernel changes.
    expect(calibrationDue(ultra, c, null)).toBeNull();
    expect(c.tookMs).toBeGreaterThan(0);
    expect(deriveCapacity(ultra, c, null)).toMatchObject({ cores: 15, sandboxes: 3, measured: true });
  });

  test("the owner's ceiling decides the threads", async () => {
    const { run, asked } = harness({ limit: { cores: 8 } });
    const c = await run("changed");
    expect(asked[0]!.threads).toBe(8);
    expect(c.body).toBe(bodyFingerprint(ultra, { cores: 8 }));
  });

  test("on a busy machine he measures on what's idle, and says so", async () => {
    const { run, asked } = harness({ load: 26.3 });
    const c = await run("asked");
    expect(asked[0]!.threads).toBe(5);
    expect(c.load).toBe(26.3);
    expect(c.note).toMatch(/busy/);
    // He counts only what he measured: one sandbox's worth, until it's quieter.
    expect(deriveCapacity(ultra, c, null).sandboxes).toBe(1);
  });

  test("sandbox start-up and a local model's speed are measured when the node has them; a failure there is a note, not a failed calibration", async () => {
    const { run } = harness();
    const c = await run("asked", {
      sandboxStart: async () => [{ kind: "container", startMs: 640 }, { kind: "vm", startMs: 1710 }],
      modelSpeed: async () => [{ runtime: "ollama", model: "qwen3:8b", tps: 41.26 }],
    });
    expect(c.sandbox).toEqual([{ kind: "container", startMs: 640 }, { kind: "vm", startMs: 1710 }]);
    expect(c.models).toEqual([{ runtime: "ollama", model: "qwen3:8b", tps: 41.3 }]);
    const broken = await run("asked", {
      sandboxStart: async () => {
        throw new Error("docker is not available on this node");
      },
      modelSpeed: async () => [],
    });
    expect(broken.sandbox).toBeUndefined();
    expect(broken.models).toBeUndefined();
    expect(broken.note).toMatch(/sandbox start-up wasn't measured: docker is not available/i);
  });

  test("a benchmark that can't run fails the calibration (nothing is recorded from a guess)", async () => {
    const { run } = harness({
      bench: async () => {
        throw new Error("the benchmark timed out");
      },
    });
    await expect(run("joined")).rejects.toThrow(/timed out/);
  });
});

describe("the benchmark itself", () => {
  test("its kernel is the one the reference was measured with, and computes the same on every machine", () => {
    // The kernel uses only operations that are exact everywhere (no library call), so its state after a fixed
    // number of blocks is one value on every machine and OS. If this changes, the kernel changed: raise KERNEL
    // and measure REFERENCE_SINGLE again on the reference machine (packages/core/src/compute.ts), then set both here.
    expect({ kernel: KERNEL, digest: kernelDigest() }).toEqual({ kernel: 2, digest: "c3e7c819" });
    expect(kernelDigest()).toBe(kernelDigest());
    expect(kernelDigest(8)).not.toBe(kernelDigest(9));
  });
  test("runs as its own short process, on the threads asked for, and leaves nothing behind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "galahad-bench-"));
    try {
      const result = await spawnBench({ threads: 2, windowMs: 40, dir });
      expect(result.single).toBeGreaterThan(0);
      expect(result.multi).toBeGreaterThan(0);
      expect(result.threads).toBeGreaterThanOrEqual(1);
      expect(result.threads).toBeLessThanOrEqual(2);
      expect(result.memoryGbps).toBeGreaterThan(0);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
