import { describe, expect, test } from "bun:test";
import { drcAgrees, foundAt, plotted } from "./hardware.ts";

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
