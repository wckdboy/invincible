import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { DESKTOP_IMAGE, HARDWARE_IMAGE } from "../../packages/sandbox/src/spec.ts";
import { OUT_DIR } from "../scorecard.ts";
import type { Samples } from "./measure.ts";
import { spawnDocker } from "./scratch.ts";
import { type Bench, type BenchVm, IN_VM, type Ran, ROOT } from "./vm.ts";

/*
 * The hardware image's cases (C1 step 11): C0's two examples (26 November 2026), a board made by KiCad's Python and a
 * part made by FreeCAD's, each worked as an agent is told to work them (agents' hardwareBriefing):
 *  - by script, first: kicad-cli for every output and as the check (Gerbers; DRC as JSON, its exit code agreeing),
 *    kipy for an edit on the running board editor (KiCad's API), freecadcmd for the part (STEP, read back);
 *  - by Computer Use, where a person would: KiCad's Plot, and FreeCAD's STEP export, with the careful policy (each
 *    commit key once the screen has settled, text typed once its window has the focus), the apps started with
 *    `desktop app` and their targets read from the accessibility tree with `desktop find`, as the agent's own.
 * Every step is one command through the agent's own path (BenchVm.agent), and every case ends at a gate that reads what
 * was made, never the screen.
 */

const HW = `${IN_VM}/hw`;
const OUT = `${IN_VM}/out`;
const BOARD = `${HW}/board.kicad_pcb`;
const PART = `${HW}/box.FCStd`;
/** C0's part, its volume read back from STEP: 1000 - pi * 1.5^2 * 5 mm^3. */
export const PART_VOLUME = "964.66";
/** The layers whose Gerbers say a board was plotted: both copper layers and its outline. */
export const PLOTTED = ["F_Cu", "B_Cu", "Edge_Cuts"] as const;

/** A case's runs: their times, how many passed their gate, and why one didn't. */
export interface Case {
  ms: Samples;
  passed: number;
  of: number;
  why: string | null;
  /** Commands a run took (by screen). */
  commands?: number;
}

const must = (r: Ran, what: string): Ran => {
  if (r.code !== 0) throw new Error(`${what} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(-300)}`);
  return r;
};
const lastJson = (text: string, prefix = ""): Record<string, any> | null => {
  const line = text.split("\n").reverse().find((l) => l.startsWith(prefix) && l.slice(prefix.length).trim().startsWith("{"));
  try {
    return line ? JSON.parse(line.slice(prefix.length)) : null;
  } catch {
    return null;
  }
};

/** Whether the Gerbers a plot made (`ls` of where they went) hold each layer that says a board was plotted. */
export function plotted(listing: string): boolean {
  const files = listing.split("\n").map((f) => f.trim()).filter(Boolean);
  return PLOTTED.every((layer) => files.some((f) => f.includes(`-${layer}.`)));
}

/** Whether a DRC's exit code says what its report says: none found and 0, or some found and not 0. */
export function drcAgrees(exit: number, report: { violations: number; unconnected: number } | null): boolean {
  return report !== null && (report.violations + report.unconnected > 0) === (exit !== 0);
}

/**
 * The states `desktop find` says its node is in (focused, checked, disabled…): the words after its place and size, never
 * its name's.
 */
export function statesOf(said: string): string[] {
  const line = said.trim().split("\n")[0] ?? "";
  const after = /\(\d+x\d+\)((?: [a-z-]+)*)$/.exec(line);
  return after ? after[1]!.trim().split(" ").filter(Boolean) : [];
}

