import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

/*
 * The part of a deploy that runs on the server as the node's own user
 * (scripts/remote-setup.sh, its user phase), run here in a home of its own with a
 * stand-in for Bun: `app` is what the node starts from, so only a release that passed
 * its tests on that host may become it.
 */

const script = resolve(import.meta.dir, "../../../scripts/remote-setup.sh");
// The script installs the Bun it pins (scripts/bun-pin.sh) unless that one is there already: the stand-in says it is.
const pinned = /^BUN_VERSION=(\S+)$/m.exec(readFileSync(resolve(import.meta.dir, "../../../scripts/bun-pin.sh"), "utf8"))![1]!;
/** The Q-AMP release scripts/qamp-pin.sh names, as its refusals say it. */
const qampPinned = /^QAMP_VERSION=(\S+)$/m.exec(readFileSync(resolve(import.meta.dir, "../../../scripts/qamp-pin.sh"), "utf8"))![1]!;
const root = mkdtempSync(join(tmpdir(), "invincible-deploy-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A server's home with one release deployed and running, and a commit staged to follow it (with Q-AMP's binary, if given). */
function server(name: string, tests: "pass" | "fail", qamp?: string) {
  const home = join(root, name);
  const stage = join(root, `${name}-stage`);
  mkdirSync(join(home, ".bun/bin"), { recursive: true });
  mkdirSync(join(home, ".invincible"), { recursive: true });
  mkdirSync(join(home, "invincible/releases/aaaaaaaaaaaa"), { recursive: true });
  mkdirSync(stage);
  writeFileSync(join(home, ".invincible/config.json"), '{ "name": "ultra" }');
  writeFileSync(join(stage, "package.json"), "{}");
  if (qamp !== undefined) writeFileSync(join(stage, "qamp.bin"), qamp);
  symlinkSync(join(home, "invincible/releases/aaaaaaaaaaaa"), join(home, "invincible/app"));
  // Bun, as far as the script asks it: its version, an install, the test suite (where it ran, and how it ended).
  writeFileSync(join(home, ".bun/bin/bun"), `#!/bin/sh\ncase "$1" in\n  --version) echo ${pinned} ;;\n  test) pwd > "$HOME/tested-in"; echo "1 ${tests}"; ${tests === "pass" ? "exit 0" : "exit 1"} ;;\nesac\n`);
  chmodSync(join(home, ".bun/bin/bun"), 0o755);
  const run = Bun.spawnSync(["bash", script, stage, "bbbbbbbbbbbb", "update", "ultra", "-", "-", "7400", "0", "0", "0", "0", "0"], {
    env: { HOME: home, PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", INVINCIBLE_USER_PHASE: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: run.exitCode,
    said: `${run.stdout.toString()}${run.stderr.toString()}`,
    app: basename(readlinkSync(join(home, "invincible/app"))),
    testedIn: existsSync(join(home, "tested-in")) ? basename(readFileSync(join(home, "tested-in"), "utf8").trim()) : null,
    home,
  };
}

test("Q-AMP's binary shipped with a deploy that isn't the pinned one refuses the deploy: nothing installed, nothing tested, app as it was", () => {
  const deploy = server("impostor", "pass", "#!/bin/sh\necho not qamp\n");
  expect(deploy.code).toBe(1);
  expect(deploy.said).toContain(`failed its checksum (it isn't Q-AMP ${qampPinned} for this machine): not installed`);
  expect(deploy.said).toContain("Q-AMP's binary wasn't installed: not deploying");
  expect(existsSync(join(deploy.home, ".invincible/bin/qamp"))).toBe(false);
  expect(deploy.testedIn).toBeNull();
  expect(deploy.app).toBe("aaaaaaaaaaaa");
});

// ufw refuses a rule whose comment holds an apostrophe ("ERROR: Invalid syntax"): the Q-AMP bridges' rule said "grants'"
// and was never added on Ultra (25 November 2026), with the deploy otherwise fine. Its root phase runs only on a server.
// A Mac node's service has launchd's PATH (/usr/bin:/bin:/usr/sbin:/sbin) unless its LaunchAgent gives one, and there it
// can't find tailscale (/usr/local/bin, /opt/homebrew/bin): it then advertised 127.0.0.1 and listened on loopback alone,
// so a peer following its endpoint reached only itself (the mini, 27 November 2026: Ultra's sync was refused, 401, by
// Ultra's own node, and the mini stayed "offline" to it). The deploy's LaunchAgent gives the node the PATH the
// installer's and the Mac app's give it.
test("the deploy's LaunchAgent gives a Mac node the PATH the installer's and the Mac app's give it, tailscale's folders in it", () => {
  const darwin = /elif \[\[ \$\(uname\) == Darwin \]\]; then[\s\S]*?<\/plist>/.exec(readFileSync(script, "utf8"))?.[0] ?? "";
  const pathIn = (text: string) => /<key>PATH<\/key><string>([^<]*)<\/string>/.exec(text)?.[1];
  const installer = pathIn(readFileSync(resolve(import.meta.dir, "../../../scripts/install.sh"), "utf8"));
  const app = /static let servicePath = "([^"]*)"/.exec(readFileSync(resolve(import.meta.dir, "../../../apps/apple/Invincible/Mac/MacNode.swift"), "utf8"))?.[1];
  expect(darwin).toContain("<key>Label</key><string>dev.invincible.node</string>");
  expect(installer?.split(":")).toEqual(expect.arrayContaining(["/opt/homebrew/bin", "/usr/local/bin"]));
  expect(app).toBe(installer);
  expect(pathIn(darwin)).toBe(installer);
});

// A node deployed as its own user (a Mac's LaunchAgent, Linux's systemd --user) had no command to type: only a root
// deploy wrote /usr/local/bin's invincible and inv (the mini, 28 November 2026: no invincible on its PATH). The setup
// writes them where the installer does (scripts/install.sh: ~/.local/bin), each run as the node is.
/** The setup's install_commands, run alone in a home of its own with a stand-in Bun that says what it was given. */
function commands(name: string, opts: { path?: string; oldInvLink?: boolean } = {}) {
  const home = join(root, name);
  const bin = join(home, ".local/bin");
  const app = join(home, "invincible/app");
  const bun = join(home, ".bun/bin/bun");
  mkdirSync(join(home, ".bun/bin"), { recursive: true });
  writeFileSync(bun, `#!/bin/sh\nprintf '%s\\n' "keystore=$INVINCIBLE_KEYSTORE" "$@"\n`);
  chmodSync(bun, 0o755);
  if (opts.oldInvLink) {
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "invincible"), "#!/bin/sh\necho an older invincible\n");
    symlinkSync("invincible", join(bin, "inv"));
  }
  const fn = /^install_commands\(\) \{\n[\s\S]*?\n\}$/m.exec(readFileSync(script, "utf8"))?.[0];
  if (!fn) throw new Error("scripts/remote-setup.sh has no install_commands");
  const run = Bun.spawnSync(["bash", "-c", `set -euo pipefail\n${fn}\ninstall_commands`], {
    env: { HOME: home, APP: app, BUN: bun, PATH: opts.path ?? "/usr/bin:/bin:/usr/sbin:/sbin" },
    stdout: "pipe",
    stderr: "pipe",
  });
  /** One of the commands it wrote, typed over ssh as a Mac runs it: launchd's PATH and nothing else. */
  const typed = (command: string, ...args: string[]) => Bun.spawnSync([join(bin, command), ...args], { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, stdout: "pipe" }).stdout.toString();
  return { code: run.exitCode, said: `${run.stdout.toString()}${run.stderr.toString()}`, bin, app, typed };
}

