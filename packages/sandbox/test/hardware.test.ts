import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DESKTOP_IMAGE, HARDWARE_IMAGE, OWN_IMAGES } from "../src/index.ts";

/*
 * The hardware image (C1 step 11): the agents' desktop with KiCad and FreeCAD, a choice per agent. Here, what the image
 * is made of, and its seed (hardware-seed), run as the VM runs it as it starts: KiCad's and FreeCAD's settings put in
 * the agent's own home where they aren't there yet. The image itself is built on a sandbox host, not here.
 */

// The seed's tests run it as the VM does, a shell script of some twenty processes, so its time is the machine's to give:
// three of them ran past bun's default 5 s in a full run at a load of 136 on 12 cores (27 November 2026), and pass alone.
// The limit is how long a busy machine may take, never what a test checks.
setDefaultTimeout(20_000);

const context = new URL("../../../sandbox/hardware/", import.meta.url);
const dockerfile = readFileSync(new URL("Dockerfile", context), "utf8");
const seedScript = fileURLToPath(new URL("hardware-seed", context));
const seeds = fileURLToPath(new URL("seed/", context));

describe("the hardware image", () => {
  test("is the desktop's with KiCad 9.0.8 from trixie-backports, pinned, and trixie's FreeCAD, without what they recommend, their versions checked as it is built", () => {
    expect(OWN_IMAGES[HARDWARE_IMAGE]).toEqual({ context: "hardware", keeper: "invincible-hardware-image", base: DESKTOP_IMAGE });
    expect(dockerfile).toMatch(/^FROM invincible\/desktop:1$/m);
    const run = dockerfile.replace(/\\\n/g, " ");
    expect(run).toMatch(/apt-get install -y --no-install-recommends kicad=9\.0\.8\+dfsg-1~bpo13\+1 freecad /);
    // (Backports by Debian's own key, as the image's other sources are; KiCad alone is asked of it, by its version.)
    expect(dockerfile).toContain("COPY backports.sources /etc/apt/sources.list.d/backports.sources\n");
    const backports = readFileSync(new URL("backports.sources", context), "utf8");
    for (const line of ["Types: deb", "URIs: http://deb.debian.org/debian", "Suites: trixie-backports", "Components: main", "Signed-By: /usr/share/keyrings/debian-archive-keyring.pgp"]) expect(backports.split("\n")).toContain(line);
    // (A release that moved fails the build, never makes another image quietly.)
    expect(run).toContain("kicad-cli version | grep -qx '9\\.0\\.8'");
    expect(run).toContain("freecadcmd --version | grep -q 'FreeCAD 1\\.0\\.0'");
  });

  test("has KiCad's API client pinned, in a venv that sees Debian's packages, and ends as the agent with its seed first", () => {
    const pins = readFileSync(new URL("requirements.txt", context), "utf8").split("\n").filter((line) => line && !line.startsWith("#"));
    expect(pins.length).toBeGreaterThan(0);
    for (const pin of pins) expect(pin).toMatch(/^[A-Za-z0-9_.-]+==[0-9][A-Za-z0-9.]*$/);
    // (0.6.0's API definitions are KiCad 9.0.8's: its check_version takes this KiCad.)
    expect(pins).toContain("kicad-python==0.6.0");
    expect(dockerfile).toContain("python3 -m venv --system-site-packages /opt/hardware");
    expect(dockerfile).toContain('/opt/hardware/bin/python -c "import kipy, pcbnew"');
    expect(dockerfile).toMatch(/^USER 1000:1000$/m);
    expect(dockerfile).toMatch(/^ENTRYPOINT \["\/usr\/local\/bin\/hardware-seed"\]$/m);
    expect(dockerfile).toMatch(/^CMD \["sleep", "infinity"\]$/m);
    // (Its seed is tried as the image is built: one that puts nothing never makes an image.)
    expect(dockerfile).toContain("HOME=/tmp/seed-check /usr/local/bin/hardware-seed true");
  });

  test("leaves /work empty, as Docker fills each agent's new home from it: what its checks start writes in a home of its own, and the build checks nothing is left", () => {
    // (KiCad's check, run as root in /work, once left its settings' folders, root's, in every agent's new home: FreeCAD
    // couldn't make its own there and never started, and the seed couldn't put KiCad's.)
    const runs = dockerfile.replace(/\\\n/g, " ").split("\n").filter((line) => line.startsWith("RUN ")).map((line) => line.slice(4));
    const started = runs.flatMap((r) => r.split("&&").map((step) => step.trim())).filter((step) => /\b(kicad-cli|freecadcmd|pcbnew|hardware-seed true)\b/.test(step));
    expect(started).toHaveLength(4);
    for (const step of started) expect(step).toMatch(/^HOME=\/tmp\/[a-z-]+ /);
    expect(runs.at(-1)).toBe('test -z "$(ls -A /work)"');
  });

  test("seeds KiCad with its library tables (none installed, so empty), its first run done, and its API server on, for kipy", () => {
    expect(readFileSync(join(seeds, "fp-lib-table"), "utf8")).toBe("(fp_lib_table\n  (version 7)\n)\n");
    expect(readFileSync(join(seeds, "sym-lib-table"), "utf8")).toBe("(sym_lib_table\n  (version 7)\n)\n");
    // (KiCad 9's own, 9.0.8's: its settings at their schema, so no migration is offered; its update question answered.)
    const common = JSON.parse(readFileSync(join(seeds, "kicad_common.json"), "utf8"));
    expect(common).toEqual({ meta: { filename: "kicad_common.json", version: 3 }, api: { enable_server: true }, do_not_show_again: { update_check_prompt: true } });
  });

  test("seeds FreeCAD with its first start done: no welcome panel, no start page", () => {
    const cfg = readFileSync(join(seeds, "freecad-user.cfg"), "utf8");
    const start = /<FCParamGroup Name="Root">\s*<FCParamGroup Name="BaseApp">\s*<FCParamGroup Name="Preferences">\s*<FCParamGroup Name="Mod">\s*<FCParamGroup Name="Start">([\s\S]*?)<\/FCParamGroup>/.exec(cfg)?.[1] ?? "";
    expect(start).toContain('<FCBool Name="FirstStart2024" Value="0"/>');
    expect(start).toContain('<FCBool Name="ShowOnStartup" Value="0"/>');
  });
});

