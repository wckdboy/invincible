import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheMount, LOCK_CHECK_PY, runArgs, type SandboxSpec } from "../src/index.ts";

/*
 * The node's install cache for rounds of other nodes' tasks' gates (install-cache.ts). The filler's check of what it is
 * given runs here against folders shaped as its input is: bun.lock and the package.json files it names. What the filler
 * then does with bun, and the round's VM's offline install from the cache, are held on a real Docker
 * (install-cache.integration.test.ts).
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
/** A folder of the filler's input: `files`, by path, and the check's exit and what it said. */
function checked(files: Record<string, string>, link?: [string, string]) {
  const at = realpathSync(mkdtempSync(join(tmpdir(), "install-cache-")));
  dirs.push(at);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(at, path, ".."), { recursive: true });
    writeFileSync(join(at, path), text);
  }
  if (link) symlinkSync(link[1], join(at, link[0]));
  const ran = spawnSync("python3", ["-I", "-c", LOCK_CHECK_PY], { cwd: at, encoding: "utf8" });
  return { code: ran.status, said: ran.stderr.trim() };
}
const lock = (packages: string, workspaces = `"": { "name": "app", "dependencies": { "is-odd": "^3.0.1" } },`) => `{
  "lockfileVersion": 1,
  "workspaces": {
    ${workspaces}
  },
  "packages": {
    ${packages}
  }
}
`;
const REGISTRY = `"is-odd": ["is-odd@3.0.1", "", { "dependencies": { "is-number": "^6.0.0" } }, "sha512-CQpnWPrDwmP1+SMHXZhtLtJv90yiyVfluGsX5iNCVkrhQtU3TQHsUWPG9wkdk9Lgd5yNpAg9jQEo90CBaXgWMA=="],
    "is-number": ["is-number@6.0.0", "", {}, "sha512-Wu1VHeILBK8KAWJUAiSZQX94GmOE45Rg6/538fKwiloUu21KncEkYGPqob2oSZ5mUT73vLGrHQjKw3KMPwfDzg=="],`;
const APP = `{ "name": "app", "dependencies": { "is-odd": "^3.0.1" } }`;

