import {
  cleanSkillText,
  DISTIL_MAX_TOKENS,
  DISTIL_REPLY_TOKENS,
  distilDetail,
  distilledTrust,
  distilPrompt,
  distilTokens,
  findSecrets,
  ledgerNetwork,
  type NodeIdentity,
  type OfferedSkill,
  type QuestEvidence,
  questReadOutside,
  randomId,
  readDistilled,
  readSkillDoc,
  redact,
  relevantSkills,
  SECRET_REDIRECT,
  SKILL_BY_GALAHAD,
  SKILL_BY_OWNER,
  SKILL_CHAT_USE,
  SKILL_DISTIL_RESOURCE,
  skillAuthor,
  skillByAgent,
  skillFrom,
  type SkillDetail,
  type SkillDoc,
  type SkillLearned,
  skillLine,
  type SkillMark,
  skillRecordLine,
  SKILLS_BUDGET,
  SKILLS_BUDGET_MAX,
  SKILLS_FENCE,
  SKILLS_FENCE_WHAT,
  SKILLS_OFFERED,
  skillSecret,
  skillStanding,
  type SkillsView,
  skillTokens,
  type SkillTrust,
  type SkillVersionView,
  type SkillView,
  tidyPlan,
  versionUsable,
} from "@galahad/core";
import { type BrainContext, chat } from "@galahad/brain";
import type { MindStore, SkillRecord, Vault } from "@galahad/mind";
import type { LedgerEntryInput } from "@galahad/sandbox";
import { fenceLines } from "./archive/retrieval.ts";
import { queryTerms } from "./archive/search.ts";
import { reconcile } from "./heartbeat.ts";

/*
 * His skills, on a node: how the mind's records (signed versions, approvals, marks, uses)
 * become what every surface shows, and the three things that happen to them here.
 *
 *   Learned: when a quest of his ends `done`, one bounded call by the cheapest usable
 *     role distils at most one skill from the evidence the reviewer saw (the commands,
 *     their exit codes, the plan). Its trust is decided here, from the quest's network as
 *     this node's own ledger recorded it, never by the model or the caller.
 *   Offered: the few usable skills that bear on a goal go to the planner and the engineer
 *     (and to a chat answer) fenced as data, exactly as memories and archived entries
 *     are. Each one's use is recorded first; one the mind refuses to count (an untrusted
 *     version you haven't approved, a retired skill) is not given.
 *   Kept in order: you approve, lock, retire, roll back and edit; a tidy-up with the
 *     heartbeat marks the long-unused stale and suggests merges, and changes nothing else.
 *
 * "Saved" is said only of what is in the mind: every write here reads the skill back
 * before it answers.
 */

export class SkillError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Who is writing: you, him (with the trust his evidence earned), or another agent (always a proposal). */
export type SkillWriter =
  | { kind: "owner"; via?: string | undefined }
  | { kind: "galahad"; trust: "agent" | "untrusted"; quest?: string | undefined; source?: string | undefined }
  | { kind: "agent"; label: string }
  /** A skill taken in from elsewhere (an Agent Skill's folder, on your word): its words are its author's, never yours. */
  | { kind: "import"; from: string; source: string };

/** At most this many skills wait for you at once: an agent can't bury your inbox in proposals. */
export const MAX_WAITING = 40;
/** Below this much of the day's budget left, he doesn't start a distillation. */
export const DISTIL_MIN_TOKENS = 800;
/** The quests whose given skills are remembered (so every call of a quest gets the same block). */
const GIVEN_KEPT = 200;

const DAY_MS = 24 * 60 * 60_000;
const ms = (hlc: string): number => Number(hlc.slice(0, 15));
const TRUSTS = new Set(["owner", "agent", "untrusted"]);
/** A trust this node doesn't know is the least it knows. */
const trustOf = (trust: string): SkillTrust => (TRUSTS.has(trust) ? (trust as SkillTrust) : "untrusted");

