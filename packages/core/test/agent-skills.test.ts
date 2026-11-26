import { describe, expect, test } from "bun:test";
import { AGENT_SKILL_STEP, readAgentSkill, readSkillDoc, SKILL_BRIEF, SKILL_LIMITS, skillAuthor, skillFrom, skillInWords, skillLine, skillSecret, SkillDocInput } from "../src/index.ts";

/*
 * Skills from elsewhere (PLAN #34): an Agent Skill's SKILL.md (its name and description between --- lines, then
 * instructions in Markdown), read as a skill of his. Text only: its instructions are its body, kept as they were
 * written, with nothing hidden in them.
 */

const WHERE = "github.com/anthropics/skills/skills/pdf";
const PDF = [
  "---",
  "name: pdf",
  "description: Comprehensive PDF manipulation toolkit for extracting text and tables, creating new PDFs, merging and splitting documents. Use when a PDF form must be filled in or PDFs processed at scale.",
  "license: Proprietary. LICENSE.txt has complete terms",
  "---",
  "",
  "# PDF Processing Guide",
  "",
  "## Quick start",
  "",
  "```python",
  "from pypdf import PdfReader",
  'reader = PdfReader("document.pdf")',
  "```",
  "",
  "For forms, read forms.md.",
].join("\n");

describe("an Agent Skill, read as a skill of his", () => {
  test("its first heading is the title, its description when to use it, its instructions the body, kept as written", () => {
    const read = readAgentSkill(PDF, WHERE);
    if (!read.ok) throw new Error(read.why);
    expect(read.doc.title).toBe("PDF Processing Guide");
    expect(read.doc.when).toBe("Comprehensive PDF manipulation toolkit for extracting text and tables, creating new PDFs, merging and splitting documents. Use when a PDF form must be filled in or PDFs processed at scale.");
    expect(read.doc.steps).toEqual([AGENT_SKILL_STEP]);
    expect(read.doc.body).toBe(PDF.split("---\n").at(-1)!.trim());
    expect(read.shortened).toBe(false);
    // It passes the skill contract as the API and the log read it, its lines kept.
    expect(readSkillDoc(JSON.parse(JSON.stringify(read.doc)))).toEqual(read.doc);
    expect(SkillDocInput.parse(read.doc).body).toContain('reader = PdfReader("document.pdf")\n```');
  });

  test("a folded or quoted description reads whole; with no heading, its name is the title", () => {
    const folded = readAgentSkill(["---", "name: release-notes", "description: >", "  Drafts release notes", "  from merged pull requests.", "---", "Read the merged pull requests since the last tag."].join("\n"), WHERE);
    expect(folded.ok && [folded.doc.title, folded.doc.when]).toEqual(["Release notes", "Drafts release notes from merged pull requests."]);
    const quoted = readAgentSkill(['---', 'name: "say"', 'description: "Says \\"hi\\", politely"', "---", "Say hi."].join("\n"), WHERE);
    expect(quoted.ok && quoted.doc.when).toBe('Says "hi", politely');
  });

  test("no front matter, no name, no description or no instructions: not an Agent Skill, and it says which", () => {
    expect(readAgentSkill("# Just a README\n\nHello.", WHERE)).toEqual({ ok: false, why: expect.stringContaining("doesn't open with") });
    expect(readAgentSkill("---\ndescription: x\n---\nBody.", WHERE)).toEqual({ ok: false, why: expect.stringContaining("names no skill") });
    expect(readAgentSkill("---\nname: x\n---\nBody.", WHERE)).toEqual({ ok: false, why: expect.stringContaining("when to use it") });
    expect(readAgentSkill("---\nname: x\ndescription: y\n---\n\n  \n", WHERE)).toEqual({ ok: false, why: expect.stringContaining("no instructions") });
  });

  test("what doesn't fit is cut where it's said, the description kept whole in the instructions", () => {
    const long = "Use it when ".concat("a long reason ".repeat(60)).trim();
    const read = readAgentSkill(["---", "name: big", `description: ${long}`, "---", "Step one.\n".repeat(3000)].join("\n"), WHERE);
    if (!read.ok) throw new Error(read.why);
    expect(read.doc.when.length).toBe(SKILL_LIMITS.when);
    expect(read.doc.when.endsWith("…")).toBe(true);
    expect(read.doc.body!.startsWith(`What it is for, in full: ${long}\n\n`)).toBe(true);
    expect(read.shortened).toBe(true);
    expect(read.doc.body!.length).toBeLessThanOrEqual(SKILL_LIMITS.body);
    expect(read.doc.body!.endsWith(`(Cut here: the rest is at ${WHERE}.)`)).toBe(true);
  });

  test("nothing hidden comes in: zero-width and bidirectional characters go, every line break is a newline", () => {
    const read = readAgentSkill("---\r\nname: x\r\ndescription: y​\r\n---\r\nRun‮ this safely.", WHERE);
    expect(read.ok && [read.doc.when, read.doc.body]).toEqual(["y", "Run this\nsafely."]);
  });

  test("its author is where it came from; its instructions go with it to a model, and to the secret scan", () => {
    expect(skillAuthor(skillFrom(WHERE))).toBe(WHERE);
    expect(skillFrom(`github.com/${"x".repeat(200)}`).length).toBe(100);
    const read = readAgentSkill(PDF, WHERE);
    if (!read.ok) throw new Error(read.why);
    expect(skillInWords(read.doc)).toContain("Its instructions, as written where it came from:\n# PDF Processing Guide");
    const line = JSON.parse(skillLine({ id: "sk_0123456789abcdef", version: "v".repeat(43), trust: "untrusted", by: skillFrom(WHERE), quest: null, at: Date.UTC(2026, 10, 20), record: "new", doc: read.doc }));
    expect(line.instructions).toBe(read.doc.body);
    const leaky = readAgentSkill(`${PDF}\n\nexport GITHUB_TOKEN=${["ghp", "A".repeat(36)].join("_")}`, WHERE);
    expect(leaky.ok && skillSecret(leaky.doc)).toBeTruthy();
  });

  test("brief, as an engineer's every call has it: long instructions their opening, cut at a line's end, saying how much more the planner had; short ones whole", () => {
    const offered = (body: string) => ({ id: "sk_0123456789abcdef", version: "v".repeat(43), trust: "untrusted" as const, by: skillFrom(WHERE), quest: null, at: 0, record: "new", doc: { title: "t", when: "w", steps: [AGENT_SKILL_STEP], proof: [], pitfalls: [], body } });
    const long = Array.from({ length: 80 }, (_, i) => `Line ${i}: ${"x".repeat(40)}`).join("\n");
    const brief = JSON.parse(skillLine(offered(long), true)).instructions as string;
    const [opening, said] = brief.split("\n… ");
    expect(long.startsWith(opening!)).toBe(true);
    expect(opening!.length).toBeLessThanOrEqual(SKILL_BRIEF);
    expect(opening!.endsWith("x")).toBe(true);
    expect(said).toBe(`(${long.length - opening!.length} characters more went to the planner, who planned with them whole)`);
    expect(JSON.parse(skillLine(offered(long))).instructions).toBe(long);
    expect(JSON.parse(skillLine(offered("Short, and whole."), true)).instructions).toBe("Short, and whole.");
  });
});