test("a node deployed as its own user gets the invincible and inv commands where the installer puts them, each run as the node is", () => {
  const deploy = commands("commands");
  expect(deploy.code).toBe(0);
  // Its CLI, on the deployed app (the link a deploy moves, so the next release is the one typed), with the file keystore.
  expect(deploy.typed("invincible", "agents", "routing")).toBe(`keystore=file\n${deploy.app}/packages/node/src/cli.ts\nagents\nrouting\n`);
  expect(deploy.typed("inv", "status")).toBe(`keystore=file\n${deploy.app}/packages/node/src/inv/main.ts\nstatus\n`);
  for (const command of ["invincible", "inv"]) expect(statSync(join(deploy.bin, command)).mode & 0o777).toBe(0o755);
  // Where ~/.local/bin isn't on the PATH, it says how to put it there, as the installer does; where it is, nothing.
  expect(deploy.said).toContain(`add ${deploy.bin} to your PATH to type invincible anywhere`);
  expect(commands("commands-on-path", { path: `${join(root, "commands-on-path/.local/bin")}:/usr/bin:/bin` }).said).toBe("");
});

test("an inv that was a link to invincible is replaced, never written through: invincible stays the CLI", () => {
  const deploy = commands("commands-old-link", { oldInvLink: true });
  expect(deploy.code).toBe(0);
  expect(lstatSync(join(deploy.bin, "inv")).isSymbolicLink()).toBe(false);
  expect(deploy.typed("invincible")).toBe(`keystore=file\n${deploy.app}/packages/node/src/cli.ts\n`);
  expect(deploy.typed("inv")).toBe(`keystore=file\n${deploy.app}/packages/node/src/inv/main.ts\n`);
});

