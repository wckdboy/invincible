import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
const root = mkdtempSync(join(tmpdir(), "galahad-deploy-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A server's home with one release deployed and running, and a commit staged to follow it (with Q-AMP's binary, if given). */
function server(name: string, tests: "pass" | "fail", qamp?: string) {
  const home = join(root, name);
  const stage = join(root, `${name}-stage`);
  mkdirSync(join(home, ".bun/bin"), { recursive: true });
  mkdirSync(join(home, ".galahad"), { recursive: true });
  mkdirSync(join(home, "galahad/releases/aaaaaaaaaaaa"), { recursive: true });
  mkdirSync(stage);
  writeFileSync(join(home, ".galahad/config.json"), '{ "name": "ultra" }');
  writeFileSync(join(stage, "package.json"), "{}");
  if (qamp !== undefined) writeFileSync(join(stage, "qamp.bin"), qamp);
  symlinkSync(join(home, "galahad/releases/aaaaaaaaaaaa"), join(home, "galahad/app"));
  // Bun, as far as the script asks it: its version, an install, the test suite (where it ran, and how it ended).
  writeFileSync(join(home, ".bun/bin/bun"), `#!/bin/sh\ncase "$1" in\n  --version) echo ${pinned} ;;\n  test) pwd > "$HOME/tested-in"; echo "1 ${tests}"; ${tests === "pass" ? "exit 0" : "exit 1"} ;;\nesac\n`);
  chmodSync(join(home, ".bun/bin/bun"), 0o755);
  const run = Bun.spawnSync(["bash", script, stage, "bbbbbbbbbbbb", "update", "ultra", "-", "-", "7777", "0", "0", "0", "0", "0"], {
    env: { HOME: home, PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", GALAHAD_USER_PHASE: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: run.exitCode,
    said: `${run.stdout.toString()}${run.stderr.toString()}`,
    app: basename(readlinkSync(join(home, "galahad/app"))),
    testedIn: existsSync(join(home, "tested-in")) ? basename(readFileSync(join(home, "tested-in"), "utf8").trim()) : null,
    home,
  };
}

test("Q-AMP's binary shipped with a deploy that isn't the pinned one refuses the deploy: nothing installed, nothing tested, app as it was", () => {
  const deploy = server("impostor", "pass", "#!/bin/sh\necho not qamp\n");
  expect(deploy.code).toBe(1);
  expect(deploy.said).toContain("failed its checksum (it isn't Q-AMP 0.1.0 for this machine): not installed");
  expect(deploy.said).toContain("Q-AMP's binary wasn't installed: not deploying");
  expect(existsSync(join(deploy.home, ".galahad/bin/qamp"))).toBe(false);
  expect(deploy.testedIn).toBeNull();
  expect(deploy.app).toBe("aaaaaaaaaaaa");
});

// ufw refuses a rule whose comment holds an apostrophe ("ERROR: Invalid syntax"): the Q-AMP bridges' rule said "grants'"
// and was never added on Ultra (25 November 2026), with the deploy otherwise fine. Its root phase runs only on a server.
test("every firewall rule the setup adds has a comment ufw accepts: no apostrophe in it", () => {
  const comments = [...readFileSync(script, "utf8").matchAll(/ufw allow [^\n]*comment "([^"]*)"/g)].map((m) => m[1]!);
  expect(comments.length).toBeGreaterThanOrEqual(3);
  for (const comment of comments) expect(comment).not.toContain("'");
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
