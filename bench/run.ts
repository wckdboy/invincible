// The Scorecard: `bun run bench [suite…] [--full] [--json] [--all] [--ci] [--seed n] [--update-baseline]`
//
// Runs the benchmark suites (deterministic, offline, in temp directories; nothing touches ~/.galahad), prints
// what each measured against its recorded baseline, writes bench/out/<suite>.json, and exits non-zero when a
// quality metric regressed, a metric the baseline had is gone, a suite broke, or a speed metric is past the
// wide threshold. What the numbers mean and the rules they follow: docs/BENCHMARKS.md.
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { collector, DEFAULT_SEED, Pace, type Suite } from "./lib.ts";
import { BASELINE_DIR, type Comparison, compare, nextBaseline, OUT_DIR, readScorecard, renderSuite, type Scorecard, SPEED_FAIL_FACTOR, SPEED_NOISE_FLOOR, writeScorecard } from "./scorecard.ts";

/** The suites run here, in the order they run: the most telling first. */
const SUITES: Record<string, () => Promise<{ suite: Suite }>> = {
  fleet: () => import("./suites/fleet.ts"),
  compute: () => import("./suites/compute.ts"),
  mind: () => import("./suites/mind.ts"),
  archive: () => import("./suites/archive.ts"),
  "harness-overhead": () => import("./suites/harness-overhead.ts"),
  context: () => import("./suites/context.ts"),
  notify: () => import("./suites/notify.ts"),
  web: () => import("./suites/web.ts"),
};

const USAGE = `bun run bench [suite…] [--full] [--json] [--all] [--ci] [--seed n] [--update-baseline]

  suite…             only these (default: all): ${Object.keys(SUITES).join(", ")}
  --full             the long sizes too (their metrics start "full.")
  --all              print every metric, not just the headline ones and those that changed
  --json             the scorecards and verdicts as JSON on stdout (the report goes to stderr)
  --ci               CI's gate: quality only (speed is reported, never fails), and a suite with no baseline fails
  --seed n           other inputs (quality is judged only against a baseline of the same seed)
  --update-baseline  record this run as bench/baseline/<suite>.json, on purpose
  --list             the suites, a line each`;

function revision(root: string): string {
  try {
    const git = Bun.spawnSync(["git", "describe", "--always", "--dirty=+dirty", "--abbrev=12"], { cwd: root, stderr: "ignore" });
    const rev = git.stdout.toString().trim();
    if (git.exitCode === 0 && rev) return rev.slice(0, 64);
  } catch {
    /* no git */
  }
  return "unknown";
}

/** What ran: the processor's own name (a hostname says who, not what). */
const machineName = (): string => (process.env.GALAHAD_BENCH_MACHINE ?? os.cpus()[0]?.model ?? "unknown").replace(/\s+/g, " ").trim().slice(0, 120);

interface Result {
  suite: string;
  scorecard: Scorecard | null;
  comparison: Comparison | null;
  error: string | null;
  tookMs: number | null;
  /** Whether it ran now (always, since every suite runs here; kept in the JSON for whatever reads it). */
  ran: boolean;
  baselineWritten: boolean;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    options: {
      full: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      ci: { type: "boolean", default: false },
      seed: { type: "string" },
      "update-baseline": { type: "boolean", default: false },
      list: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (values.list) {
    for (const name of Object.keys(SUITES)) console.log(`${name.padEnd(18)} ${(await SUITES[name]!()).suite.about}`);
    return 0;
  }
  const seed = values.seed === undefined ? DEFAULT_SEED : Number(values.seed);
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    console.error(`--seed takes a whole number from 0 to ${0xffff_ffff}`);
    return 2;
  }
  const unknown = positionals.filter((name) => !SUITES[name]);
  if (unknown.length) {
    console.error(`no such suite: ${unknown.join(", ")}\n\n${USAGE}`);
    return 2;
  }
  const named = positionals.length > 0;
  const toRun = Object.keys(SUITES).filter((name) => !named || positionals.includes(name));
  const full = values.full;
  const say = (line: string): void => void (values.json ? process.stderr : process.stdout).write(`${line}\n`);
  const progress = (line: string): void => void process.stderr.write(`  · ${line}\n`);

  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const commit = revision(root);
  const machine = { name: machineName(), cores: os.cpus().length };
  const options = { full, qualityOnly: values.ci };
  const started = performance.now();
  say(`Galahad scorecard · ${commit} · seed ${seed}${full ? " · full" : ""} · ${machine.name} (${machine.cores} threads)`);
  say("");