/** A skill's versions as every surface reads them: each one's words checked again by this node. */
export function skillVersions(record: SkillRecord): SkillVersionView[] {
  return record.versions.map((v) => ({
    id: v.id,
    n: v.n,
    prev: v.prev,
    trust: trustOf(v.trust),
    // What a misbehaving node could have put in a name is cleaned like any text of a skill.
    by: cleanSkillText(v.by).slice(0, 100),
    quest: v.quest === null ? null : cleanSkillText(v.quest).slice(0, 64),
    via: v.via,
    source: v.source ? cleanSkillText(v.source).slice(0, 400) : null,
    at: ms(v.hlc),
    approvedAt: v.approvedHlc ? ms(v.approvedHlc) : null,
    doc: readSkillDoc(v.doc),
  }));
}

const UNREADABLE: SkillDoc = { title: "(a skill this node can't read: a newer node wrote it)", when: "", steps: [], proof: [], pitfalls: [] };

function viewOf(record: SkillRecord, versions: SkillVersionView[]): { view: SkillView; shown: SkillVersionView | null } {
  const standing = skillStanding({ versions, head: record.head, retired: record.retired, staleHlc: record.staleHlc, touchedHlc: record.touchedHlc });
  // Its words: the version in use; while there's none, the one that waits.
  const shown = versions.find((v) => v.id === (standing.offered ?? record.head)) ?? versions.at(-1) ?? null;
  const doc = shown?.doc ?? UNREADABLE;
  return {
    shown,
    view: {
      id: record.id,
      state: standing.state,
      locked: record.locked,
      title: doc.title,
      when: doc.when,
      trust: shown?.trust ?? "untrusted",
      by: shown?.by ?? "",
      offered: standing.offered,
      pending: standing.pending,
      head: record.head,
      versions: versions.length,
      quest: versions[0]?.quest ?? null,
      createdAt: ms(record.createdHlc),
      touchedAt: ms(record.touchedHlc),
      uses: record.uses,
      passed: record.passed,
      failed: record.failed,
      chats: record.chats,
      lastUsedAt: record.usedHlc ? ms(record.usedHlc) : null,
    },
  };
}

export const skillView = (record: SkillRecord): SkillView => viewOf(record, skillVersions(record)).view;

const ORDER: Record<SkillView["state"], number> = { proposed: 0, "in-use": 1, stale: 2, retired: 3 };

/** Every skill: what waits for you first (a proposed skill, a version waiting), then in use, stale, retired; the latest touched first within each. */
export function listSkills(store: Pick<MindStore, "skills">): SkillView[] {
  const waits = (s: SkillView) => (s.state !== "retired" && s.pending ? 0 : 1);
  return store
    .skills()
    .map(skillView)
    .sort((a, b) => waits(a) - waits(b) || ORDER[a.state] - ORDER[b.state] || b.touchedAt - a.touchedAt || (a.id < b.id ? -1 : 1));
}

/** One skill in full: every version kept, and the quests and answers it was given to. */
export function skillDetail(store: Pick<MindStore, "skill" | "skillUses">, id: string): SkillDetail | null {
  const record = store.skill(id);
  if (!record) return null;
  const history = skillVersions(record);
  return { ...viewOf(record, history).view, history, record: store.skillUses(id, 100).map((u) => ({ quest: cleanSkillText(u.quest).slice(0, 100), version: u.version, at: ms(u.hlc), status: u.status === null ? null : cleanSkillText(u.status).slice(0, 32) })) };
}

/** What anyone but you reads in place of words that wait for your approval. */
export const WITHHELD = "(it waits for the owner's approval: its words are shown to no agent or model until then)";

/**
 * A skill as anyone but you may read it. An untrusted version you haven't approved is given to no model, so no
 * agent's tool reads it either: while a skill has no usable version, its words are withheld.
 */
export function withheld<T extends SkillView>(skill: T): T {
  return skill.offered ? skill : { ...skill, title: WITHHELD, when: "" };
}

/** A skill that may be given to a model now, with what ranking it needs. */
interface Usable extends OfferedSkill {
  passed: number;
  failed: number;
}

