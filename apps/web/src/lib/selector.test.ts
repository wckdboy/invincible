import { describe, expect, test } from "bun:test";
import { activeAfter, type ChoiceGroup, choicesSummary, filterChoices, moveActive, optionCount, typeahead } from "./selector.ts";

const roles: ChoiceGroup = {
  id: "role",
  label: "Who answers",
  options: [
    { value: "planner", label: "Planner", meta: "anthropic/claude-opus-5-5", selected: true },
    { value: "engineer", label: "Engineer", meta: "anthropic/claude-opus-5-5" },
    { value: "decider", label: "Decider", disabled: "No model hired yet" },
    { value: "swift", label: "Swift", meta: "ollama/*", keywords: ["fast", "cheap"] },
  ],
};
const projects: ChoiceGroup = {
  id: "project",
  label: "Project",
  options: [
    { value: "", label: "No project", selected: true },
    { value: "galahad", label: "Galahad" },
    { value: "homelab", label: "Home lab" },
  ],
};

describe("the smart selector", () => {
  test("without a query every group and option shows, in the order given", () => {
    const shown = filterChoices([roles, projects], "");
    expect(shown.map((g) => g.group.id)).toEqual(["role", "project"]);
    expect(shown[0]!.options.map((o) => o.option.value)).toEqual(["planner", "engineer", "decider", "swift"]);
    expect(optionCount([roles, projects])).toBe(7);
  });

  test("a query keeps each match in its group, best first, and drops empty groups", () => {
    const shown = filterChoices([roles, projects], "lab");
    expect(shown.map((g) => g.group.id)).toEqual(["project"]);
    expect(shown[0]!.options.map((o) => o.option.value)).toEqual(["homelab"]);
    // Matched letters are marked for highlighting.
    expect(shown[0]!.options[0]!.indices).toEqual([5, 6, 7]);
  });

  test("a query finds an option by what its meta line says, and by keyword", () => {
    expect(filterChoices([roles], "opus")[0]!.options.map((o) => o.option.value)).toEqual(["planner", "engineer"]);
    expect(filterChoices([roles], "cheap")[0]!.options.map((o) => o.option.value)).toEqual(["swift"]);
  });

  test("the arrow keys skip what can't be chosen and wrap around", () => {
    const items = filterChoices([roles], "").flatMap((g) => g.options);
    expect(moveActive(items, 1, 1)).toBe(3); // engineer → (decider is disabled) → swift
    expect(moveActive(items, 3, 1)).toBe(0); // wraps
    expect(moveActive(items, 0, -1)).toBe(3);
    expect(moveActive(items, -1, 1)).toBe(0); // nothing active yet: the first
    expect(moveActive([], 0, 1)).toBe(-1);
  });

  test("typing jumps to the next option that starts with what was typed", () => {
    const items = filterChoices([roles, projects], "").flatMap((g) => g.options);
    expect(typeahead(items, "e", 0)).toBe(1);
    expect(typeahead(items, "g", 0)).toBe(5);
    expect(typeahead(items, "ho", 0)).toBe(6);
    expect(typeahead(items, "d", 0)).toBe(-1); // only a disabled one starts with d
    expect(typeahead(items, "zz", 0)).toBe(-1);
    // Nothing active yet: the very first option counts.
    expect(typeahead(items, "p", -1)).toBe(0);
  });

  test("typing a search makes its best match the one Enter chooses, not the one that was active", () => {
    const planner = (s: { option: { value: string } }) => s.option.value === "planner";
    const typed = filterChoices([roles], "e").flatMap((g) => g.options);
    expect(typed[activeAfter(typed, { query: "e", queryChanged: true, keep: planner })]!.option.value).toBe("engineer");
    // A toggle re-renders without a new query: the same option stays active.
    const all = filterChoices([roles], "").flatMap((g) => g.options);
    expect(all[activeAfter(all, { query: "", queryChanged: false, keep: (s) => s.option.value === "swift" })]!.option.value).toBe("swift");
    // Opening, or clearing the search: the one chosen now.
    expect(all[activeAfter(all, { query: "", queryChanged: true, keep: () => false })]!.option.value).toBe("planner");
  });

  test("a group of toggles says what's chosen in plain words", () => {
    const kinds: ChoiceGroup = {
      id: "class",
      mode: "many",
      options: ["Read", "Create", "Modify", "Outward", "Delete"].map((label) => ({ value: label.toLowerCase(), label })),
    };
    expect(choicesSummary(kinds, "Every kind")).toBe("Every kind");
    kinds.options[3]!.selected = true;
    expect(choicesSummary(kinds, "Every kind")).toBe("Outward");
    kinds.options[4]!.selected = true;
    expect(choicesSummary(kinds, "Every kind")).toBe("Outward, Delete");
    kinds.options[0]!.selected = true;
    expect(choicesSummary(kinds, "Every kind")).toBe("3 kinds");
    expect(choicesSummary(kinds, "Every kind", { noun: "class", plural: "classes" })).toBe("3 classes");
    for (const o of kinds.options) o.selected = true;
    expect(choicesSummary(kinds, "Every kind")).toBe("Every kind");
  });
});
