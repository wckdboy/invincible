import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { plainWords } from "../../packages/agents/src/desktop-command.ts";
import type { ExecResult, Usage } from "../../packages/core/src/index.ts";
import { planOf } from "../../packages/models/src/providers.ts";
import { OUT_DIR } from "../scorecard.ts";
import { buildImages } from "./images.ts";
import { dollarsOf, gatewayAlone, modelsContext, MODEL, recording, throughGateway } from "./loop.ts";
import { runTask, TASKS, type TaskName, type TaskRun } from "./tasks.ts";
import { bench, BenchVm, cannotRunHere, clearLeftovers, IN_VM } from "./vm.ts";

/*
 * The four tasks through an agent's own tool loop with a real model (C1 step 7: "on the four tasks with a real model,
 * success, calls, tokens, dollars and minutes per task, recorded and kept as the suite's model baseline"). It spends
 * money, or a plan's allowance, so it is run by hand on a sandbox host, never by the scorecard:
 *
 *   INVINCIBLE_BENCH_SCRATCH=c1 INVINCIBLE_BENCH_GATEWAY_FILE=<the token's file> INVINCIBLE_BENCH_ROUTE=orcarouter \
 *   INVINCIBLE_BENCH_CAP_USD=15 INVINCIBLE_BENCH_METER_LABEL=c1-bench bun bench/desktop/model-runs.ts [--runs 5] [--only form]
 *
 *   INVINCIBLE_BENCH_SCRATCH=c1 INVINCIBLE_BENCH_GATEWAY_FILE=<the token's file> INVINCIBLE_BENCH_ROUTE=opencode-go/kimi-k3.1-pro \
 *   INVINCIBLE_BENCH_MAX_CALLS=150 INVINCIBLE_BENCH_EYES=opencode-go/kimi-k3.1-pro bun bench/desktop/model-runs.ts --runs 1
 *
 * - The gateway file is a node's gateway token for the benchmark, as KEY=value lines (ANTHROPIC_BASE_URL and
 *   ANTHROPIC_AUTH_TOKEN for the anthropic route; OPENAI_BASE_URL, a route template with <provider>, and OPENAI_API_KEY
 *   for the others). Its values go to the model's calls alone: never printed, never written anywhere.
 * - Claude Opus 5.5, offered the computer toolset, the adapter speaking to the gateway as to Anthropic's own API
 *   (loop.ts): directly (anthropic), or through orcarouter's Anthropic endpoint, which carries the toolset as Anthropic
 *   does (two calls, 27 November 2026). What it spends is counted from what the provider reports, at list prices (an
 *   upper bound: every input token not read from the cache priced as a cache write). A run past its share is ended;
 *   none starts once what is left of the cap is less than a run's share and a call. With a meter label, the node's own
 *   count (`invincible usage`) is read before and after each run, and each run's cost is that difference.
 * - Or a coding plan's model, `<provider>/<model>`, through the gateway's OpenAI-compatible address for it: only a plan
 *   whose terms let the primary call it itself (providers.ts `allows.native`: OpenCode Go's), as an agent's own loop
 *   does. Offered no toolset, it works the desktop by its shell's `desktop` command, shown the screen as a picture
 *   where its preset says it sees. Its plan is paid for already, and shared with the owner's own agents: its cap is
 *   in model calls, the engineer's and the eyes' together for a model that is both (INVINCIBLE_BENCH_MAX_CALLS, 150
 *   unless told), and the first answer that says the allowance or its rate is spent ends every run.
 * - Its eyes (INVINCIBLE_BENCH_EYES, a plan's model as above): the agent is told it has them, as team-runtime tells it,
 *   and a `desktop look "…"` given as a command of its own is answered as deskd answers one (the VM's picture, deskd's
 *   own framing, the eyes' words as they came), from the bench's side, through the gateway: the bench's VMs reach no
 *   network, and the token never enters one. Their calls are counted with the run. A look inside a longer command is
 *   answered by the VM's stand-in, which says to ask on a command of its own. Eyes that answer in pixels only.
 */

const flag = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : undefined;
};
const runs = Number(flag("runs") ?? 5);
const only = (flag("only")?.split(",") ?? [...TASKS]) as TaskName[];
const cap = Number(process.env.INVINCIBLE_BENCH_CAP_USD ?? NaN);
const share = Number(process.env.INVINCIBLE_BENCH_RUN_CAP_USD ?? 1.2);
const maxCalls = Number(process.env.INVINCIBLE_BENCH_MAX_CALLS ?? 150);
const route = process.env.INVINCIBLE_BENCH_ROUTE ?? "anthropic";
const eyesRoute = process.env.INVINCIBLE_BENCH_EYES;
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