/** The skills that may be given to a model: in use or stale, with a version that's trusted or approved by you. */
export function usableSkills(store: Pick<MindStore, "skills">): Usable[] {
  const out: Usable[] = [];
  for (const record of store.skills()) {
    const versions = skillVersions(record);
    const { view } = viewOf(record, versions);
    if (view.state !== "in-use" && view.state !== "stale") continue;
    const offered = versions.find((v) => v.id === view.offered);
    if (!offered?.doc) continue;
    out.push({ id: record.id, version: offered.id, trust: offered.trust, by: offered.by, quest: offered.quest, at: offered.at, record: skillRecordLine(view), doc: offered.doc, passed: record.passed, failed: record.failed });
  }
  return out;
}

/** What a quest (or an answer) was given: the fenced block, and which skills are in it. */
export interface GivenSkills {
  text: string;
  /** The same block for calls that aren't the planner's: each skill's instructions their opening alone (SKILL_BRIEF). */
  brief: string;
  skills: { id: string; title: string; trust: SkillTrust }[];
}

export interface SkillsDeps {
  store: MindStore;
  identity: NodeIdentity;
  log(message: string): void;
  /** A line in the signed ledger (each distillation is one: the day's spend is counted from them). */
  ledger(entry: LedgerEntryInput): void;
  /** The cheapest role with a usable model, or null. */
  role(): string | null;
  /** One answer from that role, stopped once it's `maxChars` long. */
  ask(role: string, prompt: string, maxChars: number, signal?: AbortSignal): Promise<{ text: string; model: string }>;
  now?: () => number;
}

export class SkillsService {
  /** Per quest: the skills it was given, chosen once from its goal (null: none bore on it). */
  private readonly given = new Map<string, GivenSkills | null>();
  /**
   * Per quest this node served: why its planner or engineer may have read others' words (untrusted memories,
   * archived entries or skills the node itself gave them). Present, even empty: the node knows what it gave.
   * A quest it has no such record of (a restart, a runner that never asked) earns no trust by silence.
   */
  private readonly others = new Map<string, Set<string>>();
  /** Quests being distilled now: never two calls for one quest. */
  private readonly distilling = new Set<string>();
  /** One distillation at a time on this node: the budget is read and spent in turn, never by two at once. */
  private turn: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: SkillsDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Event ids look like keys but are public to the fleet: the scan lets them pass, as everywhere on the node. */
  private get scan() {
    return { isPublic: (token: string) => this.deps.store.event(token) !== null };
  }

  private changed(): void {
    try {
      this.notices();
    } catch (error) {
      this.deps.log(`skills: ${(error as Error).message}`);
    }
  }

  // ---- reading -------------------------------------------------------------------

  /** `yours`: you are reading (a terminal, a paired device). Anyone else (an agent, his own tools) reads skills without the words that wait for you. */
  view(yours = true): SkillsView {
    const skills = listSkills(this.deps.store);
    return { skills: yours ? skills : skills.map(withheld), budget: this.budget() };
  }

  detail(id: string, yours = true): SkillDetail {
    const detail = skillDetail(this.deps.store, id);
    if (!detail) throw new SkillError(404, `no skill ${id}`);
    return yours ? detail : { ...withheld(detail), history: detail.history.map((v) => (versionUsable(v) ? v : { ...v, doc: null, source: null })) };
  }

  // ---- the budget ------------------------------------------------------------------

  /** The day's budget for distilling (this node's setting), and what the fleet's ledger shows spent in the last day. */
  budget(): SkillsView["budget"] {
    const set = Number(this.deps.store.meta("skills.budget") ?? SKILLS_BUDGET);
    const tokensPerDay = Number.isInteger(set) && set >= 0 && set <= SKILLS_BUDGET_MAX ? set : SKILLS_BUDGET;
    const usedToday = this.deps.store.ledgerOf(SKILL_DISTIL_RESOURCE, this.now() - DAY_MS).reduce((n, e) => n + distilTokens(e.body.detail), 0);
    return { tokensPerDay, usedToday };
  }

  setBudget(tokensPerDay: number): SkillsView["budget"] {
    this.deps.store.setMeta("skills.budget", String(tokensPerDay));
    return this.budget();
  }

