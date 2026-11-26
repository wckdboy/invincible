import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { didKeyOfEd25519, fromB64u, signingPublicKey } from "@invincible/core";
import { probeSidecar, Sidecar, type SidecarProcess, transportKey } from "../src/fabric/sidecar.ts";

/*
 * The node's sidecar supervisor without a real sidecar (the real one is in fabric.e2e.test.ts): its transport key, a
 * binary from before the sidecar, and what it says when the sidecar can't start.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const temp = () => {
  const r = mkdtempSync(join(tmpdir(), "q5s-"));
  roots.push(r);
  return r;
};

/** A stand-in for Q-AMP 0.1.0's CLI: a version, and no sidecar subcommand (clap's exit 2). */
function qamp010(dir: string): string {
  const path = join(dir, "qamp");
  writeFileSync(path, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "qamp 0.1.0"; exit 0; fi\necho "error: unrecognized subcommand \'$1\'" >&2\nexit 2\n');
  chmodSync(path, 0o755);
  return path;
}

describe("the node's transport key", () => {
  test("made once, 0600, a Q-AMP Ed25519 key of its own; read back as the same DID", () => {
    const home = temp();
    const made = transportKey(home);
    expect(made.made).toBe(true);
    expect(made.did).toMatch(/^did:key:z6Mk/);
    expect(statSync(made.path).mode & 0o777).toBe(0o600);
    const text = readFileSync(made.path, "utf8").trim();
    expect(text).toStartWith("qamp-sk1.");
    expect(didKeyOfEd25519(signingPublicKey(fromB64u(text.slice("qamp-sk1.".length))))).toBe(made.did);
    const again = transportKey(home);
    expect(again).toEqual({ ...made, made: false });
  });

  test("a key file others can read is made the node's alone again; one that isn't a key is refused", () => {
    const home = temp();
    const { path } = transportKey(home);
    chmodSync(path, 0o644);
    transportKey(home);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    writeFileSync(path, "qamp-sk1-p256.AAAA\n");
    expect(() => transportKey(home)).toThrow(/isn't a Q-AMP key/);
  });
});

describe("a binary from before the sidecar", () => {
  test("is asked, and the node says so instead of starting a sidecar that can't start", async () => {
    const dir = temp();
    const binary = qamp010(dir);
    expect(probeSidecar(binary)).toEqual({ sidecar: false, version: "0.1.0" });
    let spawned = 0;
    const sidecar = new Sidecar({ home: join(dir, "home"), binary: () => binary, listen: () => null, name: "n", log: () => {}, spawn: () => (spawned++, null as never) });
    await sidecar.start();
    await sidecar.stop();
    expect(spawned).toBe(0);
    expect(sidecar.why).toBe("stopped");
  });

  test("its state says why while it is off", async () => {
    const dir = temp();
    const binary = qamp010(dir);
    const sidecar = new Sidecar({ home: join(dir, "home"), binary: () => binary, listen: () => null, name: "n", log: () => {} });
    await sidecar.start();
    expect(sidecar.state).toBe("off");
    expect(sidecar.why).toMatch(/^the qamp here \(0\.1\.0\) has no sidecar: Q-AMP's release with one goes to <home>\/bin\/qamp/);
    await sidecar.stop();
  });
});

describe("a sidecar that won't start", () => {
  test("one that ends before it listens is down, says its last words, and is tried again", async () => {
    const dir = temp();
    const binary = join(dir, "qamp");
    writeFileSync(binary, "#!/bin/sh\nexit 0\n");
    chmodSync(binary, 0o755);
    let tries = 0;
    const spawn = (_b: string, _args: string[], _env: Record<string, string>, line: (text: string) => void): SidecarProcess => {
      tries++;
      line("error: Address already in use (os error 48)");
      return { ready: Promise.resolve(null), exited: Promise.resolve(1), kill() {} };
    };
    const down: string[] = [];
    const sidecar = new Sidecar({ home: join(dir, "home"), binary: () => binary, listen: () => "127.0.0.1:1", name: "n", log: () => {}, spawn, probe: () => ({ sidecar: true, version: "0.2.0" }), down: (why) => down.push(why) });
    await sidecar.start();
    expect(sidecar.state).toBe("down");
    expect(sidecar.why).toBe("it stopped before it listened: error: Address already in use (os error 48)");
    // Tried again a second later by itself.
    await Bun.sleep(1_300);
    expect(tries).toBe(2);
    await sidecar.stop();
    expect(down.length).toBeGreaterThanOrEqual(2);
  });

  test("a socket path too long for a Unix socket is said, never tried", async () => {
    const dir = temp();
    const binary = qamp010(dir);
    const sidecar = new Sidecar({ home: join(dir, "home"), binary: () => binary, listen: () => null, name: "n", log: () => {}, socket: `/tmp/${"x".repeat(120)}/qamp.sock`, probe: () => ({ sidecar: true, version: "0.2.0" }) });
    await sidecar.start();
    expect(sidecar.why).toMatch(/too long for a Unix socket/);
    await sidecar.stop();
  });
});
