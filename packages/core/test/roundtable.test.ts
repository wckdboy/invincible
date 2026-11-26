import { describe, expect, test } from "bun:test";
import { chooseKnight, type KnightFacts } from "../src/roundtable.ts";

/*
 * The Roundtable is a technocracy: the knight best suited to a task takes it, and evidence decides, never rank.
 * Pure: the node gathers the facts (each knight's record, its tasks, its VM as its host says now) and this says who,
 * and why, in words the owner reads.
 */

const knight = (id: string, over: Partial<KnightFacts> = {}): KnightFacts => ({
  id, name: id[0]!.toUpperCase() + id.slice(1), instructions: "Make small, verifiable changes.", role: "engineer", enabled: true,
  dailyTurns: 40, turnsToday: 0, repository: null, vm: { image: "galahad/sandbox:1", status: "running" }, tasks: [], ...over,
});
const verified = (n: number) => Array.from({ length: n }, () => ({ status: "done" as const, verified: true }));
const failed = (n: number) => Array.from({ length: n }, () => ({ status: "failed" as const, verified: false }));

describe("who takes a task", () => {
  test("a knight that can't take it is never chosen, and the reason is said: paused, its day's turns spent, no desktop, another repository", () => {
    const { choice, considered } = chooseKnight("Open the dashboard in the browser and click Export.", { desktop: true, repository: "https://github.com/you/app" }, [
      knight("gawain", { enabled: false, repository: "https://github.com/you/app", vm: { image: "galahad/desktop:1", status: "running" } }),
      knight("bedivere", { turnsToday: 40, repository: "https://github.com/you/app", vm: { image: "galahad/desktop:1", status: "running" } }),
      knight("percival", { repository: "https://github.com/you/app" }),
      knight("gareth", { repository: "https://github.com/you/other", vm: { image: "galahad/desktop:1", status: "running" } }),
      knight("kay", { vm: { image: "galahad/desktop:1", status: "running" } }),
    ]);
    expect(choice).toBeNull();
    const why = Object.fromEntries(considered.map((c) => [c.id, c.why.join("; ")]));
    expect(why).toEqual({
      gawain: "paused",
      bedivere: "its turns for today are spent (40 of 40)",
      percival: "its VM has no desktop",
      gareth: "it works on github.com/you/other",
      kay: "it has no repository",
    });
    expect(considered.every((c) => !c.eligible)).toBe(true);
  });

  test("the same repository is the same however it is written", () => {
    const { choice } = chooseKnight("Fix the importer.", { repository: "https://github.com/You/App.git/" }, [knight("percival", { repository: "https://github.com/you/app" })]);
    expect(choice?.id).toBe("percival");
  });

  test("of those that can, a free knight before a busy one, and one whose work has been verified before one whose has not", () => {
    const busy = knight("gawain", { tasks: [...verified(3), { status: "running", verified: false }] });
    const proven = knight("bedivere", { tasks: verified(3) });
    const shaky = knight("percival", { tasks: [...verified(1), ...failed(2)] });
    const { choice, considered } = chooseKnight("Fix the importer.", {}, [busy, shaky, proven]);
    expect(choice).toEqual({ id: "bedivere", name: "Bedivere", reasons: ["free now", "3 of 3 tasks verified"] });
    // Everyone considered, best first, each with its own reasons.
    expect(considered.map((c) => c.id)).toEqual(["bedivere", "percival", "gawain"]);
    expect(considered.find((c) => c.id === "gawain")!.why).toContain("busy: 1 task running");
    expect(considered.find((c) => c.id === "percival")!.why).toContain("1 of 3 tasks verified");
  });

  test("a knight whose job speaks of the task's work is preferred, and the words that matched are said", () => {
    const { choice } = chooseKnight("Review the pull request for the billing migration and check its tests.", {}, [
      knight("gawain"),
      knight("bedivere", { instructions: "Reviews changes before they ship: reads the diff, runs the tests, says what is missing." }),
    ]);
    expect(choice?.id).toBe("bedivere");
    expect(choice?.reasons).toContain("its job speaks of reviews and tests");
  });

  test("a task that speaks of a browser or a screen prefers a knight with a desktop, without requiring one", () => {
    const facts = [knight("gawain"), knight("bedivere", { vm: { image: "galahad/desktop:1", status: "running" } })];
    const { choice } = chooseKnight("Open https://example.com and read the page title.", {}, facts);
    expect(choice).toMatchObject({ id: "bedivere", reasons: expect.arrayContaining(["has a desktop, which the task looks to need"]) });
    // Asked for nothing of a screen, the desktop counts for nothing.
    expect(chooseKnight("Fix the importer.", {}, facts).choice?.reasons).not.toContain("has a desktop, which the task looks to need");
  });

  test("a knight with no VM yet can still take a task (its VM is made when it starts), behind one whose VM is ready", () => {
    const { choice, considered } = chooseKnight("Fix the importer.", {}, [knight("gawain", { vm: null }), knight("bedivere")]);
    expect(choice?.id).toBe("bedivere");
    expect(considered.find((c) => c.id === "gawain")).toMatchObject({ eligible: true, why: expect.arrayContaining(["its VM is made when the task starts"]) });
    expect(chooseKnight("Fix the importer.", {}, [knight("gawain", { vm: null })]).choice?.id).toBe("gawain");
  });

  test("equally suited, the one that has done less today takes it, then by name: the same facts always give the same knight", () => {
    const facts = [knight("percival", { turnsToday: 3 }), knight("gawain", { turnsToday: 1 }), knight("bedivere", { turnsToday: 1 })];
    expect(chooseKnight("Fix the importer.", {}, facts).choice?.id).toBe("bedivere");
    expect(chooseKnight("Fix the importer.", {}, [...facts].reverse()).choice?.id).toBe("bedivere");
  });

  test("no knights at all: nobody, and nothing considered", () => {
    expect(chooseKnight("Fix the importer.", {}, [])).toEqual({ choice: null, considered: [] });
  });
});
