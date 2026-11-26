import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { didKeyOfEd25519, fromB64u, qampEndpointOf, signingPublicKey } from "@invincible/core";
import { probeSidecar, Sidecar, sidecarListen, type SidecarProcess } from "../src/fabric/sidecar.ts";
import { Home, type Secrets, transportKeyOf } from "../src/home.ts";
import { unspecified } from "../src/qamp-grants.ts";

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

/** A key for a sidecar no node runs (a stand-in's), from a fresh seed. */
const someKey = async () => transportKeyOf(randomBytes(32), "n_test");

/** The OS keychain, stood in for: no test touches the real one. */
function keychain(): Secrets & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    get: async ({ service, name }) => items.get(`${service}/${name}`) ?? null,
    set: async ({ service, name, value }) => void items.set(`${service}/${name}`, value),
    delete: async ({ service, name }) => items.delete(`${service}/${name}`),
  };
}

const NODE = `n_${"A".repeat(43)}`;
const OTHER = `n_${"B".repeat(43)}`;

describe("the node's transport key", () => {
  test("kept where its device keys are: a 0600 file with no OS keychain, read back as the same key, its text Q-AMP's own", async () => {
    const home = new Home(temp());
    const made = await home.transportKey("file", NODE);
    expect(made.did).toMatch(/^did:key:z6Mk/);
    expect(made.text).toStartWith("qamp-sk1.");
    expect(didKeyOfEd25519(signingPublicKey(fromB64u(made.text.trim().slice("qamp-sk1.".length))))).toBe(made.did);
    expect(statSync(home.transportKeyPath).mode & 0o777).toBe(0o600);
    expect(await home.transportKey("file", NODE)).toEqual(made);
    // Its proof that it is this node's, as every node checks it in its profile.
    expect(qampEndpointOf({ qamp: { did: made.did, address: `qamp://${made.did}@192.0.2.10:7410`, pop: made.pop } }, NODE)).not.toBeNull();
  });

  test("with an OS keychain, in the keychain alone: no file of it in the home", async () => {
    const secrets = keychain();
    const dir = temp();
    const home = new Home(dir, secrets);
    const made = await home.transportKey("os", NODE);
    expect([...secrets.items.keys()]).toEqual([`dev.invincible.node/${dir}#qamp`]);
    expect(existsSync(home.transportKeyPath)).toBe(false);
    expect(await home.transportKey("os", NODE)).toEqual(made);
  });

  test("a home enrolled again as another node gets a key of its own; a rotation makes a new one; the file from before the keystore goes", async () => {
    const dir = temp();
    mkdirSync(join(dir, "qamp"), { recursive: true });
    writeFileSync(join(dir, "qamp", "node.qamp-key"), "qamp-sk1.OLDKEYFROMBEFORETHEKEYSTOREFORTESTS\n", { mode: 0o600 });
    const home = new Home(dir);
    const first = await home.transportKey("file", NODE);
    expect(existsSync(join(dir, "qamp", "node.qamp-key"))).toBe(false);
    const other = await home.transportKey("file", OTHER);
    expect(other.did).not.toBe(first.did);
    const rotated = await home.rotateTransportKey("file", OTHER);
    expect(rotated.did).not.toBe(other.did);
    expect(await home.transportKey("file", OTHER)).toEqual(rotated);
  });

  test("its sidecar is given it on stdin (--key /dev/stdin), never a path to a file", async () => {
    const dir = temp();
    const binary = join(dir, "qamp");
    writeFileSync(binary, "#!/bin/sh\nexit 0\n");
    chmodSync(binary, 0o755);
    const key = await someKey();
    const seen: { args: string[]; key: string }[] = [];
    const spawn = (_b: string, args: string[], _env: Record<string, string>, _line: (text: string) => void, given: string): SidecarProcess => {
      seen.push({ args, key: given });
      return { ready: Promise.resolve(null), exited: Promise.resolve(1), kill() {} };
    };
    const sidecar = new Sidecar({ home: join(dir, "home"), key: async () => key, binary: () => binary, listen: () => null, name: "n", log: () => {}, spawn, probe: () => ({ sidecar: true, version: "0.2.0" }) });
    await sidecar.start();
    await sidecar.stop();
    expect(seen[0]!.args.slice(0, 3)).toEqual(["sidecar", "--key", "/dev/stdin"]);
    expect(seen[0]!.key).toBe(key.text);
    expect(sidecar.did).toBe(key.did);
    expect(sidecar.pop).toBe(key.pop);
  });

  test("a real process reads it from its stdin to its end", async () => {
    const dir = temp();
    const out = join(dir, "read.txt");
    const binary = join(dir, "qamp");
    // A stand-in that copies whatever its --key names into a file of the test's, then ends.
    writeFileSync(binary, `#!/bin/sh\nif [ "$1" = "sidecar" ] && [ "$2" = "--key" ]; then cat "$3" > ${JSON.stringify(out)}; fi\nexit 0\n`);
    chmodSync(binary, 0o755);
    const key = await someKey();
    const sidecar = new Sidecar({ home: join(dir, "home"), key: async () => key, binary: () => binary, listen: () => null, name: "n", log: () => {}, probe: () => ({ sidecar: true, version: "0.2.0" }) });
    await sidecar.start();
    await sidecar.stop();
    expect(readFileSync(out, "utf8")).toBe(key.text);
  });
});