test("the commands are written for a node deployed as its own user, before its service starts; a root deploy's user phase writes none", () => {
  const text = readFileSync(script, "utf8");
  const rootPhaseEnds = text.indexOf("[[ -n ${INVINCIBLE_USER_PHASE:-} ]] && exit 0");
  const written = text.indexOf("\ninstall_commands\n");
  const services = text.indexOf("if [[ $(uname) == Linux ]] && command -v systemctl");
  expect([rootPhaseEnds > 0, written > rootPhaseEnds, services > written]).toEqual([true, true, true]);
  // (The root phase writes /usr/local/bin's; the service user's home gets none.)
  const deploy = server("root-user-phase", "pass");
  expect(deploy.code).toBe(0);
  expect(existsSync(join(deploy.home, ".local/bin"))).toBe(false);
});

test("every firewall rule the setup adds has a comment ufw accepts: no apostrophe in it", () => {
  const comments = [...readFileSync(script, "utf8").matchAll(/ufw allow [^\n]*comment "([^"]*)"/g)].map((m) => m[1]!);
  expect(comments.length).toBeGreaterThanOrEqual(3);
  for (const comment of comments) expect(comment).not.toContain("'");
});

// The setup runs under `set -euo pipefail`: a piped command substitution whose first command fails (a Lab check that
// found 21 of 22, a microVM that wouldn't boot, a tailnet status that wouldn't answer) ended the whole deploy, silently,
// before the line that was there to report it (on the first deploy of 26 November 2026). Each one that only reports
// must tolerate failure.
test("no piped command substitution in the setup can end the deploy: each that only reports tolerates failure", () => {
  // A command continued over lines (a trailing backslash) is read as the one line it is.
  const lines = readFileSync(script, "utf8").replace(/\\\n\s*/g, " ").split("\n");
  const piped = lines.map((line, i) => ({ line, n: i + 1 })).filter(({ line }) => /=\$\((?:[^()]|\([^()]*\))*\|(?:[^()]|\([^()]*\))*\)/.test(line));
  expect(piped.length).toBeGreaterThanOrEqual(4);
  // What a substitution is allowed to fail on: those that make a value the deploy can't go on without.
  const mustSucceed = [/SEARX_SECRET=/];
  const fragile = piped.filter(({ line }) => !line.includes("|| true)") && !mustSucceed.some((re) => re.test(line)));
  expect(fragile.map(({ n, line }) => `${n}: ${line.trim().slice(0, 80)}`)).toEqual([]);
});

test("a release whose tests fail on the host never becomes app: the node's code on disk stays the release it runs", () => {
  const deploy = server("refused", "fail");
  expect(deploy.code).toBe(1);
  expect(deploy.said).toContain("tests failed on this host");
  // What was tested is the new release, in its own directory.
  expect(deploy.testedIn).toBe("bbbbbbbbbbbb");
  expect(deploy.app).toBe("aaaaaaaaaaaa");
});

test("a release that passes its tests on the host becomes app", () => {
  const deploy = server("taken", "pass");
  expect(deploy.said).toContain("existing node kept");
  expect(deploy.code).toBe(0);
  expect(deploy.testedIn).toBe("bbbbbbbbbbbb");
  expect(deploy.app).toBe("bbbbbbbbbbbb");
});