  // ---- writing ----------------------------------------------------------------------

  /**
   * A new skill, or a new version of one. Yours are `owner`. His carry the trust his evidence earned, and he
   * changes only what he wrote that you haven't locked. Another agent's is a proposal of its own: untrusted,
   * waiting for you. The answer is the skill as the mind now holds it.
   */
  write(input: { id?: string | undefined; doc: SkillDoc }, who: SkillWriter): { skill: SkillView; version: string } {
    const { store, identity } = this.deps;
    const secret = skillSecret(input.doc, this.scan);
    if (secret) throw new SkillError(422, `That looks like a ${secret}. ${SECRET_REDIRECT}`);
    const by = who.kind === "owner" ? SKILL_BY_OWNER : who.kind === "galahad" ? SKILL_BY_GALAHAD : who.kind === "import" ? skillFrom(who.from) : skillByAgent(who.label);
    const trust: SkillTrust = who.kind === "owner" ? "owner" : who.kind === "galahad" ? who.trust : "untrusted";
    let id = input.id;
    if (id) {
      const record = store.skill(id);
      if (!record) throw new SkillError(404, `no skill ${id}`);
      if (who.kind === "agent") throw new SkillError(403, "Another agent proposes a skill of its own; it doesn't change one that's there.");
      if (who.kind === "import") throw new SkillError(403, "A skill taken in from elsewhere is a new one; it doesn't change one that's there.");
      if (who.kind === "galahad") {
        if (record.locked) throw new SkillError(403, "That skill is locked: he may use it, not change it.");
        if (record.versions.find((v) => v.id === record.head)?.by !== SKILL_BY_GALAHAD) throw new SkillError(403, "He changes only skills he wrote. That one is yours, or another agent's.");
        if (skillView(record).pending) throw new SkillError(409, "A version of that skill already waits for your approval.");
      }
    } else {
      if (who.kind !== "owner" && trust === "untrusted" && listSkills(store).filter((s) => s.state !== "retired" && s.pending).length >= MAX_WAITING) {
        throw new SkillError(429, `${MAX_WAITING} skills already wait for your approval. Approve or retire some first.`);
      }
      id = `sk_${randomId(12)}`;
    }
    const quest = who.kind === "galahad" ? who.quest : undefined;
    const source = who.kind === "galahad" || who.kind === "import" ? who.source : who.kind === "agent" ? `arm:${who.label}` : undefined;
    let version: string;
    try {
      version = store.emit(
        identity,
        "skill.written",
        { skill: id, doc: input.doc as unknown as Record<string, unknown>, by, ...(quest ? { quest: quest.slice(0, 64) } : {}) },
        { trust, ...(who.kind === "owner" && who.via ? { via: who.via } : {}), ...(source ? { source: source.slice(0, 400) } : {}) },
      ).id;
    } catch (error) {
      throw refused(error);
    }
    // Check, then say: only what the mind holds is "saved".
    const kept = store.skill(id);
    if (!kept?.versions.some((v) => v.id === version)) throw new SkillError(500, "The skill isn't in the mind: nothing was saved.");
    this.changed();
    return { skill: skillView(kept), version };
  }

  /** You approve exactly the version you read: the one that waits. An approval of anything else is refused. */
  approve(id: string, version: string, via?: string): SkillView {
    const { store, identity } = this.deps;
    const record = store.skill(id);
    if (!record) throw new SkillError(404, `no skill ${id}`);
    const found = skillVersions(record).find((v) => v.id === version);
    if (!found) throw new SkillError(404, "That skill has no such version.");
    if (record.head !== version) throw new SkillError(409, "The skill changed since you read it. Read it again, then approve what's there now.");
    if (found.trust !== "untrusted") throw new SkillError(409, "That version needs no approval: it isn't untrusted.");
    if (found.approvedAt !== null) throw new SkillError(409, "You approved that version already.");
    if (!found.doc) throw new SkillError(409, "This node can't read that version (a newer node wrote it): approve it from a node that can show it to you.");
    try {
      store.emit(identity, "skill.approved", { skill: id, version }, { trust: "owner", ...(via ? { via } : {}) });
    } catch (error) {
      throw refused(error);
    }
    const kept = store.skill(id);
    if (!kept?.versions.find((v) => v.id === version)?.approvedHlc) throw new SkillError(500, "The approval isn't in the mind.");
    this.changed();
    return skillView(kept);
  }

