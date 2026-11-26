import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { within } from "../src/fabric/socket.ts";

/*
 * Nothing of the fabric's waits outlives what it waited for: a call over Q-AMP that has its answer, or a sidecar's start
 * that has failed, leaves no timer behind. Each is run in a process of its own, which must end as soon as its work is
 * done: a timer left pending (a forwarded call waits up to 75 minutes) would hold it open, as it held the daemon's memory.
 */

const SRC = join(import.meta.dir, "..", "src", "fabric");
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** Runs `body` as a script of its own and says how long its process lived (null: still alive after `limitMs`, then killed). */
async function lifetime(body: string, limitMs = 5_000): Promise<number | null> {
  const dir = mkdtempSync(join(tmpdir(), "q5t-"));
  roots.push(dir);
  const file = join(dir, "script.ts");
  writeFileSync(file, body);
  const started = performance.now();
  const proc = Bun.spawn([process.execPath, file], { stdout: "ignore", stderr: "pipe", env: { ...process.env, INVINCIBLE_KEYSTORE: "file" } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ended = await Promise.race([proc.exited.then(() => true), new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), limitMs)))]);
  clearTimeout(timer);
  if (!ended) {
    proc.kill("SIGKILL");
    return null;
  }
  if (proc.exitCode !== 0) throw new Error(`the script failed: ${await new Response(proc.stderr).text()}`);
  return performance.now() - started;
}

describe("the fabric's waits end with what they waited for", () => {
  test("a call over Q-AMP that has its answer leaves no timer behind (a forwarded route's waits 75 minutes)", async () => {
    const ms = await lifetime(`
      import { Fabric } from ${JSON.stringify(join(SRC, "service.ts"))};
      import { didKeyOfEd25519, signingPublicKey } from ${JSON.stringify(join(import.meta.dir, "..", "..", "core", "src", "index.ts"))};
      const did = didKeyOfEd25519(signingPublicKey(new Uint8Array(32).fill(3)));
      const peer = { id: "n_peer", name: "beta", kind: "node", role: "full", box: null, scopes: [], enrolledBy: "n_a", enrolledHlc: "0", revokedHlc: null,
        profile: { endpoint: "http://192.0.2.10:1", caps: { qamp: { did, address: "qamp://" + did + "@192.0.2.10:7410" } } } };
      const empty = { [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined, done: true }) }) };
      const client = { open: true, call: () => ({ id: 1, chunks: empty, result: Promise.resolve({ status: 200, body: {} }), send() {}, end() {}, cancel() {} }) };
      const sidecar = { client, did: "did:key:z6Mkself", address: null, state: "up", why: null };
      const store = { onApplied: () => () => {}, devices: () => [peer], activeDevice: () => peer };
      const fabric = new Fabric({ store, identity: { id: "n_self" }, sidecar, log: () => {}, presence: async () => ({}) });
      const answer = await fabric.forward(peer, "/api/sandboxes", {}, 75 * 60_000);
      if (answer?.status !== 200) throw new Error("no answer");
      fabric.close();
    `);
    expect(ms).not.toBeNull();
    expect(ms!).toBeLessThan(5_000);
  });

  test("a sidecar's start that failed leaves no timer behind (it waits 20 s for an address)", async () => {
    const ms = await lifetime(`
      import { Sidecar } from ${JSON.stringify(join(SRC, "sidecar.ts"))};
      import { mkdtempSync } from "node:fs";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      const home = mkdtempSync(join(tmpdir(), "q5t-home-"));
      const sidecar = new Sidecar({ home, binary: () => process.execPath, listen: () => null, name: "n", log: () => {},
        probe: () => ({ sidecar: true, version: "0.2.0" }),
        spawn: () => ({ ready: Promise.resolve(null), exited: Promise.resolve(1), kill() {} }) });
      await sidecar.start();
      if (sidecar.state !== "down") throw new Error("it should be down: " + sidecar.state);
      await sidecar.stop();
    `);
    expect(ms).not.toBeNull();
    expect(ms!).toBeLessThan(5_000);
  });
});

describe("within: a wait with an end", () => {
  test("the work's answer when it comes first; what `late` says when the time runs out first, value or error", async () => {
    expect(await within(Promise.resolve("first"), 1_000, () => "late")).toBe("first");
    expect(await within(new Promise(() => {}), 20, () => "late")).toBe("late");
    await expect(within(new Promise(() => {}), 20, () => Promise.reject(new Error("no answer in 20 ms")))).rejects.toThrow("no answer in 20 ms");
    await expect(within(Promise.reject(new Error("refused")), 1_000, () => "late")).rejects.toThrow("refused");
  });
});
