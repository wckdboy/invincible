import { plainLine } from "./plain.ts";

/*
 * An MCP server's question to you, asked in the middle of a call (the protocol's elicitation, in its form mode): what
 * it asks, and the fields it wants filled in, read from the flat schema it sent. It waits in your Inbox, and nothing
 * answers it but you: never a model. What a server may ask for is bounded (a dozen fields at most, each a text, a
 * number, a yes or no, or one or several of a list); anything else is no question it can ask, and is declined. Your
 * answer is checked against what it asked before it goes back.
 *
 * Pure, and no schema library: the app reads these types, the node checks with these functions.
 */

export const QUESTION_ID = /^qn_[A-Za-z0-9_-]{16}$/;
export const QUESTION_LIMITS = { message: 1000, fields: 12, title: 100, description: 300, options: 25, option: 200, text: 2000 } as const;

interface FieldBase {
  name: string;
  title: string;
  description: string | null;
  required: boolean;
}
export type QuestionField =
  | (FieldBase & { kind: "text"; format: "email" | "uri" | "date" | "date-time" | null; minLength: number | null; maxLength: number | null; default: string | null })
  | (FieldBase & { kind: "number"; integer: boolean; minimum: number | null; maximum: number | null; default: number | null })
  | (FieldBase & { kind: "yes-no"; default: boolean | null })
  | (FieldBase & { kind: "one"; options: { value: string; title: string }[]; default: string | null })
  | (FieldBase & { kind: "many"; options: { value: string; title: string }[]; minItems: number | null; maxItems: number | null; default: string[] | null });

/** A question waiting for you, as the Inbox shows it. */
export interface QuestionView {
  id: string;
  /** The connector whose server asks, and its name as you installed it. */
  connector: string;
  label: string;
  /** What it asks, in its own words: one line, nothing hidden in it. */
  message: string;
  fields: QuestionField[];
  askedAt: number;
  /** Unanswered by then, and the call goes on without an answer. */
  expires: number;
}

export type QuestionAnswer = Record<string, string | number | boolean | string[]>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const words = (v: unknown, max: number): string | null => (typeof v === "string" && plainLine(v) ? plainLine(v).slice(0, max) : null);
const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const FORMATS = new Set(["email", "uri", "date", "date-time"]);

/** A list's options: each a value and the words it's shown as (enum and enumNames, oneOf or anyOf of const and title). */
function optionsOf(p: Record<string, unknown>): { value: string; title: string }[] | null {
  const consts = Array.isArray(p.oneOf) ? p.oneOf : Array.isArray(p.anyOf) ? p.anyOf : null;
  const raw = consts
    ? consts.map((o) => (isObj(o) && typeof o.const === "string" ? { value: o.const, title: typeof o.title === "string" ? o.title : o.const } : null))
    : Array.isArray(p.enum)
      ? p.enum.map((value, i) => (typeof value === "string" ? { value, title: Array.isArray(p.enumNames) && typeof p.enumNames[i] === "string" ? (p.enumNames[i] as string) : value } : null))
      : null;
  if (!raw || !raw.length || raw.length > QUESTION_LIMITS.options || raw.some((o) => !o || o.value.length > QUESTION_LIMITS.option)) return null;
  return raw.map((o) => ({ value: o!.value, title: plainLine(o!.title).slice(0, QUESTION_LIMITS.option) || o!.value }));
}