  /** Lock or unlock, retire or put back. Yours alone (the route says so). Asked again, it changes nothing. */
  mark(id: string, mark: Extract<SkillMark, "locked" | "retired">, on: boolean, via?: string): SkillView {
    const { store, identity } = this.deps;
    const record = store.skill(id);
    if (!record) throw new SkillError(404, `no skill ${id}`);
    if (record[mark] !== on) {
      try {
        store.emit(identity, "skill.marked", { skill: id, mark, on }, { trust: "owner", ...(via ? { via } : {}) });
      } catch (error) {
        throw refused(error);
      }
      this.changed();
    }
    return skillView(store.skill(id)!);
  }

  /** One step back: the version before the head is the head again. Nothing is deleted. */
  rollback(id: string, via?: string): SkillView {
    const { store, identity } = this.deps;
    const record = store.skill(id);
    if (!record) throw new SkillError(404, `no skill ${id}`);
    if (!record.versions.find((v) => v.id === record.head)?.prev) throw new SkillError(409, "That skill has one version: there's nothing to go back to.");
    try {
      store.emit(identity, "skill.reverted", { skill: id, from: record.head }, { trust: "owner", ...(via ? { via } : {}) });
    } catch (error) {
      throw refused(error);
    }
    this.changed();
    return skillView(store.skill(id)!);
  }

  // ---- offering -----------------------------------------------------------------------

  /**
   * The skills that bear on `about`, fenced as data, each one's use recorded against `ref` first. A skill
   * whose use the mind refuses to count is left out: what's given to a model is exactly what was recorded.
   */
  private offer(about: string, ref: string, nonce?: string): GivenSkills | null {
    const { store, identity } = this.deps;
    const picked = relevantSkills(queryTerms(about), usableSkills(store), SKILLS_OFFERED);
    const given: Usable[] = [];
    for (const skill of picked) {
      try {
        store.emit(identity, "skill.used", { skill: skill.id, version: skill.version, quest: ref });
        given.push(skill);
      } catch (error) {
        // Counted already for this quest (its plan was asked again): the same skill, given again.
        if (/already counted/.test(String((error as Error).message))) given.push(skill);
        else this.deps.log(`skills: ${skill.id} not given (${(error as Error).message})`);
      }
    }
    if (!given.length) return null;
    // (Both under one nonce: the planner's and the engineer's notes are the same block, the engineer's shorter.)
    const fence = nonce ?? randomId(12);
    return {
      text: fenceLines(SKILLS_FENCE_WHAT, SKILLS_FENCE, given.map((s) => skillLine(s)), fence),
      brief: fenceLines(SKILLS_FENCE_WHAT, SKILLS_FENCE, given.map((s) => skillLine(s, true)), fence),
      skills: given.map((s) => ({ id: s.id, title: s.doc.title, trust: s.trust })),
    };
  }

  /**
   * A quest's skills: chosen once, from its goal, and the same block (same nonce) for every call of that
   * quest, so its planner and its engineer read the same notes and nothing is counted twice.
   */
  forQuest(ref: string, goal: string): GivenSkills | null {
    if (this.given.has(ref)) return this.given.get(ref) ?? null;
    const given = this.offer(goal, ref);
    this.given.set(ref, given);
    while (this.given.size > GIVEN_KEPT) this.given.delete(this.given.keys().next().value!);
    // A skill that read the outside world (and that you approved) is still others' words in this quest's plan.
    this.gave(ref, given?.skills.some((s) => s.trust === "untrusted") ? ["it was given a skill shaped by the outside world"] : []);
    return given;
  }

