import { describe, expect, test } from "bun:test";
import { AGENT_SKILL_STEP, HlcClock, newNodeIdentity } from "@galahad/core";
import { foundFleet, MindStore } from "@galahad/mind";
import { fetchAgentSkill, RAW_GITHUB, skillAddress, SkillImportError } from "../src/skill-import.ts";
import { SkillError, SkillsService } from "../src/skills.ts";

/*
 * Skills from elsewhere (PLAN #34): an Agent Skill's folder on GitHub, its SKILL.md alone read as text from GitHub's
 * raw files (a stand-in here: nothing leaves this machine), and the skill it makes, waiting for your approval.
 */

const SKILL_MD = ["---", "name: pdf", "description: Fill in PDF forms and pull out their text. Use when a PDF must be read or filled.", "---", "", "# PDF forms", "", "Read the fields first: `python3 scripts/fields.py form.pdf`."].join("\n");

const status = (work: () => unknown): number | string => {
  try {
    work();
    return "ok";
  } catch (error) {
    return error instanceof SkillImportError || error instanceof SkillError ? error.status : String(error);
  }
};

describe("where a skill is on GitHub", () => {
  test("its folder, its SKILL.md or a repository that is the skill, at a branch, a tag or a commit", () => {
    expect(skillAddress("https://github.com/anthropics/skills/tree/main/skills/pdf")).toEqual({
      owner: "anthropics",
      repo: "skills",
      ref: "main",
      path: "skills/pdf",
      where: "github.com/anthropics/skills/skills/pdf",
      raw: `${RAW_GITHUB}/anthropics/skills/main/skills/pdf/SKILL.md`,
      page: "https://github.com/anthropics/skills/tree/main/skills/pdf",
    });
    expect(skillAddress("https://github.com/anthropics/skills/blob/v1.2/skills/pdf/SKILL.md")).toMatchObject({ ref: "v1.2", path: "skills/pdf", raw: `${RAW_GITHUB}/anthropics/skills/v1.2/skills/pdf/SKILL.md` });
    expect(skillAddress("https://github.com/someone/release-notes-skill")).toMatchObject({ ref: "HEAD", path: "", where: "github.com/someone/release-notes-skill", raw: `${RAW_GITHUB}/someone/release-notes-skill/HEAD/SKILL.md` });
  });

  test("anything else is refused before anything is fetched: another host, plain http, a port or a login, a file, a folder that climbs", () => {
    for (const url of [
      "http://github.com/a/b/tree/main/x",
      "https://gitlab.com/a/b/-/tree/main/x",
      "https://raw.githubusercontent.com/a/b/main/x/SKILL.md",
      "https://github.com:8443/a/b/tree/main/x",
      "https://me:pw@github.com/a/b/tree/main/x",
      "https://github.com/a/b/blob/main/x/run.sh",
      "https://github.com/a/b/tree/main/x/%252e%252e/y",
      "https://github.com/a/b/issues/1",
      "not an address",
    ]) {
      expect([url, status(() => skillAddress(url))]).toEqual([url, 400]);
    }
    // (A climb the URL itself folds stays in the same repository: it's just another address there.)
    expect(skillAddress("https://github.com/a/b/tree/main/x/%2e%2e/%2e%2e/y")).toMatchObject({ owner: "a", repo: "b", ref: "y", path: "" });
  });
});

describe("taking one in", () => {
  const stand = (answer: () => Response) => {
    const asked: { url: string; redirect?: RequestRedirect }[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      asked.push({ url: String(input), redirect: init?.redirect });
      return answer();
    }) as typeof globalThis.fetch;
    return { asked, fetch };
  };

  test("its SKILL.md alone is read, from that address and no other, and becomes a skill's words", async () => {
    const github = stand(() => new Response(SKILL_MD));
    const found = await fetchAgentSkill("https://github.com/anthropics/skills/tree/main/skills/pdf", { fetch: github.fetch });
    expect(github.asked).toEqual([{ url: `${RAW_GITHUB}/anthropics/skills/main/skills/pdf/SKILL.md`, redirect: "manual" }]);
    expect(found).toMatchObject({ where: "github.com/anthropics/skills/skills/pdf", source: "https://github.com/anthropics/skills/tree/main/skills/pdf", shortened: false });
    expect(found.doc).toMatchObject({ title: "PDF forms", when: "Fill in PDF forms and pull out their text. Use when a PDF must be read or filled.", steps: [AGENT_SKILL_STEP] });
    // What it says to run stays words: nothing of the folder is fetched, let alone run.
    expect(found.doc.body).toContain("`python3 scripts/fields.py form.pdf`");
  });

  test("no SKILL.md there, an address GitHub sends elsewhere, one too large, or one that isn't an Agent Skill: refused, saying which", async () => {
    const failed = async (answer: () => Response): Promise<[number, string]> => {
      const error = await fetchAgentSkill("https://github.com/a/b/tree/main/x", { fetch: stand(answer).fetch }).catch((e: unknown) => e);
      if (!(error instanceof SkillImportError)) throw new Error(`not refused: ${String(error)}`);
      return [error.status, error.message];
    };
    expect(await failed(() => new Response("404: Not Found", { status: 404 }))).toEqual([404, expect.stringContaining("no SKILL.md in github.com/a/b/x")]);
    expect(await failed(() => new Response(null, { status: 302, headers: { location: "https://evil.example/SKILL.md" } }))).toEqual([502, expect.stringContaining("sent that address elsewhere")]);
    expect(await failed(() => new Response("x".repeat(300 * 1024)))).toEqual([413, expect.stringContaining("over 256 KB")]);
    expect(await failed(() => new Response("# A README\n\nNo front matter."))).toEqual([422, expect.stringContaining("That isn't an Agent Skill")]);
    expect(await failed(() => new Response("busy", { status: 503 }))).toEqual([502, expect.stringContaining("503")]);
  });

  test("the skill it makes is untrusted, by where it came from, and waits: no model is given it before you approve it, then as a note with its instructions", async () => {
    const identity = newNodeIdentity();
    const store = new MindStore(":memory:", new HlcClock(() => Date.UTC(2026, 10, 20, 3)));
    foundFleet(store, identity, { fleetName: "camelot", nodeName: "ultra" });
    const skills = new SkillsService({ store, identity, log: () => {}, ledger: () => {}, role: () => null, ask: async () => ({ text: "NONE", model: "x" }), now: () => Date.UTC(2026, 10, 20, 3) });
    const found = await fetchAgentSkill("https://github.com/anthropics/skills/tree/main/skills/pdf", { fetch: stand(() => new Response(SKILL_MD)).fetch });
    const { skill, version } = skills.write({ doc: found.doc }, { kind: "import", from: found.where, source: found.source });
    expect(skill).toMatchObject({ title: "PDF forms", trust: "untrusted", by: "from:github.com/anthropics/skills/skills/pdf", state: "proposed", pending: version });
    expect(skills.detail(skill.id).history[0]).toMatchObject({ source: "https://github.com/anthropics/skills/tree/main/skills/pdf" });
    expect(skills.forQuest("q-1", "fill in the PDF form")).toBeNull();
    skills.approve(skill.id, version);
    const given = skills.forQuest("q-2", "fill in the PDF form");
    expect(given?.skills).toEqual([{ id: skill.id, title: "PDF forms", trust: "untrusted" }]);
    expect(given?.text).toContain("python3 scripts/fields.py form.pdf");
    // Taken in again, it's another skill: one from elsewhere never changes one that's there.
    expect(status(() => skills.write({ id: skill.id, doc: found.doc }, { kind: "import", from: found.where, source: found.source }))).toBe(403);
  });
});
