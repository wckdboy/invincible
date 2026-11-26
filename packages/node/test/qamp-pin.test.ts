import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/*
 * scripts/qamp-pin.sh: Q-AMP's binary is taken from a file you fetched (its forge is sign-in only), checked against the
 * release's SHA-256 for this machine, and put where the node looks by a rename. A file that isn't it is refused, and
 * whatever was there stays.
 */

const repo = resolve(import.meta.dir, "../../..");
const pin = join(repo, "scripts/qamp-pin.sh");
const root = mkdtempSync(join(tmpdir(), "galahad-qamp-pin-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** install_qamp <file> <dir>, with `before` run first (a pin for a stand-in, another machine's uname). */
function install(file: string, dir: string, before = "") {
  const run = Bun.spawnSync(["bash", "-c", `set -euo pipefail; source "$0"; ${before}\ninstall_qamp "$1" "$2"`, pin, file, dir], { stdout: "pipe", stderr: "pipe" });
  return { code: run.exitCode, said: `${run.stdout}${run.stderr}` };
}

const platformPin = (): string | null => {
  const key = `${process.platform}-${process.arch}`;
  return key === "linux-x64" ? "QAMP_SHA256_LINUX_X86_64" : key === "darwin-arm64" ? "QAMP_SHA256_DARWIN_ARM64" : null;
};

test("the pins are the release's: version 0.1.0, one SHA-256 for Linux x86_64 and one for macOS arm64", () => {
  const text = readFileSync(pin, "utf8");
  expect(/^QAMP_VERSION=(\S+)$/m.exec(text)?.[1]).toBe("0.1.0");
  expect(/^QAMP_SHA256_LINUX_X86_64=([0-9a-f]{64})$/m.exec(text)?.[1]).toBe("81d6f7107b616054fd7f7afb5017e86cd01e7c8f0e7b08620f92d8136d2bb0db");
  expect(/^QAMP_SHA256_DARWIN_ARM64=([0-9a-f]{64})$/m.exec(text)?.[1]).toBe("c316bed93f411c8c580d08b242e6b862ea5b9abd3739d04bed3d344360462914");
});

test("a file that isn't the pinned binary is refused, and the one already there stays", () => {
  const dir = join(root, "refused");
  mkdirSync(dir);
  writeFileSync(join(dir, "qamp"), "the one already there");
  writeFileSync(join(root, "impostor"), "#!/bin/sh\necho not qamp\n");
  const run = install(join(root, "impostor"), dir);
  expect(run.code).toBe(1);
  expect(run.said).toContain("failed its checksum (it isn't Q-AMP 0.1.0 for this machine): not installed");
  expect(readFileSync(join(dir, "qamp"), "utf8")).toBe("the one already there");
  expect(existsSync(join(dir, "qamp.new"))).toBe(false);
});

test("a file that matches its pin is put in place by a rename, executable", () => {
  const name = platformPin();
  if (!name) return void console.warn(`no Q-AMP pin for ${process.platform}-${process.arch}: installing a match not checked here`);
  const dir = join(root, "taken");
  const stand = join(root, "stand-in");
  writeFileSync(stand, "#!/bin/sh\necho qamp 0.1.0\n");
  const sha = createHash("sha256").update(readFileSync(stand)).digest("hex");
  // The pin, for this test alone, is the stand-in's: what's checked is the mechanism, not the release.
  const run = install(stand, dir, `${name}=${sha}`);
  expect(run.code).toBe(0);
  expect(run.said).toContain(`→ Q-AMP 0.1.0 at ${dir}/qamp (checksum-verified)`);
  expect(readFileSync(join(dir, "qamp"), "utf8")).toBe("#!/bin/sh\necho qamp 0.1.0\n");
  expect(statSync(join(dir, "qamp")).mode & 0o777).toBe(0o755);
  expect(existsSync(join(dir, "qamp.new"))).toBe(false);
});

test("no file, or a machine with no pin: refused, saying which", () => {
  expect(install(join(root, "nowhere"), join(root, "none")).said).toContain("no such file (Q-AMP 0.1.0's binary for this machine)");
  const elsewhere = install(join(root, "impostor"), join(root, "none"), 'uname() { [[ $1 == -s ]] && echo Plan9 || echo mips; }');
  expect([elsewhere.code, elsewhere.said.trim()]).toEqual([1, "no pinned Q-AMP 0.1.0 for Plan9 mips"]);
  expect(existsSync(join(root, "none"))).toBe(false);
});

test("it passes shellcheck, where shellcheck is installed", () => {
  const shellcheck = Bun.which("shellcheck");
  if (!shellcheck) return void console.warn("shellcheck isn't installed here: not checked");
  const run = Bun.spawnSync([shellcheck, "-S", "warning", pin], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  expect(`${run.stdout}${run.stderr}`).toBe("");
});
