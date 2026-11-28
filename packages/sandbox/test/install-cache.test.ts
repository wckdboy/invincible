import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheMount, FILL_CHECK_PY, fillerArgs, LOCK_CHECK_PY, runArgs, type SandboxSpec } from "../src/index.ts";

/*
 * The node's install cache for rounds of other nodes' tasks' gates (install-cache.ts). The filler's check of what it is
 * given runs here against folders shaped as its input is (a tree's bun.lock alone), and so does what it writes from it:
 * the fill's own manifest, and its check of the lockfile bun resolves that manifest to. What the filler then does with
 * bun, its way out through the node's proxy, and the round's VM's offline install from the cache, are held on a real
 * Docker (install-cache.integration.test.ts).
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
  const at = realpathSync(mkdtempSync(join(tmpdir(), "install-cache-")));
  dirs.push(at);
  return at;
};
/**
 * A folder of the filler's input: `files`, by path, and the check's exit, what it said, and what it wrote: the fill's own
 * manifest, and the hashes it asks for.
 */
function checked(files: Record<string, string>, link?: [string, string]) {
  const at = temp();
  const given = join(at, "m");
  mkdirSync(given);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(given, path, ".."), { recursive: true });
    writeFileSync(join(given, path), text);
  }
  if (link) symlinkSync(link[1], join(given, link[0]));
  const ran = spawnSync("python3", ["-I", "-c", LOCK_CHECK_PY, join(at, "fill"), join(at, "hashes.json")], { cwd: given, encoding: "utf8" });
  const read = (path: string) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null);
  return { code: ran.status, said: ran.stderr.trim(), manifest: read(join(at, "fill", "package.json")), hashes: read(join(at, "hashes.json")) as Record<string, string> | null };
}
const lock = (packages: string, workspaces = `"": { "name": "app", "dependencies": { "is-odd": "^3.0.1" } },`, more = "") => `{
  "lockfileVersion": 1,${more}
  "workspaces": {
    ${workspaces}
  },
  "packages": {
    ${packages}
  }
}
`;
const ODD = "sha512-CQpnWPrDwmP1+SMHXZhtLtJv90yiyVfluGsX5iNCVkrhQtU3TQHsUWPG9wkdk9Lgd5yNpAg9jQEo90CBaXgWMA==";
const NUMBER = "sha512-Wu1VHeILBK8KAWJUAiSZQX94GmOE45Rg6/538fKwiloUu21KncEkYGPqob2oSZ5mUT73vLGrHQjKw3KMPwfDzg==";
const REGISTRY = `"is-odd": ["is-odd@3.0.1", "", { "dependencies": { "is-number": "^6.0.0" } }, "${ODD}"],
    "is-number": ["is-number@6.0.0", "", {}, "${NUMBER}"],`;
const refusedFor = (said: string) => `${said}, so nothing is filled`;

