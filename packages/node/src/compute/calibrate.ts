import { fileURLToPath } from "node:url";
import { bodyFingerprint, type Calibration, type CalibrationReason, ceilingThreads, type ComputeBody, type ComputeLimit, KERNEL, redact } from "@galahad/core";
import type { BenchOptions, BenchResult } from "./bench.ts";

/*
 * A calibration: this node measures itself, for a few seconds, at low priority, on
 * no more threads than its ceiling (and, on a busy machine, only on what's idle).
 * What it finds is recorded in the mind by the node itself (compute.calibrated), and
 * placement and slots use those numbers instead of guessing from a core count.
 *
 * Pure orchestration: the benchmark, the sandbox start and the model's speed are
 * injected, so a test checks what he asks of the machine without running one.
 */

/** How long each CPU part of the benchmark runs. */
export const BENCH_WINDOW_MS = 400;
/** The benchmark is stopped if it takes longer than this. */
export const BENCH_TIMEOUT_MS = 30_000;

export interface CalibrateDeps {
  body: ComputeBody;
  limit: ComputeLimit | null;
  /** The node's home: where the disk part writes its file. */
  dir: string;
  /** The machine's load now (1 minute, in threads). */
  load(): number;
  now(): number;
  bench(options: BenchOptions): Promise<BenchResult>;
  /** How long a sandbox takes to be ready, per kind this host runs (through the node's own governed host). */
  sandboxStart?(): Promise<{ kind: "container" | "vm"; startMs: number }[]>;
  /** Tokens a second from each local runtime's first chat model. */
  modelSpeed?(): Promise<{ runtime: string; model: string; tps: number }[]>;
}

const round1 = (x: number): number => Math.round(x * 10) / 10;
const why = (error: unknown): string => redact(String((error as Error)?.message ?? error)).split("\n")[0]!.slice(0, 160);

export async function calibrate(reason: CalibrationReason, deps: CalibrateDeps): Promise<Calibration> {
  const started = deps.now();
  const notes: string[] = [];
  const ceiling = ceilingThreads(deps.body, deps.limit);
  const load = Math.max(0, deps.load());
  // Only what's idle: other work on the machine keeps its threads while he measures.
  const idle = Math.max(1, Math.floor(deps.body.cores - load));
  const threads = Math.min(ceiling, idle);
  if (threads < ceiling) notes.push(`The machine was busy (load ${round1(load)} of ${deps.body.cores} threads): measured on ${threads} of the ${ceiling} threads he may use, and he measures again when it's quieter.`);
  const measured = await deps.bench({ threads, windowMs: BENCH_WINDOW_MS, dir: deps.dir });
  if (!(measured.single > 0) || !(measured.multi > 0)) throw new Error("the benchmark measured nothing");

  let sandbox: Calibration["sandbox"];
  if (deps.sandboxStart) {
    try {
      const starts = await deps.sandboxStart();
      if (starts.length) sandbox = starts.slice(0, 4).map((s) => ({ kind: s.kind, startMs: Math.round(s.startMs) }));
    } catch (error) {
      notes.push(`Sandbox start-up wasn't measured: ${why(error)}.`);
    }
  }
  let models: Calibration["models"];
  if (deps.modelSpeed) {
    try {
      const speeds = await deps.modelSpeed();
      if (speeds.length) models = speeds.slice(0, 8).map((m) => ({ runtime: m.runtime, model: m.model.slice(0, 200), tps: round1(m.tps) }));
    } catch (error) {
      notes.push(`A local model's speed wasn't measured: ${why(error)}.`);
    }
  }
  return {
    at: started,
    tookMs: Math.max(1, Math.round(deps.now() - started)),
    reason,
    body: bodyFingerprint(deps.body, deps.limit),
    cpu: { single: Math.round(measured.single), multi: Math.round(measured.multi), threads: measured.threads, kernel: KERNEL },
    ...(measured.memoryGbps !== undefined ? { memoryGbps: measured.memoryGbps } : {}),
    ...(measured.disk ? { disk: measured.disk } : {}),
    ...(sandbox ? { sandbox } : {}),
    ...(models ? { models } : {}),
    load: round1(load),
    ...(notes.length ? { note: notes.join(" ").slice(0, 500) } : {}),
  };
}

const BENCH_SCRIPT = fileURLToPath(new URL("./bench.ts", import.meta.url));

/**
 * The benchmark as its own process (bench.ts): it lowers its own priority, runs for a second or two and
 * prints one line. Stopped if it outlasts BENCH_TIMEOUT_MS. The node itself is never slowed or niced.
 */
export async function spawnBench(options: BenchOptions): Promise<BenchResult> {
  const proc = Bun.spawn([process.execPath, BENCH_SCRIPT, JSON.stringify(options)], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), BENCH_TIMEOUT_MS);
  try {
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`the benchmark ${code === null || proc.killed ? "timed out" : `ended with ${code}`}${err.trim() ? `: ${err.trim().split("\n").at(-1)!.slice(0, 200)}` : ""}`);
    const line = out.trim().split("\n").at(-1) ?? "";
    const result = JSON.parse(line) as BenchResult;
    if (typeof result.single !== "number" || typeof result.multi !== "number" || typeof result.threads !== "number") throw new Error("the benchmark's answer couldn't be read");
    return result;
  } finally {
    clearTimeout(timer);
  }
}