/** Where `desktop find` says the node is, x,y; null when it found none. */
export function foundAt(said: string): [number, number] | null {
  const m = /^(\d+),(\d+) /.exec(said.trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** The hardware image under the bench's names, from this checkout, made on the bench's desktop image (images.ts). */
export async function buildHardware(b: Bench, root = ROOT): Promise<number> {
  const desktop = b.names.image(DESKTOP_IMAGE);
  const hardware = b.names.image(HARDWARE_IMAGE);
  b.log(`building ${hardware} from this checkout (KiCad and FreeCAD: minutes the first time)`);
  const ran = await spawnDocker(["buildx", "build", "--quiet", "--load", "--build-context", `${DESKTOP_IMAGE}=docker-image://${desktop}`, "-t", hardware, join(root, "sandbox/hardware")], 60 * 60_000);
  if (ran.code !== 0) throw new Error(`the bench's hardware image didn't build:\n${ran.stderr.trim().split("\n").slice(-12).join("\n")}`);
  const size = await spawnDocker(["image", "inspect", hardware, "--format", "{{.Size}}"], 30_000);
  return Number(size.stdout.trim());
}

const timed = async (n: number, run: (i: number) => Promise<{ ms: number; ok: boolean; why?: string }>): Promise<Case> => {
  const t0 = performance.now();
  const samples: number[] = [];
  let passed = 0;
  let why: string | null = null;
  for (let i = 1; i <= n; i++) {
    const r = await run(i);
    samples.push(r.ms);
    if (r.ok) passed++;
    else why ??= r.why ?? "its gate failed";
  }
  return { ms: { samples, span: [t0, performance.now()] }, passed, of: n, why };
};

/**
 * The VM's processes of those names (pgrep -x), stopped by their PIDs if they haven't ended in 3 s: what a case
 * started, gone before the next. (Debian runs FreeCAD as freecad-python3, its alternative for freecad.)
 */
async function stopAll(vm: BenchVm, ...names: string[]): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const pids = (await Promise.all(names.map((name) => vm.raw(["pgrep", "-x", name])))).flatMap((r) => r.stdout.split("\n")).filter((p) => /^\d+$/.test(p));
    if (!pids.length) return;
    if (i === 10) for (const pid of pids) await vm.raw(["kill", pid]);
    await Bun.sleep(300);
  }
}

/** The fixtures, made once and not timed: the board by KiCad's Python, the part (and its FreeCAD file) by FreeCAD's. */
export async function fixtures(vm: BenchVm): Promise<void> {
  must(await vm.agent(`mkdir -p ${OUT} && python3 ${HW}/board.py ${BOARD}`), "the board");
  must(await vm.agent(`BENCH_STEP=${OUT}/box-0.step BENCH_FCSTD=${PART} freecadcmd -c "exec(open('${HW}/box.py').read())"`), "the part");
}

