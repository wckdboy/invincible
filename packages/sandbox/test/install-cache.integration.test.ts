import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chownSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { FILLER_UID, fillerArgs, GATE_VM_ENV } from "../src/index.ts";

/*
 * The node's install cache on a real Docker (install-cache.ts): its filler, as the node runs it (fillerArgs), filling a
 * folder of this run's own from the registry over Docker's default bridge, and a round of gates' VM (no network, the gates'
 * user, the cache mounted read-only) installing from it offline. A lockfile that names another source is refused before
 * anything is fetched; one whose hash isn't the registry's tarball's is refused by bun as it downloads, and nothing of it is
 * kept; a package that wasn't filled fails the gate's install, offline. It prints what each fill took.
 *
 * Every container is this run's own (`install-cache-<hex>-`), removed by its own name, and nothing of it listens on the
 * bridge. Linux, Docker, the sandbox image and the registry (registry.npmjs.org) reachable from the bridge. Skipped, and so
 * unverified, anywhere else.
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
  // (Each filler and VM goes as it ends, --rm; one a deadline cut short goes by its own name.)
  for (let n = 1; n <= made; n++) docker(["rm", "-f", `${PREFIX}${n}`]);
  rmSync(dir, { recursive: true, force: true });
});
const named = () => `${PREFIX}${++made}`;
/** The image's PATH, as the node reads it for the filler (imagePath). */
const path = () => JSON.parse(docker(["image", "inspect", "--format", "{{json .Config.Env}}", IMAGE]).stdout).find((e: string) => e.startsWith("PATH="))?.slice(5) ?? "/usr/local/bin:/usr/bin:/bin";
/** A cache folder of this run's, the filler's user's, as the node makes it. */
function cacheFolder(): string {
  const at = join(dir, `cache-${++made}`);
  mkdirSync(at, { mode: 0o755 });
  if (process.getuid?.() === 0) chownSync(at, FILLER_UID, FILLER_UID);
  return at;
}
const user = () => (process.getuid?.() ? `${process.getuid!()}:${process.getgid!()}` : `${FILLER_UID}:${FILLER_UID}`);
/** The manifests as the task's VM gives them: a gzipped tar of `files`. */
function manifests(files: Record<string, string>): Uint8Array {
  const at = mkdtempSync(join(dir, "m-"));
  for (const [file, text] of Object.entries(files)) writeFileSync(join(at, file), text);
  const tar = spawnSync("tar", ["-c", "-C", at, ...Object.keys(files)]);
  return gzipSync(tar.stdout);
}
/** A fill, as the node runs it: its exit, what it said, and how long the whole container took. */
function fill(cache: string, given: Uint8Array) {
  const began = performance.now();
  const ran = docker(fillerArgs({ name: named(), image: IMAGE, cache, user: user(), path: path() }), given);
  return { code: ran.status, said: ran.stderr.trim(), ms: Math.round(performance.now() - began) };
}
/** A lockfile made the honest way, by bun in a scratch container on the bridge, for `deps`. */
function locked(deps: Record<string, string>): { "package.json": string; "bun.lock": string } {
  const manifest = JSON.stringify({ name: "app", private: true, dependencies: deps });
  const ran = docker(["run", "--rm", "--name", named(), "--network", "bridge", "--user", "65534:65534", "--read-only", "--cap-drop", "ALL", "--tmpfs", "/tmp:rw,size=512m,mode=1777", "--entrypoint", "/usr/bin/env", IMAGE, "-i", `PATH=${path()}`, "HOME=/tmp/h", "BUN_INSTALL_CACHE_DIR=/tmp/c", "/bin/bash", "--noprofile", "--norc", "-c", `mkdir -p /tmp/a && cd /tmp/a && printf '%s' '${manifest}' > package.json && bun install --ignore-scripts >/dev/null 2>&1 && cat bun.lock`]);
  if (ran.status !== 0) throw new Error(`no lockfile could be made: ${ran.stderr}`);
  return { "package.json": manifest, "bun.lock": ran.stdout };
}
/** A round of gates' VM, as the node makes one, the cache mounted read-only: `command` run in a copy of `files`, as the gates' user, its environment a gate's. */
function gate(cache: string, files: Record<string, string>, command: string) {
  const script = Object.entries(files).map(([file, text]) => `printf '%s' '${text.replaceAll("'", "'\\''")}' > ${file}`).join("; ");
  const ran = docker(["run", "--rm", "--name", named(), "--init", "--user", "65534:65534", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--read-only", "--network", "none", "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m,mode=1777", "--tmpfs", "/gates:rw,exec,nosuid,nodev,size=1g,uid=65534,gid=65534,mode=0700", "--mount", `type=bind,src=${cache},dst=/cache/bun,readonly`, "--env", `${GATE_VM_ENV}=1`, "--env", "BUN_INSTALL_CACHE_DIR=/cache/bun", "--workdir", "/gates", "--entrypoint", "/usr/bin/env", IMAGE, "-i", `PATH=${path()}`, "HOME=/gates/home", "TMPDIR=/gates/tmp", "BUN_INSTALL_CACHE_DIR=/cache/bun", "/bin/bash", "--noprofile", "--norc", "-c", `mkdir -p /gates/home /gates/tmp /gates/tree && cd /gates/tree && ${script} && ${command}`]);
  return { code: ran.status, out: `${ran.stdout}${ran.stderr}` };
}

describe.skipIf(!available)("the node's install cache, on a real Docker", () => {
  const TEST = `import { expect, test } from "bun:test";\nimport isOdd from "is-odd";\ntest("odd", () => expect(isOdd(3)).toBe(true));\n`;
  let honest: ReturnType<typeof locked>;
  let cache = "";

  test("a lockfile of the registry's packages fills it, as the node's filler runs; the same again finds it there", () => {
    honest = locked({ "is-odd": "3.0.1" });
    cache = cacheFolder();
    const first = fill(cache, manifests(honest));
    expect([first.code, first.said.split("\n").at(-1)]).toEqual([0, expect.stringMatching(/installed|packages|done|Saved/i)]);
    const entries = readdirSync(cache);
    expect(entries.some((e) => e.startsWith("is-odd@3.0.1"))).toBe(true);
    expect(entries.some((e) => e.startsWith("is-number@"))).toBe(true);
    const again = fill(cache, manifests(honest));
    expect(again.code).toBe(0);
    console.log(`the filler, whole: ${first.ms} ms with an empty cache (${entries.length} entries made), ${again.ms} ms again with nothing new`);
  });

  test("a round's VM installs from it offline, as the gates' user, and can write nothing of it", () => {
    const ran = gate(cache, { ...honest, "odd.test.ts": TEST }, "bun install --frozen-lockfile && bun test odd.test.ts && (touch /cache/bun/x 2>&1 || true)");
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

  test("a lockfile that names another source is refused before anything is fetched, and nothing is filled", () => {
    const fresh = cacheFolder();
    const git = { "package.json": JSON.stringify({ name: "app", dependencies: { "is-odd": "github:someone/is-odd" } }), "bun.lock": honest["bun.lock"].replace(/"is-odd@3\.0\.1", "",/, '"is-odd@github:someone/is-odd#abc", {},') };
    const ran = fill(fresh, manifests(git));
    expect([ran.code, ran.said.split("\n").at(-1)]).toEqual([1, expect.stringContaining("isn't the default registry")]);
    expect(readdirSync(fresh)).toEqual([]);
    // Nor anything of the tree's besides: a bunfig.toml naming a registry of its own.
    const configured = fill(fresh, manifests({ ...honest, "bunfig.toml": `[install]\nregistry = "http://192.0.2.1/"\n` }));
    expect([configured.code, configured.said]).toEqual([1, "what it was given holds bunfig.toml, which is no manifest of its, so nothing is filled"]);
    expect(readdirSync(fresh)).toEqual([]);
  });

  test("a lockfile whose hash isn't the registry's tarball's is refused by bun as it downloads, and nothing of it is kept", () => {
    const fresh = cacheFolder();
    const hash = /"is-odd@3\.0\.1", "",[^\n]*?"(sha512-[^"]+)"/.exec(honest["bun.lock"])?.[1];
    expect(hash).toBeDefined();
    const wrong = `sha512-${"A".repeat(86)}==`;
    const ran = fill(fresh, manifests({ ...honest, "bun.lock": honest["bun.lock"].replace(hash!, wrong) }));
    expect(ran.code).not.toBe(0);
    expect(ran.said).toMatch(/[Ii]ntegrity/);
    expect(readdirSync(fresh).some((e) => e.startsWith("is-odd@3.0.1"))).toBe(false);
  });
});
