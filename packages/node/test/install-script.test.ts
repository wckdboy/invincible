import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/*
 * The one-line install (scripts/install.sh), asked what it would do (--plan) in homes of its own: it says each change
 * and makes none. Installing for real downloads Bun and the dependencies, so that was tried by hand in a scratch home;
 * this holds what it decides.
 */

const root = resolve(import.meta.dir, "../../..");
const script = join(root, "scripts/install.sh");
const scratch = mkdtempSync(join(tmpdir(), "invincible-install-"));
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
    env: { HOME: home, PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", INVINCIBLE_SOURCE: source },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: run.exitCode, said: `${run.stdout}${run.stderr}`, home };
}

test("on a machine new to it, it says it would fetch this commit, install its own Bun in its own folder, add the command and found a fleet; and changes nothing", () => {
  const { code, said, home } = plan("fresh", ["--name", "laptop", "--fleet", "homelab"]);
  expect(code).toBe(0);
  expect(said).toContain("--plan: nothing below is done");
  expect(said).toContain(`would: install the pinned Bun into ${home}/.local/share/invincible/bun`);
  // Never over a Bun of yours.
  expect(said).not.toContain(`${home}/.bun`);
  expect(said).toContain(`would: write ${home}/.local/bin/invincible`);
  // `inv` is the command line client (docs/CLI.md), a command of its own: never another name for `invincible`.
  expect(said).toContain(`would: write ${home}/.local/bin/inv: the command line client (packages/node/src/inv/main.ts)`);
  expect(said).toContain("would: invincible init --name laptop --fleet homelab");
  expect(readdirSync(home)).toEqual([]);
});

test("it keeps the node running as a service of yours, and publishes it and pairs a phone only then", () => {
  const kept = plan("service", []);
  if (process.platform === "darwin") expect(kept.said).toContain(`would: write ${kept.home}/Library/LaunchAgents/sh.invincible.node.plist`);
  else expect(kept.said).toMatch(/would: write .*systemd\/user\/invincible\.service|no service manager for you here/);
  const none = plan("no-service", ["--no-service"]);
  expect(none.said).not.toMatch(/LaunchAgents|systemd|publish the app|pair a phone/);
  expect(plan("no-expose", ["--no-expose"]).said).not.toContain("publish the app");
});

test("with an invite it joins your fleet instead, and a machine that is already a node is kept as it is", () => {
  expect(plan("join", ["--join", "gi1.fake-invite-for-tests", "--name", "server"]).said).toContain("would: invincible join gi1.fake-invite-for-tests --name server");
  const kept = plan("node", [], (home) => {
    mkdirSync(join(home, ".invincible"));
    writeFileSync(join(home, ".invincible/config.json"), '{ "name": "keep" }');
  });
  expect(kept.said).toContain("is already a node");
  expect(kept.said).not.toMatch(/invincible (init|join)/);
});

test("an option it doesn't know is refused, and --help says what it does", () => {
  expect(plan("unknown", ["--frobnicate"]).code).toBe(2);
  const help = Bun.spawnSync(["bash", script, "--help"], { stdout: "pipe" }).stdout.toString();
  expect(help).toContain("curl -fsSL https://invincible.sh | bash");
  expect(help).toContain("--no-expose");
});

test("run by a shell that isn't bash (`curl … | sh` on Debian is dash), it says to run it with bash and stops, having done nothing", () => {
  const shells = ["dash", "zsh"].flatMap((name) => Bun.which(name) ?? []);
  if (!shells.length) return void console.warn("neither dash nor zsh is installed here: not checked");
  for (const shell of shells) {
    const home = join(scratch, `by-${shell.split("/").pop()}`);
    mkdirSync(home);
    const run = Bun.spawnSync([shell], { stdin: Bun.file(script), env: { HOME: home, PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" }, stdout: "pipe", stderr: "pipe" });
    expect([shell, run.exitCode]).toEqual([shell, 1]);
    expect(run.stderr.toString()).toContain("curl -fsSL https://invincible.sh | bash");
    expect(readdirSync(home)).toEqual([]);
  }
});

test("both installers make `inv` the command line client, run as the node's own command is, never a link to it", () => {
  // Until 26 November 2026 each linked inv to invincible, so `inv ask "…"`, as invincible.sh shows it, ran the node's
  // command instead of the client.
  expect(existsSync(join(root, "packages/node/src/inv/main.ts"))).toBe(true);
  for (const installer of ["scripts/install.sh", "scripts/remote-setup.sh"]) {
    const text = readFileSync(join(root, installer), "utf8");
    expect(text).not.toMatch(/ln -sfn invincible \S*\binv\b/);
    expect(text).toContain("packages/node/src/inv/main.ts");
  }
});

test("it passes shellcheck, where shellcheck is installed", () => {
  const shellcheck = Bun.which("shellcheck");
  if (!shellcheck) return void console.warn("shellcheck isn't installed here: not checked");
  const run = Bun.spawnSync([shellcheck, "-S", "warning", "-x", script, join(root, "scripts/bun-pin.sh")], { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(`${run.stdout}${run.stderr}`).toBe("");
  expect(existsSync(script)).toBe(true);
});