describe("kipy, where an agent's commands run", () => {
  // An agent's commands run in login shells, where Debian's /etc/profile sets PATH afresh (the workshop's tools-path.sh
  // says why): kipy's venv must be put back there, first, so their python3 imports it. deskd, and the apps it starts,
  // aren't login shells: they keep Debian's own python3, the image setting no PATH of its own.
  const PROFILE_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/local/games:/usr/games";
  const script = fileURLToPath(new URL("hardware-path.sh", context));
  const after = (path: string, times = 1) => {
    const p = Bun.spawnSync(["/bin/sh", "-c", `${'. "$1"; '.repeat(times)}printf %s "$PATH"`, "sh", script], { env: { PATH: path, HOME: "/work" }, stdout: "pipe", stderr: "pipe" });
    expect({ stderr: p.stderr.toString(), code: p.exitCode }).toEqual({ stderr: "", code: 0 });
    return p.stdout.toString();
  };

  test("a login shell has kipy's venv first, once, however many times it is read", () => {
    expect(dockerfile).toContain("COPY hardware-path.sh /etc/profile.d/invincible-hardware.sh\n");
    expect(after(PROFILE_PATH).split(":")).toEqual(["/opt/hardware/bin", ...PROFILE_PATH.split(":")]);
    expect(after(PROFILE_PATH, 2)).toBe(after(PROFILE_PATH));
  });

  test("the image puts nothing on its own PATH: deskd and what it starts keep Debian's python3", () => {
    expect(dockerfile).not.toMatch(/^ENV PATH=/m);
  });
});

describe("its seed, as the VM runs it as it starts", () => {
  /** hardware-seed in a home of the test's own (and a seed folder of its own, where given), the VM's command after it. */
  function seed(home: string, command: string[] = [], env: Record<string, string> = {}) {
    const p = Bun.spawnSync(["sh", seedScript, ...command], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, INVINCIBLE_HARDWARE_SEED: seeds, ...env }, stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  }
  const home = () => mkdtempSync(join(tmpdir(), "invincible-hardware-home-"));
  const PLACES = [".config/kicad/9.0/kicad_common.json", ".config/kicad/9.0/fp-lib-table", ".config/kicad/9.0/sym-lib-table", ".config/FreeCAD/user.cfg"];

  test("puts each setting where it isn't, from the image's own, then runs the VM's command", () => {
    const h = home();
    try {
      expect(seed(h, ["sh", "-c", "echo the command of the VM"])).toMatchObject({ code: 0, out: "the command of the VM\n" });
      for (const place of PLACES) expect(existsSync(join(h, place))).toBe(true);
      expect(readFileSync(join(h, ".config/kicad/9.0/fp-lib-table"), "utf8")).toBe(readFileSync(join(seeds, "fp-lib-table"), "utf8"));
      // (Nothing half-written is left beside them.)
      expect(Bun.spawnSync(["find", h, "-name", "*.part"]).stdout.toString()).toBe("");
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("never replaces what the agent has: its own settings stay as they are", () => {
    const h = home();
    try {
      mkdirSync(join(h, ".config/kicad/9.0"), { recursive: true });
      writeFileSync(join(h, ".config/kicad/9.0/kicad_common.json"), '{"mine": true}\n');
      expect(seed(h).code).toBe(0);
      expect(readFileSync(join(h, ".config/kicad/9.0/kicad_common.json"), "utf8")).toBe('{"mine": true}\n');
      expect(existsSync(join(h, ".config/kicad/9.0/fp-lib-table"))).toBe(true);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("never keeps the VM from starting: a home it can't write, or a seed that's gone, and the command still runs", () => {
    const h = home();
    try {
      chmodSync(h, 0o500);
      expect(seed(h, ["sh", "-c", "echo started"])).toMatchObject({ code: 0, out: "started\n" });
      chmodSync(h, 0o700);
      expect(seed(h, ["sh", "-c", "echo started"], { INVINCIBLE_HARDWARE_SEED: join(h, "no-such-seed") })).toMatchObject({ code: 0, out: "started\n" });
      expect(existsSync(join(h, ".config/kicad/9.0/fp-lib-table"))).toBe(false);
    } finally {
      chmodSync(h, 0o700);
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("with no command, it seeds and ends; the command's own exit is the VM's", () => {
    const h = home();
    try {
      expect(seed(h)).toMatchObject({ code: 0, out: "" });
      expect(seed(h, ["sh", "-c", "exit 3"]).code).toBe(3);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });
});
