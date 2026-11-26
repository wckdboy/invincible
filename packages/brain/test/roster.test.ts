import { describe, expect, test } from "bun:test";
import { newNodeIdentity } from "@galahad/core";
import { foundFleet, MindStore } from "@galahad/mind";
import { pinnedEffort, roleModels, ROLES, roster, workRole } from "../src/index.ts";

function mind() {
  const identity = newNodeIdentity();
  const store = new MindStore(":memory:");
  foundFleet(store, identity, { fleetName: "camelot", nodeName: "n" });
  const hire = (role: string, models: string[]) => store.emit(identity, "roster.set", { role, models });
  const pin = (role: string, effort: "auto" | "low" | "medium" | "high" | "xhigh" | "max") => store.emit(identity, "roster.effort", { role, effort });
  /** A provider set up, as `galahad key add` (or the app) leaves it: a record naming where it is and its key. */
  const setUp = (id: string, baseUrl: string) => store.emit(identity, "provider.set", { id, kind: "openai", baseUrl, secret: id });
  return { store, hire, pin, setUp };
}

describe("a role you haven't set", () => {
  test("runs on its defaults whose provider you set up: the first key you add answers, whoever it is for", () => {
    const { store, setUp } = mind();
    // Nothing set up: every default, so what can't answer says what to add.
    expect(roleModels(store, "planner")).toEqual(ROLES.planner!.defaults);
    // The cheaper open models first (your word, 23 November 2026), the frontier closed ones after.
    expect(roleModels(store, "planner")[0]).toBe("deepseek/deepseek-v4-pro");
    // DeepSeek's key alone: its models play the roles, and no other default is passed over in every answer.
    setUp("deepseek", "https://api.deepseek.com");
    for (const role of ["planner", "engineer", "reviewer"]) expect([role, roleModels(store, role)]).toEqual([role, ["deepseek/deepseek-v4-pro"]]);
    expect(roleModels(store, "swift")).toEqual(["deepseek/deepseek-flash"]);
    expect(roster(store).planner).toMatchObject({ models: ["deepseek/deepseek-v4-pro"], configured: false });
    // An Anthropic key too: the cheaper open model answers first, Claude after it (your word, 23 November 2026: mainly
    // the coding plans and the cheaper, still near-frontier open models from China or hosted in Europe).
    setUp("anthropic", "https://api.anthropic.com");
    expect(roleModels(store, "planner")).toEqual(["deepseek/deepseek-v4-pro", "anthropic/claude-opus-5-5"]);
    // A role nobody hired goes on the engineer's.
    expect(roleModels(store, "researcher")).toEqual(["deepseek/deepseek-v4-pro", "anthropic/claude-opus-5-5"]);
  });

  test("a coding plan's key puts its models first for the engineer's work, and only there: his talk with you is never a plan's", () => {
    const { store, setUp } = mind();
    setUp("deepseek", "https://api.deepseek.com");
    setUp("opencode-go", "https://opencode.ai/inference/go/openai/v1");
    setUp("zai-coding", "https://api.z.ai/api/coding/paas/v4");
    expect(roleModels(store, "engineer")).toEqual(["opencode-go/deepseek-v4-pro", "opencode-go/glm-5.3", "zai-coding/glm-5.3", "deepseek/deepseek-v4-pro"]);
    expect(roleModels(store, "planner")).toEqual(["deepseek/deepseek-v4-pro"]);
    expect(roleModels(store, "reviewer")).toEqual(["deepseek/deepseek-v4-pro"]);
  });

  test("a role you set runs on what you set, whatever is set up", () => {
    const { store, hire, setUp } = mind();
    setUp("deepseek", "https://api.deepseek.com");
    hire("planner", ["anthropic/claude-opus-5-5"]);
    expect(roleModels(store, "planner")).toEqual(["anthropic/claude-opus-5-5"]);
  });
});

describe("the role a knight's work runs on", () => {
  test("its own, unless that is the reviewer's or a tool's: then the engineer's", () => {
    expect(["frontend", "engineer", "planner", "swift", "reviewer", "eyes", "decider", "embedder"].map(workRole)).toEqual(["frontend", "engineer", "planner", "swift", "engineer", "engineer", "engineer", "engineer"]);
  });
});

describe("roles you make", () => {
  test("a role you made is listed with its models, for knights to work on, and removing it takes it off the list", () => {
    const { store, hire } = mind();
    hire("frontend", ["orcarouter/anthropic/claude-opus-5.5", "deepseek/deepseek-v4-pro"]);
    expect(roster(store).frontend).toMatchObject({ models: ["orcarouter/anthropic/claude-opus-5.5", "deepseek/deepseek-v4-pro"], configured: true, custom: true, forKnights: true });
    expect(roleModels(store, "frontend")).toEqual(["orcarouter/anthropic/claude-opus-5.5", "deepseek/deepseek-v4-pro"]);
    hire("frontend", []);
    expect(roster(store).frontend).toBeUndefined();
  });

  test("a built-in role emptied goes back to its defaults, and is never removed", () => {
    const { store, hire } = mind();
    hire("engineer", ["deepseek/deepseek-v4-pro"]);
    hire("engineer", []);
    expect(roster(store).engineer).toMatchObject({ configured: false, custom: false, forKnights: true });
  });

  test("a role nobody hired answers with the engineer's models as you set them, not with a built-in default", () => {
    const { store, hire } = mind();
    hire("engineer", ["deepseek/deepseek-v4-pro", "opencode-go/glm-5.3"]);
    expect(roleModels(store, "researcher")).toEqual(["deepseek/deepseek-v4-pro", "opencode-go/glm-5.3"]);
  });

  test("knights work on the planner, engineer, swift and your own roles; the reviewer, tools and chores are not theirs", () => {
    const { store, hire } = mind();
    hire("fold", ["deepseek/deepseek-flash"]);
    hire("Odd.Name", ["deepseek/deepseek-v4-pro"]);
    const listed = roster(store);
    expect(Object.entries(listed).filter(([, spec]) => spec.forKnights).map(([role]) => role).sort()).toEqual(["engineer", "planner", "swift"]);
    // A chore is described as one, not as a role you made.
    expect(listed.fold).toMatchObject({ custom: false, forKnights: false });
    expect(listed.fold!.description).toContain("story");
    // A name a knight can't carry is still yours to hire models for.
    expect(listed["Odd.Name"]).toMatchObject({ custom: true, forKnights: false });
  });
});

describe("how hard a role's models think", () => {
  test("as each step needs, unless you pin it to a level; pinned back to auto, by the step again", () => {
    const { store, pin } = mind();
    expect(roster(store).engineer!.effort).toBe("auto");
    expect(pinnedEffort(store, "engineer")).toBeNull();
    pin("engineer", "medium");
    expect(roster(store).engineer!.effort).toBe("medium");
    expect(pinnedEffort(store, "engineer")).toBe("medium");
    // Every other role still thinks by the step.
    expect(roster(store).planner!.effort).toBe("auto");
    pin("engineer", "auto");
    expect(pinnedEffort(store, "engineer")).toBeNull();
    expect(roster(store).engineer!.effort).toBe("auto");
  });
});