describe("the filler's check of what it is given (LOCK_CHECK_PY)", () => {
  test("a lockfile of the default registry's packages, and a workspace's own, passes, as this repository's own does", () => {
    expect(checked({ "bun.lock": lock(REGISTRY), "package.json": APP })).toEqual({ code: 0, said: "" });
    const own: Record<string, string> = { "bun.lock": readFileSync("bun.lock", "utf8"), "package.json": readFileSync("package.json", "utf8") };
    for (const path of Object.keys(JSON.parse(readFileSync("bun.lock", "utf8").replace(/,(\s*[}\]])/g, "$1")).workspaces as object)) if (path) own[`${path}/package.json`] = readFileSync(`${path}/package.json`, "utf8");
    expect(checked(own)).toEqual({ code: 0, said: "" });
  });

  test("a package from anywhere but the default registry is refused, and nothing is filled: another registry, a git, GitHub, tarball, file or link one", () => {
    for (const entry of [
      `"is-odd": ["is-odd@3.0.1", "https://registry.example.test/", {}, "sha512-x"],`,
      `"is-odd": ["is-odd@git+https://example.test/x.git#abc", {}, "abc"],`,
      `"is-odd": ["is-odd@github:someone/is-odd#abc", {}, "someone-is-odd-abc"],`,
      `"is-odd": ["is-odd@https://example.test/is-odd.tgz", {}],`,
      `"is-odd": ["is-odd@file:../is-odd", {}],`,
      `"is-odd": ["is-odd@link:is-odd", {}],`,
    ]) {
      const ran = checked({ "bun.lock": lock(entry), "package.json": APP });
      expect([entry, ran.code]).toEqual([entry, 1]);
      expect(ran.said).toEndWith("which isn't the default registry's, so nothing is filled");
    }
  });

  test("a package.json that asks for a package from elsewhere is refused, whatever its lockfile says", () => {
    for (const spec of ["github:someone/is-odd", "someone/is-odd", "git+https://example.test/x.git", "https://example.test/x.tgz", "file:../x", "link:x"]) {
      const ran = checked({ "bun.lock": lock(REGISTRY), "package.json": JSON.stringify({ name: "app", devDependencies: { "is-odd": spec } }) });
      expect([spec, ran.code, ran.said]).toEqual([spec, 1, `its package.json asks is-odd from ${spec}, which isn't the default registry, so nothing is filled`]);
    }
    // Overrides too, nested or not.
    expect(checked({ "bun.lock": lock(REGISTRY), "package.json": JSON.stringify({ name: "app", overrides: { "is-number": { x: "github:a/b" } } }) }).code).toBe(1);
    // A version, a range, a tag, an npm: alias, the workspace's own and a catalog's are the registry's.
    expect(checked({ "bun.lock": lock(REGISTRY), "package.json": JSON.stringify({ name: "app", dependencies: { a: "1.2.3", b: "^1.0.0 || >=2.0.0 <3", c: "latest", d: "npm:is-odd@^3.0.1", e: "workspace:*", f: "catalog:" } }) }).code).toBe(0);
  });

  test("what two readers could read two ways is refused: a key twice, a comment, a lockfile that isn't JSON", () => {
    const twice = checked({ "bun.lock": lock(`${REGISTRY}\n    "is-odd": ["is-odd@github:someone/is-odd#abc", {}, "x"],`), "package.json": APP });
    expect(twice).toEqual({ code: 1, said: "its bun.lock names is-odd twice, so nothing is filled" });
    expect(checked({ "bun.lock": `// a comment\n${lock(REGISTRY)}`, "package.json": APP }).said).toStartWith("its bun.lock can't be read:");
    expect(checked({ "bun.lock": "not json", "package.json": APP }).code).toBe(1);
    expect(checked({ "bun.lock": lock(REGISTRY), "package.json": `{ "name": "app", "name": "other" }` }).said).toBe("its package.json names name twice, so nothing is filled");
  });

  test("nothing of the tree but its manifests is taken: a bunfig.toml, an .npmrc, any other file, or a link, is refused", () => {
    for (const extra of ["bunfig.toml", ".npmrc", "sub/bunfig.toml", "notes.txt"]) {
      const ran = checked({ "bun.lock": lock(REGISTRY), "package.json": APP, [extra]: `registry = "http://192.0.2.1/"\n` });
      expect([extra, ran.code, ran.said]).toEqual([extra, 1, `what it was given holds ${extra}, which is no manifest of its, so nothing is filled`]);
    }
    expect(checked({ "bun.lock": lock(REGISTRY), "package.json": APP }, ["linked", "package.json"]).said).toBe("what it was given holds linked, which is no manifest of its, so nothing is filled");
  });

  test("a workspace whose package.json it wasn't given, one out of the tree, or a patch, is refused", () => {
    const two = `"": { "name": "app" },\n    "packages/lib": { "name": "lib" },`;
    expect(checked({ "bun.lock": lock(REGISTRY, two), "package.json": APP }).said).toBe("its bun.lock names a workspace, packages/lib, whose package.json it wasn't given, so nothing is filled");
    expect(checked({ "bun.lock": lock(REGISTRY, two), "package.json": APP, "packages/lib/package.json": `{ "name": "lib" }` }).code).toBe(0);
    expect(checked({ "bun.lock": lock(REGISTRY, `"": { "name": "app" },\n    "../out": { "name": "out" },`), "package.json": APP }).said).toBe("its bun.lock names a workspace out of its tree, ../out, so nothing is filled");
    expect(checked({ "bun.lock": lock(REGISTRY).replace('"lockfileVersion": 1,', '"lockfileVersion": 1, "patchedDependencies": { "is-odd@3.0.1": "patches/x.patch" },'), "package.json": APP }).said).toBe("its bun.lock patches packages, which a fill can't, so nothing is filled");
  });
});

describe("a round of gates' VM and the cache", () => {
  const base: SandboxSpec = { id: "0123456789", run: "handed.task-abcdefghijkl", node: "node-1", image: "invincible/sandbox:1", network: "isolated", cpus: 1, memoryGb: 1, pidsLimit: 1024, ttlMinutes: 60, ephemeral: true, providers: [], createdAt: 0, env: {}, isolation: "vm" };
  const flags = (args: string[], flag: string) => args.filter((_, i) => args[i - 1] === flag);
  test("is mounted read-only into a round's VM alone, with bun told where it is; never into another VM", () => {
    const gate = runArgs({ ...base, task: "task-abcdefghijkl", gate: true, cache: "/var/lib/node/cache/bun" });
    expect(flags(gate, "--mount")).toContain("type=bind,src=/var/lib/node/cache/bun,dst=/cache/bun,readonly");
    expect(cacheMount("/x")).toEqual(["--mount", "type=bind,src=/x,dst=/cache/bun,readonly"]);
    expect(flags(gate, "--env")).toContain("BUN_INSTALL_CACHE_DIR=/cache/bun");
    for (const args of [runArgs({ ...base, task: "task-abcdefghijkl", cache: "/var/lib/node/cache/bun" }), runArgs({ ...base, cache: "/var/lib/node/cache/bun" }), runArgs({ ...base, task: "task-abcdefghijkl", gate: true })]) {
      expect(flags(args, "--mount").some((m) => m.includes("/cache/bun"))).toBe(false);
      expect(flags(args, "--env").some((e) => e.startsWith("BUN_INSTALL_CACHE_DIR="))).toBe(false);
    }
  });
});
