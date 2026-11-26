import { readFileSync } from "node:fs";
import { type RouteName, SKILL_ID, SKILL_LIMITS, skillAuthor, type SkillDetail, type SkillDoc, SkillDocInput, skillInWords, skillRecordLine, SKILLS_BUDGET_MAX, type SkillsView, type SkillVersionView, type SkillView } from "@galahad/core";

/*
 * `galahad skills`: his skills at a terminal. Thin: the node keeps them and decides
 * everything (who may write, what a version's trust is, what may be approved); this
 * shapes input and prints. Approving shows the whole of what you approve, and where it
 * came from, before it asks.
 */

interface Api {
  call<T = any>(name: RouteName, input?: unknown): Promise<T>;
}

type Flags = Record<string, string | boolean | (string | boolean)[] | undefined>;

export interface SkillsCliHooks {
  confirm(question: string): boolean;
  readFile?(path: string): string;
}

const tty = process.stdout.isTTY;
const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s);

export const SKILLS_USAGE = `usage:
  galahad skills [--all]                 his skills: state, uses and track record (retired ones with --all)
  galahad skills show <id>               one in full: its words, where it came from, every version, the quests that used it
  galahad skills approve <id> [-y]       read the version that waits, in full, then approve exactly that one
  galahad skills lock <id> | unlock <id> locked: he may use it, not change it
  galahad skills retire <id> | restore <id>   retired: kept, never offered (nothing is deleted)
  galahad skills rollback <id> [-y]      one step back, to the version before the latest
  galahad skills write [<id>] --title "…" --when "…" --step "…" [--step "…"]… [--proof "command => what to expect"]… [--pitfall "…"]…
  galahad skills write [<id>] --file skill.json     yours (owner); with an id, a new version of that skill
  galahad skills import <github folder>  an Agent Skill (its SKILL.md alone, as text: nothing in it runs), waiting for your approval
  galahad skills budget [<tokens a day>] the day's budget for distilling skills from passed quests (0: off)`;

const STATE: Record<SkillView["state"], string> = { proposed: "proposed", "in-use": "in use", stale: "stale", retired: "retired" };
const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const list = (v: Flags[string]): string[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]).filter((x): x is string => typeof x === "string");

/** A skill's state as a few words: what it is, and what waits. */
export function stateWords(s: Pick<SkillView, "state" | "locked" | "pending" | "offered">): string {
  const waits = s.state !== "retired" && s.pending ? (s.offered ? ", a new version waits for you" : ", waits for you") : "";
  return `${STATE[s.state]}${s.locked ? ", locked" : ""}${waits}`;
}

/** One skill in a line, for the list. */
export function skillRow(s: SkillView): string {
  return `${s.id}  ${stateWords(s).padEnd(34)} ${s.trust.padEnd(9)} ${s.title}${dim(`  · ${skillRecordLine(s)}`)}`;
}

/** Where a version came from, in a line: who wrote it, from what, with what trust, and whether you approved it. */
export function versionLine(v: SkillVersionView): string {
  const approved = v.trust !== "untrusted" ? "" : v.approvedAt ? ` · approved by you ${when(v.approvedAt)}` : " · not approved";
  return `v${v.n} · ${when(v.at)} · by ${skillAuthor(v.by)} · ${v.trust}${approved}${v.source ? ` · ${v.source}` : v.quest ? ` · quest ${v.quest}` : ""}`;
}

/** A skill in full, as a terminal shows it. */
export function skillPage(skill: SkillDetail): string[] {
  const shown = skill.history.find((v) => v.id === (skill.offered ?? skill.head));
  const pending = skill.pending && skill.pending !== shown?.id ? skill.history.find((v) => v.id === skill.pending) : null;
  return [
    `${bold(skill.title)} ${dim(`· ${skill.id}`)}`,
    `${stateWords(skill)} · ${skillRecordLine(skill)}`,
    "",
    ...(shown?.doc ? skillInWords(shown.doc).split("\n").slice(1) : ["(this node can't read its words: a newer node wrote it)"]),
    ...(pending ? ["", bold("A new version waits for your approval:"), `  ${versionLine(pending)}`, ...(pending.doc ? skillInWords(pending.doc).split("\n").map((l) => `  ${l}`) : ["  (unreadable here)"])] : []),
    "",
    bold("Versions"),
    ...skill.history.map((v) => `  ${v.id === skill.head ? "→" : " "} ${versionLine(v)}`),
    ...(skill.record.length ? ["", bold("Used in"), ...skill.record.slice(0, 20).map((u) => `  ${when(u.at)}  ${u.quest}${u.status ? `  ${u.status}` : ""}`)] : []),
  ];
}

