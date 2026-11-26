import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Usage } from "../../packages/core/src/index.ts";
import { OUT_DIR } from "../scorecard.ts";
import { buildImages } from "./images.ts";
import { dollarsOf, modelsContext, MODEL, recording, throughGateway } from "./loop.ts";
import { runTask, TASKS, type TaskName, type TaskRun } from "./tasks.ts";
import { bench, BenchVm, cannotRunHere, clearLeftovers } from "./vm.ts";

/*
 * The four tasks through an agent's own tool loop with a real model (C1 step 7: "on the four tasks with a real model,
 * success, calls, tokens, dollars and minutes per task, recorded and kept as the suite's model baseline"). It spends
 * money, so it is run by hand on a sandbox host, never by the scorecard:
 *
 *   INVINCIBLE_BENCH_SCRATCH=c1 INVINCIBLE_BENCH_GATEWAY_FILE=<the token's file> INVINCIBLE_BENCH_ROUTE=orcarouter \
 *   INVINCIBLE_BENCH_CAP_USD=15 INVINCIBLE_BENCH_METER_LABEL=c1-bench bun bench/desktop/model-runs.ts [--runs 5] [--only form]
 *
 * - The gateway file is a node's gateway token for the benchmark, as KEY=value lines (ANTHROPIC_BASE_URL and
 *   ANTHROPIC_AUTH_TOKEN for the anthropic route; OPENAI_BASE_URL, a route template with <provider>, and OPENAI_API_KEY
 *   for a router's). Its values go to the model's calls alone: never printed, never written anywhere.
 * - Its model is Claude Opus 5.5, offered the computer toolset, the adapter speaking to the gateway as to Anthropic's
 *   own API (loop.ts): directly (anthropic), or through orcarouter's Anthropic endpoint, which carries the toolset as
 *   Anthropic does (two calls, 27 November 2026).
 * - What it spends is counted from what the provider reports, at list prices (an upper bound: every input token not
 *   read from the cache priced as a cache write). A run past its share is ended; none starts once what is left of the
 *   cap is less than a run's share and a call. With a meter label, the node's own count (`invincible usage`) is read
 *   before and after each run, and each run's cost is that difference.
 */

const flag = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : undefined;
};
const runs = Number(flag("runs") ?? 5);
const only = (flag("only")?.split(",") ?? [...TASKS]) as TaskName[];
const cap = Number(process.env.INVINCIBLE_BENCH_CAP_USD ?? NaN);
const share = Number(process.env.INVINCIBLE_BENCH_RUN_CAP_USD ?? 1.2);
const route = process.env.INVINCIBLE_BENCH_ROUTE ?? "anthropic";
const label = process.env.INVINCIBLE_BENCH_METER_LABEL;
const file = process.env.INVINCIBLE_BENCH_GATEWAY_FILE;

