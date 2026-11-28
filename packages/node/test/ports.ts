import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

/*
 * Ports for a test's servers that no other server is handed. A port taken with `port: 0` and let go, to be used a moment
 * later, can be handed to the next server that asks for any port before the test uses it, and the daemon then fails to
 * start ("Is port … in use?", as CI saw on 17 November 2026). These come from below the range the OS hands out for
 * `port: 0` (Linux 32768–60999, macOS 49152–65535), one after another from a random start, each checked free as it is
 * given, and each held for this process from then until it ends: a port is given to one test process on a machine at a
 * time, whatever its TMPDIR, by a file of its own in HELD (made only where none is). So two test runs on one machine
 * never both take a port between its being chosen and its server starting, which a check that it is free can't
 * promise: two agents' checks on the shared Mac mini (28 November 2026) did, and fabric-link-scopes' second node, whose
 * port waits unbound through a pairing, found it "in use". What the port is used for is the test's: nothing listens on
 * it until its server does, so a port no server is started on is refused, as before. A hold lasts while its process
 * lives and HOLD_MS at most, as long as a test may take to start a server on a port it chose (a file of one that ended
 * is taken back, and `bun test` ends its processes with no exit to let theirs go by).
 */
export const TEST_PORTS = { first: 20_000, last: 31_999 } as const;
// (Where it starts can be given, INVINCIBLE_TEST_PORTS_FROM: ports.test.ts has two processes start at one place.)
const from = Number(process.env.INVINCIBLE_TEST_PORTS_FROM);
let next = Number.isInteger(from) && from >= TEST_PORTS.first && from <= TEST_PORTS.last ? from : TEST_PORTS.first + Math.floor(Math.random() * (TEST_PORTS.last - TEST_PORTS.first + 1));

/** Where each port given to a test process is held while that process lives: one machine's, every user's. */
export const HELD = "/tmp/invincible-test-ports";
/** The longest a port is held: past it, a server's own bind holds it, or nothing does. */
export const HOLD_MS = 10 * 60_000;
/** The ports this process holds, let go as it ends. */
const mine = new Set<number>();
/** False once HELD can't be used here: each port is then only checked free, as it was before. */
let shared = true;
process.on("exit", () => {
  for (const port of mine) {
    try {
      unlinkSync(join(HELD, String(port)));
    } catch {
      /* gone already */
    }
  }
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // (Another user's process is there too, only not ours to signal.)
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** `port` held for this process, unless another living test process holds it. */
function hold(port: number): boolean {
  if (!shared) return true;
  const file = join(HELD, String(port));
  for (let again = 0; again < 2; again++) {
    try {
      const fd = openSync(file, "wx", 0o644);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      mine.add(port);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" && again === 0) {
        try {
          mkdirSync(HELD, { recursive: true });
          chmodSync(HELD, 0o1777);
        } catch {
          /* another made it, or it can't be made: asked again below */
        }
        continue;
      }
      if (code !== "EEXIST") {
        shared = false;
        return true;
      }
      // Another's while its process lives, HOLD_MS at most; else taken back. (The clock is the machine's: a test may stub
      // Date's.)
      let holder = Number.NaN;
      let age = 0;
      try {
        holder = Number(readFileSync(file, "utf8"));
        age = performance.timeOrigin + performance.now() - statSync(file).mtimeMs;
      } catch {
        /* let go as it was read: asked again */
      }
      if (Number.isInteger(holder) && holder > 0 && alive(holder) && age < HOLD_MS) return false;
      try {
        unlinkSync(file);
      } catch {
        /* another took it back first */
      }
    }
  }
  return false;
}

/** This process's hold on `port` let go (it wasn't free after all). */
function letGo(port: number): void {
  if (!mine.delete(port)) return;
  try {
    unlinkSync(join(HELD, String(port)));
  } catch {
    /* gone already */
  }
}

export function freePort(): number {
  for (let tried = 0; tried <= TEST_PORTS.last - TEST_PORTS.first; tried++) {
    const port = next;
    next = next === TEST_PORTS.last ? TEST_PORTS.first : next + 1;
    if (!hold(port)) continue;
    try {
      Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response() }).stop(true);
      return port;
    } catch {
      // Something else on this machine has it: the next one.
      letGo(port);
    }
  }
  throw new Error(`no port free for a test between ${TEST_PORTS.first} and ${TEST_PORTS.last}`);
}

/** A UDP port of the same range that is free now (a sidecar's, in a test), held as freePort's are. */
export async function freeUdpPort(): Promise<number> {
  for (let tried = 0; tried <= TEST_PORTS.last - TEST_PORTS.first; tried++) {
    const port = next;
    next = next === TEST_PORTS.last ? TEST_PORTS.first : next + 1;
    if (!hold(port)) continue;
    try {
      const socket = await Bun.udpSocket({ hostname: "127.0.0.1", port });
      socket.close();
      return port;
    } catch {
      // Taken: the next one.
      letGo(port);
    }
  }
  throw new Error(`no UDP port free for a test between ${TEST_PORTS.first} and ${TEST_PORTS.last}`);
}
