import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drcAgrees, foundAt, openBoard, plotted, screen, statesOf } from "./hardware.ts";
import type { Ran } from "./vm.ts";

/* What the hardware suite's gates read (C1 step 11): a plot's files, a DRC's exit and report, where `desktop find` says a node is. */

describe("a plot's Gerbers", () => {
  const board = ["board-F_Cu.gbr", "board-B_Cu.gbr", "board-Edge_Cuts.gbr", "board-F_Mask.gbr", "board-job.gbrjob", ""].join("\n");

  test("hold both copper layers and the outline", () => {
    expect(plotted(board)).toBe(true);
    // (With Protel's extensions too: the layer's name is what says it.)
    expect(plotted("board-F_Cu.gtl\nboard-B_Cu.gbl\nboard-Edge_Cuts.gm1\n")).toBe(true);
  });

  test("without one of them, or with nothing, a board wasn't plotted", () => {
    expect(plotted(board.replace("board-Edge_Cuts.gbr", ""))).toBe(false);
    expect(plotted(board.replace("board-B_Cu.gbr", ""))).toBe(false);
    expect(plotted("")).toBe(false);
    // (A name that only has the layer's in it, not as the layer's own, isn't one.)
    expect(plotted("notes-F_Cu-draft.txt\nboard-B_Cu.gbr\nboard-Edge_Cuts.gbr\n")).toBe(false);
    expect(plotted("F_Cu\nB_Cu\nEdge_Cuts\n")).toBe(false);
  });
});

describe("a DRC's exit code and its report", () => {
  test("agree when it found something and exited non-zero, or found nothing and exited 0", () => {
    expect(drcAgrees(5, { violations: 3, unconnected: 0 })).toBe(true);
    expect(drcAgrees(5, { violations: 0, unconnected: 1 })).toBe(true);
    expect(drcAgrees(0, { violations: 0, unconnected: 0 })).toBe(true);
  });

  test("disagree otherwise, and no report is never agreement", () => {
    expect(drcAgrees(0, { violations: 3, unconnected: 0 })).toBe(false);
    expect(drcAgrees(5, { violations: 0, unconnected: 0 })).toBe(false);
    expect(drcAgrees(0, null)).toBe(false);
  });
});

describe("where desktop find says a node is", () => {
  test("its x,y, from the start of what it said", () => {
    expect(foundAt('640,450 · [3] push button "Plot" at 640,450 (80x30)\n')).toEqual([640, 450]);
    expect(foundAt("")).toBeNull();
    expect(foundAt('desktop: no push button named like "Plot" is on the screen\n')).toBeNull();
  });
});

