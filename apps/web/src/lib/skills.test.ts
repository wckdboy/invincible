import { describe, expect, test } from "bun:test";
import { SKILL_LIMITS, type SkillDetail, type SkillVersionView, type SkillView } from "@galahad/core/skills";
import { budgetLine, docFromForm, formOf, originWords, shownVersion, skillGroups, stateBadge, trustWords, waitingVersion } from "./skills.ts";

/* The Skills page's reasoning: what waits comes first, what each state and origin is called, and the editor's fields. */

const V1 = "a".repeat(43);
const V2 = "b".repeat(43);

const view = (over: Partial<SkillView> = {}): SkillView => ({
  id: "sk_aaaaaaaaaaaaaaaa",
  state: "in-use",
  locked: false,
  title: "Fix a failing test",
  when: "a test fails",
  trust: "agent",
  by: "galahad",
  offered: V1,
  pending: null,
  head: V1,
  versions: 1,
  quest: "q-1",
  createdAt: 1,
  touchedAt: 1,
  uses: 0,
  passed: 0,
  failed: 0,
  chats: 0,
  lastUsedAt: null,
  ...over,
});

const version = (over: Partial<SkillVersionView> = {}): SkillVersionView => ({
  id: V1,
  n: 1,
  prev: null,
  trust: "agent",
  by: "galahad",
  quest: "q-1",
  via: null,
  source: "quest:q-1",
  at: 1,
  approvedAt: null,
  doc: { title: "Fix a failing test", when: "a test fails", steps: ["run it alone", "fix the code"], proof: [{ command: "bun test", expect: "0 fail" }], pitfalls: ["never retry"] },
  ...over,
});

describe("the list", () => {
  test("what waits for you is its own group (a proposed skill, a new version of one in use); a retired one waits for nothing", () => {
    const skills = [
      view({ id: "sk_proposed", state: "proposed", offered: null, pending: V1 }),
      view({ id: "sk_revision", pending: V2 }),
      view({ id: "sk_plain" }),
      view({ id: "sk_stale", state: "stale" }),
      view({ id: "sk_retired", state: "retired", pending: V1 }),
    ];
    const groups = skillGroups(skills);
    expect(groups.waiting.map((s) => s.id)).toEqual(["sk_proposed", "sk_revision"]);
    expect(groups.inUse.map((s) => s.id)).toEqual(["sk_revision", "sk_plain", "sk_stale"]);
    expect(groups.retired.map((s) => s.id)).toEqual(["sk_retired"]);
    expect(skillGroups([])).toEqual({ waiting: [], inUse: [], retired: [] });
  });

  test("a state's badge: colour only where it means something", () => {
    expect(stateBadge(view())).toEqual({ label: "in use", tone: "ok" });
    expect(stateBadge(view({ state: "proposed" }))).toEqual({ label: "waits for you", tone: "warn" });
    expect(stateBadge(view({ state: "stale" }))).toEqual({ label: "stale", tone: "neutral" });
    expect(stateBadge(view({ state: "retired" }))).toEqual({ label: "retired", tone: "neutral" });
  });

  test("the budget in a line", () => {
    expect(budgetLine({ tokensPerDay: 6000, usedToday: 1234 })).toBe("1,234 of 6,000 tokens used in the last day for distilling skills (one bounded call per passed quest).");
    expect(budgetLine({ tokensPerDay: 0, usedToday: 0 })).toBe("He distils no skills from quests: the budget is 0.");
  });
});

describe("where a version came from", () => {
  test("who wrote it and from what; why it's untrusted, in the node's own words", () => {
    expect(originWords(version())).toBe("Written by Galahad, from quest q-1.");
    expect(originWords(version({ source: "quest:q-9 (its sandbox was online; the ledger records a sandbox of its that wasn't isolated)" }))).toBe("Written by Galahad, from quest q-9. Untrusted because its sandbox was online; the ledger records a sandbox of its that wasn't isolated.");
    expect(originWords(version({ by: "arm:hermes", source: "arm:hermes", quest: null }))).toBe("Proposed by the agent hermes.");
    expect(originWords(version({ by: "owner", source: null, quest: null }))).toBe("Written by you.");
    expect(originWords(version({ source: "written in a chat", quest: null }))).toBe("Written by Galahad (written in a chat).");
    expect(originWords(version({ source: null }))).toBe("Written by Galahad, from quest q-1.");
  });

  test("what its trust means for whether he's given it", () => {
    expect(trustWords(version({ trust: "owner", by: "owner" }))).toBe("Your own words.");
    expect(trustWords(version())).toContain("passed review with no network");
    expect(trustWords(version({ trust: "untrusted" }))).toContain("given to no model until you approve this exact version");
    expect(trustWords(version({ trust: "untrusted", approvedAt: 5 }))).toContain("You read and approved this exact version");
  });

  test("the version a page shows, and the one that waits", () => {
    const first = version();
    const second = version({ id: V2, n: 2, prev: V1, trust: "untrusted" });
    const detail = (over: Partial<SkillDetail>): SkillDetail => ({ ...view(), history: [first, second], record: [], ...over });
    // A new version waits behind the one in use.
    const revision = detail({ head: V2, pending: V2, offered: V1 });
    expect(shownVersion(revision)?.id).toBe(V1);
    expect(waitingVersion(revision)?.id).toBe(V2);
    // A proposed skill: its page shows the proposal, and that's what waits.
    const proposed = detail({ state: "proposed", head: V2, pending: V2, offered: null });
    expect(shownVersion(proposed)?.id).toBe(V2);
    expect(waitingVersion(proposed)?.id).toBe(V2);
    // Nothing waits on a retired skill, or one with no pending version.
    expect(waitingVersion(detail({ state: "retired", pending: V2 }))).toBeNull();
    expect(waitingVersion(detail({}))).toBeNull();
  });
});