/** The fields an elicitation's requested schema asks for, or why it is no question a server may ask here. */
export function questionFields(schema: unknown): { ok: true; fields: QuestionField[] } | { ok: false; why: string } {
  if (!isObj(schema) || schema.type !== "object" || !isObj(schema.properties)) return { ok: false, why: "it asked for no form" };
  const entries = Object.entries(schema.properties);
  if (!entries.length) return { ok: false, why: "it asked for nothing" };
  if (entries.length > QUESTION_LIMITS.fields) return { ok: false, why: `it asked for ${entries.length} fields (at most ${QUESTION_LIMITS.fields})` };
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === "string") : []);
  const fields: QuestionField[] = [];
  for (const [name, raw] of entries) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name) || !isObj(raw)) return { ok: false, why: `its field "${name.slice(0, 64)}" isn't one a form can hold` };
    const base: FieldBase = { name, title: words(raw.title, QUESTION_LIMITS.title) ?? name, description: words(raw.description, QUESTION_LIMITS.description), required: required.has(name) };
    if (raw.type === "string" && (raw.enum !== undefined || raw.oneOf !== undefined)) {
      const options = optionsOf(raw);
      if (!options) return { ok: false, why: `its field "${name}" offers no list a form can hold` };
      fields.push({ ...base, kind: "one", options, default: typeof raw.default === "string" && options.some((o) => o.value === raw.default) ? raw.default : null });
    } else if (raw.type === "array" && isObj(raw.items)) {
      const options = optionsOf(raw.items);
      if (!options) return { ok: false, why: `its field "${name}" offers no list a form can hold` };
      const fallback = Array.isArray(raw.default) && raw.default.every((d) => typeof d === "string" && options.some((o) => o.value === d)) ? (raw.default as string[]) : null;
      fields.push({ ...base, kind: "many", options, minItems: count(raw.minItems), maxItems: count(raw.maxItems), default: fallback });
    } else if (raw.type === "string") {
      const format = typeof raw.format === "string" && FORMATS.has(raw.format) ? (raw.format as "email") : null;
      const maxLength = Math.min(count(raw.maxLength) ?? QUESTION_LIMITS.text, QUESTION_LIMITS.text);
      fields.push({ ...base, kind: "text", format, minLength: count(raw.minLength), maxLength, default: typeof raw.default === "string" ? raw.default.slice(0, maxLength) : null });
    } else if (raw.type === "number" || raw.type === "integer") {
      fields.push({ ...base, kind: "number", integer: raw.type === "integer", minimum: num(raw.minimum), maximum: num(raw.maximum), default: num(raw.default) });
    } else if (raw.type === "boolean") {
      fields.push({ ...base, kind: "yes-no", default: typeof raw.default === "boolean" ? raw.default : null });
    } else return { ok: false, why: `its field "${name}" isn't a text, a number, a yes or no, or a choice` };
  }
  return { ok: true, fields };
}

/** Your answer, checked against what it asked: what goes back to the server, or which field is wrong and how. */
export function checkAnswer(fields: readonly QuestionField[], content: Record<string, unknown>): { ok: true; content: QuestionAnswer } | { ok: false; field: string; why: string } {
  const out: QuestionAnswer = {};
  const known = new Set(fields.map((f) => f.name));
  const stray = Object.keys(content).find((name) => !known.has(name));
  if (stray) return { ok: false, field: stray, why: "it wasn't asked for" };
  for (const f of fields) {
    const v = content[f.name];
    const empty = v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);
    if (empty) {
      if (f.required) return { ok: false, field: f.name, why: "it's needed" };
      continue;
    }
    if (f.kind === "text") {
      if (typeof v !== "string") return { ok: false, field: f.name, why: "a text is needed" };
      const text = v.trim();
      if (f.maxLength !== null && text.length > f.maxLength) return { ok: false, field: f.name, why: `at most ${f.maxLength} characters` };
      if (f.minLength !== null && text.length < f.minLength) return { ok: false, field: f.name, why: `at least ${f.minLength} characters` };
      if (f.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return { ok: false, field: f.name, why: "an email address is needed" };
      if (f.format === "uri" && !/^[a-z][a-z0-9+.-]*:\S+$/i.test(text)) return { ok: false, field: f.name, why: "an address is needed" };
      if (f.format === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(text)) return { ok: false, field: f.name, why: "a date is needed (2026-11-20)" };
      if (f.format === "date-time" && Number.isNaN(Date.parse(text))) return { ok: false, field: f.name, why: "a date and time are needed" };
      out[f.name] = text;
    } else if (f.kind === "number") {
      const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : Number.NaN;
      if (!Number.isFinite(n) || (f.integer && !Number.isInteger(n))) return { ok: false, field: f.name, why: f.integer ? "a whole number is needed" : "a number is needed" };
      if (f.minimum !== null && n < f.minimum) return { ok: false, field: f.name, why: `at least ${f.minimum}` };
      if (f.maximum !== null && n > f.maximum) return { ok: false, field: f.name, why: `at most ${f.maximum}` };
      out[f.name] = n;
    } else if (f.kind === "yes-no") {
      if (typeof v !== "boolean") return { ok: false, field: f.name, why: "yes or no is needed" };
      out[f.name] = v;
    } else if (f.kind === "one") {
      if (typeof v !== "string" || !f.options.some((o) => o.value === v)) return { ok: false, field: f.name, why: "one of its choices is needed" };
      out[f.name] = v;
    } else {
      if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && f.options.some((o) => o.value === x))) return { ok: false, field: f.name, why: "some of its choices are needed" };
      const chosen = [...new Set(v as string[])];
      if (f.minItems !== null && chosen.length < f.minItems) return { ok: false, field: f.name, why: `at least ${f.minItems}` };
      if (f.maxItems !== null && chosen.length > f.maxItems) return { ok: false, field: f.name, why: `at most ${f.maxItems}` };
      out[f.name] = chosen;
    }
  }
  return { ok: true, content: out };
}
