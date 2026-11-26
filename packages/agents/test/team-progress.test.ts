import { describe, expect, test } from "bun:test";
import type { RunEvent } from "../src/run.ts";
import { progress } from "../src/team-runtime.ts";

/*
 * What a task's trail says of each step of its run (team-runtime.ts `progress`): the runner's own words, a line each.
 */

describe("a task's trail", () => {
  test("says nothing of a run's end: how it ended is the task's verdict, beside its proof, never a bare 'finished'", () => {
    // (26 November 2026: every ended task's thread showed a step that said "finished", and nothing else.)
    const outcome = { status: "done", summary: "Verified.", steps: 3, revisions: 0 } as unknown as Extract<RunEvent, { type: "finished" }>["outcome"];
    expect(progress({ type: "finished", outcome })).toBe("");
  });

  test("every other step is said in words, never as the bare name of its event", () => {
    const said = [
      progress({ type: "command", step: 1, command: "bun test" } as RunEvent),
      progress({ type: "thought", step: 1, text: "Looking at the importer." } as RunEvent),
      progress({ type: "submitted", summary: "Done." } as RunEvent),
    ];
    for (const line of said) expect(line).toMatch(/ · /);
  });
});
