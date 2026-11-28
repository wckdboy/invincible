import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxView } from "@invincible/core";
import { PIPE_END, SandboxError, SandboxHost } from "../src/index.ts";

/*
 * A pipe between two of a host's sandboxes (SandboxHost.pipe; the fifth fabric review's R5-3): what one side prints is
 * the other's input, as it is printed, through the host alone and never kept there; past its cap both sides are ended,
 * their clients here and what they started in their VMs (the seventh fabric review's I-c), and it says it was cut. Docker
 * is a stand-in that runs each side's command here, as `docker exec` runs it in its VM, with the environment it is given,
 * and keeps a record of every time it is asked.
 */

const dir = mkdtempSync(join(tmpdir(), "pipe-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
/** What the stand-in was asked: a file for each time it ran, holding its arguments, each ended by a NUL. */
const calls = join(dir, "calls");
mkdirSync(calls);
/** `docker exec [--interactive] [--workdir /work] [--env K=V]… <container> timeout --signal=KILL <n>s bash -lc <command>`, run here. */
const docker = join(dir, "docker");
writeFileSync(
  docker,
  `#!/bin/bash
printf '%s\\0' "$@" > "$(mktemp "${calls}/call.XXXXXX")"
[ "$1" = exec ] || exit 99
shift
while :; do
  case $1 in
    --interactive) shift ;;
    --workdir) shift 2 ;;
    --env) export "$2"; shift 2 ;;
    -*) exit 98 ;;
    *) break ;;
  esac
done
shift
[ "$1" = timeout ] && shift 3
[ "$1" = bash ] && [ "$2" = -lc ] && exec bash -c "$3"
exec "$@"
`,
);
chmodSync(docker, 0o755);

/** How the host runs Docker for anything but a pipe's sides (a pipe's end, in a VM): the same stand-in, run here. */
async function runner(args: string[], timeoutMs: number) {
  const proc = Bun.spawn([docker, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { code, stdout, stderr };
}

function host(status: Record<string, string> = { a: "running", b: "running" }, engine?: "container") {
  const made = new SandboxHost({ node: "test", maxCpus: 8, maxMemoryGb: 16, docker, runner, ledger: () => {}, ...(engine ? { engine } : {}), tokens: { mint: () => ({ token: "t", info: { hash: "h" } }), revoke: () => true } } as never);
  // (Which VMs are here, and how they stand: what a listing of Docker's would say.)
  Object.assign(made, { get: async (id: string) => (status[id] ? ({ id, status: status[id] } as unknown as SandboxView) : null) });
  return made;
}
const side = (id: string, command: string) => ({ id, cmd: ["bash", "-lc", command] });

describe("a pipe between two of a host's sandboxes", () => {
  test("gives what one side prints to the other as its input, all of it; what the other prints comes back, the first's never", async () => {
    const piped = await host().pipe(side("a", "printf 'given:'; head -c 3000000 /dev/zero; echo said >&2"), side("b", "wc -c | tr -d ' '"), { timeoutSec: 30, maxBytes: 64 << 20 });
    expect(piped.bytes).toBe(3_000_006);
    expect(piped.cut).toBe(false);
    expect([piped.from.exitCode, piped.from.stdout, piped.from.stderr.trim()]).toEqual([0, "", "said"]);
    expect([piped.to.exitCode, piped.to.stdout.trim()]).toEqual([0, "3000006"]);
  });

  test("past its cap ends both sides and says it was cut, the cap's worth at most given on", async () => {
    const out = join(dir, "kept");
    const piped = await host().pipe(side("a", "head -c 200000000 /dev/zero"), side("b", `cat > ${out}`), { timeoutSec: 30, maxBytes: 100_000 });
    expect(piped.cut).toBe(true);
    expect(piped.bytes).toBeGreaterThan(100_000);
    expect(piped.bytes).toBeLessThan(200_000_000);
    expect(Bun.file(out).size).toBeLessThanOrEqual(100_000);
  });

  test("says how each side ended: one that fails, and the other given an input that ended there", async () => {
    const piped = await host().pipe(side("a", "printf part; echo 'could not read it' >&2; exit 3"), side("b", "cat; echo ' and its end'"), { timeoutSec: 30, maxBytes: 64 << 20 });
    expect([piped.from.exitCode, piped.from.stderr.trim()]).toEqual([3, "could not read it"]);
    expect([piped.to.exitCode, piped.to.stdout]).toEqual([0, "part and its end\n"]);
    expect([piped.bytes, piped.cut]).toEqual([4, false]);
  });

  test("is refused before anything runs: on a Mac, for a VM not on this node, or for one that isn't running", async () => {
    const refused = async (made: SandboxHost) => (await made.pipe(side("a", "exit 0"), side("b", "exit 0"), { timeoutSec: 30, maxBytes: 1 }).catch((error: SandboxError) => error)) as SandboxError;
    expect((await refused(host(undefined, "container"))).status).toBe(424);
    expect((await refused(host({ a: "running" }))).status).toBe(404);
    expect((await refused(host({ a: "running", b: "exited" }))).status).toBe(409);
  });
});

/*
 * What a pipe's sides started in their VMs is ended there too, not only their docker clients here (the seventh fabric
 * review's I-c): Docker leaves what an exec started running when its client goes. Each side runs with the pipe's own tag
 * in its environment, and the end (PIPE_END) is asked of a VM by it.
 *
 * The stand-in runs a side's command as its client's own process, so killing the client would end the command itself;
 * in a VM the command outlives its client. So a side here starts a child of its own, which outlives its client's kill as
 * a VM's command does, and its pid is the one that must be gone. Its output is the client's no longer once the client
 * is gone (a VM's never reaches the host then), so the child's stderr isn't the client's, and nor is the stdout of a
 * receiver's child.
 */

/** Whether a process still runs. One killed but not yet reaped (state Z, as an orphan stays in CI's container, whose PID 1 reaps none) has ended. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== "linux") return true;
  try {
    return !/^\d+ \(.*\) Z /s.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
};

async function until(what: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

/** A pid written to a file, once it is there whole. */
async function pidIn(file: string): Promise<number> {
  await until(() => existsSync(file) && /^\d+\n$/.test(readFileSync(file, "utf8")));
  return Number(readFileSync(file, "utf8"));
}

/** A sending side whose child writes its own pid, floods past any cap, and then sleeps: it outlives its client. */
const outliving = (pidFile: string) => `sh -c 'echo $$ > ${pidFile}; trap "" PIPE; while printf "%065536d" 0; do :; done; exec sleep 300' 2>/dev/null & wait`;
/** A receiving side that reads its input to its end, with a child that sleeps on after it: the child's pid is written first. */
const receiving = (pidFile: string) => `sleep 300 >/dev/null 2>&1 & echo $! > ${pidFile}; cat >/dev/null; wait`;

const vmOf = (argv: string[]) => argv.find((arg) => arg.startsWith("invincible-sbx-"))?.slice("invincible-sbx-".length);
const tagOf = (argv: string[]) => argv.find((arg) => arg.startsWith("INVINCIBLE_PIPE="))?.slice("INVINCIBLE_PIPE=".length);
/** What the stand-in was asked for one pipe: its two sides (found by a mark in their commands), their tags, and the ends asked with them. */
function asked(mark: string) {
  const all = readdirSync(calls).map((name) => readFileSync(join(calls, name), "utf8").split("\0").slice(0, -1));
  const sides = all.filter((argv) => argv.some((arg) => arg.includes(mark)));
  const tags = sides.map(tagOf);
  const ends = all.filter((argv) => argv.includes(PIPE_END) && tags.includes(argv.at(-1)));
  return { sides: sides.map(vmOf).sort(), tags, ends: ends.map(vmOf).sort(), endsRanWith: ends.map(tagOf), endArgs: ends.map((argv) => argv.slice(argv.indexOf(PIPE_END) - 2)) };
}

/** What a test started here, killed by its pids where it is still there (a Mac has no /proc for the end to find it by). */
function tidy(pids: number[]): void {
  for (const pid of pids) if (pid > 1 && alive(pid)) process.kill(pid, "SIGKILL");
}

/** A pipe cut at its cap, its sides each with a child that outlives its client; with the children's pids. */
async function cutPipe() {
  const mark = randomBytes(6).toString("hex");
  const [fromPid, toPid] = [join(dir, `${mark}.from.pid`), join(dir, `${mark}.to.pid`)];
  const piped = await host().pipe(side("a", outliving(fromPid)), side("b", receiving(toPid)), { timeoutSec: 30, maxBytes: 1_000_000 });
  return { mark, piped, children: [await pidIn(fromPid), await pidIn(toPid)] };
}

/**
 * A pipe whose receiving side exits at the first of its input while its sender's child still gives; with that child's
 * pid and how long the pipe took. (At the first byte, not before it: by then the child is there, its pid written.)
 */
async function brokenPipe() {
  const mark = randomBytes(6).toString("hex");
  const fromPid = join(dir, `${mark}.from.pid`);
  const began = Date.now();
  // (Its deadline is 2 s, so its timer would end both sides at 17 s: a pipe that waited for it took that long.)
  const piped = await host().pipe(side("a", outliving(fromPid)), side("b", `: ${mark}; head -c 1 >/dev/null`), { timeoutSec: 2, maxBytes: 64 << 20 });
  return { mark, piped, tookMs: Date.now() - began, child: await pidIn(fromPid) };
}

describe("a pipe's end in its VMs (the seventh fabric review's I-c)", () => {
  test("cut at its cap: its end is asked in both VMs, by the pipe's own tag, the one both sides ran with, and never with the tag itself", async () => {
    const { mark, piped, children } = await cutPipe();
    try {
      expect(piped.cut).toBe(true);
      const seen = asked(mark);
      expect(seen.sides).toEqual(["a", "b"]);
      // One tag for the pipe, of 128 bits or more, that both sides ran with.
      expect(seen.tags[0]).toMatch(/^[0-9a-f]{32,}$/);
      expect(seen.tags[1]).toBe(seen.tags[0]!);
      expect(seen.ends).toEqual(["a", "b"]);
      expect(seen.endArgs).toEqual([
        ["sh", "-c", PIPE_END, "end", seen.tags[0]!],
        ["sh", "-c", PIPE_END, "end", seen.tags[0]!],
      ]);
      // (The end runs without the tag in its environment: otherwise it would be among what it kills.)
      expect(seen.endsRanWith).toEqual([undefined, undefined]);
    } finally {
      tidy(children);
    }
  }, 60_000);

  test.skipIf(process.platform !== "linux")("cut at its cap: nothing its sides started is left running once it returns, the sender's child that outlived its client nor the receiver's (Linux only: the end reads /proc)", async () => {
    const { piped, children } = await cutPipe();
    try {
      expect(piped.cut).toBe(true);
      await until(() => children.every((pid) => !alive(pid))).catch(() => {});
      expect(children.map(alive)).toEqual([false, false]);
    } finally {
      tidy(children);
    }
  }, 60_000);

  test("broken, its receiving side gone at the first of its input while the sender still gives: the sender is ended at once, its end asked in its VM alone, never at the deadline", async () => {
    const { mark, piped, tookMs, child } = await brokenPipe();
    try {
      expect([piped.cut, piped.to.exitCode]).toEqual([false, 0]);
      // (Its client killed here: what it exits with says so.)
      expect(piped.from.exitCode).toBe(137);
      expect(tookMs).toBeLessThan(15_000);
      const seen = asked(mark);
      expect(seen.sides).toEqual(["a", "b"]);
      expect(seen.ends).toEqual(["a"]);
    } finally {
      tidy([child]);
    }
  }, 60_000);

  test.skipIf(process.platform !== "linux")("broken, its receiving side gone at the first of its input: the sender's child that outlived its client is gone once it returns (Linux only: the end reads /proc)", async () => {
    const { child } = await brokenPipe();
    try {
      await until(() => !alive(child)).catch(() => {});
      expect(alive(child)).toBe(false);
    } finally {
      tidy([child]);
    }
  }, 60_000);

  test("a pipe that comes to its end asks no end of either VM", async () => {
    const mark = randomBytes(6).toString("hex");
    const piped = await host().pipe(side("a", `: ${mark}; head -c 100000 /dev/zero`), side("b", `: ${mark}; wc -c`), { timeoutSec: 30, maxBytes: 64 << 20 });
    expect([piped.cut, piped.from.exitCode, piped.to.exitCode, piped.to.stdout.trim()]).toEqual([false, 0, 0, "100000"]);
    expect(asked(mark).ends).toEqual([]);
  });

  test("PIPE_END refuses a tag that isn't 32 or more hex digits before it looks at anything, so no other pipe's can match", async () => {
    const ran = async (tag: string) => Bun.spawn(["sh", "-c", PIPE_END, "end", tag], { stdout: "ignore", stderr: "ignore" }).exited;
    for (const tag of ["", "abc", ".*", "0123456789abcdef0123456789abcde", "0123456789ABCDEF0123456789abcdef", "0123456789abcdef0123456789abcdef x"]) expect([tag, await ran(tag)]).toEqual([tag, 2]);
    expect(await ran(randomBytes(16).toString("hex"))).toBe(0);
  });

  test.skipIf(process.platform !== "linux")("PIPE_END ends what has its tag and the group each tagged process leads, nothing else: not a group an untagged process leads, nor another pipe's (Linux only: it reads /proc)", async () => {
    const tag = randomBytes(16).toString("hex");
    const started: number[] = [];
    const lines = async (proc: { stdout: ReadableStream<Uint8Array> }, n: number) => {
      const reader = proc.stdout.getReader();
      let printed = "";
      while (printed.split("\n").length <= n) {
        const read = await reader.read();
        if (read.done) throw new Error(`it ended before it printed ${n} pid(s): ${JSON.stringify(printed)}`);
        printed += new TextDecoder().decode(read.value);
      }
      return printed.trim().split("\n").map(Number);
    };
    try {
      // A side as a VM has it: a tagged process leading a group of its own (a side's `timeout`, here setsid's), with an
      // untagged child in that group, as the node's git runs.
      const piped = Bun.spawn(["setsid", "sh", "-c", "env -u INVINCIBLE_PIPE sleep 301 & echo $!; wait"], { env: { ...process.env, INVINCIBLE_PIPE: tag }, stdout: "pipe" });
      started.push(piped.pid);
      // A group an untagged process leads (as the agent's own work does), with a process given the tag in it: that one alone goes.
      const other = Bun.spawn(["setsid", "sh", "-c", `INVINCIBLE_PIPE=${tag} sleep 302 & echo $!; sleep 303 & echo $!; wait`], { stdout: "pipe" });
      started.push(other.pid);
      // Another pipe's, which has a tag of its own.
      const another = Bun.spawn(["sleep", "304"], { env: { ...process.env, INVINCIBLE_PIPE: randomBytes(16).toString("hex") } });
      started.push(another.pid);
      const [untaggedChild] = await lines(piped, 1);
      const [taggedMember, untaggedMember] = await lines(other, 2);
      started.push(untaggedChild!, taggedMember!, untaggedMember!);

      const ended = Bun.spawn(["sh", "-c", PIPE_END, "end", tag]);
      expect(await ended.exited).toBe(0);
      await until(() => !alive(piped.pid) && !alive(untaggedChild!) && !alive(taggedMember!)).catch(() => {});
      expect([piped.pid, untaggedChild, taggedMember].map((pid) => alive(pid!))).toEqual([false, false, false]);
      expect([other.pid, untaggedMember, another.pid].map((pid) => alive(pid!))).toEqual([true, true, true]);
    } finally {
      tidy(started);
    }
  }, 30_000);
});
