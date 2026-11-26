import { describe, expect, test } from "bun:test";
import { chooseAgent, type AgentFacts } from "../src/agents.ts";

/*
 * The agent best suited to a task takes it, and evidence decides, never rank.
 * Pure: the node gathers the facts (each agent's record, its tasks, its VM as its host says now) and this says who,
 * and why, in words the owner reads.
 */

const agent = (id: string, over: Partial<AgentFacts> = {}): AgentFacts => ({
  id, name: id[0]!.toUpperCase() + id.slice(1), instructions: "Make small, verifiable changes.", role: "engineer", enabled: true,
  dailyTurns: 40, turnsToday: 0, repository: null, vm: { image: "invincible/sandbox:1", status: "running" }, tasks: [], ...over,
});
const verified = (n: number) => Array.from({ length: n }, () => ({ status: "done" as const, verified: true }));
const failed = (n: number) => Array.from({ length: n }, () => ({ status: "failed" as const, verified: false }));

describe("who takes a task", () => {
  test("an agent that can't take it is never chosen, and the reason is said: paused, its day's turns spent, no desktop, another repository", () => {
    const { choice, considered } = chooseAgent("Open the dashboard in the browser and click Export.", { desktop: true, repository: "https://github.com/you/app" }, [
      agent("rio", { enabled: false, repository: "https://github.com/you/app", vm: { image: "invincible/desktop:1", status: "running" } }),
      agent("una", { turnsToday: 40, repository: "https://github.com/you/app", vm: { image: "invincible/desktop:1", status: "running" } }),
      agent("ivo", { repository: "https://github.com/you/app" }),
      agent("max", { repository: "https://github.com/you/other", vm: { image: "invincible/desktop:1", status: "running" } }),
      agent("noa", { vm: { image: "invincible/desktop:1", status: "running" } }),
    ]);
    expect(choice).toBeNull();
    const why = Object.fromEntries(considered.map((c) => [c.id, c.why.join("; ")]));
    expect(why).toEqual({
      rio: "paused",
      una: "its turns for today are spent (40 of 40)",
      ivo: "its VM has no desktop",
      max: "it works on github.com/you/other",
      noa: "it has no repository",
    });
    expect(considered.every((c) => !c.eligible)).toBe(true);
  });

  test("a task held to a node goes to an agent whose VM is on it: one elsewhere, or with no VM yet, can't take it", () => {
    const on = "n_" + "u".repeat(43);
    const { choice, considered } = chooseAgent("Run the long suite.", { node: on }, [
      agent("rio", { node: "n_" + "m".repeat(43) }),
      agent("ivo", { vm: null, node: null }),
      agent("una", { node: on }),
    ]);
    expect(choice?.id).toBe("una");
    const why = Object.fromEntries(considered.filter((c) => !c.eligible).map((c) => [c.id, c.why.join("; ")]));
    expect(why).toEqual({ rio: "its VM is on another node", ivo: "its VM isn't made yet, so it isn't on that node" });
    // Without a node named, where a VM is changes nothing.
    expect(chooseAgent("Run the long suite.", {}, [agent("rio", { node: "n_" + "m".repeat(43) })]).choice?.id).toBe("rio");
  });

  test("the same repository is the same however it is written", () => {
    const { choice } = chooseAgent("Fix the importer.", { repository: "https://github.com/You/App.git/" }, [agent("ivo", { repository: "https://github.com/you/app" })]);
    expect(choice?.id).toBe("ivo");
  });

  test("of those that can, a free agent before a busy one, and one whose work has been verified before one whose has not", () => {
    const busy = agent("rio", { tasks: [...verified(3), { status: "running", verified: false }] });
    const proven = agent("una", { tasks: verified(3) });
    const shaky = agent("ivo", { tasks: [...verified(1), ...failed(2)] });
    const { choice, considered } = chooseAgent("Fix the importer.", {}, [busy, shaky, proven]);
    expect(choice).toEqual({ id: "una", name: "Una", reasons: ["free now", "3 of 3 tasks verified"] });
    // Everyone considered, best first, each with its own reasons.
    expect(considered.map((c) => c.id)).toEqual(["una", "ivo", "rio"]);
    expect(considered.find((c) => c.id === "rio")!.why).toContain("busy: 1 task running");
    expect(considered.find((c) => c.id === "ivo")!.why).toContain("1 of 3 tasks verified");
  });

  test("an agent whose job speaks of the task's work is preferred, and the words that matched are said", () => {
    const { choice } = chooseAgent("Review the pull request for the billing migration and check its tests.", {}, [
      agent("rio"),
      agent("una", { instructions: "Reviews changes before they ship: reads the diff, runs the tests, says what is missing." }),
    ]);
    expect(choice?.id).toBe("una");
    expect(choice?.reasons).toContain("its job speaks of reviews and tests");
  });

  test("a task that speaks of a browser or a screen prefers an agent with a desktop, without requiring one", () => {
    const facts = [agent("rio"), agent("una", { vm: { image: "invincible/desktop:1", status: "running" } })];
    const { choice } = chooseAgent("Open https://example.com and read the page title.", {}, facts);
    expect(choice).toMatchObject({ id: "una", reasons: expect.arrayContaining(["has a desktop, which the task looks to need"]) });
    // Asked for nothing of a screen, the desktop counts for nothing.
    expect(chooseAgent("Fix the importer.", {}, facts).choice?.reasons).not.toContain("has a desktop, which the task looks to need");
  });

  test("an agent with no VM yet can still take a task (its VM is made when it starts), behind one whose VM is ready", () => {
    const { choice, considered } = chooseAgent("Fix the importer.", {}, [agent("rio", { vm: null }), agent("una")]);
    expect(choice?.id).toBe("una");
    expect(considered.find((c) => c.id === "rio")).toMatchObject({ eligible: true, why: expect.arrayContaining(["its VM is made when the task starts"]) });
    expect(chooseAgent("Fix the importer.", {}, [agent("rio", { vm: null })]).choice?.id).toBe("rio");
  });

  test("equally suited, the one that has done less today takes it, then by name: the same facts always give the same agent", () => {
    const facts = [agent("ivo", { turnsToday: 3 }), agent("rio", { turnsToday: 1 }), agent("una", { turnsToday: 1 })];
    expect(chooseAgent("Fix the importer.", {}, facts).choice?.id).toBe("rio");
    expect(chooseAgent("Fix the importer.", {}, [...facts].reverse()).choice?.id).toBe("rio");
  });

  test("no agents at all: nobody, and nothing considered", () => {
    expect(chooseAgent("Fix the importer.", {}, [])).toEqual({ choice: null, considered: [] });
  });
});
