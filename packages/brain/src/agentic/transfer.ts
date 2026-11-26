import { answerOk, type TrialAnswer, trialScore } from "@galahad/core";
import { type Check, js } from "./kit.ts";

/*
 * Between the node and a sandbox, for agentic trials: putting a repository into one,
 * taking what was left out of one, and the record a graded trial makes. Everything
 * travels as shell commands through the sandbox's ordinary exec (the only door there
 * is), with payloads in base64 so nothing needs quoting; `bun` in the sandbox does
 * the unpacking and the packing.
 *
 * Each command starts with a comment naming what it is, so a stand-in sandbox in a
 * test can do the same thing without a shell.
 */

export const MARK = "# galahad-trial:";

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
const SCRATCH = "/tmp/.galahad-trial";
/** A command's argument is at most 100,000 characters at the node's door: payloads go in pieces well under it. */
const CHUNK = 60_000;

const UNPACK = js`import fs from "node:fs";
import path from "node:path";
const root = process.argv[2];
for (const [file, text] of Object.entries(FILES)) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}
`;

/** The commands that write `files` (path → text) under `root`, creating directories as needed. */
export function putCommands(files: Record<string, string>, root: string): string[] {
  for (const path of Object.keys(files)) if (path.startsWith("/") || path.split("/").includes("..")) throw new Error(`a file's path stays under its root: ${path}`);
  // One self-unpacking module: the files as a literal, then the code that writes them.
  const payload = b64(`const FILES = ${JSON.stringify(files)};\n${UNPACK}`);
  const pieces: string[] = [];
  for (let at = 0; at < payload.length; at += CHUNK) pieces.push(payload.slice(at, at + CHUNK));
  return [
    `${MARK}put-reset\nmkdir -p ${SCRATCH} && : > ${SCRATCH}/in.b64`,
    ...pieces.map((piece) => `${MARK}put-chunk\nprintf %s '${piece}' >> ${SCRATCH}/in.b64`),
    `${MARK}put-apply ${root}\nbase64 -d ${SCRATCH}/in.b64 > ${SCRATCH}/unpack.mjs && bun ${SCRATCH}/unpack.mjs '${root}' && rm -rf ${SCRATCH}`,
  ];
}

/** What a put-apply command's payload holds, for a stand-in sandbox (the chunks' base64, joined, decoded here). */
export function unpackPayload(base64: string): Record<string, string> {
  const source = Buffer.from(base64, "base64").toString("utf8");
  const end = source.indexOf(";\nimport fs");
  if (!source.startsWith("const FILES = ") || end < 0) throw new Error("not a put payload");
  return JSON.parse(source.slice("const FILES = ".length, end)) as Record<string, string>;
}

/** The most a tree may hold when it's taken out: a file's size, and all of them together. */
export const TREE_FILE_BYTES = 200_000;
export const TREE_BYTES = 600_000;

const PACK = js`import fs from "node:fs";
import path from "node:path";
const root = process.argv[2];
const files = {};
const skipped = [];
let total = 0;
const walk = (dir, prefix) => {
  for (const name of fs.readdirSync(dir).sort()) {
    if (name === ".git" || name === "node_modules") continue;
    const full = path.join(dir, name);
    const rel = prefix ? prefix + "/" + name : name;
    // Links aren't followed: only what is really in the tree is taken.
    const stat = fs.lstatSync(full);
    if (stat.isDirectory()) walk(full, rel);
    else if (!stat.isFile() || stat.size > ${TREE_FILE_BYTES} || total + stat.size > ${TREE_BYTES}) skipped.push(rel);
    else {
      total += stat.size;
      files[rel] = fs.readFileSync(full, "utf8");
    }
  }
};
if (fs.existsSync(root)) walk(root, "");
console.log("TREE " + Buffer.from(JSON.stringify({ files, skipped }), "utf8").toString("base64"));
`;

/** The command that prints the tree under `root` (its files' text; no .git, no node_modules, no links, nothing huge). */
export const treeCommand = (root: string): string => `${MARK}tree ${root}\nmkdir -p ${SCRATCH} && printf %s '${b64(PACK)}' | base64 -d > ${SCRATCH}/pack.mjs && bun ${SCRATCH}/pack.mjs '${root}'; rm -rf ${SCRATCH}`;

/** A tree as a stand-in sandbox prints it. */
export const treeOutput = (files: Record<string, string>, skipped: string[] = []): string => `TREE ${b64(JSON.stringify({ files, skipped }))}\n`;

/** What the tree command printed, read back; null when it isn't a tree (the command failed, or its output was cut). */
export function readTree(stdout: string): { files: Record<string, string>; skipped: string[] } | null {
  const line = stdout.split("\n").find((l) => l.startsWith("TREE "));
  if (!line) return null;
  try {
    const parsed = JSON.parse(Buffer.from(line.slice(5).trim(), "base64").toString("utf8")) as { files?: unknown; skipped?: unknown };
    if (!parsed.files || typeof parsed.files !== "object" || Array.isArray(parsed.files)) return null;
    const files: Record<string, string> = {};
    for (const [path, text] of Object.entries(parsed.files as Record<string, unknown>)) {
      if (typeof text !== "string" || path.startsWith("/") || path.split("/").includes("..")) return null;
      files[path] = text;
    }
    return { files, skipped: Array.isArray(parsed.skipped) ? parsed.skipped.filter((s): s is string => typeof s === "string") : [] };
  } catch {
    return null;
  }
}

/** Where a fresh sandbox holds what is graded, and the hidden checks beside it. */
export const GRADE = { root: "/work/grade", repo: "/work/grade/repo", script: "/work/grade/check.mjs", result: "/work/grade/result.json", quest: "/work/grade/quest.json" } as const;

/** The command that runs one hidden check, and what its output must hold for the check to have passed. */
export function checkCommand(key: string, token: string): { command: string; passed(result: { exitCode: number; stdout: string }): boolean } {
  return {
    command: `${MARK}check ${key} ${token}\ncd ${GRADE.root} && bun ${GRADE.script} ${GRADE.repo} ${GRADE.result} ${GRADE.quest} ${key} ${token}`,
    // Exit 0 alone isn't enough: a module that exits the process when it's imported prints no such line.
    passed: (result) => result.exitCode === 0 && result.stdout.split(/\r?\n/).includes(`PASS ${key} ${token}`),
  };
}

export interface GradedChecks {
  answers: TrialAnswer[];
  score: number;
  note?: string;
}

/**
 * A trial's record of its hidden checks: each an answer every replica can re-check (expected 1, got 1 when it
 * passed, 0 when it failed, nothing when it couldn't be run), the score their share. `passed`: true, false, or
 * null for a check that wasn't run.
 */
export function gradeChecks(checks: readonly Pick<Check, "key">[], passed: (key: string) => boolean | null): GradedChecks {
  const answers = checks.map((check): TrialAnswer => {
    const verdict = passed(check.key);
    const got = verdict === null ? null : verdict ? 1 : 0;
    return { key: check.key, units: "pass", expected: 1, got, tolerance: 0, ok: answerOk(got, 1, 0) };
  });
  const unrun = answers.filter((a) => a.got === null).map((a) => a.key);
  const failed = answers.filter((a) => a.got === 0).map((a) => a.key);
  const note = unrun.length ? `not run: ${unrun.join(", ")}` : failed.length ? `failed: ${failed.join(", ")}` : undefined;
  return { answers, score: trialScore(answers), ...(note ? { note: note.slice(0, 1000) } : {}) };
}
