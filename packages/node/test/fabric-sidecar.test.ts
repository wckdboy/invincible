import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { didKeyOfEd25519, fromB64u, signingPublicKey } from "@invincible/core";
import { Sidecar, type SidecarProcess, transportKey } from "../src/fabric/sidecar.ts";

/*
 * The node's sidecar supervisor without a real sidecar (the real one is in fabric.e2e.test.ts): its transport key, and
 * what it says when the sidecar can't start.
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
    const sidecar = new Sidecar({ home: join(dir, "home"), binary: () => binary, listen: () => "127.0.0.1:1", name: "n", log: () => {}, spawn, down: (why) => down.push(why) });
    await sidecar.start();
    expect(sidecar.state).toBe("down");
    expect(sidecar.why).toBe("it stopped before it listened: error: Address already in use (os error 48)");
    // Tried again a second later by itself.
    await Bun.sleep(1_300);
    expect(tries).toBe(2);
    await sidecar.stop();
    expect(down.length).toBeGreaterThanOrEqual(2);
  });

});
