import { describe, expect, test } from "bun:test";
import { OWN_WORK_ONLY, ownWorkOnly, ownWorkRefusal } from "../src/own-work.ts";
import { TEAM_OWNER, TEAM_PRIMARY } from "../src/team.ts";

/*
 * A plan that works only on your own repositories (the owner's word, 28 November 2026): a Gemini plan, whose sign-in is a
 * key to the owner's Google Cloud that any command agy runs can read (the review's H1). Your agent directs it as any plan;
 * it never works on another node's task, nor for an agent with no repository you set: refused, saying how to get it run.
 */
describe("work a Gemini plan runs", () => {
  const ada = { name: "Ada", repository: "https://github.com/example/app" };
  const RULE = "The Gemini plan works only on your own repositories";

  test("a Gemini plan is such a plan, and no other is: Antigravity's, or an ACP agent whose command runs agy", () => {
    expect(OWN_WORK_ONLY).toEqual(["google-antigravity"]);
    for (const harness of ["antigravity"]) expect([harness, ownWorkOnly({ harness })]).toEqual([harness, true]);
    for (const harness of ["native", "opencode", "hermes", "claude", "codex"]) expect([harness, ownWorkOnly({ harness })]).toEqual([harness, false]);
    for (const acp of ["agy acp", "/opt/agy/bin/agy acp", "env AGY_CLI_DISABLE_AUTO_UPDATE=true agy acp"]) expect([acp, ownWorkOnly({ harness: "acp", acp })]).toEqual([acp, true]);
    for (const acp of ["goose acp", "gemini --experimental-acp", "agy-wrapper acp", "/opt/agy/bin/goose acp", null, undefined]) expect([acp, ownWorkOnly({ harness: "acp", acp })]).toEqual([acp, false]);
  });

  test("yours and your agent's, on its agent's repository: a task you gave, one your agent gave in any turn, its yes to a proposal, a fix it gives back", () => {
    const fix = { connector: "github", owner: "example", repo: "app", branch: "invincible/units", pr: 7 };
    for (const task of [{}, { givenBy: TEAM_OWNER }, { givenBy: TEAM_PRIMARY }, { givenBy: TEAM_PRIMARY, proposedBy: TEAM_PRIMARY }, { proposedBy: "bo" }, { givenBy: TEAM_PRIMARY, fix }]) {
      expect([JSON.stringify(task), ownWorkRefusal(task, ada)]).toEqual([JSON.stringify(task), null]);
    }
  });

  test("another node's task, and its proposal approved or not, and an agent on no repository of yours: refused, saying how to get it run", () => {
    const another = `${RULE}: another node's task never runs on it; give it to an agent of yours on another plan`;
    expect(ownWorkRefusal({ givenBy: "node:n_FAKE" }, ada)).toBe(another);
    // (Handed over beyond your grant, it is a proposal of that node's: approved by you, still another node's.)
    expect(ownWorkRefusal({ givenBy: "node:n_FAKE", proposedBy: "node:n_FAKE" }, ada)).toBe(another);
    expect(ownWorkRefusal({ proposedBy: "node:n_FAKE" }, ada)).toBe(another);
    for (const task of [{}, { givenBy: TEAM_PRIMARY }]) expect(ownWorkRefusal(task, { name: "Ada", repository: null })).toBe(`${RULE}: Ada works on no repository of yours; set one, then give the task again`);
  });
});