/** A VM whose desktop answers each command as `answer` says (null: it found nothing), every command it was asked kept. */
function answering(answer: (command: string) => string | null) {
  const asked: string[] = [];
  const reply = (command: string): Ran => {
    asked.push(command);
    const out = answer(command);
    return { code: out === null ? 1 : 0, stdout: out ?? "", stderr: "", ms: 1 };
  };
  return { asked, vm: { agent: async (command: string) => reply(command), raw: async (argv: string[]) => reply(argv.join(" ")) } };
}
const nowait = { pause: async () => {} };
/** A PNG's signature: enough of one to be kept as one. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");

describe("a screen case's press that finds nothing", () => {
  test("keeps what was on the screen, the focus, the windows, the tree and the screen itself, says where, and none of that is the agent's turns", async () => {
    const keep = mkdtempSync(join(tmpdir(), "invincible-bench-kept-"));
    const { vm } = answering((command) => {
      if (command.startsWith("desktop find ")) return null;
      if (command === "desktop focus") return 'focus: pcbnew "Loading PCB"';
      if (command === "desktop windows") return '"board — PCB Editor" (pcbnew)\n"Loading PCB" (pcbnew) · focused';
      if (command === "desktop tree") return '[1] progress bar "Loading" at 640,400 (300x20)';
      if (command.includes("desktop shot")) return PNG;
      return "";
    });
    const s = screen(vm, "kicad-plot-3", { keep, ...nowait });
    const error = (await s.press(["menu item"], "Plot...").catch((e: Error) => e)) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('no menu item named like "Plot..." on the screen');
    expect(error.message).toContain('focus: pcbnew "Loading PCB"');
    expect(error.message).toContain(join(keep, "failed-kicad-plot-3-1"));
    expect(readdirSync(keep).sort()).toEqual(["failed-kicad-plot-3-1.png", "failed-kicad-plot-3-1.txt"]);
    expect(readFileSync(join(keep, "failed-kicad-plot-3-1.png")).toString("base64")).toBe(PNG);
    const kept = readFileSync(join(keep, "failed-kicad-plot-3-1.txt"), "utf8");
    for (const part of ['no menu item named like "Plot..."', 'focus: pcbnew "Loading PCB"', '"Loading PCB" (pcbnew) · focused', 'progress bar "Loading"']) expect(kept).toContain(part);
    // (Its ten looks for the item are the agent's; the bench's own, for what was there, aren't.)
    expect(s.commands()).toBe(10);
  });
});

describe("KiCad's quit", () => {
  test("answers its question to save by discarding, so KiCad ends by its own quit and the board stays as the case found it", async () => {
    let quitting = false;
    const { vm, asked } = answering((command) => {
      if (command === "desktop key ctrl+q") return (quitting = true), "pressed ctrl+q";
      if (command === "desktop focus") return quitting ? 'focus: pcbnew "Save Changes?"' : 'focus: pcbnew "board — PCB Editor"';
      if (command === "desktop find 'push button' 'Discard'") return quitting ? '412,388 · [7] push button "Discard Changes" at 412,388 (120x30)' : null;
      if (command.startsWith("desktop click ")) return "clicked";
      return "";
    });
    await screen(vm, "kicad-plot-1", { keep: mkdtempSync(join(tmpdir(), "invincible-bench-kept-")), ...nowait }).quit(/Save Changes\?/, "Discard");
    expect(asked.filter((c) => !c.startsWith("desktop focus"))).toEqual(["desktop key ctrl+q", "desktop find 'push button' 'Discard'", "desktop click 412 388"]);
  });

  test("asks nothing more of an app that ends without asking", async () => {
    const { vm, asked } = answering((command) => (command === "desktop focus" ? 'focus: Chromium "about:blank - Chromium"' : command.startsWith("desktop find ") ? null : ""));
    await screen(vm, "kicad-plot-2", { keep: mkdtempSync(join(tmpdir(), "invincible-bench-kept-")), ...nowait }).quit(/Save Changes\?/, "Discard");
    expect(asked.filter((c) => !c.startsWith("desktop focus"))).toEqual(["desktop key ctrl+q"]);
  });
});

describe("KiCad's board editor, ready for its menus", () => {
  /** pcbnew on the board, its editor with the focus and the screen settled at once, and "Loading PCB" up for `loading` looks. */
  const opening = (loading: number) => {
    let looks = 0;
    return answering((command) => {
      if (command.startsWith("desktop app pcbnew ")) return "started pcbnew";
      if (command === "desktop focus") return 'focus: pcbnew "board — PCB Editor"';
      if (command.includes("probe.py settle-full")) return '{"settled":true}';
      if (command === "desktop windows") return looks++ < loading ? '"board — PCB Editor" (pcbnew)\n"Loading PCB" (KiCad PCB Editor) · focused' : '"board — PCB Editor" (pcbnew) · focused';
      if (command.includes("desktop shot")) return PNG;
      return "";
    });
  };

  test("only once \"Loading PCB\" is gone: the editor's focus and a still screen aren't enough, as its menus take no click while it is up", async () => {
    const { vm, asked } = opening(3);
    const s = screen(vm, "kicad-plot-1", { keep: mkdtempSync(join(tmpdir(), "invincible-bench-kept-")), ...nowait });
    expect(await openBoard(s, "/work/bench/hw/board.kicad_pcb")).toBeNull();
    // (Looked at until it was gone: three times with it up, once without.)
    expect(asked.filter((c) => c === "desktop windows")).toHaveLength(4);
    expect(asked.lastIndexOf("desktop windows")).toBeGreaterThan(asked.findLastIndex((c) => c.includes("probe.py settle-full")));
  });

  test("not ready while \"Loading PCB\" never goes, and says so with what was on the screen", async () => {
    const keep = mkdtempSync(join(tmpdir(), "invincible-bench-kept-"));
    const { vm } = opening(Infinity);
    const error = (await openBoard(screen(vm, "kicad-plot-2", { keep, ...nowait }), "/work/bench/hw/board.kicad_pcb").catch((e: Error) => e)) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('"Loading PCB" still on the screen');
    expect(readdirSync(keep).sort()).toEqual(["failed-kicad-plot-2-1.png", "failed-kicad-plot-2-1.txt"]);
  });
});