/** A proof as typed: "command => what to expect". */
export function parseProof(text: string): { command: string; expect: string } {
  const at = text.lastIndexOf("=>");
  if (at < 1 || !text.slice(at + 2).trim()) throw new Error(`a proof is "command => what to expect" (got: ${text})`);
  return { command: text.slice(0, at).trim(), expect: text.slice(at + 2).trim() };
}

/** A skill's words from flags or a JSON file, checked as the node will check them, said in words when they won't do. */
export function docFromFlags(flags: Flags, readFile: (path: string) => string = (path) => readFileSync(path, "utf8")): SkillDoc {
  let raw: unknown;
  if (typeof flags.file === "string") {
    try {
      raw = JSON.parse(readFile(flags.file));
    } catch (error) {
      throw new Error(`${flags.file} isn't JSON a skill can be read from: ${(error as Error).message}`);
    }
  } else {
    raw = { title: flags.title, when: flags.when, steps: list(flags.step), proof: list(flags.proof).map(parseProof), pitfalls: list(flags.pitfall) };
  }
  const parsed = SkillDocInput.safeParse(raw);
  if (!parsed.success) {
    const what = parsed.error.issues.map((i) => `${i.path.join(".") || "skill"}: ${i.message}`).join("; ");
    throw new Error(`That isn't a skill yet (${what}). It needs a title (up to ${SKILL_LIMITS.title} characters), when to use it, and 1 to ${SKILL_LIMITS.steps} steps; nothing else but proof and pitfalls.\n${SKILLS_USAGE}`);
  }
  return parsed.data;
}

const need = (id: string | undefined): string => {
  if (!id || !SKILL_ID.test(id)) throw new Error(`a skill's id looks like sk_… (galahad skills lists them)\n${SKILLS_USAGE}`);
  return id;
};