  /**
   * What the node gave a quest's planner or engineer on one call, as far as others' words go: each reason is
   * why a skill learned from that quest can't be trusted as his alone (none: that call was given nothing
   * untrusted). The server says so on every call of a quest it serves.
   */
  gave(ref: string, reasons: readonly string[]): void {
    const known = this.others.get(ref) ?? new Set<string>();
    for (const reason of reasons) known.add(reason);
    this.others.delete(ref);
    this.others.set(ref, known);
    while (this.others.size > GIVEN_KEPT * 2) this.others.delete(this.others.keys().next().value!);
  }

  /**
   * An answer's skills: chosen from your question, under a nonce of its own. Counted once a skill a day
   * (`chat:<day>`), however many answers it went with: a chat never fills the log.
   */
  forAnswer(question: string): GivenSkills | null {
    return this.offer(question, `${SKILL_CHAT_USE}${new Date(this.now()).toISOString().slice(0, 10)}`);
  }

  // ---- learning -------------------------------------------------------------------------

  /**
   * A quest of his has ended and is remembered. Its outcome is recorded against each skill it was given;
   * and if its review passed, one bounded call distils at most one skill from its evidence.
   * `sandboxes`: the quest ref its sandboxes carry in the ledger (what the node itself recorded of them).
   */
  async learn(evidence: QuestEvidence, about: { ref: string; sandboxes: string; signal?: AbortSignal }): Promise<SkillLearned> {
    const { store, identity } = this.deps;
    const titles = new Map(listSkills(store).map((s) => [s.id, s.title]));
    const uses = store.skillsUsedBy(about.ref);
    for (const use of uses) {
      if (use.status) continue;
      try {
        store.emit(identity, "skill.outcome", { skill: use.skill, quest: about.ref, status: evidence.status });
      } catch (error) {
        this.deps.log(`skills: outcome of ${about.ref} not recorded for ${use.skill} (${(error as Error).message})`);
      }
    }
    this.given.delete(about.ref);
    // What this node gave the quest's planner and engineer besides the goal (null: it has no record of serving it).
    const served = this.others.get(about.ref) ?? null;
    this.others.delete(about.ref);
    // Only what the mind now holds is said to have been recorded.
    const used = store.skillsUsedBy(about.ref).map((u) => ({ id: u.skill, title: titles.get(u.skill) ?? u.skill }));
    const nothing = (why: string): SkillLearned => ({ skill: null, revised: false, why, used });

    if (evidence.status !== "done") return nothing("only a quest whose review passed teaches a skill");
    if (!evidence.steps.length) return nothing("the quest ran no commands");
    if (this.distilling.has(about.ref)) return nothing("this quest is being distilled already");
    // One distillation at a time on this node, each in its turn: the budget it reads is the budget it spends from.
    this.distilling.add(about.ref);
    const mine = this.turn.then(() => this.distil(evidence, about, used, served));
    this.turn = mine.catch(() => {});
    try {
      return await mine;
    } finally {
      this.distilling.delete(about.ref);
    }
  }

