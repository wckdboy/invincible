import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/*
 * The one-line install (scripts/install.sh), asked what it would do (--plan) in homes of its own: it says each change
 * and makes none. Installing for real downloads Bun and the dependencies, so that was tried by hand in a scratch home;
 * this holds what it decides.
 */

const root = resolve(import.meta.dir, "../../..");
const script = join(root, "scripts/install.sh");
const scratch = mkdtempSync(join(tmpdir(), "galahad-install-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// The checkout it installs from is one of its own (--plan reads only its commit), so this runs from a tarball too.
const source = join(scratch, "source");
mkdirSync(source);
const git = (...a: string[]) => Bun.spawnSync(["git", "-C", source, "-c", "user.email=t@t", "-c", "user.name=t", ...a]);
git("init", "-q");
git("commit", "-q", "--allow-empty", "-m", "init");

function plan(name: string, args: string[], before?: (home: string) => void) {
  const home = join(scratch, name);
  mkdirSync(home, { recursive: true });
  before?.(home);
  const run = Bun.spawnSync(["bash", script, "--plan", ...args], {
    env: { HOME: home, PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", GALAHAD_SOURCE: source },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: run.exitCode, said: `${run.stdout}${run.stderr}`, home };
}

test("on a machine new to it, it says it would fetch this commit, install its own Bun in its own folder, add the command and found a fleet; and changes nothing", () => {
  const { code, said, home } = plan("fresh", ["--name", "laptop", "--fleet", "camelot"]);
  expect(code).toBe(0);
  expect(said).toContain("--plan: nothing below is done");
  expect(said).toContain(`would: install the pinned Bun into ${home}/.local/share/galahad/bun`);
  // Never over a Bun of yours.
  expect(said).not.toContain(`${home}/.bun`);
  expect(said).toContain(`would: write ${home}/.local/bin/galahad`);
  expect(said).toContain("would: galahad init --name laptop --fleet camelot");
  expect(readdirSync(home)).toEqual([]);
});

test("it keeps the node running as a service of yours, and publishes it and pairs a phone only then", () => {
  const kept = plan("service", []);
  if (process.platform === "darwin") expect(kept.said).toContain(`would: write ${kept.home}/Library/LaunchAgents/sh.galahad.node.plist`);
  else expect(kept.said).toMatch(/would: write .*systemd\/user\/galahad\.service|no service manager for you here/);
  const none = plan("no-service", ["--no-service"]);
  expect(none.said).not.toMatch(/LaunchAgents|systemd|publish the app|pair a phone/);
  expect(plan("no-expose", ["--no-expose"]).said).not.toContain("publish the app");
});

test("with an invite it joins your fleet instead, and a machine that is already a node is kept as it is", () => {
  expect(plan("join", ["--join", "gi1.fake-invite-for-tests", "--name", "server"]).said).toContain("would: galahad join gi1.fake-invite-for-tests --name server");
  const kept = plan("node", [], (home) => {
    mkdirSync(join(home, ".galahad"));
    writeFileSync(join(home, ".galahad/config.json"), '{ "name": "keep" }');
  });
  expect(kept.said).toContain("is already a node");
  expect(kept.said).not.toMatch(/galahad (init|join)/);
});

test("an option it doesn't know is refused, and --help says what it does", () => {
  expect(plan("unknown", ["--frobnicate"]).code).toBe(2);
  const help = Bun.spawnSync(["bash", script, "--help"], { stdout: "pipe" }).stdout.toString();
  expect(help).toContain("curl -fsSL https://galahad.sh | bash");
  expect(help).toContain("--no-expose");
});

test("it passes shellcheck, where shellcheck is installed", () => {
  const shellcheck = Bun.which("shellcheck");
  if (!shellcheck) return void console.warn("shellcheck isn't installed here: not checked");
  const run = Bun.spawnSync([shellcheck, "-S", "warning", "-x", script, join(root, "scripts/bun-pin.sh")], { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(`${run.stdout}${run.stderr}`).toBe("");
  expect(existsSync(script)).toBe(true);
});
