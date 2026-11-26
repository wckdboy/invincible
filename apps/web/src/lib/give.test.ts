import { describe, expect, test } from "bun:test";
import { budgetFrom, gatesFrom, giveInput, givenTo } from "./give.ts";

describe("a task's budget, as typed", () => {
  test("dollars with a point or a comma, with or without the sign; nothing typed is no budget", () => {
    expect(budgetFrom("")).toEqual({ usd: null });
    expect(budgetFrom("  ")).toEqual({ usd: null });
    expect(budgetFrom("0.50")).toEqual({ usd: 0.5 });
    expect(budgetFrom("$2")).toEqual({ usd: 2 });
    expect(budgetFrom("$ 1,5")).toEqual({ usd: 1.5 });
    expect(budgetFrom("100")).toEqual({ usd: 100 });
  });

  test("anything else is said plainly", () => {
    for (const text of ["abc", "1.2.3", ".5", "5.", "-1", "1e3"]) expect(budgetFrom(text)).toEqual({ error: "A budget is an amount in US dollars, like 0.50." });
    for (const text of ["0", "0.00", "100.01", "250"]) expect(budgetFrom(text)).toEqual({ error: "A budget is more than $0 and at most $100." });
  });

  test("given to the Roundtable, it goes with the task only when there is one", () => {
    const base = { goal: "Fix it", title: "", gates: [], desktop: false, repository: "" };
    expect(giveInput({ ...base, budgetUsd: 0.5 })).toEqual({ goal: "Fix it", budgetUsd: 0.5 });
    expect(giveInput({ ...base, budgetUsd: null })).toEqual({ goal: "Fix it" });
  });
});

describe("the commands that prove a task is done, as typed", () => {
  test("one a line, blank lines and spaces around them left out", () => {
    expect(gatesFrom("bun test\n\n  bun run typecheck  \n")).toEqual({ gates: ["bun test", "bun run typecheck"] });
    expect(gatesFrom("")).toEqual({ gates: [] });
    expect(gatesFrom("  \n ")).toEqual({ gates: [] });
  });

  test("at most sixteen, each at most a thousand characters: more is said, never cut", () => {
    expect(gatesFrom(Array.from({ length: 16 }, (_, i) => `test -f ${i}`).join("\n"))).toMatchObject({ gates: { length: 16 } });
    expect(gatesFrom(Array.from({ length: 17 }, (_, i) => `test -f ${i}`).join("\n"))).toEqual({ error: "At most 16 commands: this has 17." });
    expect(gatesFrom(`echo ${"x".repeat(1000)}`)).toEqual({ error: "A command can be at most 1,000 characters: line 1 is longer." });
  });
});

describe("a task given to the Roundtable, as the node takes it", () => {
  test("only what was given: no empty title, no empty list, and needs only when there are some", () => {
    expect(giveInput({ goal: "  Fix the importer  ", title: " ", gates: [], desktop: false, repository: "" })).toEqual({ goal: "Fix the importer" });
    expect(giveInput({ goal: "Fetch the export", title: " This month's export ", gates: ["test -s export.csv"], desktop: true, repository: "" })).toEqual({
      goal: "Fetch the export",
      title: "This month's export",
      gates: ["test -s export.csv"],
      needs: { desktop: true },
    });
    expect(giveInput({ goal: "Fix it", title: "", gates: [], desktop: false, repository: " https://github.com/you/app " })).toEqual({ goal: "Fix it", needs: { repository: "https://github.com/you/app" } });
  });
});

describe("who took it, and why", () => {
  const answer = {
    task: { id: "task-abcdefghijkl", room: "dm-gawain" },
    choice: { id: "gawain", name: "Gawain", reasons: ["free now", "no tasks yet", "has a desktop"] },
    considered: [
      { id: "gawain", name: "Gawain", eligible: true, why: ["free now", "no tasks yet", "has a desktop"] },
      { id: "ada", name: "Ada", eligible: true, why: ["busy: 1 task running", "1 of 1 task verified"] },
      { id: "bors", name: "Bors", eligible: false, why: ["paused"] },
      { id: "gareth", name: "Gareth", eligible: false, why: ["its VM has no desktop", "its turns for today are spent (40 of 40)"] },
    ],
  };

  test("the knight that took it, its reasons, and where the task is", () => {
    expect(givenTo(answer)).toMatchObject({ id: "gawain", name: "Gawain", room: "dm-gawain", why: "free now · no tasks yet · has a desktop" });
  });

  test("how each of the others stood, in the node's order: those that could have, then those that couldn't, and why", () => {
    expect(givenTo(answer).others).toEqual([
      { id: "ada", name: "Ada", line: "busy: 1 task running · 1 of 1 task verified", could: true },
      { id: "bors", name: "Bors", line: "can't take it: paused", could: false },
      { id: "gareth", name: "Gareth", line: "can't take it: its VM has no desktop · its turns for today are spent (40 of 40)", could: false },
    ]);
  });

  test("the only knight at the table has no others", () => {
    expect(givenTo({ ...answer, considered: answer.considered.slice(0, 1) }).others).toEqual([]);
  });
});