/** Where a route's calls go, with which token, as which model; `openai`: the provider whose OpenAI-compatible address it is. */
export interface Route {
  base: string;
  token: string;
  model: string;
  versioned: boolean;
  openai?: string;
}

/** Where a route's calls go: anthropic, orcarouter, or `<provider>/<model>` at the gateway's address for it; null when the file hasn't what it needs. */
export function routeOf(values: Record<string, string>, route: string): Route | null {
  if (route === "anthropic") return values.ANTHROPIC_BASE_URL && values.ANTHROPIC_AUTH_TOKEN ? { base: values.ANTHROPIC_BASE_URL, token: values.ANTHROPIC_AUTH_TOKEN, model: MODEL, versioned: false } : null;
  if (!values.OPENAI_BASE_URL?.includes("<provider>") || !values.OPENAI_API_KEY) return null;
  if (route === "orcarouter") return { base: values.OPENAI_BASE_URL.replace("<provider>", "orcarouter"), token: values.OPENAI_API_KEY, model: "anthropic/claude-opus-5.5", versioned: true };
  const slash = route.indexOf("/");
  const provider = route.slice(0, slash);
  if (slash <= 0 || !/^[a-z0-9][a-z0-9-]*$/.test(provider) || !route.slice(slash + 1)) return null;
  return { base: values.OPENAI_BASE_URL.replace("<provider>", provider), token: values.OPENAI_API_KEY, model: route.slice(slash + 1), versioned: false, openai: provider };
}

/** Why the bench won't call a route's model itself, or null when it may: an OpenAI route must be a plan whose terms let the primary call it. */
export function whyNotOurs(way: Route): string | null {
  if (!way.openai) return null;
  const plan = planOf(way.openai);
  if (!plan) return `${way.openai} isn't a coding plan: a model billed by the token runs only with the owner's yes`;
  return plan.allows.native ? null : `${way.openai}'s terms keep the primary's own calls off it (only coding tools it names may call it)`;
}

