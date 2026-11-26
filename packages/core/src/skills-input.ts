import { z } from "zod";
import type { findSecrets } from "./secret-scan.ts";
import { cleanSkillBody, cleanSkillText, type QuestEvidence as Evidence, SKILL_ID, SKILL_LIMITS, SKILL_VERSION, SKILLS_BUDGET_MAX, type SkillDoc, skillSecret } from "./skills.ts";

/*
 * What the node takes in about skills, checked at the boundary (skills.ts has the record
 * and the rules, without a schema library). A skill's words are strict where they enter
 * (the API, the distiller's reply) and read leniently from the log, so a field a newer
 * node adds never makes an older one refuse the event or the skill.
 */

export const SkillId = z.string().regex(SKILL_ID, "a skill's id, sk_…");
export const SkillVersionId = z.string().regex(SKILL_VERSION, "a version's id");

const Line = (max: number) =>
  z
    .string()
    .max(max * 4)
    .transform(cleanSkillText)
    .pipe(z.string().min(1).max(max));

/** A skill's words as they enter: every text one line, cleaned and bounded. */
export const SkillDocInput = z.strictObject({
  title: Line(SKILL_LIMITS.title),
  when: Line(SKILL_LIMITS.when),
  steps: z.array(Line(SKILL_LIMITS.step)).min(1).max(SKILL_LIMITS.steps),
  proof: z
    .array(z.strictObject({ command: Line(SKILL_LIMITS.command), expect: Line(SKILL_LIMITS.expect) }))
    .max(SKILL_LIMITS.proofs)
    .default([]),
  pitfalls: z.array(Line(SKILL_LIMITS.pitfall)).max(SKILL_LIMITS.pitfalls).default([]),
  /** Its instructions in full (a skill taken in from elsewhere): their lines kept, nothing hidden in them. */
  body: z
    .string()
    .max(SKILL_LIMITS.body * 2)
    .transform(cleanSkillBody)
    .pipe(z.string().min(1).max(SKILL_LIMITS.body))
    .optional(),
});
export type SkillDocInput = z.input<typeof SkillDocInput>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A skill's words as the log holds them, read by this node: the fields it knows, checked and bounded
 * again; a field a newer node added is ignored. Null: not a skill this node can read (it's then offered
 * to nobody, and shown as unreadable).
 */
export function readSkillDoc(v: unknown): SkillDoc | null {
  if (!isObj(v)) return null;
  const known = {
    title: v.title,
    when: v.when,
    steps: v.steps,
    ...(v.proof === undefined ? {} : { proof: Array.isArray(v.proof) ? v.proof.map((p) => (isObj(p) ? { command: p.command, expect: p.expect } : p)) : v.proof }),
    ...(v.pitfalls === undefined ? {} : { pitfalls: v.pitfalls }),
    ...(v.body === undefined ? {} : { body: v.body }),
  };
  const parsed = SkillDocInput.safeParse(known);
  return parsed.success ? parsed.data : null;
}

const QuestRef = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/);
const ExitCode = z.number().int().min(-1).max(255);

/** A quest's evidence (skills.ts QuestEvidence), as its runner sends it. */
export const QuestEvidenceInput = z.strictObject({
  quest: QuestRef,
  sandbox: QuestRef.optional(),
  goal: z.string().min(1).max(4000),
  status: z.enum(["done", "unverified", "gave-up", "stopped"]),
  network: z.enum(["isolated", "gateway", "online"]),
  repo: z.boolean().optional(),
  agent: z.string().max(40).optional(),
  plan: z.string().max(8000),
  steps: z.array(z.strictObject({ command: z.string().max(4000), exitCode: ExitCode })).max(400),
  gates: z.array(z.strictObject({ command: z.string().max(1000), exitCode: ExitCode })).max(16).optional(),
}) satisfies z.ZodType<Evidence>;

/** What the distiller answered: a skill (and the one of his it would revise), or nothing, and why. */
export type Distilled = { doc: SkillDoc; revises: string | null; droppedProofs: number } | { doc: null; why: string };

/**
 * Read the distiller's reply. A skill only when it's exactly one: a JSON object that passes the contract,
 * with nothing that looks like a secret. A proof is kept only when its command is one the evidence shows
 * exited 0 (a command that ran, or a gate): the model can't vouch for a command nobody ran.
 */
export function readDistilled(reply: string, e: Pick<Evidence, "steps" | "gates">, options?: Parameters<typeof findSecrets>[1]): Distilled {
  const text = reply.trim();
  if (!text || /^\W*NONE\W*$/i.test(text)) return { doc: null, why: "nothing worth doing the same way again" };
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { doc: null, why: "the reply wasn't a skill" };
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { doc: null, why: "the reply wasn't a skill" };
  }
  if (!isObj(raw)) return { doc: null, why: "the reply wasn't a skill" };
  const { revises, ...fields } = raw;
  const doc = readSkillDoc(fields);
  if (!doc) return { doc: null, why: "the reply wasn't a skill" };
  const ran = new Set([...e.steps, ...(e.gates ?? [])].filter((s) => s.exitCode === 0).map((s) => cleanSkillText(s.command)));
  const proof = doc.proof.filter((p) => ran.has(p.command));
  const checked = { ...doc, proof };
  const secret = skillSecret(checked, options);
  if (secret) return { doc: null, why: `it looked like it held a ${secret}` };
  return { doc: checked, revises: typeof revises === "string" && SKILL_ID.test(revises) ? revises : null, droppedProofs: doc.proof.length - proof.length };
}

/* ---------- what the API takes ---------- */

/** Write a skill, or a new version of one (`id`). Who you are decides its trust; the node never takes it from the caller. */
export const SkillWriteInput = z.strictObject({ id: SkillId.optional(), doc: SkillDocInput });
/** Approve exactly the version you read. */
export const SkillApproveInput = z.strictObject({ id: SkillId, version: SkillVersionId });
export const SkillLockInput = z.strictObject({ id: SkillId, locked: z.boolean() });
export const SkillRetireInput = z.strictObject({ id: SkillId, retired: z.boolean() });
export const SkillsBudgetInput = z.strictObject({ tokensPerDay: z.number().int().min(0).max(SKILLS_BUDGET_MAX) });
