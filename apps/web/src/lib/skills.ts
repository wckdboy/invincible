import { findSecrets } from "@galahad/core/secret-scan";
import { cleanSkillText, SKILL_LIMITS, skillAuthor, type SkillDetail, type SkillDoc, type SkillsView, type SkillVersionView, type SkillView } from "@galahad/core/skills";

/*
 * The Skills page's reasoning, as pure functions (views/skills.ts draws them): how the
 * list is grouped (what waits for you first), what a skill's state and a version's
 * origin are called, and a skill's words to and from the editor's plain text fields.
 */

export interface SkillGroups {
  /** A proposed skill, or a new version of one in use: each needs your answer. */
  waiting: SkillView[];
  /** In use and stale: what he may be given. */
  inUse: SkillView[];
  retired: SkillView[];
}

/** The list in the order the page shows it: what waits for you, what's in use, what's retired. */
export function skillGroups(skills: readonly SkillView[]): SkillGroups {
  const retired = skills.filter((s) => s.state === "retired");
  const live = skills.filter((s) => s.state !== "retired");
  return { waiting: live.filter((s) => s.pending), inUse: live.filter((s) => s.state === "in-use" || s.state === "stale"), retired };
}

export type SkillTone = "ok" | "warn" | "neutral" | "accent" | "agent";

/** A skill's state as a badge: its word and its tone (colour only ever means status). */
export function stateBadge(s: Pick<SkillView, "state">): { label: string; tone: SkillTone } {
  if (s.state === "proposed") return { label: "waits for you", tone: "warn" };
  if (s.state === "stale") return { label: "stale", tone: "neutral" };
  if (s.state === "retired") return { label: "retired", tone: "neutral" };
  return { label: "in use", tone: "ok" };
}

/** Why a version waits, or doesn't, in a sentence for its page. */
export function trustWords(v: Pick<SkillVersionView, "trust" | "approvedAt" | "by">): string {
  if (v.trust === "owner") return "Your own words.";
  if (v.trust === "agent") return "His own note, from a quest of his that passed review with no network. He was the only one who could shape it.";
  return v.approvedAt
    ? "Shaped by what was read from outside. You read and approved this exact version; he's given it as data, marked untrusted."
    : "Shaped by what was read from outside (the web, a repository, a chat, another agent). It's given to no model until you approve this exact version.";
}

/** Where a version came from, as the node recorded it: who wrote it, from what, and why it's untrusted when it is. */
export function originWords(v: Pick<SkillVersionView, "by" | "quest" | "source">): string {
  const who = skillAuthor(v.by);
  // An Agent Skill's folder you had taken in: its SKILL.md, read as text.
  if (v.by.startsWith("from:")) return `Taken in from ${v.source ?? who}: its SKILL.md, read as text. Nothing in its folder ran or was taken in besides.`;
  const written = `Written by ${who}`;
  if (!v.source) return v.quest ? `${written}, from quest ${v.quest}.` : `${written}.`;
  // "quest:q-1 (its sandbox was online; …)" → the quest, then the node's reasons.
  const quest = /^quest:(\S+)(?: \((.*)\))?$/s.exec(v.source);
  if (quest) return `${written}, from quest ${quest[1]}.${quest[2] ? ` Untrusted because ${quest[2]}.` : ""}`;
  if (v.source.startsWith("arm:")) return `Proposed by the agent ${v.source.slice(4)}.`;
  return `${written} (${v.source}).`;
}

/** The version a skill's page shows as its words: the one in use; while there's none, the one that waits. */
export function shownVersion(skill: SkillDetail): SkillVersionView | null {
  return skill.history.find((v) => v.id === (skill.offered ?? skill.head)) ?? skill.history.at(-1) ?? null;
}

/** The version that waits for your approval, when one does (and the skill isn't retired). */
export function waitingVersion(skill: SkillDetail): SkillVersionView | null {
  if (skill.state === "retired" || !skill.pending) return null;
  return skill.history.find((v) => v.id === skill.pending) ?? null;
}