describe("a binary from before the sidecar", () => {
  test("is asked, and the node says so instead of starting a sidecar that can't start", async () => {
    const dir = temp();
    const binary = qamp010(dir);
    expect(probeSidecar(binary)).toEqual({ sidecar: false, version: "0.1.0" });
    let spawned = 0;
    const sidecar = new Sidecar({ home: join(dir, "home"), key: someKey, binary: () => binary, listen: () => null, name: "n", log: () => {}, spawn: () => (spawned++, null as never) });
    await sidecar.start();
    await sidecar.stop();
    expect(spawned).toBe(0);
    expect(sidecar.why).toBe("stopped");
  });

  test("its state says why while it is off", async () => {
    const dir = temp();
    const binary = qamp010(dir);
    const sidecar = new Sidecar({ home: join(dir, "home"), key: someKey, binary: () => binary, listen: () => null, name: "n", log: () => {} });
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
    const sidecar = new Sidecar({ home: join(dir, "home"), key: someKey, binary: () => binary, listen: () => "127.0.0.1:1", name: "n", log: () => {}, spawn, probe: () => ({ sidecar: true, version: "0.2.0" }), down: (why) => down.push(why) });
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
    const sidecar = new Sidecar({ home: join(dir, "home"), key: someKey, binary: () => binary, listen: () => null, name: "n", log: () => {}, socket: `/tmp/${"x".repeat(120)}/qamp.sock`, probe: () => ({ sidecar: true, version: "0.2.0" }) });
    await sidecar.start();
    expect(sidecar.why).toMatch(/too long for a Unix socket/);
    await sidecar.stop();
  });
});

describe("where the sidecar listens", () => {
  test("on the node's own address and port, an IPv6 one in brackets", () => {
    expect(sidecarListen("192.0.2.10", 7410, unspecified)).toBe("192.0.2.10:7410");
    expect(sidecarListen("fd7a:115c:a1e0::1", 7410, unspecified)).toBe("[fd7a:115c:a1e0::1]:7410");
    expect(sidecarListen("[fd7a:115c:a1e0::1]", 7410, unspecified)).toBe("[fd7a:115c:a1e0::1]:7410");
    expect(sidecarListen("127.0.0.1", 47410, unspecified)).toBe("127.0.0.1:47410");
  });

  test("never every interface, however it is written: then it only dials out", () => {
    for (const any of ["0.0.0.0", "0", "::", "[::]", "::0", "0:0::0", "::ffff:0.0.0.0", ""]) expect([any, sidecarListen(any, 7410, unspecified)]).toEqual([any, null]);
  });
});
