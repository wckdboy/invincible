import { redact } from "./secret-scan.ts";

/*
 * The Roundtable is a technocracy: the knight best suited to a task takes it, and evidence decides, never rank.
 * Pure and zod-free (the app uses it too): the node gathers the facts (each knight's record, its tasks, its VM as
 * its host says now) and this says who takes the task, and why, in words the owner reads.
 *
 * What can't be bent is a requirement: a paused knight, one whose turns for the day are spent, one without a
 * desktop when the task needs a screen, one on another repository. Of those that can take it, a knight is weighed
 * by what is known of it: whether it is free now, how much of its work has been verified, and whether its job
 * speaks of the task's work. Ties go to the one that has done less today, then by name, so the same facts always
 * give the same knight.
 */

export interface KnightFacts {
  id: string;
  name: string;
  /** Its job, in the words it was given. */
  instructions: string;
  role: string;
  enabled: boolean;
  dailyTurns: number;
  turnsToday: number;
  repository: string | null;
  /** Its VM as its host says now; null: none made yet (one is made when a task starts). */
  vm: { image: string; status: string } | null;
  /** Its tasks, each as it stands. */
  tasks: { status: string; verified: boolean }[];
}

/** What a task requires of the knight that takes it. */
export interface TaskNeeds {
  /** A desktop in its VM (a display and a browser). */
  desktop?: boolean;
  /** The repository it must work on. */
  repository?: string;
}

export interface KnightChoice {
  id: string;
  name: string;
  reasons: string[];
}

export interface KnightConsidered {
  id: string;
  name: string;
  /** It may take the task; when not, `why` says what stands in the way. */
  eligible: boolean;
  score: number;
  why: string[];
}

/** A repository, however it is written: github.com/you/app for https://github.com/You/App.git/ and the like. */
export const repositoryKey = (url: string): string =>
  url.trim().toLowerCase().replace(/^[a-z+]+:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "").replace(/\.git$/, "").replace(/\/+$/, "");

/** A task that speaks of a browser or a screen: a desktop is likely to help, though it is not required. */
const SCREEN = /https?:\/\/|\b(browser|website|web ?page|web site|screen|screenshot|click|desktop|sign in|log ?in|captcha)\b/i;

/** Words that say nothing of what a task is about. */
const STOP = new Set(
  "about after again also always another before being both cannot could does doing done each either every from have having into itself just keep keeps make makes made many more most much must never only other ought over same should since some such than that their them then there these they this those through under until upon very what when where which while whom whose will with within without would your yours".split(" "),
);