describe("the filler's check of what it is given (LOCK_CHECK_PY), and the manifest it writes from it", () => {
  test("a lockfile of the default registry's packages, and a workspace's own, passes; the fill's own manifest asks for each of them by name and version, and for nothing else", () => {
    const ran = checked({ "bun.lock": lock(REGISTRY) });
    expect([ran.code, ran.said]).toEqual([0, ""]);
    expect(ran.manifest).toEqual({ name: "fill", private: true, optionalDependencies: { p0: "npm:is-number@6.0.0", p1: "npm:is-odd@3.0.1" } });
    expect(ran.hashes).toEqual({ "is-number@6.0.0": NUMBER, "is-odd@3.0.1": ODD });
    // This repository's own: each of the registry's packages it names once, whatever its workspaces ask.
    const own = checked({ "bun.lock": readFileSync("bun.lock", "utf8") });
    expect([own.code, own.said]).toEqual([0, ""]);
    const asked = Object.values(own.manifest.optionalDependencies as Record<string, string>);
    expect(asked.length).toBeGreaterThan(50);
    for (const spec of asked) expect(spec).toMatch(/^npm:(@[a-z0-9._~-]+\/)?[a-z0-9._~-]+@\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
    expect(asked.some((spec) => spec.includes("workspace:"))).toBe(false);
    expect(Object.keys(own.manifest).sort()).toEqual(["name", "optionalDependencies", "private"]);
    // Nothing of the registry's: nothing written, nothing to fill.
    const none = checked({ "bun.lock": lock(`"lib": ["lib@workspace:packages/lib"],`) });
    expect([none.code, none.manifest, none.hashes]).toEqual([0, null, null]);
  });

  test("a package from anywhere but the default registry is refused, and nothing is filled: another registry, a git, GitHub, tarball, file or link one", () => {
    for (const entry of [
      `"is-odd": ["is-odd@3.0.1", "https://registry.example.test/", {}, "${ODD}"],`,
      `"is-odd": ["is-odd@git+https://example.test/x.git#abc", {}, "abc"],`,
      `"is-odd": ["is-odd@github:someone/is-odd#abc", {}, "someone-is-odd-abc"],`,
      `"is-odd": ["is-odd@https://example.test/is-odd.tgz", {}],`,
      `"is-odd": ["is-odd@file:../is-odd", {}],`,
      `"is-odd": ["is-odd@link:is-odd", {}],`,
      `"is-odd": ["is-odd@root:", {}],`,
      `"is-odd": ["is-odd@3.0.1", "", {}, "${ODD}", "more"],`,
    ]) {
      const ran = checked({ "bun.lock": lock(entry) });
      expect([entry, ran.code, ran.manifest]).toEqual([entry, 1, null]);
      expect(ran.said).toEndWith("which isn't the default registry's, so nothing is filled");
    }
  });

  test("every package of the registry's has a sha512 hash, one alone (the twelfth review's R12-2)", () => {
    for (const hash of ["", "sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk=", "sha512-short==", `sha512-${"A".repeat(86)}`, `sha256-${"A".repeat(43)}=`]) {
      const ran = checked({ "bun.lock": lock(`"is-odd": ["is-odd@3.0.1", "", {}, "${hash}"],`) });
      expect([hash, ran.code, ran.said]).toEqual([hash, 1, refusedFor("its bun.lock has no sha512 hash of is-odd@3.0.1")]);
    }
    const two = checked({ "bun.lock": lock(`"is-odd": ["is-odd@3.0.1", "", {}, "${ODD}"],\n    "a/is-odd": ["is-odd@3.0.1", "", {}, "${NUMBER}"],`) });
    expect([two.code, two.said]).toEqual([1, refusedFor("its bun.lock has two hashes of is-odd@3.0.1")]);
    // The same package twice, by one hash, is asked for once.
    const twice = checked({ "bun.lock": lock(`"is-odd": ["is-odd@3.0.1", "", {}, "${ODD}"],\n    "a/is-odd": ["is-odd@3.0.1", "", {}, "${ODD}"],`) });
    expect([twice.code, twice.manifest?.optionalDependencies]).toEqual([0, { p0: "npm:is-odd@3.0.1" }]);
  });

  test("what isn't an npm name, or an exact version, is refused: a name out of its folder, a URL in a name, a range for a version", () => {
    for (const [ident, said] of [
      ["evil/-/evil-1.0.0.tgz?/../../../lodash@4.17.21", "which is no package's name"],
      ["../x@1.0.0", "which is no package's name"],
      [".hidden@1.0.0", "which is no package's name"],
      ["@scope/a/b@1.0.0", "which is no package's name"],
      ["a b@1.0.0", "which is no package's name"],
      ["is-odd", "which is no package's name"],
      ["is-odd@^3.0.1", "which isn't the default registry's"],
      ["is-odd@3.0", "which isn't the default registry's"],
      ["is-odd@latest", "which isn't the default registry's"],
    ] as const) {
      const ran = checked({ "bun.lock": lock(`"x": ["${ident}", "", {}, "${ODD}"],`) });
      expect([ident, ran.code, ran.said]).toEqual([ident, 1, refusedFor(`its bun.lock names ${ident}, ${said}`)]);
    }
    // A scoped name, a prerelease and a build are the registry's.
    expect(checked({ "bun.lock": lock(`"@a/b": ["@a/b@1.0.0-rc.1+build.5", "", {}, "${ODD}"],`) }).code).toBe(0);
  });

  /*
   * The twelfth review's R12-2: bun fetched what a catalog named (t1a, t1b, t3, t4, t9), whatever the lockfile's packages
   * said, and what a lockfile's overrides named (t5). Now the filler is given the lockfile alone, never a package.json,
   * and asks for each of its packages by name and version: a catalog or an override of a manifest never reaches bun. The
   * lockfile's own catalogs, overrides and workspaces are checked as strictly as a dependency all the same.
   */
  test("R12-2: a catalog or an override that names anything but the registry's is refused; one in a manifest never reaches bun, which asks for the lockfile's packages alone", () => {
    const evil = `"is-odd": ["is-odd@3.0.1", "", {}, "${ODD}"],`;
    const root = (deps: string) => `"": { "name": "root", "dependencies": { ${deps} } },`;
    for (const [what, more, deps, said] of [
      ["t1a: the lockfile's catalog, a tarball", `\n  "catalog": { "is-odd": "http://192.0.2.7:47124/evil.tgz" },`, `"is-odd": "catalog:"`, `its bun.lock's catalog asks is-odd from "http://192.0.2.7:47124/evil.tgz", which isn't the default registry`],
      ["t3: a named catalog, a tarball", `\n  "catalogs": { "x": { "is-odd": "http://192.0.2.7:47124/named.tgz" } },`, `"is-odd": "catalog:x"`, `its bun.lock's catalog x asks is-odd from "http://192.0.2.7:47124/named.tgz", which isn't the default registry`],
      ["t4: a catalog's git", `\n  "catalog": { "is-odd": "git+http://192.0.2.7:47124/evil.git" },`, `"is-odd": "catalog:"`, `its bun.lock's catalog asks is-odd from "git+http://192.0.2.7:47124/evil.git", which isn't the default registry`],
      ["t9: a catalog's git file", `\n  "catalog": { "is-odd": "git+file:///srv/example/inner.git" },`, `"is-odd": "catalog:"`, `its bun.lock's catalog asks is-odd from "git+file:///srv/example/inner.git", which isn't the default registry`],
      ["t5: the lockfile's overrides", `\n  "overrides": { "is-odd": "http://192.0.2.7:47124/ovr.tgz" },`, `"is-odd": "3.0.1"`, `its bun.lock's overrides asks is-odd from "http://192.0.2.7:47124/ovr.tgz", which isn't the default registry`],
      ["a workspace's own dependency", "", `"is-odd": "github:someone/is-odd"`, `its bun.lock's workspace of its own's dependencies asks is-odd from "github:someone/is-odd", which isn't the default registry`],
      ["a catalog's catalog", `\n  "catalog": { "is-odd": "catalog:" },`, `"is-odd": "catalog:"`, `its bun.lock's catalog asks is-odd from "catalog:", which isn't the default registry`],
    ] as const) {
      const ran = checked({ "bun.lock": lock(evil, root(deps), more) });
      expect([what, ran.code, ran.said, ran.manifest]).toEqual([what, 1, refusedFor(said), null]);
    }
    // t1b, t3, t4, t9 as the review gave them: the lockfile's catalogs the registry's, a manifest's not. The filler is given
    // no manifest, so refuses one given it; and from the lockfile alone it asks for the registry's is-odd@3.0.1, and nothing
    // a manifest names.
    const manifest = JSON.stringify({ name: "root", workspaces: { packages: [], catalog: { "is-odd": "http://192.0.2.7:47124/evil.tgz" }, catalogs: { x: { "is-odd": "git+http://192.0.2.7:47124/evil.git" } } }, catalog: { "is-odd": "http://192.0.2.7:47124/top.tgz" }, dependencies: { "is-odd": "catalog:" } });
    const caught = lock(evil, root(`"is-odd": "catalog:"`), `\n  "catalog": { "is-odd": "3.0.1" },\n  "catalogs": { "x": { "is-odd": "^3.0.0" } },`);
    expect(checked({ "bun.lock": caught, "package.json": manifest }).said).toBe(refusedFor("what it was given holds package.json, and a fill is given its bun.lock alone"));
    const alone = checked({ "bun.lock": caught });
    expect([alone.code, alone.said, alone.manifest]).toEqual([0, "", { name: "fill", private: true, optionalDependencies: { p0: "npm:is-odd@3.0.1" } }]);
  });

  test("a field that isn't a table of npm names is refused, though bun never reads it here", () => {
    for (const [more, said] of [
      [`\n  "catalog": ["is-odd"],`, "its bun.lock's catalog is no table of packages"],
      [`\n  "catalog": "http://192.0.2.7/",`, "its bun.lock's catalog is no table of packages"],
      [`\n  "catalogs": { "x": "http://192.0.2.7/" },`, "its bun.lock's catalog x is no table of packages"],
      [`\n  "catalogs": [],`, "its bun.lock's catalogs are no table"],
      [`\n  "catalogs": { "x/../y": {} },`, "its bun.lock names a catalog x/../y, which is no catalog's name"],
      [`\n  "overrides": "x",`, "its bun.lock's overrides is no table of packages"],
      [`\n  "overrides": { "is-odd": { "is-number": "1.0.0" } },`, `its bun.lock's overrides asks is-odd from {"is-number": "1.0.0"}, which isn't the default registry`],
      [`\n  "catalog": { "../x": "1.0.0" },`, "its bun.lock's catalog names ../x, which is no package's name"],
    ] as const) {
      const ran = checked({ "bun.lock": lock(REGISTRY, undefined, more) });
      expect([more, ran.code, ran.said]).toEqual([more, 1, refusedFor(said)]);
    }
    expect(checked({ "bun.lock": lock(REGISTRY, `"": { "name": "app", "dependencies": "is-odd" },`) }).said).toBe(refusedFor("its bun.lock's workspace of its own's dependencies is no table of packages"));
    expect(checked({ "bun.lock": lock(REGISTRY, `"": "app",`) }).said).toBe(refusedFor("its bun.lock's workspace of its own is no table"));
    expect(checked({ "bun.lock": `{ "lockfileVersion": 1, "workspaces": [], "packages": {} }` }).said).toBe(refusedFor("its bun.lock's workspaces are no table"));
    expect(checked({ "bun.lock": `{ "lockfileVersion": 1, "packages": [] }` }).said).toBe(refusedFor("its bun.lock's packages are no table"));
    // A version, a range, a tag, an npm: alias, the workspace's own and a catalog's are the registry's, for a dependency.
    const asks = `"": { "name": "app", "dependencies": { "a": "1.2.3", "b": "^1.0.0 || >=2.0.0 <3", "c": "latest", "d": "npm:is-odd@^3.0.1", "e": "workspace:*", "f": "catalog:", "g": "catalog:x" } },`;
    expect(checked({ "bun.lock": lock(REGISTRY, asks, `\n  "catalogs": { "x": { "g": "^1.0.0" } },`) }).code).toBe(0);
  });

  test("what two readers could read two ways is refused: a key twice, a comment, a lockfile that isn't JSON", () => {
    const twice = checked({ "bun.lock": lock(`${REGISTRY}\n    "is-odd": ["is-odd@github:someone/is-odd#abc", {}, "x"],`) });
    expect(twice).toMatchObject({ code: 1, said: "its bun.lock names is-odd twice, so nothing is filled" });
    expect(checked({ "bun.lock": `// a comment\n${lock(REGISTRY)}` }).said).toStartWith("its bun.lock can't be read:");
    expect(checked({ "bun.lock": "not json" }).code).toBe(1);
    expect(checked({ "bun.lock": lock(REGISTRY, undefined, `\n  "catalog": { "is-odd": "3.0.1", "is-odd": "http://192.0.2.7/" },`) }).said).toBe("its bun.lock names is-odd twice, so nothing is filled");
  });

  test("nothing of the tree but its bun.lock is taken: a package.json, a bunfig.toml, an .npmrc, any other file or folder, or a link, is refused", () => {
    for (const extra of ["package.json", "bunfig.toml", ".npmrc", "sub/bunfig.toml", "notes.txt"]) {
      const ran = checked({ "bun.lock": lock(REGISTRY), [extra]: `registry = "http://192.0.2.1/"\n` });
      expect([extra, ran.code, ran.said, ran.manifest]).toEqual([extra, 1, refusedFor(`what it was given holds ${extra.split("/")[0]}, and a fill is given its bun.lock alone`), null]);
    }
    expect(checked({ "bun.lock": lock(REGISTRY) }, ["linked", "bun.lock"]).said).toBe(refusedFor("what it was given holds linked, and a fill is given its bun.lock alone"));
    const at = temp();
    writeFileSync(join(at, "real.lock"), lock(REGISTRY));
    expect(checked({}, ["bun.lock", join(at, "real.lock")]).said).toBe(refusedFor("its bun.lock is no file"));
    expect(checked({}).said).toStartWith("its bun.lock can't be read (");
  });

  test("a workspace out of the tree, or a patch, is refused", () => {
    expect(checked({ "bun.lock": lock(REGISTRY, `"": { "name": "app" },\n    "../out": { "name": "out" },`) }).said).toBe(refusedFor("its bun.lock names a workspace out of its tree, ../out"));
    expect(checked({ "bun.lock": lock(REGISTRY, `"": { "name": "app" },\n    "/abs": { "name": "out" },`) }).said).toBe(refusedFor("its bun.lock names a workspace out of its tree, /abs"));
    expect(checked({ "bun.lock": lock(REGISTRY).replace('"lockfileVersion": 1,', '"lockfileVersion": 1, "patchedDependencies": { "is-odd@3.0.1": "patches/x.patch" },') }).said).toBe(refusedFor("its bun.lock patches packages, which a fill can't"));
  });
});

describe("the filler's check of the lockfile bun resolved its own manifest to (FILL_CHECK_PY), before it fetches a tarball", () => {
  /** The fill's folder as bun left it, its lockfile's packages `packages`, and the hashes the tree's bun.lock asked for. */
  function resolved(packages: string, hashes: Record<string, string> = { "is-number@6.0.0": NUMBER, "is-odd@3.0.1": ODD }) {
    const at = temp();
    mkdirSync(join(at, "fill"));
    writeFileSync(join(at, "fill", "bun.lock"), lock(packages, `"": { "name": "fill", "optionalDependencies": { "p0": "npm:is-number@6.0.0", "p1": "npm:is-odd@3.0.1" } },`));
    writeFileSync(join(at, "hashes.json"), JSON.stringify(hashes));
    const ran = spawnSync("python3", ["-I", "-c", FILL_CHECK_PY, join(at, "fill"), join(at, "hashes.json")], { encoding: "utf8" });
    return { code: ran.status, said: ran.stderr.trim() };
  }
  const p0 = `"p0": ["is-number@6.0.0", "", {}, "${NUMBER}"],`;
  test("each package the tree's lockfile names, by its hash, passes; what the registry's resolution adds beside them is said", () => {
    expect(resolved(`${p0}\n    "p1": ["is-odd@3.0.1", "", { "dependencies": { "is-number": "^6.0.0" } }, "${ODD}"],`)).toEqual({ code: 0, said: "" });
    const more = resolved(`${p0}\n    "p1": ["is-odd@3.0.1", "", {}, "${ODD}"],\n    "kind-of": ["kind-of@6.0.3", "", {}, "${NUMBER}"],`);
    expect(more).toEqual({ code: 0, said: "the registry's resolution adds 1 package(s) its bun.lock doesn't name, the first kind-of@6.0.3" });
  });

  test("a hash that isn't the registry's, a package the registry hasn't, or anything not of the registry's, is refused before any tarball is fetched", () => {
    expect(resolved(`${p0}\n    "p1": ["is-odd@3.0.1", "", {}, "${NUMBER}"],`)).toEqual({ code: 1, said: refusedFor("its bun.lock's hash of is-odd@3.0.1 isn't the registry's") });
    expect(resolved(p0)).toEqual({ code: 1, said: refusedFor("the registry has no is-odd@3.0.1, which its bun.lock names") });
    expect(resolved(`${p0}\n    "p1": ["is-odd@3.0.1", "", {}, "${ODD}"],\n    "x": ["x@https://example.test/x.tgz", {}],`)).toEqual({ code: 1, said: refusedFor("bun would fetch x@https://example.test/x.tgz, which isn't the default registry's") });
    expect(resolved(`${p0}\n    "p1": ["is-odd@3.0.1", "https://registry.example.test/", {}, "${ODD}"],`)).toEqual({ code: 1, said: refusedFor("bun would fetch is-odd@3.0.1, which isn't the default registry's") });
  });
});

describe("the filler, as Docker runs it", () => {
  test("has no network: its one way out is the node's proxy, its socket's folder mounted read-only, where bun is told to send what it fetches", () => {
    const args = fillerArgs({ name: "invincible-sbx-fill-0123456789", image: "invincible/sandbox:1", cache: "/var/lib/node/cache/bun", user: "65533:65533", path: "/usr/bin:/bin", proxy: "/var/lib/node/cache/fill-0123456789" });
    const flag = (name: string) => args.filter((_, i) => args[i - 1] === name);
    expect(flag("--network")).toEqual(["none"]);
    expect(flag("--mount")).toEqual(["type=bind,src=/var/lib/node/cache/bun,dst=/cache", "type=bind,src=/var/lib/node/cache/fill-0123456789,dst=/proxy,readonly"]);
    for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) expect(args).toContain(`${name}=http://127.0.0.1:3128`);
    expect(args.some((a) => a.startsWith("NO_PROXY=") || a.startsWith("no_proxy="))).toBe(false);
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