describe("what desktop find says of a node's states", () => {
  test("the states after its place and size, never its name", () => {
    expect(statesOf('19,31 · [1] menu "File" at 19,31 (39x25) disabled\n')).toEqual(["disabled"]);
    expect(statesOf('1085,629 · [15] check box "All items" at 1085,629 (79x20) checked focused\n')).toEqual(["checked", "focused"]);
    expect(statesOf('640,450 · [3] push button "Plot" at 640,450 (80x30)\n')).toEqual([]);
    // (A name with a state's word in it is a name.)
    expect(statesOf('300,200 · [4] push button "Show disabled (2x2) items" at 300,200 (90x30)\n')).toEqual([]);
    expect(statesOf("")).toEqual([]);
  });
});

describe("a press on what takes no click yet", () => {
  test("waits for it to be enabled, as a menu is once its editor has loaded, and clicks it once: clicked disabled, it does nothing", async () => {
    let looks = 0;
    const { vm, asked } = answering((command) => {
      if (command === "desktop find 'menu' 'File'") return looks++ < 2 ? '19,31 · [1] menu "File" at 19,31 (39x25) disabled' : '19,31 · [1] menu "File" at 19,31 (39x25)';
      if (command.startsWith("desktop click ")) return "clicked";
      return "";
    });
    await screen(vm, "kicad-plot-1", { keep: mkdtempSync(join(tmpdir(), "invincible-bench-kept-")), ...nowait }).press(["menu"], "File");
    expect(asked.filter((c) => c.startsWith("desktop click "))).toEqual(["desktop click 19 31"]);
    expect(asked.indexOf("desktop click 19 31")).toBe(3);
  });

  test("one that stays disabled is said so, with what was on the screen", async () => {
    const keep = mkdtempSync(join(tmpdir(), "invincible-bench-kept-"));
    const { vm, asked } = answering((command) => {
      if (command === "desktop find 'menu' 'File'") return '19,31 · [1] menu "File" at 19,31 (39x25) disabled';
      if (command.includes("desktop shot")) return PNG;
      return "";
    });
    const error = (await screen(vm, "kicad-plot-2", { keep, ...nowait }).press(["menu"], "File").catch((e: Error) => e)) as Error;
    expect(error.message).toContain('the menu named like "File" stayed disabled');
    expect(asked.some((c) => c.startsWith("desktop click "))).toBe(false);
    expect(readdirSync(keep).sort()).toEqual(["failed-kicad-plot-2-1.png", "failed-kicad-plot-2-1.txt"]);
  });
});

describe("KiCad's board editor, its board loaded", () => {
  test("ready only once its title names the board: before, it's \"PCB Editor\" alone, its menus disabled and \"Loading PCB\" not up yet", async () => {
    let looks = 0;
    const { vm, asked } = answering((command) => {
      if (command.startsWith("desktop app pcbnew ")) return "started pcbnew";
      if (command === "desktop focus") return looks++ < 3 ? 'focus: pcbnew "PCB Editor"' : 'focus: pcbnew "board — PCB Editor"';
      if (command.includes("probe.py settle-full")) return '{"settled":true}';
      if (command === "desktop windows") return '"PCB Editor" (pcbnew) · focused';
      return "";
    });
    const s = screen(vm, "kicad-plot-1", { keep: mkdtempSync(join(tmpdir(), "invincible-bench-kept-")), ...nowait });
    expect(await openBoard(s, "/work/bench/hw/board.kicad_pcb")).toBeNull();
    const focus = asked.filter((c) => c === "desktop focus");
    expect(focus.length).toBeGreaterThanOrEqual(4);
    expect(asked.findIndex((c) => c.includes("probe.py settle-full"))).toBeGreaterThan(asked.lastIndexOf("desktop focus"));
  });

  test("one that never names its board isn't ready, and says why", async () => {
    const { vm } = answering((command) => (command.startsWith("desktop app pcbnew ") ? "started pcbnew" : command === "desktop focus" ? 'focus: pcbnew "PCB Editor"' : ""));
    expect(await openBoard(screen(vm, "kicad-plot-2", { keep: mkdtempSync(join(tmpdir(), "invincible-bench-kept-")), ...nowait }), "/work/bench/hw/board.kicad_pcb")).toBe("the PCB editor never named its board: it never loaded it");
  });
});