/** C0's examples by script, `n` runs each, as an agent's commands, each to its gate. */
export async function byScript(vm: BenchVm, n: number): Promise<Record<"gerbers" | "drc" | "edit" | "step", Case>> {
  const gerbers = await timed(n, async (i) => {
    const r = await vm.agent(`rm -rf ${OUT}/gerb-${i} && kicad-cli pcb export gerbers --output ${OUT}/gerb-${i}/ ${BOARD} >/dev/null && ls ${OUT}/gerb-${i}`);
    return { ms: r.ms, ok: r.code === 0 && plotted(r.stdout), why: `exit ${r.code}: ${(r.stderr || r.stdout).trim().slice(-160)}` };
  });
  const drc = await timed(n, async (i) => {
    const r = await vm.agent(`kicad-cli pcb drc --format json --exit-code-violations --output ${OUT}/drc-${i}.json ${BOARD} >/dev/null; echo "exit $?"; python3 -c "import json;d=json.load(open('${OUT}/drc-${i}.json'));print(json.dumps({'violations':len(d.get('violations',[])),'unconnected':len(d.get('unconnected_items',[]))}))"`);
    const exit = Number(/^exit (\d+)$/m.exec(r.stdout)?.[1] ?? -1);
    const report = lastJson(r.stdout) as { violations: number; unconnected: number } | null;
    return { ms: r.ms, ok: drcAgrees(exit, report), why: `exit ${exit}, report ${JSON.stringify(report)}` };
  });
  // An edit through KiCad's API (kipy) on the board open in its editor, as the briefing says: every track to a width of
  // its own each run, saved, and read back from the file by KiCad's own Python module.
  must(await vm.agent(`desktop app pcbnew ${BOARD}`), "pcbnew started");
  let ready = false;
  for (let i = 0; i < 120 && !ready; i++) {
    ready = (await vm.agent(`python3 ${HW}/edit.py --ping`)).code === 0;
    if (!ready) await Bun.sleep(500);
  }
  if (!ready) throw new Error("KiCad's API never answered from the open board editor (its API server seeded on: kicad_common.json)");
  const edit = await timed(n, async (i) => {
    const width = (0.3 + 0.05 * i).toFixed(2);
    const r = await vm.agent(`python3 ${HW}/edit.py ${width}`);
    const back = lastJson((await vm.agent(`python3 ${HW}/widths.py ${BOARD}`)).stdout);
    return { ms: r.ms, ok: r.code === 0 && JSON.stringify(back?.widths) === `[${Number(width)}]`, why: `exit ${r.code}, widths ${JSON.stringify(back?.widths)}: ${r.stderr.trim().slice(-160)}` };
  });
  await vm.agent("desktop key ctrl+q");
  await stopAll(vm, "pcbnew");
  const step = await timed(n, async (i) => {
    const r = await vm.agent(`BENCH_STEP=${OUT}/box-${i}.step freecadcmd -c "exec(open('${HW}/box.py').read())" 2>&1`);
    const got = lastJson(r.stdout, "BENCH ");
    return { ms: r.ms, ok: r.code === 0 && got?.ok === true, why: `exit ${r.code}: ${JSON.stringify(got) ?? r.stdout.trim().slice(-160)}` };
  });
  return { gerbers, drc, edit, step };
}

/** What a run through the screen asks of its VM: commands as the agent runs them, and the bench's own. */
type OnScreen = Pick<BenchVm, "agent" | "raw">;

/**
 * One run through the screen: its commands counted, its targets from the accessibility tree, the careful policy. A
 * press that finds nothing leaves what was on the screen, to look at (`keep`: bench/out/hardware/, never committed), in
 * files named by the run's `label`, so a miss says why.
 */