  const results: Result[] = [];
  for (const name of toRun) {
    const result: Result = { suite: name, scorecard: null, comparison: null, error: null, tookMs: null, ran: true, baselineWritten: false };
    results.push(result);
    process.stderr.write(`${name}…\n`);
    let suite: Suite | null = null;
    const t0 = performance.now();
    try {
      suite = (await SUITES[name]!()).suite;
      // The machine's pace is sampled beside every timing, and whenever the suite awaits (see Pace).
      const pace = new Pace();
      const { ctx, metrics, finish } = collector(seed, full, progress, pace);
      const sampler = setInterval(() => pace.pulse(), 200);
      try {
        await suite.run(ctx);
      } finally {
        clearInterval(sampler);
      }
      const calibration = finish()!;
      result.tookMs = performance.now() - t0;
      const card: Scorecard = { suite: name, commit, at: Date.now(), seed, machine: { ...machine, calibration }, metrics };
      writeScorecard(OUT_DIR, card);
      result.scorecard = card;
      const baseline = readScorecard(BASELINE_DIR, name);
      result.comparison = compare(card, baseline, options);
      if (values["update-baseline"]) {
        writeScorecard(BASELINE_DIR, nextBaseline(card, baseline, full));
        result.baselineWritten = true;
      }
    } catch (error) {
      result.tookMs = performance.now() - t0;
      result.error = String((error as Error)?.stack ?? error);
    }
    if (result.scorecard && result.comparison) say(renderSuite(result.scorecard, result.comparison, { all: values.all, headline: suite?.headline ?? [], about: suite?.about ?? "", tookMs: result.tookMs }));
    else say(`${name}: BROKE\n  ${(result.error ?? "").split("\n").slice(0, 6).join("\n  ")}`);
    if (result.baselineWritten) say(`  baseline recorded: bench/baseline/${name}.json`);
    say("");
  }

  // What it comes to.
  const rows = results.flatMap((r) => (r.comparison?.rows ?? []).map((row) => ({ suite: r.suite, row })));
  const of = (...verdicts: string[]) => rows.filter(({ row }) => verdicts.includes(row.verdict));
  const broke = results.filter((r) => r.error);
  const unbaselined = results.filter((r) => r.comparison?.note && !r.baselineWritten);
  const regressed = of("regressed");
  const gone = of("gone").filter(({ row }) => row.metric.kind === "quality" || !values.ci);
  // A suite whose baseline was just recorded isn't failed by what differs from the old one: that was the point.
  const failed = broke.length > 0 || results.some((r) => r.comparison?.failed && !r.baselineWritten) || (values.ci && unbaselined.length > 0);
  const name = ({ suite, row }: (typeof rows)[number]) => `${suite}/${row.metric.id}`;
  const list = (items: typeof rows): string => `${items.slice(0, 8).map(name).join(", ")}${items.length > 8 ? `, and ${items.length - 8} more` : ""}`;
  say(`In all: ${rows.length} metrics in ${results.filter((r) => r.scorecard).length} suites, ${((performance.now() - started) / 1000).toFixed(0)} s.`);
  const better = of("better");
  const slower = of("slower");
  if (better.length) say(`  Better: ${list(better)}.`);
  if (slower.length) say(`  Slower beyond noise (reported, not failed; noise is ±${Math.round(SPEED_NOISE_FLOOR * 100)} % or the samples' own spread, a fail is over ${SPEED_FAIL_FACTOR}×): ${list(slower)}.`);
  const over = values["update-baseline"] ? " (against the baseline this run replaces)" : "";
  if (regressed.length) say(`  REGRESSED${over}: ${list(regressed)}.`);
  if (gone.length) say(`  GONE${over}: ${list(gone)}.`);
  if (broke.length) say(`  BROKE: ${broke.map((r) => r.suite).join(", ")}.`);
  if (unbaselined.length) say(`  Not judged (${values.ci ? "fails under --ci" : "no baseline, or another seed"}): ${unbaselined.map((r) => r.suite).join(", ")}.`);
  const recorded = results.filter((r) => r.baselineWritten);
  if (recorded.length) say(`  Baseline recorded for: ${recorded.map((r) => r.suite).join(", ")}.`);
  say(failed ? "FAILED." : recorded.length || unbaselined.length || better.length || slower.length ? "OK." : "Nothing moved.");

  if (values.json) {
    process.stdout.write(
      `${JSON.stringify({ commit, seed, full, at: Date.now(), failed, suites: results.map((r) => ({ suite: r.suite, ran: r.ran, tookMs: r.tookMs === null ? null : Math.round(r.tookMs), error: r.error, scorecard: r.scorecard, note: r.comparison?.note ?? null, verdicts: (r.comparison?.rows ?? []).map((row) => ({ id: row.metric.id, verdict: row.verdict, change: row.change, baseline: row.baseline?.value ?? null })) })) }, null, 2)}\n`,
    );
  }
  return failed ? 1 : 0;
}

// Timers a suite left behind (a governor's, a store's) never hold the run open.
process.exit(await main());
