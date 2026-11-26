/*
 * What a model was seen to do when it was checked (packages/brain/src/checks.ts): whether it follows the quest
 * loop's command format, reads a screen, and points at the right place on one. Evidence, not a label: the
 * Roundtable's rule (the best suited takes the task) applies to models too. Recorded in the mind (LWW by model,
 * `model.checked`) and read leniently: a newer node that checks more never makes an older one lose what it knows.
 * Zod-free, so the app reads it as the node does.
 */

export interface ModelCheck {
  /** When it was checked (ms). */
  at: number;
  /** Galahad's revision that checked it. */
  version?: string;
  /** The quest loop: of the replies it sent, how many held a command to run (or said DONE or GIVE UP). */
  format?: { replies: number; good: number };
  /** A screenshot's largest heading, read back: right or not, and what it said. */
  reads?: { ok: boolean; said: string };
  /** Places on that screenshot: how many it was asked for, how many of its answers land on them, how far off on average (px). */
  places?: { targets: number; landed: number; meanErrorPx: number | null };
  /** Each part that could not be done, and why. */
  errors?: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1_000_000;

/** A check as the mind holds it; null when it isn't one. What is malformed in it is dropped, what is extra is kept. */
export function readModelCheck(raw: unknown): ModelCheck | null {
  if (!isObj(raw) || typeof raw.at !== "number" || !Number.isFinite(raw.at)) return null;
  const check: ModelCheck = { ...raw, at: raw.at } as ModelCheck;
  delete check.format;
  delete check.reads;
  delete check.places;
  delete check.errors;
  const { format, reads, places, errors } = raw;
  if (isObj(format) && count(format.replies) && count(format.good) && format.good <= format.replies) check.format = { replies: format.replies, good: format.good };
  if (isObj(reads) && typeof reads.ok === "boolean" && typeof reads.said === "string") check.reads = { ok: reads.ok, said: reads.said.slice(0, 200) };
  if (isObj(places) && count(places.targets) && count(places.landed) && places.landed <= places.targets) {
    check.places = { targets: places.targets, landed: places.landed, meanErrorPx: typeof places.meanErrorPx === "number" && Number.isFinite(places.meanErrorPx) ? places.meanErrorPx : null };
  }
  if (Array.isArray(errors)) {
    const said = errors.filter((e): e is string => typeof e === "string").map((e) => e.slice(0, 300));
    if (said.length) check.errors = said.slice(0, 8);
  }
  if (typeof raw.version !== "string") delete check.version;
  return check;
}

/** It follows the quest loop's format: at least four replies in five held a command. null: not checked. */
export const followsFormat = (check: ModelCheck | null): boolean | null =>
  check?.format && check.format.replies ? check.format.good / check.format.replies >= 0.8 : null;

/** It read the screen's heading right. null: not checked. */
export const readsScreens = (check: ModelCheck | null): boolean | null => (check?.reads ? check.reads.ok : null);

/** Every place it was asked for, it answered on its target: a click there would land. null: not checked. */
export const placesClicks = (check: ModelCheck | null): boolean | null =>
  check?.places && check.places.targets ? check.places.landed === check.places.targets : null;

/** What a check found, a phrase each, in the words the terminal and the app use. */
export function checkFacts(check: ModelCheck): string[] {
  const facts: string[] = [];
  if (check.format) facts.push(`commands in ${check.format.good} of ${check.format.replies} replies`);
  if (check.reads) facts.push(check.reads.ok ? "reads a screen" : `misreads a screen (said: ${check.reads.said.slice(0, 60)})`);
  if (check.places) facts.push(`${check.places.landed} of ${check.places.targets} clicks land${check.places.meanErrorPx === null ? "" : ` (${Math.round(check.places.meanErrorPx)} px off on average)`}`);
  for (const error of check.errors ?? []) {
    const at = error.indexOf(":");
    facts.push(at > 0 ? `could not check ${error.slice(0, at)}:${error.slice(at + 1)}` : `could not check: ${error}`);
  }
  return facts;
}

/**
 * The model that looks at a knight's screen: the first one named for the role (`eyes`) that can be used there; with
 * none named, the checked model that reads the screen and whose clicks all land, nearest the mark. Evidence chooses.
 */
export function chooseEyes(named: readonly string[], checks: readonly { ref: string; check: ModelCheck }[], usable: (ref: string) => boolean): string | null {
  if (named.length) return named.find(usable) ?? null;
  const seeing = checks.filter(({ ref, check }) => placesClicks(check) === true && readsScreens(check) !== false && usable(ref));
  seeing.sort((a, b) => (a.check.places!.meanErrorPx ?? 0) - (b.check.places!.meanErrorPx ?? 0) || a.ref.localeCompare(b.ref));
  return seeing[0]?.ref ?? null;
}