  /** The one bounded call, and what becomes of its answer. Runs in its turn (see learn). */
  private async distil(evidence: QuestEvidence, about: { ref: string; sandboxes: string; signal?: AbortSignal }, used: SkillLearned["used"], served: Set<string> | null): Promise<SkillLearned> {
    const { store } = this.deps;
    const nothing = (why: string): SkillLearned => ({ skill: null, revised: false, why, used });
    const now = this.now();
    // One distillation a quest, ever: the ledger says whether this one had its.
    if (store.ledgerOf(SKILL_DISTIL_RESOURCE, now - 30 * DAY_MS).some((e) => e.body.target === about.ref)) return nothing("this quest was distilled already");
    const budget = this.budget();
    if (budget.tokensPerDay === 0) return nothing("distilling skills is off (its budget is 0)");
    const left = budget.tokensPerDay - budget.usedToday;
    if (left < DISTIL_MIN_TOKENS) return nothing(`today's budget for skills is spent (${budget.usedToday} of ${budget.tokensPerDay} tokens)`);
    const role = this.deps.role();
    if (!role) return nothing("no role has a usable model");

    // The skills it was given: it may say "nothing new", or improve one he may change.
    const offered = used.map((u) => {
      const record = store.skill(u.id);
      const head = record?.versions.find((v) => v.id === record.head);
      return { id: u.id, title: u.title, revisable: !!record && !record.locked && head?.by === SKILL_BY_GALAHAD && !skillView(record).pending };
    });
    const total = Math.min(DISTIL_MAX_TOKENS, left);
    const reply = Math.min(DISTIL_REPLY_TOKENS, Math.floor(total * 0.3));
    // Everything a model sees is redacted first: a command can hold anything.
    const safe: QuestEvidence = {
      ...evidence,
      goal: redact(evidence.goal),
      plan: redact(evidence.plan),
      steps: evidence.steps.map((s) => ({ command: redact(s.command), exitCode: s.exitCode })),
      ...(evidence.gates ? { gates: evidence.gates.map((g) => ({ command: redact(g.command), exitCode: g.exitCode })) } : {}),
    };
    const prompt = distilPrompt(safe, { nonce: randomId(12), offered, maxChars: (total - reply) * 4 });
    let answer: { text: string; model: string };
    try {
      answer = await this.deps.ask(role, prompt, reply * 4, about.signal);
    } catch (error) {
      // An attempt costs what was sent: it's in the ledger, and this quest isn't asked about again.
      this.deps.ledger({ class: "create", resource: SKILL_DISTIL_RESOURCE, target: about.ref, verdict: "allow", reason: "a skill from a quest that passed review", detail: `${distilDetail(skillTokens(prompt), role)} · no answer` });
      return nothing(`the ${role} role couldn't answer (${redact(String((error as Error).message ?? error)).slice(0, 160)})`);
    }
    const text = answer.text.slice(0, reply * 4);
    this.deps.ledger({ class: "create", resource: SKILL_DISTIL_RESOURCE, target: about.ref, verdict: "allow", reason: "a skill from a quest that passed review", detail: distilDetail(skillTokens(prompt) + skillTokens(text), answer.model || role) });

    const read = readDistilled(text, safe, this.scan);
    if (!read.doc) return nothing(read.why);
    // Its trust is this node's to decide, from what its own ledger recorded of the quest's sandboxes.
    const recorded = store
      .ledgerOf("docker.container", now - 2 * DAY_MS)
      // Each sandbox as it was made (its removal is a line too, and says nothing of its network).
      .filter((e) => e.body.class === "create" && e.body.quest === about.sandboxes)
      .map((e) => ledgerNetwork(e.body.detail) ?? "unknown");
    const reasons = [...questReadOutside(evidence, recorded), ...(served ? [...served] : ["this node has no record of what its planner was given"])];
    const trust = distilledTrust(reasons);
    const revises = read.revises && offered.some((o) => o.id === read.revises && o.revisable) ? read.revises : undefined;
    try {
      const { skill } = this.write({ id: revises, doc: read.doc }, { kind: "galahad", trust: trust === "agent" ? "agent" : "untrusted", quest: evidence.quest, source: `quest:${evidence.quest}${reasons.length ? ` (${reasons.join("; ")})` : ""}` });
      return { skill, revised: !!revises, why: null, used };
    } catch (error) {
      return nothing(error instanceof SkillError ? error.message : "the skill couldn't be kept");
    }
  }

  // ---- the tidy-up (with the heartbeat) ---------------------------------------------------

  /** Marks the long-unused stale (when `mark`), and brings the inbox's suggestions in line. Changes nothing else. */
  tidy(mark = true): { stale: number; merges: number } {
    const { store, identity } = this.deps;
    const now = this.now();
    const plan = this.plan(now);
    let stale = 0;
    if (mark) {
      for (const id of plan.stale) {
        try {
          store.emit(identity, "skill.marked", { skill: id, mark: "stale", on: true });
          stale += 1;
        } catch (error) {
          this.deps.log(`skills: ${id} not marked stale (${(error as Error).message})`);
        }
      }
    }
    this.notices();
    return { stale, merges: plan.merges.length };
  }

  private plan(now: number) {
    return tidyPlan(
      this.deps.store.skills().map((record) => {
        const { view, shown } = viewOf(record, skillVersions(record));
        return { id: record.id, state: view.state, touchedAt: view.touchedAt, doc: shown?.doc ?? null };
      }),
      now,
    );
  }