export function screen(vm: OnScreen, label: string, opts: { keep?: string; pause?: (ms: number) => Promise<unknown> } = {}) {
  const keep = opts.keep ?? join(OUT_DIR, "hardware");
  const pause = opts.pause ?? ((ms: number) => Bun.sleep(ms));
  let commands = 0;
  let misses = 0;
  const sh = async (command: string): Promise<Ran> => {
    commands++;
    return vm.agent(command);
  };
  const settle = () => sh(`python3 ${IN_VM}/probe.py settle-full 6 300`);
  const focusIs = async (title: RegExp, tries = 30): Promise<string | null> => {
    for (let i = 0; i < tries; i++) {
      const said = (await sh("desktop focus")).stdout.trim();
      if (title.test(said)) return said;
      await pause(200);
    }
    return null;
  };
  /**
   * What was on the screen as a press found nothing, by the bench's own looks (no agent's turn): the focus, the windows,
   * the tree and the screen itself, kept; the focus, and where they went, said.
   */
  const kept = async (missed: string): Promise<string> => {
    const said = async (argv: string[]) => (await vm.raw(argv)).stdout.trim();
    const focus = await said(["desktop", "focus"]);
    const windows = await said(["desktop", "windows"]);
    const tree = await said(["desktop", "tree"]);
    const shot = await vm.raw(["sh", "-c", "f=/tmp/failed.png; desktop shot $f >/dev/null && base64 -w0 $f"]);
    const base = join(keep, `failed-${label}-${++misses}`);
    mkdirSync(keep, { recursive: true });
    writeFileSync(`${base}.txt`, `${[missed, focus, windows, tree].join("\n\n")}\n`);
    const png = shot.code === 0 && shot.stdout.trim() !== "";
    if (png) writeFileSync(`${base}.png`, Buffer.from(shot.stdout.trim(), "base64"));
    return `${focus.split("\n")[0]}; kept: ${base}.txt${png ? " and .png" : ""}`;
  };
  /**
   * The first of `roles` named like `name` on the screen, pressed where `desktop find` says it is, once it takes a
   * click: one deskd says is disabled (a menu, while its editor loads) is waited for, as a click on it does nothing.
   */
  const press = async (roles: string[], name: string): Promise<void> => {
    let disabled = false;
    for (let i = 0; i < 10; i++) {
      for (const role of roles) {
        const said = (await sh(`desktop find '${role}' '${name}'`)).stdout;
        const at = foundAt(said);
        if (!at) continue;
        if (statesOf(said).includes("disabled")) {
          disabled = true;
          continue;
        }
        must(await sh(`desktop click ${at[0]} ${at[1]}`), `the click on ${role} "${name}"`);
        return;
      }
      await pause(300);
    }
    const missed = disabled ? `the ${roles.join(" or ")} named like "${name}" stayed disabled` : `no ${roles.join(" or ")} named like "${name}" on the screen`;
    throw new Error(`${missed} (${await kept(missed)})`);
  };
  /**
   * The app quit by its own key, as a person quits it: where it asks first whether to save (its focus like `asks`), its
   * changes discarded by the button named like `discard`, so it ends by its quit, never by stopAll's kill.
   */
  const quit = async (asks: RegExp, discard: string): Promise<void> => {
    await sh("desktop key ctrl+q");
    if (await focusIs(asks, 10)) await press(["push button"], discard);
  };
  /**
   * Until no window like `title` is on the screen (`desktop windows`): a modal one, as a progress dialog is, takes the
   * clicks meant for the window under it. Still there after `tries` looks, a quarter of a second apart, it is said, with
   * what was on the screen.
   */
  const gone = async (title: RegExp, tries = 60): Promise<void> => {
    for (let i = 0; i < tries; i++) {
      if (!title.test((await sh("desktop windows")).stdout)) return;
      await pause(250);
    }
    const missed = `${title.source} still on the screen after ${(tries * 250) / 1000} s`;
    throw new Error(`${missed} (${await kept(missed)})`);
  };
  return { sh, settle, focusIs, press, quit, gone, commands: () => commands };
}

/**
 * KiCad's board editor open on `board`, ready for its menus: null when it is, otherwise why it isn't. Ready is its board
 * loaded, its title naming it ("board — PCB Editor"), the screen settled, and no "Loading PCB" up. The editor takes the
 * focus before it loads its board, as "PCB Editor" alone: then its menus are disabled and "Loading PCB" isn't up yet, so
 * neither that dialog nor a still screen says the board is in (a pcbnew's first start in a VM clicked File there, every
 * time, and opened no menu: Ultra, 27 November 2026).
 */
export async function openBoard(s: ReturnType<typeof screen>, board: string): Promise<string | null> {
  const loaded = new RegExp(`"${basename(board, ".kicad_pcb").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} — PCB Editor"`);
  must(await s.sh(`desktop app pcbnew ${board}`), "pcbnew started");
  const first = await s.focusIs(/PCB Editor|File Open Warning|Configure Global/);
  if (!first) return "no KiCad window took the focus";
  if (/Configure Global/.test(first)) return "KiCad asked for its global library table: its seed didn't take";
  if (/File Open Warning/.test(first)) await s.press(["push button"], "Open Anyway");
  if (!(await s.focusIs(loaded))) return "the PCB editor never named its board: it never loaded it";
  await s.settle();
  await s.gone(/"Loading PCB"/);
  return null;
}