/** The day's budget for distilling, in a line. */
export function budgetLine(budget: SkillsView["budget"]): string {
  if (budget.tokensPerDay === 0) return "He distils no skills from quests: the budget is 0.";
  return `${budget.usedToday.toLocaleString("en-GB")} of ${budget.tokensPerDay.toLocaleString("en-GB")} tokens used in the last day for distilling skills (one bounded call per passed quest).`;
}

/* ---------- the editor: a skill as plain text fields ---------- */

export interface SkillForm {
  title: string;
  when: string;
  /** One step a line. */
  steps: string;
  /** One proof a line: "command => what to expect". */
  proof: string;
  /** One pitfall a line. */
  pitfalls: string;
}

export const formOf = (doc: SkillDoc | null): SkillForm => ({
  title: doc?.title ?? "",
  when: doc?.when ?? "",
  steps: (doc?.steps ?? []).join("\n"),
  proof: (doc?.proof ?? []).map((p) => `${p.command} => ${p.expect}`).join("\n"),
  pitfalls: (doc?.pitfalls ?? []).join("\n"),
});

const lines = (text: string): string[] => text.split(/\r?\n/).map(cleanSkillText).filter(Boolean);

/**
 * A skill's words from the editor, checked as the node will check them, or what's wrong with them in a
 * sentence (and which field). Nothing secret-shaped is sent: skills replicate in plaintext to every device.
 */
export function docFromForm(form: SkillForm): { doc: SkillDoc } | { problem: string; field: keyof SkillForm } {
  const title = cleanSkillText(form.title);
  if (!title) return { problem: "Give it a title: what kind of work this is.", field: "title" };
  if (title.length > SKILL_LIMITS.title) return { problem: `The title is at most ${SKILL_LIMITS.title} characters.`, field: "title" };
  const when = cleanSkillText(form.when);
  if (!when) return { problem: "Say when to use it.", field: "when" };
  if (when.length > SKILL_LIMITS.when) return { problem: `"When to use it" is at most ${SKILL_LIMITS.when} characters.`, field: "when" };
  const steps = lines(form.steps);
  if (!steps.length) return { problem: "Write at least one step, one a line.", field: "steps" };
  if (steps.length > SKILL_LIMITS.steps) return { problem: `At most ${SKILL_LIMITS.steps} steps: a skill is short.`, field: "steps" };
  if (steps.some((s) => s.length > SKILL_LIMITS.step)) return { problem: `A step is at most ${SKILL_LIMITS.step} characters.`, field: "steps" };
  const proof: SkillDoc["proof"] = [];
  for (const line of lines(form.proof)) {
    const at = line.lastIndexOf("=>");
    const command = at > 0 ? line.slice(0, at).trim() : "";
    const expect = at > 0 ? line.slice(at + 2).trim() : "";
    if (!command || !expect) return { problem: 'A proof is a command and what to expect of it: "bun test => 0 fail".', field: "proof" };
    if (command.length > SKILL_LIMITS.command || expect.length > SKILL_LIMITS.expect) return { problem: `A proof's command is at most ${SKILL_LIMITS.command} characters, and what to expect ${SKILL_LIMITS.expect}.`, field: "proof" };
    proof.push({ command, expect });
  }
  if (proof.length > SKILL_LIMITS.proofs) return { problem: `At most ${SKILL_LIMITS.proofs} proofs.`, field: "proof" };
  const pitfalls = lines(form.pitfalls);
  if (pitfalls.length > SKILL_LIMITS.pitfalls) return { problem: `At most ${SKILL_LIMITS.pitfalls} pitfalls.`, field: "pitfalls" };
  if (pitfalls.some((p) => p.length > SKILL_LIMITS.pitfall)) return { problem: `A pitfall is at most ${SKILL_LIMITS.pitfall} characters.`, field: "pitfalls" };
  for (const [field, texts] of [["title", [title]], ["when", [when]], ["steps", steps], ["proof", proof.flatMap((p) => [p.command, p.expect])], ["pitfalls", pitfalls]] as const) {
    const finding = texts.map((t) => findSecrets(t)[0]).find(Boolean);
    if (finding) return { problem: `That looks like a ${finding.kind}. Skills are shared in plaintext with every device: keys belong in the vault.`, field };
  }
  return { doc: { title, when, steps, proof, pitfalls } };
}