export async function skillsCommand(api: Api, sub: string | undefined, rest: string[], flags: Flags, hooks: SkillsCliHooks): Promise<void> {
  switch (sub) {
    case undefined:
    case "list": {
      const { skills, budget } = await api.call<SkillsView>("skills");
      const shown = flags.all ? skills : skills.filter((s) => s.state !== "retired");
      if (!skills.length) console.log("He has no skills yet. He learns one when a quest of his passes its review (galahad do …), and you can write one: galahad skills write --title … --when … --step …");
      for (const s of shown) console.log(skillRow(s));
      const retired = skills.length - shown.length;
      if (retired) console.log(dim(`${retired} retired (kept, never offered): galahad skills --all`));
      const waiting = skills.filter((s) => s.state !== "retired" && s.pending).length;
      if (waiting) console.log(`${bold(`${waiting} wait${waiting === 1 ? "s" : ""} for your approval`)} ${dim("· none is given to a model before: galahad skills approve <id> shows it in full first")}`);
      console.log(dim(`Distilling: ${budget.usedToday} of ${budget.tokensPerDay} tokens used in the last day${budget.tokensPerDay === 0 ? " (off)" : ""} · galahad skills budget <tokens>`));
      return;
    }
    case "show": {
      const { skill } = await api.call<{ skill: SkillDetail }>("skill", { id: need(rest[0]) });
      console.log(skillPage(skill).join("\n"));
      return;
    }
    case "import": {
      if (!rest[0]) throw new Error(`which folder? galahad skills import https://github.com/<owner>/<repo>/tree/<branch>/<folder>\n${SKILLS_USAGE}`);
      const { skill, shortened } = await api.call<{ skill: SkillView; shortened: boolean }>("importSkill", { url: rest[0] });
      console.log(`Taken in as text: "${skill.title}" (${skill.id}), from ${skillAuthor(skill.by)}. Only its SKILL.md was read; nothing in its folder runs.`);
      if (shortened) console.log(dim("Its instructions were longer than a skill keeps: they end where it says the rest is."));
      console.log(`${bold("It waits for your approval")} ${dim(`· no model is given it before: galahad skills approve ${skill.id} shows it in full first`)}`);
      return;
    }
    case "approve": {
      const { skill } = await api.call<{ skill: SkillDetail }>("skill", { id: need(rest[0]) });
      const waiting = skill.pending ? skill.history.find((v) => v.id === skill.pending) : null;
      if (!waiting || skill.state === "retired") throw new Error(skill.state === "retired" ? "That skill is retired: restore it first (galahad skills restore <id>)." : "Nothing of that skill waits for your approval.");
      // Approval is of what you read: all of it, and where it came from.
      console.log([`${bold("This version waits for your approval")} ${dim(`· ${skill.id}`)}`, versionLine(waiting), "", ...(waiting.doc ? skillInWords(waiting.doc).split("\n") : ["(this node can't read its words: approve it from a node that can show it to you)"]), ""].join("\n"));
      if (!waiting.doc) return;
      console.log(dim("Approved, it is given to his planner and engineer as a note (data, fenced, marked untrusted) when it bears on a quest. It never runs anything by itself."));
      if (!flags.yes && !hooks.confirm("Approve exactly this version?")) return;
      const done = await api.call<{ skill: SkillView }>("approveSkill", { id: skill.id, version: waiting.id });
      console.log(`Approved: "${done.skill.title}" is ${stateWords(done.skill)}.`);
      return;
    }
    case "lock":
    case "unlock": {
      const { skill } = await api.call<{ skill: SkillView }>("lockSkill", { id: need(rest[0]), locked: sub === "lock" });
      console.log(skill.locked ? `Locked: he may use "${skill.title}", not change it.` : `Unlocked: he may revise "${skill.title}" again, if he wrote it.`);
      return;
    }
    case "retire":
    case "restore": {
      const { skill } = await api.call<{ skill: SkillView }>("retireSkill", { id: need(rest[0]), retired: sub === "retire" });
      console.log(skill.state === "retired" ? `Retired: "${skill.title}" is kept with every version, and offered to nobody. galahad skills restore ${skill.id} puts it back.` : `Restored: "${skill.title}" is ${stateWords(skill)}.`);
      return;
    }
    case "rollback": {
      const id = need(rest[0]);
      const { skill: before } = await api.call<{ skill: SkillDetail }>("skill", { id });
      const head = before.history.find((v) => v.id === before.head);
      const prev = head?.prev ? before.history.find((v) => v.id === head.prev) : null;
      if (!head || !prev) throw new Error("That skill has one version: there's nothing to go back to.");
      console.log(`From  ${versionLine(head)}\n      ${head.doc?.title ?? "(unreadable here)"}\nto    ${versionLine(prev)}\n      ${prev.doc?.title ?? "(unreadable here)"}`);
      if (!flags.yes && !hooks.confirm("Go back one version? (Both stay in its history.)")) return;
      const { skill } = await api.call<{ skill: SkillView }>("rollbackSkill", { id });
      console.log(`Rolled back: "${skill.title}" is ${stateWords(skill)}.`);
      return;
    }
    case "write": {
      const id = rest[0] ? need(rest[0]) : undefined;
      const doc = docFromFlags(flags, hooks.readFile);
      const { skill } = await api.call<{ skill: SkillView; version: string }>("writeSkill", { ...(id ? { id } : {}), doc });
      // The node answered with the skill as the mind holds it: only then is it said to be saved.
      console.log(`Saved ${id ? `version ${skill.versions} of` : "your skill"} "${skill.title}" (${skill.id}): ${stateWords(skill)}, ${skill.trust}.`);
      return;
    }
    case "budget": {
      if (rest[0] === undefined) {
        const { budget } = await api.call<SkillsView>("skills");
        console.log(`Distilling skills: ${budget.tokensPerDay === 0 ? "off (0 tokens a day)" : `${budget.tokensPerDay} tokens a day`}; ${budget.usedToday} used in the last day. One bounded call per passed quest at most, by the cheapest usable role.`);
        return;
      }
      const tokensPerDay = Number(rest[0]);
      if (!Number.isInteger(tokensPerDay) || tokensPerDay < 0 || tokensPerDay > SKILLS_BUDGET_MAX) throw new Error(`the budget is a whole number of tokens a day, 0 (off) to ${SKILLS_BUDGET_MAX}`);
      const { budget } = await api.call<{ budget: SkillsView["budget"] }>("setSkillsBudget", { tokensPerDay });
      console.log(budget.tokensPerDay === 0 ? "Distilling skills is off: he learns none from quests until you raise it." : `He may spend ${budget.tokensPerDay} tokens a day distilling skills (${budget.usedToday} used in the last day).`);
      return;
    }
    default:
      throw new Error(SKILLS_USAGE);
  }
}