/** C0's examples through the screen, `n` runs each, as C0 found them done (KiCad's Plot, FreeCAD's STEP export). */
export async function byScreen(vm: BenchVm, n: number): Promise<Record<"kicadPlot" | "freecadStep", Case>> {
  const counted: Record<"kicadPlot" | "freecadStep", number> = { kicadPlot: 0, freecadStep: 0 };
  const kicadPlot = await timed(n, async (i) => {
    const s = screen(vm, `kicad-plot-${i}`);
    const t0 = performance.now();
    let acted = 0;
    try {
      await s.sh(`rm -f ${HW}/*.gbr ${HW}/*.gbrjob`);
      const notReady = await openBoard(s, BOARD);
      if (notReady) return { ms: performance.now() - t0, ok: false, why: notReady };
      await s.press(["menu"], "File");
      await s.press(["menu item"], "Plot...");
      if (!(await s.focusIs(/"Plot"/))) return { ms: performance.now() - t0, ok: false, why: "the Plot dialog never took the focus" };
      await s.settle();
      await s.press(["push button"], "Plot");
      acted = performance.now() - t0;
      let listing = "";
      for (let i = 0; i < 20 && !plotted(listing); i++) {
        listing = (await vm.raw(["sh", "-c", `ls ${HW}`])).stdout;
        if (!plotted(listing)) await Bun.sleep(300);
      }
      await s.press(["push button"], "Close").catch(() => {});
      await s.settle();
      // (The Plot keeps its settings in the board, so KiCad asks whether to save it as it quits: discarded, the board
      // stays as the case found it, and KiCad ends by its quit. The gate is the plot: stopAll is still there after.)
      await s.quit(/Save Changes\?/, "Discard").catch(() => {});
      return { ms: acted, ok: plotted(listing), why: `the plot made: ${listing.split("\n").filter((f) => f.includes(".g")).join(" ") || "nothing"}` };
    } catch (error) {
      return { ms: acted || performance.now() - t0, ok: false, why: (error as Error).message };
    } finally {
      counted.kicadPlot = Math.max(counted.kicadPlot, s.commands());
      await stopAll(vm, "pcbnew");
    }
  });
  const freecadStep = await timed(n, async (i) => {
    const s = screen(vm, `freecad-step-${i}`);
    const t0 = performance.now();
    let acted = 0;
    const file = `${OUT}/screen-${i}.step`;
    try {
      await s.sh(`rm -f ${file}`);
      must(await s.sh(`desktop app freecad ${PART}`), "FreeCAD started");
      if (!(await s.focusIs(/FreeCAD/, 60))) return { ms: performance.now() - t0, ok: false, why: "FreeCAD never took the focus" };
      await s.settle();
      await s.press(["page tab"], "Model");
      await s.press(["tree item", "table cell", "list item"], "Block");
      await s.sh("desktop key ctrl+e");
      if (!(await s.focusIs(/Export/))) return { ms: performance.now() - t0, ok: false, why: "the export dialog never took the focus" };
      await s.settle();
      // (The dialog exports by the filter chosen, not by the name typed: STEP first. It opens on another.)
      await s.press(["combo box"], "(*.");
      await s.settle();
      await s.press(["list item"], "(*.step");
      await s.settle();
      await s.press(["text"], "File name");
      await s.sh("desktop key ctrl+a");
      await s.sh(`desktop type '${file}'`);
      await s.settle();
      await s.sh("desktop key Return");
      await s.settle();
      // STEP's own options: accepted as they are.
      if (await s.focusIs(/"STEP/, 10)) {
        await s.settle();
        await s.sh("desktop key Return");
        await s.settle();
      }
      acted = performance.now() - t0;
      const got = lastJson((await vm.agent(`BENCH_STEP=${file} freecadcmd -c "exec(open('${HW}/volume.py').read())" 2>&1`)).stdout, "BENCH ");
      await s.sh("desktop key ctrl+q");
      return { ms: acted, ok: got?.volume?.toFixed?.(2) === PART_VOLUME, why: `the export read back: ${JSON.stringify(got)}` };
    } catch (error) {
      return { ms: acted || performance.now() - t0, ok: false, why: (error as Error).message };
    } finally {
      counted.freecadStep = Math.max(counted.freecadStep, s.commands());
      await stopAll(vm, "freecad", "freecad-python3");
    }
  });
  return { kicadPlot: { ...kicadPlot, commands: counted.kicadPlot }, freecadStep: { ...freecadStep, commands: counted.freecadStep } };
}