describe("the editor", () => {
  test("a skill to its fields and back", () => {
    const doc = version().doc!;
    const form = formOf(doc);
    expect(form).toEqual({ title: "Fix a failing test", when: "a test fails", steps: "run it alone\nfix the code", proof: "bun test => 0 fail", pitfalls: "never retry" });
    expect(docFromForm(form)).toEqual({ doc });
    expect(formOf(null)).toEqual({ title: "", when: "", steps: "", proof: "", pitfalls: "" });
  });

  test("lines are cleaned, blank ones dropped, and hidden characters removed", () => {
    const read = docFromForm({ title: "  Tidy​ notes ", when: "when\tthey pile up", steps: "\n  first \r\n\r\nsecond‮\n", proof: "", pitfalls: "\n" });
    expect(read).toEqual({ doc: { title: "Tidy notes", when: "when they pile up", steps: ["first", "second"], proof: [], pitfalls: [] } });
  });

  test("what's missing or too much is said in a sentence, with the field to fix", () => {
    const ok = { title: "t", when: "w", steps: "s", proof: "", pitfalls: "" };
    expect(docFromForm({ ...ok, title: " " })).toMatchObject({ field: "title" });
    expect(docFromForm({ ...ok, title: "x".repeat(SKILL_LIMITS.title + 1) })).toMatchObject({ field: "title" });
    expect(docFromForm({ ...ok, when: "" })).toMatchObject({ field: "when" });
    expect(docFromForm({ ...ok, steps: "\n\n" })).toMatchObject({ field: "steps", problem: "Write at least one step, one a line." });
    expect(docFromForm({ ...ok, steps: Array(SKILL_LIMITS.steps + 1).fill("s").join("\n") })).toMatchObject({ field: "steps" });
    expect(docFromForm({ ...ok, steps: "x".repeat(SKILL_LIMITS.step + 1) })).toMatchObject({ field: "steps" });
    expect(docFromForm({ ...ok, proof: "bun test" })).toMatchObject({ field: "proof" });
    expect(docFromForm({ ...ok, proof: "=> nothing" })).toMatchObject({ field: "proof" });
    expect(docFromForm({ ...ok, proof: Array(SKILL_LIMITS.proofs + 1).fill("a => b").join("\n") })).toMatchObject({ field: "proof" });
    expect(docFromForm({ ...ok, pitfalls: Array(SKILL_LIMITS.pitfalls + 1).fill("p").join("\n") })).toMatchObject({ field: "pitfalls" });
    // A command with "=>" in it: the last one divides.
    expect(docFromForm({ ...ok, proof: "node -e 'x => x' => prints nothing" })).toEqual({ doc: { title: "t", when: "w", steps: ["s"], proof: [{ command: "node -e 'x => x'", expect: "prints nothing" }], pitfalls: [] } });
  });

  test("nothing secret-shaped leaves the page", () => {
    const key = `sk-ant-api03-${"FAKEfake".repeat(6)}`;
    const read = docFromForm({ title: "Deploy", when: "deploying", steps: `export ANTHROPIC_API_KEY=${key}`, proof: "", pitfalls: "" });
    expect(read).toMatchObject({ field: "steps" });
    expect("problem" in read ? read.problem : "").toContain("keys belong in the vault");
    expect(docFromForm({ title: "Deploy", when: "deploying", steps: "s", proof: `curl -H 'x-api-key: ${key}' https://example.test => 200`, pitfalls: "" })).toMatchObject({ field: "proof" });
  });
});

describe("an answer's steps", () => {
  test("the skills he had at hand are said as that, not as archived entries he read", async () => {
    const { archiveStep } = await import("./chats.ts");
    const skill = { id: "sk_aaaaaaaaaaaaaaaa", title: "Fix a failing test", kind: "skill", trust: "agent" };
    expect(archiveStep([skill])).toEqual({ text: "Had 1 skill at hand", detail: "[sk_aaaaaaaaaaaaaaaa] Fix a failing test" });
    const both = archiveStep([skill, { ...skill, id: "sk_bbbbbbbbbbbbbbbb", title: "From the web", trust: "untrusted" }]);
    expect(both.text).toBe("Had 2 skills at hand");
    expect(both.detail).toContain("[sk_bbbbbbbbbbbbbbbb] From the web (untrusted)");
    // Archived entries read as ever.
    expect(archiveStep([{ id: "arc_AAAAAAAAAAAAAAAAAAAAAA", title: "A drawbridge", kind: "idea", trust: "owner" }]).text).toBe("Read 1 archived entry");
    expect(archiveStep([]).text).toBe("Read 0 archived entries");
  });
});
