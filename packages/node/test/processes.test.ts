import { expect, spyOn, test } from "bun:test";
import { commandOf, outputOf } from "../src/processes.ts";

/*
 * What the node asks of short commands it asks without holding its thread, and within a time limit (processes.ts, 28
 * November 2026): on the Mac mini a Bun.spawnSync that lost its child held a test worker's thread for 58 minutes, past
 * every timeout.
 */

test("a command's output and exit, a process's command line, and none for a pid no process has: never by a synchronous spawn", async () => {
  const sync = spyOn(Bun, "spawnSync");
  const sleeper = Bun.spawn(["sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  try {
    expect(await outputOf(["sh", "-c", "printf 'qamp 0.2.0\\n'; exit 3"])).toEqual({ code: 3, stdout: "qamp 0.2.0\n" });
    expect(await commandOf(sleeper.pid)).toBe("sleep 30");
    expect(await commandOf(999_999_999)).toBeNull();
    expect(sync).not.toHaveBeenCalled();
  } finally {
    sync.mockRestore();
    sleeper.kill("SIGKILL");
  }
});

test("a command that runs past its time limit is stopped there, and answers nothing; one that can't be run answers nothing", async () => {
  const began = Date.now();
  expect(await outputOf(["sleep", "30"], { timeoutMs: 300 })).toBeNull();
  expect(Date.now() - began).toBeLessThan(4_000);
  expect(await outputOf(["/nonexistent/invincible-no-such-binary"])).toBeNull();
});
