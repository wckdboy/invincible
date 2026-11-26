import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { TERMINAL_HANG_UP } from "../src/spec.ts";

/*
 * Closing a terminal, inside the sandbox: Docker leaves what an exec started running when its client goes, so what
 * the terminal started is hung up there by its tag. Linux only (it reads /proc), as a sandbox is.
 */

/** Whether a process still runs. One that was killed but that nothing has reaped yet (a zombie: where its parent is
 * gone and no init process adopts it, as in a CI runner's container with a plain command for its PID 1) has ended:
 * only its entry is left (/proc/<pid>/stat says state Z). */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
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

test.skipIf(process.platform !== "linux")("what a terminal started is hung up by its tag: what was started with nohup stays, a shell that ignores the hang-up is killed", async () => {
  const tag = `t${Date.now().toString(16)}`;
  const env = { ...process.env, GALAHAD_TERMINAL: tag };
  // A shell with a job, and a job started with nohup: what a terminal's shell is like.
  const shell = Bun.spawn(["sh", "-c", "sleep 300 & echo $!; nohup sleep 301 >/dev/null 2>&1 & echo $!; wait"], { env, stdout: "pipe" });
  // A shell that leads its own session and ignores the hang-up: one that would otherwise never go.
  const stubborn = Bun.spawn(["setsid", "sh", "-c", "trap '' HUP; while :; do sleep 1; done"], { env });
  // Another terminal's shell, untouched.
  const other = Bun.spawn(["sh", "-c", "sleep 303"], { env: { ...process.env, GALAHAD_TERMINAL: `${tag}x` } });
  const reader = shell.stdout.getReader();
  let printed = "";
  while (printed.split("\n").length < 3) printed += new TextDecoder().decode((await reader.read()).value);
  const [job, nohupped] = printed.trim().split("\n").map(Number) as [number, number];
  await Bun.sleep(200);

  const hangUp = Bun.spawn(["sh", "-c", TERMINAL_HANG_UP, "hang-up", tag]);
  expect(await hangUp.exited).toBe(0);
  await until(() => !alive(shell.pid) && !alive(job) && !alive(stubborn.pid));
  expect(alive(nohupped)).toBe(true);
  expect(alive(other.pid)).toBe(true);
  process.kill(nohupped, "SIGKILL");
  other.kill();
});
