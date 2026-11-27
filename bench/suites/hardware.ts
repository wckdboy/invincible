import { buildHardware, byScreen, byScript, type Case, fixtures } from "../desktop/hardware.ts";
import { buildImages } from "../desktop/images.ts";
import { bench, BenchVm, cannotRunHere, clearLeftovers } from "../desktop/vm.ts";
import { sig, type Suite, type SuiteContext } from "../lib.ts";

/*
 * The hardware image (C1 step 11): an agent's desktop with KiCad and FreeCAD, made as the node makes one for an agent
 * given the hardware tools, and C0's two examples worked on it (bench/desktop/hardware.ts): by script, as its briefing
 * tells an agent, and through the screen, where a person would. Like the desktop suite it needs Docker with Kata, so it
 * runs on a sandbox host alone, under the bench's own names (desktop/scratch.ts), its VM removed whatever happens;
 * elsewhere it is skipped, and said to be, and never a pass.
 */

/** Runs of each case. */
const N = 5;

const NOTE = {
  gerbers: "kicad-cli pcb export gerbers of C0's board, its copper and outline Gerbers there after",
  drc: "kicad-cli pcb drc --format json --exit-code-violations of C0's board, its report read and its exit code agreeing",
  edit: "every track of C0's board to a width of its own through KiCad's API (kipy) on the open board editor, saved, read back from the file",
  step: "C0's part made by freecadcmd (a block with a hole), exported as STEP and read back, its volume right",
  kicadPlot: "KiCad's Plot through the screen (File, Plot..., Plot), from the editor's start to the press, its Gerbers there after",
  freecadStep: "FreeCAD's STEP export through the screen (Model, Block, Export, the STEP filter, a name), from its start to the export, read back",
};

/** A case: its time (the median of its runs), its runs that passed their gate, and what it took through the screen. */
function record(ctx: SuiteContext, id: string, c: Case, note: string): void {
  ctx.speed(`${id}.ms`, c.ms.samples, "ms", "lower", c.ms.span, note);
  ctx.quality(id, c.passed, `of ${c.of}`, "higher", { n: c.of, note: `${note}: runs that passed their gate${c.passed < c.of && c.why ? `; one that didn't: ${c.why.slice(0, 160)}` : ""}` });
  if (c.commands !== undefined) ctx.quality(`${id}.commands`, c.commands, "commands", "lower", { note: `${note}: the most commands a run took, each an agent's turn` });
}

export const suite: Suite = {
  name: "hardware",
  about: "the hardware image: KiCad and FreeCAD in an agent's Kata microVM, C0's two examples by script and through the screen",
  headline: ["hardware.script.gerbers.ms", "hardware.script.drc.ms", "hardware.script.edit.ms", "hardware.script.step.ms", "hardware.screen.kicad-plot.ms", "hardware.screen.freecad-step.ms", "hardware.image.gb"],
  cannot: cannotRunHere,
  strict: { noiseFloor: 0.2 },
  asMeasured: true,
  // C1 step 11: by script, each within a second and through its gate every time; through the screen, every time, KiCad's
  // Plot within 10 s and FreeCAD's STEP export within 20 s (C0: 6.3-6.8 s and 13.8-17.7 s); the image at most 6 GB (5.53).
  held: {
    "hardware.script.gerbers": N,
    "hardware.script.drc": N,
    "hardware.script.edit": N,
    "hardware.script.step": N,
    "hardware.script.gerbers.ms": 1000,
    "hardware.script.drc.ms": 1000,
    "hardware.script.edit.ms": 1000,
    "hardware.script.step.ms": 1000,
    "hardware.screen.kicad-plot": N,
    "hardware.screen.freecad-step": N,
    "hardware.screen.kicad-plot.ms": 10_000,
    "hardware.screen.freecad-step.ms": 20_000,
    "hardware.image.gb": 6,
  },
  async run(ctx) {
    const prefix = process.env.INVINCIBLE_BENCH_SCRATCH ?? "bench";
    const b = bench(prefix, ctx.log);
    const left = await clearLeftovers(b);
    if (left) ctx.log(`removed ${left} things an earlier run of the bench left behind`);
    await buildImages(b);
    const size = await buildHardware(b);
    ctx.quality("hardware.image.gb", sig(size / 1e9, 3), "GB", "lower", { resolution: 0.02, note: "the hardware image as built from this checkout: the desktop's, with KiCad and FreeCAD from Debian trixie and kipy" });
    // One VM, 1 vCPU and 4 GB, as an agent's VM with the hardware tools is once its desktop is used.
    const { vm } = await BenchVm.make(b, { desktop: true, hardware: true, memoryGb: 4, seed: ctx.seed });
    try {
      await vm.ready(ctx.seed);
      await fixtures(vm);
      const script = await byScript(vm, N);
      record(ctx, "hardware.script.gerbers", script.gerbers, NOTE.gerbers);
      record(ctx, "hardware.script.drc", script.drc, NOTE.drc);
      record(ctx, "hardware.script.edit", script.edit, NOTE.edit);
      record(ctx, "hardware.script.step", script.step, NOTE.step);
      const shown = await byScreen(vm, N);
      record(ctx, "hardware.screen.kicad-plot", shown.kicadPlot, NOTE.kicadPlot);
      record(ctx, "hardware.screen.freecad-step", shown.freecadStep, NOTE.freecadStep);
    } finally {
      await vm.remove().catch((error) => ctx.log(`couldn't remove ${vm.container}: ${(error as Error).message}`));
      const still = await clearLeftovers(b);
      if (still) ctx.log(`removed ${still} more of the bench's own`);
    }
  },
};
