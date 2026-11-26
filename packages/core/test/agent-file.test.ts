import { describe, expect, test } from "bun:test";
import { AGENT_FILE, agentFromFile, agentToFile } from "../src/agents.ts";

/*
 * An agent as a file you carry (PLAN #20): its settings between --- lines, each value JSON (which YAML reads too),
 * then its job under its name. What goes in is who it is and how it works; never its memory, its record or a key.
 */

const MAX = {
  id: "max",
  name: "Max",
  instructions: "You keep your agent's own repository healthy.\n\n- Failing test first.\n- Never force-push.",
  role: "engineer",
  models: ["opencode-go/deepseek-v4-pro", "opencode-go/glm-5.3"],
  sensitive: false,
  harness: "acp",
  acp: "goose acp",
  repository: "https://github.com/amiriteorg/invincible",
  dailyTurns: 40,
  avatar: { v: 2, color: "#3abeff" },
  keys: ["stripe"],
};

describe("an agent as a file", () => {
  test("written and read back, it is the same agent: its job whole, its settings as they were", () => {
    const { text, scrubbed } = agentToFile(MAX);
    expect(scrubbed).toBe(0);
    expect(text.split("\n").slice(0, 4)).toEqual(["---", `invincible: "${AGENT_FILE}"`, 'id: "max"', 'name: "Max"']);
    expect(text).toContain('models: ["opencode-go/deepseek-v4-pro","opencode-go/glm-5.3"]');
    expect(text).toContain("---\n\n# Max\n\nYou keep your agent's own repository healthy.");
    const read = agentFromFile(text);
    expect(read).toEqual({ ok: true, agent: MAX, ignored: [] });
  });

  test("its memory, its record and its keys never go in; a key in its job is taken out, and said", () => {
    const leaky = ["ghp", "A".repeat(36)].join("_");
    const { text, scrubbed } = agentToFile({ ...MAX, instructions: `Push with ${leaky} when asked.`, memory: "the owner's office is in Aarhus", turnsToday: 3, workspace: { id: "vm-1" } } as never);
    expect(scrubbed).toBe(1);
    expect(text).not.toContain(leaky);
    expect(text).toContain("[redacted");
    for (const word of ["memory", "Aarhus", "turnsToday", "workspace", "vm-1"]) expect(text).not.toContain(word);
    // Only the names of the keys it was given, to give again where it goes.
    expect(text).toContain('keys: ["stripe"]');
  });

  test("written by hand: plain values read as words, what isn't an agent's is left out and said", () => {
    const read = agentFromFile(['---', `invincible: ${AGENT_FILE}`, "id: scout", "name: 'Scout'", "harness: native", "dailyTurns: 12", "colour: red", "---", "# Scout", "", "Looks around."].join("\n"));
    expect(read).toEqual({ ok: true, agent: { id: "scout", name: "Scout", instructions: "Looks around.", harness: "native", dailyTurns: 12 }, ignored: ["colour"] });
  });

  test("anything else is said not to be one: no settings, another kind of file, no id or no name", () => {
    expect(agentFromFile("# Just notes")).toEqual({ ok: false, why: expect.stringContaining("doesn't open with an agent's settings") });
    expect(agentFromFile("---\nname: pdf\ndescription: an Agent Skill\n---\nBody")).toEqual({ ok: false, why: expect.stringContaining("isn't an agent file") });
    expect(agentFromFile(`---\ninvincible: "${AGENT_FILE}"\nname: "X"\n---\n`)).toEqual({ ok: false, why: "it names no id" });
    expect(agentFromFile(`---\ninvincible: "${AGENT_FILE}"\nid: "x"\n---\n`)).toEqual({ ok: false, why: "it gives the agent no name" });
  });
});