/** A word reduced to a stem good enough to match reviews with review and tests with test. */
function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(ss|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** The words of a text worth matching, each with its stem, in the order they appear. */
function words(text: string): { word: string; stem: string }[] {
  const seen = new Set<string>();
  const out: { word: string; stem: string }[] = [];
  for (const word of text.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []) {
    if (STOP.has(word)) continue;
    const s = stem(word);
    if (seen.has(s)) continue;
    seen.add(s);
    out.push({ word, stem: s });
  }
  return out;
}

const listed = (items: string[]): string => (items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Who takes a task, and why; everyone considered, best first (those that can't, after, by name). */
export function chooseKnight(goal: string, needs: TaskNeeds, knights: readonly KnightFacts[]): { choice: KnightChoice | null; considered: KnightConsidered[] } {
  const asked = new Set(words(goal).map((w) => w.stem));
  const wantsScreen = !needs.desktop && SCREEN.test(goal);
  const repository = needs.repository ? repositoryKey(needs.repository) : null;
  const considered = knights.map((k): KnightConsidered & { turnsToday: number } => {
    const hasDesktop = !!k.vm && k.vm.image.includes("desktop");
    // What can't be bent.
    const barred: string[] = [];
    if (!k.enabled) barred.push("paused");
    if (k.turnsToday >= k.dailyTurns) barred.push(`its turns for today are spent (${k.turnsToday} of ${k.dailyTurns})`);
    if (needs.desktop && !hasDesktop) barred.push(k.vm ? "its VM has no desktop" : "it has no VM with a desktop");
    if (repository) {
      if (!k.repository) barred.push("it has no repository");
      else if (repositoryKey(k.repository) !== repository) barred.push(`it works on ${repositoryKey(k.repository)}`);
    }
    if (barred.length) return { id: k.id, name: k.name, eligible: false, score: 0, why: barred, turnsToday: k.turnsToday };

    // What is known of it.
    const why: string[] = [];
    let score = 0;
    const running = k.tasks.filter((t) => t.status === "running").length;
    const queued = k.tasks.filter((t) => t.status === "queued").length;
    if (running + queued === 0) {
      score += 1;
      why.push("free now");
    } else {
      score -= running + queued;
      why.push(`busy: ${[running ? `${plural(running, "task")} running` : "", queued ? `${queued} queued` : ""].filter(Boolean).join(", ")}`);
    }
    const ended = k.tasks.filter((t) => t.status === "done" || t.status === "failed");
    const good = ended.filter((t) => t.status === "done" && t.verified).length;
    // (One verified task in one is not certainty: what is known counts as much as it is.)
    score += (2 * (good + 1)) / (ended.length + 2);
    why.push(ended.length ? `${good} of ${plural(ended.length, "task")} verified` : "no tasks yet");
    const job = words(`${k.instructions} ${k.role}`).filter((w) => asked.has(w.stem)).slice(0, 3);
    if (job.length) {
      score += 0.75 * job.length;
      why.push(`its job speaks of ${listed(job.map((w) => w.word))}`);
    }
    if (needs.desktop || (wantsScreen && hasDesktop)) {
      if (wantsScreen) score += 1;
      why.push(needs.desktop ? "has a desktop" : "has a desktop, which the task looks to need");
    }
    if (!k.vm) why.push("its VM is made when the task starts");
    else score += 0.25;
    return { id: k.id, name: k.name, eligible: true, score, why, turnsToday: k.turnsToday };
  });
  considered.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    if (!a.eligible) return a.name.localeCompare(b.name);
    if (a.score !== b.score) return b.score - a.score;
    if (a.turnsToday !== b.turnsToday) return a.turnsToday - b.turnsToday;
    return a.name.localeCompare(b.name);
  });
  const best = considered.find((c) => c.eligible);
  return {
    choice: best ? { id: best.id, name: best.name, reasons: best.why } : null,
    considered: considered.map(({ turnsToday: _, ...c }) => c),
  };
}

/* ---------- a knight as a file you carry (PLAN #20) ---------- */

/** What a knight file says it is, on its first line of settings. */
export const KNIGHT_FILE = "knight 1";

/** A knight as a file holds it: who it is, its job, and how it works. Never its memory, its record or its keys. */
export interface KnightFile {
  id: string;
  name: string;
  /** Its job, in the words it was given. */
  instructions: string;
  role?: string;
  models?: string[];
  sensitive?: boolean;
  harness?: string;
  acp?: string;
  repository?: string;
  dailyTurns?: number;
  avatar?: unknown;
  /** The names of the keys it was given where it came from: never a key, and given again only by you. */
  keys?: string[];
}

const KNIGHT_FIELDS = ["id", "name", "role", "models", "sensitive", "harness", "acp", "repository", "dailyTurns", "avatar", "keys"] as const;

/**
 * A knight as a Markdown file: its settings between --- lines (each value JSON, which YAML reads too), then its job
 * under its name. Anything in its job that looks like a key is taken out first (`scrubbed` says how many); its memory,
 * its record and its keys never go into it, only the names of the keys it was given.
 */
export function knightToFile(knight: KnightFile): { text: string; scrubbed: number } {
  const settings: Record<string, unknown> = { galahad: KNIGHT_FILE };
  for (const field of KNIGHT_FIELDS) {
    const value = knight[field];
    if (value === undefined || value === null || (Array.isArray(value) && !value.length)) continue;
    settings[field] = value;
  }
  const instructions = redact(knight.instructions.trim());
  const scrubbed = instructions.split("[redacted").length - 1;
  const front = Object.entries(settings).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  return { text: `---\n${front.join("\n")}\n---\n\n# ${knight.name}\n\n${instructions}\n`, scrubbed };
}

/**
 * A knight file read back: its settings (a value that isn't JSON is read as the words it is), and its job, the text
 * under its name. Only what a knight file holds is read; anything else in it is left out, and said.
 */
export function knightFromFile(text: string): { ok: true; knight: KnightFile; ignored: string[] } | { ok: false; why: string } {
  const plain = text.replace(/\r\n?/g, "\n").replace(/^﻿/, "");
  const front = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(plain);
  if (!front) return { ok: false, why: "it doesn't open with a knight's settings (between --- lines)" };
  const settings: Record<string, unknown> = {};
  for (const line of front[1]!.split("\n")) {
    const field = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(line);
    if (!field) continue;
    const raw = field[2]!.trim();
    try {
      settings[field[1]!] = JSON.parse(raw);
    } catch {
      settings[field[1]!] = raw.replace(/^(["'])(.*)\1$/, "$2");
    }
  }
  if (settings.galahad !== KNIGHT_FILE) return { ok: false, why: `it isn't a knight file (its settings don't open with galahad: "${KNIGHT_FILE}")` };
  const id = typeof settings.id === "string" ? settings.id.trim() : "";
  const name = typeof settings.name === "string" ? settings.name.trim() : "";
  if (!id) return { ok: false, why: "it names no id" };
  if (!name) return { ok: false, why: "it gives the knight no name" };
  // Its job: everything under its settings, its first heading (its name) aside.
  const instructions = plain.slice(front[0].length).replace(/^\s*#[ \t]+[^\n]*\n?/, "").trim();
  const knight: KnightFile = { id, name, instructions };
  const ignored: string[] = [];
  const words = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
  const list = (value: unknown): string[] | undefined => (Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : undefined);
  for (const [key, value] of Object.entries(settings)) {
    if (key === "galahad" || key === "id" || key === "name") continue;
    if (key === "role" && words(value)) knight.role = value.trim();
    else if (key === "models" && list(value)) knight.models = list(value);
    else if (key === "sensitive" && typeof value === "boolean") knight.sensitive = value;
    else if (key === "harness" && words(value)) knight.harness = value.trim();
    else if (key === "acp" && words(value)) knight.acp = value.trim();
    else if (key === "repository" && words(value)) knight.repository = value.trim();
    else if (key === "dailyTurns" && typeof value === "number") knight.dailyTurns = value;
    else if (key === "avatar" && value && typeof value === "object") knight.avatar = value;
    else if (key === "keys" && list(value)) knight.keys = list(value);
    else ignored.push(key);
  }
  return { ok: true, knight, ignored };
}
