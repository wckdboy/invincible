import { expect, test } from "bun:test";
import { closeSync, existsSync, openSync, readFileSync, utimesSync, writeSync } from "node:fs";
import { join } from "node:path";
import { freePort, HELD, HOLD_MS, TEST_PORTS } from "./ports.ts";

test("a test's ports: never one the OS hands a server that asks for any port, never the same twice in a run", () => {
  const given = Array.from({ length: 50 }, () => freePort());
  expect(new Set(given).size).toBe(50);
  for (const port of given) expect(port >= TEST_PORTS.first && port <= TEST_PORTS.last).toBe(true);
  // What the OS hands out for `port: 0` is outside them, so a stand-in started after a port was chosen never takes it.
  for (let i = 0; i < 20; i++) {
    const any = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
    try {
      expect(any.port! < TEST_PORTS.first || any.port! > TEST_PORTS.last).toBe(true);
    } finally {
      any.stop(true);
    }
  }
});

/** The first line a process prints, as a number (within 10 s). */
async function firstNumber(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader();
  let text = "";
  const late = Date.now() + 10_000;
  while (!text.includes("\n") && Date.now() < late) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return Number(text.split("\n")[0]);
}

/** A place in the range for a test of its own to ask from, apart from others' by tens. */
const somewhere = () => TEST_PORTS.first + 10 * Math.floor(Math.random() * ((TEST_PORTS.last - TEST_PORTS.first) / 10));
/** A process asking for a port from `from`, printing it, then living `ms` more. */
const asks = (from: number, ms = 1500) =>
  Bun.spawn([process.execPath, "-e", `const { freePort } = await import(${JSON.stringify(join(import.meta.dir, "ports.ts"))}); console.log(freePort()); await Bun.sleep(${ms});`], {
    env: { ...process.env, INVINCIBLE_TEST_PORTS_FROM: String(from) },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });

test("a port one test process was given is never given to another while the first lives, bound or not yet (two runs on one machine)", async () => {
  // Two processes asking from one place, as two runs on one machine do whose ports have met: the first holds its port
  // unbound a while, as a test does between choosing a node's port and starting it (a pairing, for fabric-door's second).
  const from = somewhere();
  const first = asks(from);
  const one = await firstNumber(first.stdout);
  const second = asks(from);
  const other = await firstNumber(second.stdout);
  await Promise.all([first.exited, second.exited]);
  expect(one).toBe(from);
  expect(other).not.toBe(one);
  // Each held by a file naming its process, let go as that process ended (a script's; `bun test`'s are taken back).
  expect([existsSync(join(HELD, String(one))), existsSync(join(HELD, String(other)))]).toEqual([false, false]);
});

test("a hold is taken back once its process has ended, or once it is older than a test takes to start a server", async () => {
  // One whose process has ended: its port is given again.
  const ended = Bun.spawn([process.execPath, "-e", "0"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  await ended.exited;
  // (Made only where no hold is: never over one another process has.)
  let from = somewhere();
  for (;;) {
    try {
      const fd = openSync(join(HELD, String(from)), "wx");
      writeSync(fd, String(ended.pid));
      closeSync(fd);
      break;
    } catch {
      from = somewhere();
    }
  }
  const again = asks(from, 0);
  expect(await firstNumber(again.stdout)).toBe(from);
  await again.exited;
  // One whose process lives but that is older than HOLD_MS: given again too (by then its server holds the port, or none does).
  const living = asks(somewhere(), 5000);
  const kept = await firstNumber(living.stdout);
  expect(readFileSync(join(HELD, String(kept)), "utf8")).toBe(String(living.pid));
  const then = (Date.now() - HOLD_MS - 60_000) / 1000;
  utimesSync(join(HELD, String(kept)), then, then);
  const taken = asks(kept, 0);
  expect(await firstNumber(taken.stdout)).toBe(kept);
  await taken.exited;
  living.kill();
  await living.exited;
});

test("a port given is held by no server: nothing answers on it until the test starts one there", async () => {
  const port = freePort();
  await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  const server = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("mine") });
  try {
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("mine");
  } finally {
    server.stop(true);
  }
});