/** The file's KEY=value lines (a line of anything else is no value). */
export function gatewayValues(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^export /, "");
    const at = line.indexOf("=");
    if (at > 0 && /^[A-Z_]+$/.test(line.slice(0, at))) values[line.slice(0, at)] = line.slice(at + 1).replace(/^(["'])(.*)\1$/, "$2");
  }
  return values;
}

/** Where a route's calls go, with which token, as which model; null when the file hasn't what it needs. */
export function routeOf(values: Record<string, string>, route: string): { base: string; token: string; model: string; versioned: boolean } | null {
  if (route === "anthropic") return values.ANTHROPIC_BASE_URL && values.ANTHROPIC_AUTH_TOKEN ? { base: values.ANTHROPIC_BASE_URL, token: values.ANTHROPIC_AUTH_TOKEN, model: MODEL, versioned: false } : null;
  if (route === "orcarouter") return values.OPENAI_BASE_URL?.includes("<provider>") && values.OPENAI_API_KEY ? { base: values.OPENAI_BASE_URL.replace("<provider>", "orcarouter"), token: values.OPENAI_API_KEY, model: "anthropic/claude-opus-5.5", versioned: true } : null;
  return null;
}

/** What the node's meter (`invincible usage`, its by-who lines) says a token's label has spent, in dollars; null when it says nothing of it. */
export function meterDollars(text: string, label: string): number | null {
  // (Its lines are coloured on a terminal: the colour codes aren't the words.)
  // (A gateway token's line is its label, as an agent's arm's is arm:<its label>.)
  const line = text.replace(/\x1b\[[0-9;]*m/g, "").split("\n").find((l) => l.trim().split(/\s+/)[0] === label);
  const said = line ? /\$([0-9][0-9,]*(?:\.[0-9]+)?)\s*$/.exec(line.trim()) : null;
  return said ? Number(said[1]!.replaceAll(",", "")) : null;
}

/** One run as the runner keeps it: the task's run, what it cost (an upper bound, and the node's meter) and how long it took. */
export type RunRecord = TaskRun & { dollars: number; meter: number | null; minutes: number };

const median = (xs: readonly number[]): number | null => {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
const round = (n: number, places = 4) => Number(n.toFixed(places));

/**
 * The runs by task, as the desktop suite keeps its model baseline (bench/baseline/desktop-model.json): passes of the
 * runs, the model calls and actions a run took (median and most), the most calls per action a passing run took, the
 * tokens, the dollars (the node's meter, and the runner's upper bound) and the minutes. `bar`: the passes it is held to.
 */
export function recordOf(report: { at: string; commit: string; model: string; route: string; runs: readonly RunRecord[] }, bar: { passed: number; of: number }) {
  const tasks = Object.fromEntries(
    [...new Set(report.runs.map((r) => r.task))].map((task) => {
      const these = report.runs.filter((r) => r.task === task);
      const passing = these.filter((r) => r.pass);
      const loops = these.map((r) => r.loop).filter((l): l is NonNullable<TaskRun["loop"]> => Boolean(l));
      const sum = (f: (l: NonNullable<TaskRun["loop"]>) => number) => loops.reduce((total, l) => total + f(l), 0);
      return [
        task,
        {
          passed: passing.length,
          of: these.length,
          ...(these.some((r) => !r.pass) ? { failed: these.filter((r) => !r.pass).map((r) => `run ${r.run}: ${r.why.slice(0, 200)}`) } : {}),
          calls: { median: median(loops.map((l) => l.calls)), most: Math.max(0, ...loops.map((l) => l.calls)) },
          actions: { median: median(loops.map((l) => l.actions)), most: Math.max(0, ...loops.map((l) => l.actions)) },
          callsPerAction: passing.length ? round(Math.max(...passing.map((r) => r.loop!.calls / Math.max(1, r.loop!.actions))), 2) : null,
          tokens: { input: sum((l) => l.usage.input), cached: sum((l) => l.usage.cached ?? 0), output: sum((l) => l.usage.output), unreported: sum((l) => l.unknown) },
          dollars: { meter: these.every((r) => r.meter !== null) ? round(these.reduce((total, r) => total + r.meter!, 0)) : null, upperBound: round(these.reduce((total, r) => total + r.dollars, 0)) },
          minutes: { median: round(median(these.map((r) => r.minutes)) ?? 0, 2), most: round(Math.max(0, ...these.map((r) => r.minutes)), 2) },
        },
      ];
    }),
  );
  const passed = report.runs.filter((r) => r.pass).length;
  return {
    suite: "desktop-model",
    at: report.at,
    commit: report.commit,
    model: report.model,
    route: report.route,
    bar,
    passed,
    of: report.runs.length,
    held: passed >= bar.passed,
    dollars: { meter: report.runs.every((r) => r.meter !== null) ? round(report.runs.reduce((total, r) => total + r.meter!, 0)) : null, upperBound: round(report.runs.reduce((total, r) => total + r.dollars, 0)) },
    tasks,
  };
}

const meter = (): number | null => {
  if (!label) return null;
  const r = Bun.spawnSync(["invincible", "usage", "--days", "2"], { stdout: "pipe", stderr: "pipe" });
  return r.exitCode === 0 ? (meterDollars(r.stdout.toString(), label) ?? 0) : null;
};

async function main(): Promise<void> {
  const cannot = await cannotRunHere();
  if (cannot) throw new Error(`the model runs can't run here: ${cannot}`);
  if (!file) throw new Error("INVINCIBLE_BENCH_GATEWAY_FILE names no gateway token's file");
  if (!Number.isFinite(cap) || cap <= 0) throw new Error("INVINCIBLE_BENCH_CAP_USD: the spend the runs stop at, in dollars");
  const way = routeOf(gatewayValues(readFileSync(file, "utf8")), route);
  if (!way) throw new Error(`the gateway file has no ${route} route`);
  const log = (line: string) => console.error(line);
  const b = bench(process.env.INVINCIBLE_BENCH_SCRATCH ?? "bench", log);
  await clearLeftovers(b);
  await buildImages(b);
  const { vm } = await BenchVm.make(b, { desktop: true, seed: 1 });
  const done: RunRecord[] = [];
  let spent = 0;
  try {
    await vm.ready(1);
    for (const task of only) {
      for (let run = 1; run <= runs; run++) {
        // A run's share and a call's more must be left of the cap, or none starts.
        if (spent + share + 0.5 > cap) {
          log(`stopped before ${task} ${run}: $${spent.toFixed(2)} spent of $${cap}, and a run may take $${share}`);
          break;
        }
        const stop = new AbortController();
        const before = meter();
        const t0 = performance.now();
        const r = await runTask(vm, task, "model", run, {
          ctx: (asked) => modelsContext(way.token, recording(throughGateway(way.base, { versioned: way.versioned }), asked), way.model),
          spent: (counted) => {
            if (dollarsOf(counted.usage) > share) stop.abort(new Error(`the run passed its share of $${share}`));
          },
          signal: stop.signal,
        });
        const usage: Usage = r.loop?.usage ?? { input: 0, output: 0, cached: 0 };
        const dollars = dollarsOf(usage);
        spent += dollars;
        const after = meter();
        const one = { ...r, dollars: Number(dollars.toFixed(4)), meter: before !== null && after !== null ? Number((after - before).toFixed(4)) : null, minutes: Number(((performance.now() - t0) / 60_000).toFixed(2)) };
        done.push(one);
        log(`${task} ${run}: ${r.pass ? "pass" : `fail: ${r.why.slice(0, 160)}`} · ${r.loop?.calls ?? 0} calls, ${r.loop?.actions ?? 0} actions · ${usage.input} in (${usage.cached ?? 0} cached), ${usage.output} out · ≤ $${one.dollars}${one.meter !== null ? `, the meter $${one.meter}` : ""} · ${one.minutes} min`);
      }
    }
  } finally {
    await vm.remove().catch((error) => log(`couldn't remove ${vm.container}: ${(error as Error).message}`));
    await clearLeftovers(b);
  }
  const report = { at: new Date().toISOString(), commit: process.env.INVINCIBLE_BENCH_COMMIT ?? "unknown", model: way.model, route, runs: done, spentUpperBound: Number(spent.toFixed(4)), meterTotal: done.every((r) => r.meter !== null) ? Number(done.reduce((s, r) => s + r.meter!, 0).toFixed(4)) : null };
  mkdirSync(join(OUT_DIR, "desktop"), { recursive: true });
  writeFileSync(join(OUT_DIR, "desktop", "model-runs.json"), `${JSON.stringify(report, null, 2)}\n`);
  // (The record the suite keeps as its model baseline, by task: C1 step 7's bar, 18 of 20 to start.)
  writeFileSync(join(OUT_DIR, "desktop", "model-record.json"), `${JSON.stringify(recordOf(report, { passed: Math.ceil((done.length * 18) / 20), of: done.length }), null, 2)}\n`);
  console.log(JSON.stringify(report));
}

if (import.meta.main) await main();
