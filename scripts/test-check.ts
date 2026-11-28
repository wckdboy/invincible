/*
 * `bun run check`'s tests: `bun test` with these arguments, watched, so a worker that hangs can't hang the check without
 * a word (28 November 2026: on the Mac mini one worker of eight spun 58 minutes inside a Bun.spawnSync that lost its
 * child, in evals-budget, and the check never ended). A synchronous wait holds the worker's thread, so no test timeout
 * fires there. So each worker says where it stands (bench/test-preload.ts: its file, which of its tests has begun, and
 * whether one is running), and this names any test still running past STUCK_MS. That's past any test's own limit (the
 * largest is 600 s). It also names every worker's place when the whole run has printed nothing for STUCK_MS. Then it
 * stops the run and every process under it, by their PIDs: under --parallel each worker leads a process group of its
 * own, so a group's kill leaves them running. It ends with `bun test`'s own exit otherwise.
 *
 *   bun scripts/test-check.ts [bun test's arguments]
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const STUCK_MS = Number(process.env.INVINCIBLE_TEST_STUCK_MS ?? 15 * 60_000);
const EVERY_MS = Number(process.env.INVINCIBLE_TEST_WATCH_EVERY_MS ?? 30_000);

interface Place {
  pid: number;
  file: string;
  test: number;
  running: boolean;
  at: number;
}

const watch = mkdtempSync(join(tmpdir(), "invincible-test-watch-"));
const child = Bun.spawn([process.execPath, "test", ...process.argv.slice(2)], {
  stdin: "inherit",
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env, INVINCIBLE_TEST_WATCH: watch },
});
let lastOutput = Date.now();
const pass = async (from: ReadableStream<Uint8Array>, to: NodeJS.WriteStream): Promise<void> => {
  for await (const chunk of from) {
    lastOutput = Date.now();
    to.write(chunk);
  }
};
const passed = Promise.all([pass(child.stdout, process.stdout), pass(child.stderr, process.stderr)]);

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Where each worker that is still alive stands. */
function places(): Place[] {
  const out: Place[] = [];
  for (const name of readdirSync(watch)) {
    try {
      const place = JSON.parse(readFileSync(join(watch, name), "utf8")) as Place;
      if (alive(place.pid)) out.push(place);
    } catch {
      /* half written: read again next time */
    }
  }
  return out;
}

const said = (place: Place): string => `${relative(process.cwd(), place.file)} (worker ${place.pid}): ${place.running ? `its test ${place.test} began` : `between its tests, after test ${place.test},`} ${Math.round((Date.now() - place.at) / 60_000)} min ago`;

/** Every process under `root`, deepest first, from `ps` (asked without holding this thread): what a group's kill would leave. */
async function tree(root: number): Promise<number[]> {
  const ps = Bun.spawn(["ps", "-A", "-o", "pid=,ppid="], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const listed = await new Response(ps.stdout).text();
  const children = new Map<number, number[]>();
  for (const line of listed.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || ppid === undefined) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const out: number[] = [];
  const walk = (pid: number): void => {
    for (const kid of children.get(pid) ?? []) walk(kid);
    out.push(pid);
  };
  walk(root);
  return out;
}

let stopping: Promise<never> | null = null;

/** Says why, then stops `bun test`, its workers and all under them, by their PIDs, and ends this with 1. Once. */
function stop(why: string[]): Promise<never> {
  return (stopping ??= stopAll(why));
}

async function stopAll(why: string[]): Promise<never> {
  process.stderr.write(`\ntest-check: ${why.join("\ntest-check: ")}\ntest-check: stopping the run and every process under it.\n`);
  // (The workers by what they said of themselves too, in case one isn't found under bun test.)
  const workers = places().map((place) => place.pid);
  const pids = [...new Set([...(await Promise.all(workers.map((pid) => tree(pid)))).flat(), ...(await tree(child.pid))])];
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* gone */
    }
  }
  await Bun.sleep(3_000);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  rmSync(watch, { recursive: true, force: true });
  process.exit(1);
}

const looking = setInterval(() => {
  const now = Date.now();
  const stuck = places().filter((place) => place.running && now - place.at > STUCK_MS);
  if (stuck.length) {
    void stop(stuck.map((place) => `${said(place)}, and has neither ended nor timed out: a wait that holds its thread (a synchronous spawn, a busy loop).`));
    return;
  }
  if (now - lastOutput > STUCK_MS) void stop([`nothing printed for ${Math.round((now - lastOutput) / 60_000)} min. Where its workers stand:`, ...places().map(said)]);
}, EVERY_MS);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void stop([`stopped (${signal}).`]));

const code = await child.exited;
clearInterval(looking);
// (Stopped: bun test ended by the signal, and the stop ends this, with 1, once all under it is gone.)
if (stopping) await stopping;
await passed;
rmSync(watch, { recursive: true, force: true });
process.exit(code);