  /** What needs you about his skills, as notices: how many wait for your approval, and pairs that look like one. */
  private notices(): void {
    const { store, identity } = this.deps;
    const now = this.now();
    const skills = listSkills(store);
    const titles = new Map(skills.map((s) => [s.id, s.title]));
    const waiting = skills.filter((s) => s.state !== "retired" && s.pending);
    const show = (title: string) => cleanSkillText(redact(title)).slice(0, 60);
    const findings = [
      ...(waiting.length
        ? [
            {
              key: "skills-waiting",
              severity: "info" as const,
              title: `${waiting.length} skill${waiting.length === 1 ? " waits" : "s wait"} for your approval`,
              // By id and author only: a notice is read by agents, and these words aren't theirs to read yet.
              body: `${waiting.slice(0, 8).map((s) => `${s.id} (by ${skillAuthor(s.by)})`).join("; ")}. None is given to a model until you approve it: read each in full first (galahad skills show <id>, or the Skills page).`.slice(0, 2000),
            },
          ]
        : []),
      ...this.plan(now).merges.map((m) => ({
        key: `skill-merge:${m.a}:${m.b}`,
        severity: "info" as const,
        title: `Galahad suggests: "${show(titles.get(m.a) ?? m.a)}" and "${show(titles.get(m.b) ?? m.b)}" look like one skill`.slice(0, 200),
        body: `${m.a} and ${m.b} share ${Math.round(m.similarity * 100)} % of their words. He merges nothing himself: if you agree, edit one and retire the other, or dismiss this.`,
      })),
    ].filter((f) => !findSecrets(`${f.title} ${f.body}`, this.scan).length);
    reconcile(store, identity, findings, now, "skills");
  }
}

/** A distillation's call may take this long, no longer. */
const ASK_TIMEOUT_MS = 90_000;

/**
 * How the node asks a role for one bounded answer: no tools, a model slot taken first (it waits its turn, like
 * any background call), stopped once it has written its share or after ASK_TIMEOUT_MS.
 */
export function skillAsker(ctx: {
  store: MindStore;
  vault: Vault;
  fetch?: typeof fetch | undefined;
  governor?: { enterModel(opts: { wait: boolean }, signal?: AbortSignal): Promise<() => void> };
  /** Told of each model call, for the node's count of them (usage.ts). */
  spent?: BrainContext["spent"];
}): SkillsDeps["ask"] {
  return async (role, prompt, maxChars, outer) => {
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), ASK_TIMEOUT_MS);
    const abort = () => stop.abort();
    outer?.addEventListener("abort", abort, { once: true });
    let leave: (() => void) | null = null;
    let text = "";
    let model = "";
    try {
      leave = (await ctx.governor?.enterModel({ wait: true }, stop.signal)) ?? null;
      for await (const event of chat({ store: ctx.store, vault: ctx.vault, ...(ctx.fetch ? { fetch: ctx.fetch } : {}), ...(ctx.spent ? { spent: ctx.spent } : {}) }, { role, messages: [{ role: "user", content: prompt }], signal: stop.signal })) {
        if (event.type === "text") text += event.text;
        else if (event.type === "model" || event.type === "done") model = event.ref;
        else if (event.type === "error") throw new Error(event.error);
        if (text.length >= maxChars) {
          stop.abort();
          break;
        }
      }
    } catch (error) {
      // Stopped because it had written enough: what it wrote stands. Anything else is the caller's to hear.
      if (!stop.signal.aborted || outer?.aborted || text.length < maxChars) throw error;
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", abort);
      leave?.();
    }
    return { text, model };
  };
}

/** The mind refused it by its own rules: said as it is, never as an internal error. */
function refused(error: unknown): SkillError {
  const message = String((error as Error)?.message ?? error);
  const why = /^emit (?:not authorized|rejected): (.*)$/s.exec(message)?.[1];
  return new SkillError(why ? 409 : 500, why ? `The mind refused it: ${why}.` : "The skill couldn't be kept.");
}