/** What the node's meter (`invincible usage`, its by-who lines) says a token's label has spent, in dollars; null when it says nothing of it. */
export function meterDollars(text: string, label: string): number | null {
  // (Its lines are coloured on a terminal: the colour codes aren't the words.)
  // (A gateway token's line is its label, as an agent's arm's is arm:<its label>.)
  const line = text.replace(/\x1b\[[0-9;]*m/g, "").split("\n").find((l) => l.trim().split(/\s+/)[0] === label);
  const said = line ? /\$([0-9][0-9,]*(?:\.[0-9]+)?)\s*$/.exec(line.trim()) : null;
  return said ? Number(said[1]!.replaceAll(",", "")) : null;
}

/** The question of a `desktop look` given as a command of its own (its words as a shell splits them, the eyes' own flags aside); null for any other command. */
export function lookOf(command: string): string | null {
  const words = plainWords(command.trim());
  if (!words || words[0] !== "desktop" || words[1] !== "look") return null;
  const asked: string[] = [];
  for (let i = 2; i < words.length; i++) {
    if (words[i] === "--eyes" || words[i] === "--space") i++;
    else asked.push(words[i]!);
  }
  return asked.join(" ").trim();
}

/** deskd's own framing of a look (EYES_FRAMING in deskd.py's source), so a look the bench answers is asked as deskd asks it. */
export function eyesFraming(source: string): string {
  const literal = /^EYES_FRAMING = \(((?:\s*"(?:[^"\\\n]|\\.)*")+)\s*\)/m.exec(source);
  if (!literal) throw new Error("deskd.py has no EYES_FRAMING");
  return [...literal[1]!.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)].map((part) => JSON.parse(`"${part[1]}"`) as string).join("");
}

/** Whether a refusal says a plan's allowance, or its rate, is spent: the bench stops at the first. */
export const limitAnswer = (text: string): boolean => /\b(402|429)\b|allowance|rate.?limit|too many requests|quota|usage limit/i.test(text);

/** The eyes' calls in a run, and what they took. */
export interface EyesCount {
  calls: number;
  input: number;
  output: number;
  ms: number;
  failed: number;
}

/**
 * A look answered as deskd answers one, from the bench's side (see the header): the VM's own picture of the screen
 * (settled, as JPEG), the question in deskd's framing, to the eyes through the gateway; their words as they came.
 * A refusal is said as deskd says one, and `limited` is told when it says the allowance is spent.
 */
export async function benchLook(question: string, inVm: (command: string, timeoutSec: number) => Promise<ExecResult>, eyes: Route, framing: string, count: EyesCount, limited: (why: string) => void, via: typeof fetch = fetch): Promise<ExecResult> {
  const said = (exitCode: number, stdout: string, stderr: string, t0: number): ExecResult => ({ exitCode, stdout, stderr, durationMs: Math.round(performance.now() - t0), truncated: false });
  const t0 = performance.now();
  if (!question) return said(2, "", 'desktop: look takes a question: desktop look "<question>"\n', t0);
  const shot = await inVm(`f=$(mktemp --suffix=.jpg) && desktop shot "$f" >/dev/null && base64 -w0 "$f"; rm -f "$f"`, 60);
  const data = shot.stdout.trim();
  if (shot.exitCode !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return said(1, "", `desktop: the model that looks could not be reached (no picture: ${shot.stderr.trim().slice(0, 200)})\n`, t0);
  count.calls++;
  const body = { model: eyes.model, max_tokens: 600, messages: [{ role: "user", content: [{ type: "text", text: `${framing}\n\n${question}` }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${data}` } }] }] };
  let reply: Response;
  try {
    reply = await via(`${eyes.base}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${eyes.token}`, "content-type": "application/json", "user-agent": "invincible-desktop/2" }, body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) });
  } catch (error) {
    count.failed++;
    count.ms += performance.now() - t0;
    return said(1, "", `desktop: the model that looks could not be reached (${String((error as Error).message ?? error).slice(0, 200)})\n`, t0);
  }
  if (!reply.ok) {
    const why = `${reply.status} ${(await reply.text()).slice(0, 300).replace(/\n/g, " ")}`;
    count.failed++;
    count.ms += performance.now() - t0;
    if (limitAnswer(why)) limited(`the eyes: ${why}`);
    return said(1, "", `desktop: the model that looks could not answer (${why})\n`, t0);
  }
  const answer = (await reply.json()) as { choices?: { message?: { content?: string | null } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  count.input += answer.usage?.prompt_tokens ?? 0;
  count.output += answer.usage?.completion_tokens ?? 0;
  count.ms += performance.now() - t0;
  return said(0, `${(answer.choices?.[0]?.message?.content ?? "").trim() || "(it said nothing)"}\n`, "", t0);
}

/** One run as the runner keeps it: the task's run, what it cost (an upper bound, and the node's meter), how long it took, and its eyes' calls. */
export type RunRecord = TaskRun & { dollars: number; meter: number | null; minutes: number; eyes?: EyesCount };

const median = (xs: readonly number[]): number | null => {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
const round = (n: number, places = 4) => Number(n.toFixed(places));

/**
 * The runs by task, as the desktop suite keeps its model baseline (bench/baseline/desktop-model.json): passes of the
 * runs, the model calls and actions a run took (median and most), the calls per action a passing run took (median and most), the
 * tokens, the dollars (the node's meter, and the runner's upper bound), the minutes, and the eyes' calls where it had
 * eyes. `bar`: the passes it is held to.
 */
export function recordOf(report: { at: string; commit: string; model: string; route: string; eyes?: string | null; runs: readonly RunRecord[] }, bar: { passed: number; of: number }) {
  const tasks = Object.fromEntries(
    [...new Set(report.runs.map((r) => r.task))].map((task) => {
      const these = report.runs.filter((r) => r.task === task);
      const passing = these.filter((r) => r.pass);
      const loops = these.map((r) => r.loop).filter((l): l is NonNullable<TaskRun["loop"]> => Boolean(l));
      const sum = (f: (l: NonNullable<TaskRun["loop"]>) => number) => loops.reduce((total, l) => total + f(l), 0);
      /** Each passing run's model calls over its actions: the record gives the median beside the worst. */
      const ratios = passing.map((r) => r.loop!.calls / Math.max(1, r.loop!.actions));
      const looked = these.filter((r) => r.eyes);
      return [
        task,
        {
          passed: passing.length,
          of: these.length,
          ...(these.some((r) => !r.pass) ? { failed: these.filter((r) => !r.pass).map((r) => `run ${r.run}: ${r.why.slice(0, 200)}`) } : {}),
          calls: { median: median(loops.map((l) => l.calls)), most: Math.max(0, ...loops.map((l) => l.calls)) },
          actions: { median: median(loops.map((l) => l.actions)), most: Math.max(0, ...loops.map((l) => l.actions)) },
          callsPerAction: ratios.length ? { median: round(median(ratios)!, 2), most: round(Math.max(...ratios), 2) } : null,
          tokens: { input: sum((l) => l.usage.input), cached: sum((l) => l.usage.cached ?? 0), output: sum((l) => l.usage.output), unreported: sum((l) => l.unknown) },
          dollars: { meter: these.every((r) => r.meter !== null) ? round(these.reduce((total, r) => total + r.meter!, 0)) : null, upperBound: round(these.reduce((total, r) => total + r.dollars, 0)) },
          minutes: { median: round(median(these.map((r) => r.minutes)) ?? 0, 2), most: round(Math.max(0, ...these.map((r) => r.minutes)), 2) },
          ...(looked.length ? { eyes: { calls: { median: median(looked.map((r) => r.eyes!.calls)), most: Math.max(...looked.map((r) => r.eyes!.calls)) }, tokens: { input: looked.reduce((t, r) => t + r.eyes!.input, 0), output: looked.reduce((t, r) => t + r.eyes!.output, 0) }, failed: looked.reduce((t, r) => t + r.eyes!.failed, 0) } } : {}),
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
    ...(report.eyes ? { eyes: report.eyes } : {}),
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
  const values = gatewayValues(readFileSync(file, "utf8"));
  const way = routeOf(values, route);
  if (!way) throw new Error(`the gateway file has no ${route} route`);
  const eyes = eyesRoute ? routeOf(values, eyesRoute) : null;
  if (eyesRoute && !eyes?.openai) throw new Error(`INVINCIBLE_BENCH_EYES: ${eyesRoute} isn't a <provider>/<model> the gateway file reaches`);
  for (const w of [way, eyes]) {
    const not = w ? whyNotOurs(w) : null;
    if (not) throw new Error(`the bench won't run on it: ${not}`);
  }
  // A plan's runs are capped in calls; a model billed by the token, in dollars.
  const onPlan = Boolean(way.openai);
  if (onPlan ? !(maxCalls > 0) : !(Number.isFinite(cap) && cap > 0)) throw new Error(onPlan ? "INVINCIBLE_BENCH_MAX_CALLS: the model calls the runs stop at" : "INVINCIBLE_BENCH_CAP_USD: the spend the runs stop at, in dollars");
  const framing = eyesFraming(readFileSync(new URL("../../sandbox/desktop/deskd.py", import.meta.url), "utf8"));
  const log = (line: string) => console.error(line);
  const b = bench(process.env.INVINCIBLE_BENCH_SCRATCH ?? "bench", log);
  await clearLeftovers(b);
  await buildImages(b);
  const { vm } = await BenchVm.make(b, { desktop: true, seed: 1 });
  const done: RunRecord[] = [];
  let spent = 0;
  /** Model calls so far, by model: the engineer's and the eyes'. */
  const calls = new Map<string, number>();
  const called = (model: string, n: number) => calls.set(model, (calls.get(model) ?? 0) + n);
  let stopped: string | null = null;
  try {
    await vm.ready(1);
    // (The VM's stand-in eyes answer only a look inside a longer command, and say how to ask the real ones.)
    if (eyes) await vm.raw(["sh", "-c", `printf '%s' "$1" > ${IN_VM}/eyes-answer.txt`, "sh", 'The eyes answer a look given as a command of its own: desktop look "<question>".']);
    for (const task of only) {
      for (let run = 1; run <= runs && !stopped; run++) {
        // A run's share and a call's more must be left of the cap, or none starts (a plan's: a run's most steps, in calls).
        const most = Math.max(calls.get(way.model) ?? 0, eyes ? (calls.get(eyes.model) ?? 0) : 0);
        if (onPlan ? most >= maxCalls : spent + share + 0.5 > cap) {
          stopped = onPlan ? `${most} model calls made of the ${maxCalls} allowed` : `$${spent.toFixed(2)} spent of $${cap}, and a run may take $${share}`;
          break;
        }
        const stop = new AbortController();
        const before = meter();
        const t0 = performance.now();
        const count: EyesCount = { calls: 0, input: 0, output: 0, ms: 0, failed: 0 };
        const limited = (why: string) => {
          stopped ??= `a limit answer: ${why.slice(0, 240)}`;
          stop.abort(new Error(stopped));
        };
        const r = await runTask(vm, task, "model", run, {
          ctx: (asked) =>
            way.openai
              ? modelsContext(way.token, recording(gatewayAlone(way.base), asked), way.model, { id: way.openai, baseUrl: way.base })
              : modelsContext(way.token, recording(throughGateway(way.base, { versioned: way.versioned }), asked), way.model),
          spent: (counted) => {
            if (onPlan) {
              const engineer = (calls.get(way.model) ?? 0) + counted.calls + (eyes?.model === way.model ? count.calls : 0);
              if (engineer >= maxCalls) stop.abort(new Error(`the run reached the ${maxCalls} model calls allowed`));
            } else if (dollarsOf(counted.usage) > share) stop.abort(new Error(`the run passed its share of $${share}`));
          },
          signal: stop.signal,
          ...(onPlan ? { toolset: false } : {}),
          ...(eyes
            ? {
                eyes: true,
                exec: (command: string, timeoutSec: number, inVm: (command: string, timeoutSec: number) => Promise<ExecResult>) => {
                  const question = lookOf(command);
                  return question === null ? inVm(command, timeoutSec) : benchLook(question, inVm, eyes, framing, count, limited);
                },
              }
            : {}),
        });
        const usage: Usage = r.loop?.usage ?? { input: 0, output: 0, cached: 0 };
        called(way.model, r.loop?.calls ?? 0);
        if (eyes) called(eyes.model, count.calls);
        // A plan's calls are paid for already: no dollars by the token.
        const dollars = onPlan ? 0 : dollarsOf(usage);
        spent += dollars;
        const after = meter();
        const one: RunRecord = { ...r, dollars: Number(dollars.toFixed(4)), meter: before !== null && after !== null ? Number((after - before).toFixed(4)) : null, minutes: Number(((performance.now() - t0) / 60_000).toFixed(2)), ...(eyes ? { eyes: { ...count, ms: Math.round(count.ms) } } : {}) };
        done.push(one);
        if (!r.pass && r.why.startsWith("the loop failed:") && limitAnswer(r.why)) stopped ??= `a limit answer: ${r.why.slice(0, 240)}`;
        log(`${task} ${run}: ${r.pass ? "pass" : `fail: ${r.why.slice(0, 160)}`} · ${r.loop?.calls ?? 0} calls, ${r.loop?.actions ?? 0} actions${eyes ? `, ${count.calls} looks` : ""} · ${usage.input} in (${usage.cached ?? 0} cached), ${usage.output} out · ${onPlan ? "a plan's" : `≤ $${one.dollars}`}${one.meter !== null ? `, the meter $${one.meter}` : ""} · ${one.minutes} min`);
      }
      if (stopped) break;
    }
  } finally {
    await vm.remove().catch((error) => log(`couldn't remove ${vm.container}: ${(error as Error).message}`));
    await clearLeftovers(b);
  }
  if (stopped) log(`stopped: ${stopped}`);
  const report = {
    at: new Date().toISOString(),
    commit: process.env.INVINCIBLE_BENCH_COMMIT ?? "unknown",
    model: way.openai ? `${way.openai}/${way.model}` : way.model,
    route,
    eyes: eyes ? eyesRoute! : null,
    calls: Object.fromEntries(calls),
    stopped,
    runs: done,
    spentUpperBound: Number(spent.toFixed(4)),
    meterTotal: done.every((r) => r.meter !== null) ? Number(done.reduce((s, r) => s + r.meter!, 0).toFixed(4)) : null,
  };
  mkdirSync(join(OUT_DIR, "desktop"), { recursive: true });
  writeFileSync(join(OUT_DIR, "desktop", "model-runs.json"), `${JSON.stringify(report, null, 2)}\n`);
  // (The record the suite keeps as its model baseline, by task: C1 step 7's bar, 18 of 20 to start.)
  writeFileSync(join(OUT_DIR, "desktop", "model-record.json"), `${JSON.stringify(recordOf(report, { passed: Math.ceil((done.length * 18) / 20), of: done.length }), null, 2)}\n`);
  console.log(JSON.stringify(report));
}

if (import.meta.main) await main();
