import { costOf, type ExecResult, type Prices, type SandboxView, spendTotal, type TeamSnapshot, type TeamTaskRecord, type TrialAnswer, type TrialRecord, trialScore, tokensLabel, usdLabel } from "@galahad/core";
import { QUEST_DEFAULTS, testFilesOf } from "@galahad/brain";
import { inWorkdir, type NodeClient, questId, runNodeQuest } from "./quest-cli.ts";
import { quote } from "./team-runtime.ts";
import { harnessOptions, heldToEffort, nothingAnswered, tellPassedOver, type TrialJob, type TrialUnit } from "./trial-cli.ts";

/**
 * The commands a trial of a knight's task has: never fewer than 150, and three times what its knight's run used when
 * that is more. A trial stays bounded, so its runs can be compared, and the bound is the case's own, the same in every
 * run of it. It was 40, what a knight's task had until it was audited instead of counted (17 November 2026); on
 * 21 November both cases graded in the first run with real models used all 40 and were stopped, one that had taken its
 * knight 52: a knight's task has no such bound now, and the default loop calls its tools one at a time, so the same work
 * is more commands.
 */
export const commandsFor = (c: Pick<YourCase, "record">): number => Math.max(150, 3 * c.record.commands);

/*
 * Trials from your own work (PLAN #9). A case is a knight's task that passed review, in a repository, with the commit
 * it began from kept: its goal, its repository at that commit, its gates, and what its run took. A trial of it is an
 * ordinary quest in a fresh sandbox: the repository at that commit (fetched through the read-only git gateway on a
 * lease of the sandbox's own: checkoutRepository), where the knight had it, with the goal and the gates. Then what the
 * engineer left is taken out as a patch against the commit and graded apart: the gates run in fresh sandboxes he never
 * had, and a program decides, gate by gate.
 *
 * A gate counts only when it proves something here: it fails on the commit with only the held-out tests put in place
 * (the test files the task's own change adds or changes; one that passes before any work proves nothing: PLAN #7), and
 * it passes with the task's own whole change (one that change can't pass in a fresh sandbox, for something its knight
 * installed first, say, can't grade another's). Both are asked before any model is paid; a case with no such gate isn't
 * graded, and says why. What the engineer left is graded with the held-out tests put back over whatever he left in
 * them, so his version of those files doesn't count either way. A gate also fails when the change alters a test file it
 * names that the task's own change didn't touch, as a quest's lock refuses one. The score is the share of counted gates
 * passed, beside how the trial's quest ended.
 *
 * Nothing the mind learned goes with the quest (no archive, memories or skills): the archive keeps the task's own
 * change, and a memory or a skill may hold what the task taught. The checkout holds the commit and its history and
 * nothing after it. A crash of the machinery (a commit that can't be fetched, a sandbox that can't be made, a change
 * that can't be read) is recorded as a crash, which says nothing about ability.
 */

/** A knight's task, as a trial's case. */
export interface YourCase {
  /** As a trial's problem: the task's id made a slug (`_` read as `-`). */
  id: string;
  task: string;
  title: string;
  knight: string;
  goal: string;
  gates: string[];
  /** Its knight's repository, and the commit the task began from. */
  repository: string;
  base: string;
  /** Where the task's own change is kept: its patch is what a counted gate must pass with. */
  artifact: string;
  /** What its run took, as its runner counted it. */
  record: TeamTaskRecord;
}

/** Why one of your knights' tasks isn't a case. */
export type NotACase = "not verified" | "no change kept" | "no record of its run" | "no gates" | "needs a desktop" | "knight removed" | "no repository";

/** A gate that runs the desktop's own command (a knight's VM with a screen has it; a trial's sandbox doesn't, yet). */
const looksAtADesktop = (gate: string): boolean => /(^|[;&|(]\s*|\$\(\s*)desktop\s/.test(gate);

export interface YourCases {
  /** Hardest first. */
  cases: YourCase[];
  /** The tasks that aren't cases, and why. */
  left: { task: string; why: NotACase }[];
}

/** A task's id as a trial's problem. (Twelve characters of [a-z0-9_-]: two tasks would have to differ only in a `_` to meet.) */
export const caseId = (task: string): string => task.replace(/_/g, "-");

/**
 * Your cases, from the tasks the team's controller keeps (its latest 512). A task's gates are its own: a knight's task
 * proposes none, so one given none isn't a case. Nor is one whose gate looks at a desktop: a trial's sandbox has none,
 * so that gate could only fail there. A removed knight's task isn't one either: the snapshot no longer says which
 * repository it worked in. Its repository is its knight's as it is now.
 */
export function yourCases(team: Pick<TeamSnapshot, "tasks" | "teammates">): YourCases {
  const cases: YourCase[] = [];
  const left: YourCases["left"] = [];
  for (const task of team.tasks) {
    const knight = team.teammates.find((t) => t.id === task.assignee);
    const leave = (why: NotACase): void => void left.push({ task: task.id, why });
    if (!task.verified) leave("not verified");
    else if (!task.changes) leave("no change kept");
    else if (!task.record) leave("no record of its run");
    else if (!task.gates.length) leave("no gates");
    else if (task.gates.some(looksAtADesktop)) leave("needs a desktop");
    else if (!knight) leave("knight removed");
    else if (!knight.repository) leave("no repository");
    else {
      cases.push({
        id: caseId(task.id),
        task: task.id,
        title: task.title,
        knight: knight.id,
        goal: task.goal,
        gates: [...task.gates],
        repository: knight.repository,
        base: task.changes.base,
        artifact: task.changes.artifact,
        record: task.record,
      });
    }
  }
  return { cases: cases.sort(hardestFirst), left };
}

const tokensOf = (c: YourCase): number => spendTotal(c.record.spent).tokens;

/** Hardest first, by what the original run took: more revisions, then more commands, then more tokens; then the latest. */
export const hardestFirst = (a: YourCase, b: YourCase): number =>
  b.record.revisions - a.record.revisions || b.record.commands - a.record.commands || tokensOf(b) - tokensOf(a) || b.record.endedAt - a.record.endedAt || (a.task < b.task ? -1 : a.task > b.task ? 1 : 0);

/**
 * The cases a run takes: those named, by task id (as it is or as its slug) or by knight, else every one; hardest first.
 * A task that isn't a case says why; a name that is neither says so.
 */
export function chooseCases(yours: YourCases, names: readonly string[]): YourCase[] {
  const named = (c: YourCase, name: string): boolean => c.task === name || c.id === name || c.knight === name;
  const problems = names.flatMap((name) => {
    if (yours.cases.some((c) => named(c, name))) return [];
    const not = yours.left.find((l) => l.task === name || caseId(l.task) === name);
    return [not ? `${name} isn't a case (${not.why})` : `${name}: no case, nor a knight with one`];
  });
  if (problems.length) throw new Error(`${problems.join("; ")} (galahad trial problems --suite yours lists them)`);
  return names.length ? yours.cases.filter((c) => names.some((name) => named(c, name))) : [...yours.cases];
}

/** Your cases as the node's team controller has them now. */
export async function readCases(node: NodeClient): Promise<YourCases> {
  return yourCases(await node.call<TeamSnapshot>("team"));
}

/** Tokens and money in words: money at your prices, "at least" where some model has none. */
function costLine(lines: TeamTaskRecord["spent"], prices: Prices): string {
  const total = spendTotal(lines);
  const cost = costOf(lines, prices);
  const money = cost.complete ? usdLabel(cost.usd) : cost.usd > 0 ? `at least ${usdLabel(cost.usd)}` : "no price";
  return `${tokensLabel(total.tokens)}${total.complete ? "" : "+"} tokens · ${money}`;
}

/** What a case's original run took and cost, in a line. */
export function originalRun(c: YourCase, prices: Prices): string {
  const r = c.record;
  const minutes = Math.max(1, Math.round((r.endedAt - r.startedAt) / 60_000));
  return `${r.revisions} revision${r.revisions === 1 ? "" : "s"} · ${r.commands} command${r.commands === 1 ? "" : "s"} · ${minutes} min · ${costLine(r.spent, prices)}`;
}

/** Under the list: what a run of the hardest would likely cost going by when they were done, and which tasks aren't cases. */
export function yoursAside(yours: YourCases, prices: Prices, hardest: number): string {
  const said: string[] = [];
  if (yours.cases.length) {
    const first = yours.cases.slice(0, hardest);
    said.push(
      `A run that names none takes the first ${first.length} (--hardest n for more or fewer). When they were done they took ${costLine(first.flatMap((c) => c.record.spent), prices)} ` +
        "(a coding tool's own calls on its own sign-in weren't counted); grading them costs no tokens.",
    );
  }
  const total = yours.cases.length + yours.left.length;
  if (!total) said.push("No task of your knights' yet: a case is one that passed review in a repository, with gates of its own.");
  else if (yours.left.length) {
    const counts = new Map<NotACase, number>();
    for (const { why } of yours.left) counts.set(why, (counts.get(why) ?? 0) + 1);
    said.push(`${yours.left.length} of your knights' ${total} latest tasks aren't cases: ${[...counts].map(([why, n]) => `${n} ${why}`).join(", ")}.`);
  }
  return said.join("\n");
}

/* ---------- a trial of a case ---------- */

/** A client that can read a kept file's bytes (the CLI's can): the patches are read from where they were kept. */
export type CaseClient = NodeClient & { bytes?(name: "artifactFile", input: { id: string; path: string }): Promise<{ bytes: Uint8Array }> };

/** Where a case's repository is, in every sandbox of its trial: where its knight had it. */
export const rootOf = (c: Pick<YourCase, "task">): string => `/work/tasks/${c.task}`;
/** Where a patch is put in a grading sandbox: outside the repository. */
const PATCH = "/work/.trial/changes.patch";
/** The most a patch may be to be taken out and graded. */
export const PATCH_BYTES = 8 * 2 ** 20;
/** How long a gate may run when graded: a quest's own limit on a command (a fresh sandbox has nothing cached yet). */
export const GATE_TIMEOUT_SEC = QUEST_DEFAULTS.commandTimeoutSec;
/** A command's argument is at most 100,000 characters at the node's door: a patch goes in pieces well under it. */
const CHUNK = 60_000;

/** For the engineer, after the usual instructions: where the work is, and what of it counts. Nothing about the answer. */
const instructions = (c: YourCase): string =>
  [
    "This is a trial: a real task in a real repository, graded by its gates run against what you leave behind.",
    `The repository is at ${rootOf(c)}, checked out at ${c.base.slice(0, 12)}, the commit the task begins from; your commands start there.`,
    "What counts is what you leave in it: it is taken out as a patch against that commit (new files included; nothing git ignores, and nothing outside the repository), put on a fresh checkout of it, and the gates are run there.",
  ].join(" ");

/** Each gate's exit code, the test files it names that the patch altered (PLAN #7: those may not change), and its tail. */
export interface GateRun {
  exits: number[];
  altered: string[][];
  /** The end of what each gate printed when it failed (where a test runner says what failed); empty for a gate that passed. */
  tails?: string[];
}

/** A patch put on a grading checkout, whole, or only some of its files (a held-out test put back, or left out). */
interface PatchLayer {
  patch: Uint8Array;
  /** Apply only these files (none: the whole patch). */
  only?: string[];
  /** Leave these files out (none: nothing left out). */
  except?: string[];
}

/** Commands that put bytes at a path in a sandbox, in pieces under the door's limit (base64 holds no quote). */
function putBytes(bytes: Uint8Array, path: string): string[] {
  const text = Buffer.from(bytes).toString("base64");
  const pieces: string[] = [];
  for (let at = 0; at < text.length; at += CHUNK) pieces.push(text.slice(at, at + CHUNK));
  return [`mkdir -p ${quote(path.slice(0, path.lastIndexOf("/")))} && : > ${quote(`${path}.b64`)}`, ...pieces.map((piece) => `printf %s '${piece}' >> ${quote(`${path}.b64`)}`), `base64 -d < ${quote(`${path}.b64`)} > ${quote(path)} && rm -f ${quote(`${path}.b64`)}`];
}

/** A patch kept in an artifact (a task's change, or what a trial left), read from where it was kept. */
async function keptPatch(node: CaseClient, artifact: string, what: string): Promise<Uint8Array> {
  if (!node.bytes) throw new Error(`${what} can't be read by this client`);
  let bytes: Uint8Array;
  try {
    ({ bytes } = await node.bytes("artifactFile", { id: artifact, path: "changes.patch" }));
  } catch (error) {
    throw new Error(`${what} couldn't be read (${artifact}): ${(error as Error).message}`);
  }
  if (bytes.length > PATCH_BYTES) throw new Error(`${what} is ${Math.ceil(bytes.length / 2 ** 20)} MB as a patch: more than a trial grades (${PATCH_BYTES / 2 ** 20} MB)`);
  return bytes;
}

/** A path as git apply's --include and --exclude read it, a pattern: its `[`, `*`, `?` and `\\` stand for themselves. */
const literally = (path: string): string => path.replace(/[\\*?[\]]/g, "\\$&");

/** A path read as one shell word, so testFilesOf sees it whole (its spaces can't split it). */
const oneWord = (path: string): string => `'${path.replace(/'/g, `'\\''`)}'`;

/** Whether a path is a test file, by the same rule testFilesOf uses: the path read as one word after a program name. */
const isTestFile = (path: string): boolean => testFilesOf(`cat ${oneWord(path)}`).includes(path);

/** The new path of a `+++ ` line in a patch (`b/…`), unquoted; null for `/dev/null` and for lines that aren't one. */
function patchNewPath(line: string): string | null {
  if (!line.startsWith("+++ ")) return null;
  const field = line.slice(4);
  let path: string;
  if (field.startsWith('"')) {
    // Git's C-style quoting: a non-ASCII byte is octal, `"` and `\` are escaped; the bytes are UTF-8.
    const end = field.lastIndexOf('"');
    const body = field.slice(1, end < 0 ? field.length : end);
    const bytes: number[] = [];
    for (let i = 0; i < body.length; i++) {
      const c = body[i]!;
      if (c === "\\" && i + 1 < body.length) {
        const next = body[i + 1]!;
        if (/[0-7]/.test(next)) {
          let oct = "";
          let j = i + 1;
          while (j < body.length && j < i + 4 && /[0-7]/.test(body[j]!)) {
            oct += body[j]!;
            j++;
          }
          bytes.push(parseInt(oct, 8));
          i = j - 1;
        } else {
          bytes.push(next.charCodeAt(0));
          i++;
        }
      } else {
        bytes.push(c.charCodeAt(0));
      }
    }
    path = Buffer.from(bytes).toString("utf8");
  } else {
    // A path may hold spaces: a tab ends it (the marker git puts after a path that could be misread).
    const tab = field.indexOf("\t");
    path = tab < 0 ? field : field.slice(0, tab);
  }
  if (path === "/dev/null") return null;
  return path.startsWith("b/") ? path.slice(2) : path;
}

/**
 * The test files a patch adds or changes (its held-out tests), read from its `+++ b/…` headers and kept only when
 * testFilesOf would name them. A deleted file (`+++ /dev/null`) holds nothing out.
 */
export function heldOutTestsOf(patch: Uint8Array): string[] {
  const seen = new Set<string>();
  for (const line of Buffer.from(patch).toString("utf8").split("\n")) {
    const path = patchNewPath(line);
    if (path && isTestFile(path)) seen.add(path);
  }
  return [...seen].sort();
}

/**
 * The case's gates in a fresh sandbox of their own: the repository at the commit the task began from, with each layer
 * of `layers` put on it in order, and each gate run where its knight ran it. No model, and nothing of the engineer's
 * but the patches. `exempt` are the held-out test files: a gate that names one is not judged to have altered it.
 * Whatever keeps the gates from being run at all throws: a crash.
 */
async function gatesOn(node: CaseClient, c: YourCase, job: TrialJob, layers: PatchLayer[], exempt: string[] = []): Promise<GateRun> {
  const { sandbox } = await node.call<{ sandbox: SandboxView }>("createSandbox", {
    network: job.network,
    quest: questId("g"),
    ...(job.isolation ? { isolation: job.isolation } : {}),
    ...(job.on ? { on: job.on } : {}),
  });
  const exec = (command: string, timeoutSec: number): Promise<ExecResult> => node.call<ExecResult>("execSandbox", { id: sandbox.id, cmd: ["bash", "-c", command], timeoutSec, on: sandbox.node });
  const root = rootOf(c);
  try {
    await node.call("checkoutRepository", { id: sandbox.id, on: sandbox.node, repository: c.repository, commit: c.base, path: root });
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i]!;
      if (!layer.patch.length) continue;
      const patch = `${PATCH}.${i}`;
      for (const command of putBytes(layer.patch, patch)) {
        const put = await exec(command, 120);
        if (put.exitCode !== 0) throw new Error(`the patch couldn't be put in the grading sandbox: ${(put.stderr || put.stdout).trim().slice(0, 300)}`);
      }
      const args = ["apply", "--whitespace=nowarn", ...(layer.only ?? []).map((f) => `--include=${quote(literally(f))}`), ...(layer.except ?? []).map((f) => `--exclude=${quote(literally(f))}`)];
      const applied = await exec(`cd ${quote(root)} && git ${args.join(" ")} ${quote(patch)}`, 300);
      if (applied.exitCode !== 0) throw new Error(`the patch doesn't apply to ${c.base.slice(0, 12)}: ${(applied.stderr || applied.stdout).trim().slice(0, 300)}`);
    }
    // What the layers changed of what was there (a test file a patch adds is new: one the work was to write).
    const changedRun = await exec(`cd ${quote(root)} && git add -A -N . && git diff --name-only`, 300);
    if (changedRun.exitCode !== 0) throw new Error(`what the patch changed couldn't be listed: ${(changedRun.stderr || changedRun.stdout).trim().slice(0, 300)}`);
    const changed = new Set(changedRun.stdout.split("\n").map((line) => line.trim()).filter(Boolean));
    const exemptSet = new Set(exempt);
    const altered = c.gates.map((gate) => testFilesOf(gate).filter((file) => changed.has(file) && !exemptSet.has(file)));
    const exits: number[] = [];
    const tails: string[] = [];
    for (const gate of c.gates) {
      if (job.signal?.aborted) throw new Error("stopped");
      const run = await exec(inWorkdir(root, gate), GATE_TIMEOUT_SEC);
      exits.push(run.exitCode);
      tails.push(gateTail(run));
    }
    return { exits, altered, tails };
  } finally {
    await node.call("destroySandbox", { id: sandbox.id, on: sandbox.node }).catch(() => {});
  }
}

const passes = (run: GateRun, i: number): boolean => run.exits[i] === 0 && !run.altered[i]!.length;
/** Why a gate didn't pass, in words. */
const failed = (run: GateRun, i: number): string => (run.altered[i]!.length ? `alters ${run.altered[i]!.join(", ")}, which it runs` : `exit ${run.exits[i]}`);

/** How many of a failing gate's last printed characters its note keeps: where a test runner says what failed. */
export const TAIL_CHARS = 300;

/**
 * The end of what a failing gate printed, where it says what failed: its stderr (bun's and jest's test runners report
 * there), or with nothing there its stdout (pytest's, go test's, cargo's and a shell script's). A gate that passed keeps
 * nothing.
 */
export const gateTail = (result: Pick<ExecResult, "exitCode" | "stderr" | "stdout">): string =>
  result.exitCode === 0 ? "" : (result.stderr.trim() || result.stdout.trim()).slice(-TAIL_CHARS);

/** The record's note is at most this many characters (TrialRecord). */
const NOTE_LIMIT = 1000;

/** A note's fixed words, and the tail of a failing gate's output that is cut first when the note must fit its limit. */
interface GateNote {
  words: string;
  tail: string;
}

/** A note's words with its gate's printed tail, if any. */
const noteText = (note: GateNote): string => (note.tail ? `${note.words}: ${note.tail}` : note.words);

/** Which gates prove something, and the note for each that doesn't (a failing gate's printed tail with it). */
function judgeNotes(gates: readonly string[], before: GateRun, withOwn: GateRun): { counted: number[]; uncounted: GateNote[] } {
  const counted: number[] = [];
  const uncounted: GateNote[] = [];
  for (const i of gates.keys()) {
    if (before.exits[i] === 0) uncounted.push({ words: `gate ${i + 1} passes before any work`, tail: "" });
    else if (!passes(withOwn, i)) uncounted.push({ words: `gate ${i + 1} fails with the task's own change too (${failed(withOwn, i)})`, tail: withOwn.tails?.[i] ?? "" });
    else counted.push(i);
  }
  return { counted, uncounted };
}

/**
 * The note, within the record's limit: its words stay whole, and a failing gate's printed tail is cut (keeping its
 * own end, every tail equally) before anything else when the whole note wouldn't fit.
 */
function fitNote(prefix: string, parts: GateNote[], suffix: string): string {
  const sep = "; ";
  const fixed = prefix.length + suffix.length + parts.reduce((n, p) => n + p.words.length, 0) + sep.length * Math.max(0, parts.length - 1);
  const tails = parts.map((p) => p.tail);
  const labels = tails.reduce((n, t) => n + (t ? 2 : 0), 0);
  const budget = Math.max(0, NOTE_LIMIT - fixed - labels);
  let cap = Math.max(0, ...tails.map((t) => t.length));
  while (cap > 0 && tails.reduce((n, t) => n + Math.min(t.length, cap), 0) > budget) cap--;
  const body = parts
    .map((p) => {
      const tail = p.tail;
      if (!tail) return p.words;
      const keep = Math.min(tail.length, cap);
      return keep ? `${p.words}: ${tail.slice(tail.length - keep)}` : p.words;
    })
    .join(sep);
  return `${prefix}${body}${suffix}`.slice(0, NOTE_LIMIT);
}

/**
 * Which gates prove something here: each that fails on the commit as it was and passes with the task's own change.
 * The rest, each with why it doesn't count.
 */
export function judgeGates(gates: readonly string[], before: GateRun, withOwn: GateRun): { counted: number[]; uncounted: string[] } {
  const { counted, uncounted } = judgeNotes(gates, before, withOwn);
  return { counted, uncounted: uncounted.map(noteText) };
}

/** A counted gate as an answer a replica can re-check: expected 1, got 1 (passed), 0 (failed) or nothing (not run). */
const answer = (i: number, got: 1 | 0 | null): TrialAnswer => ({ key: `gate_${i + 1}`, units: "pass", expected: 1, got, tolerance: 0, ok: got === 1 });

/** One trial of a case. The record, or null when you stopped it. */
export async function attemptCase(node: CaseClient, c: YourCase, job: TrialJob): Promise<TrialRecord | null> {
  const models = new Set<string>();
  const started = Date.now();
  const root = rootOf(c);
  // A case is the same whatever the seed: every trial of it is at seed 0, so any two runs of it pair case by case.
  const base = { run: job.run, suite: job.suite, problem: c.id, title: c.title, domain: c.knight, seed: 0, version: job.version };
  let counted: number[] = [];
  let quest: TrialRecord["quest"];
  const unscored = (note: string): TrialRecord => ({
    ...base,
    status: "crashed",
    score: 0,
    answers: counted.map((i) => answer(i, null)),
    ...(quest ? { quest } : {}),
    models: [...models].slice(0, 8),
    seconds: Math.round((Date.now() - started) / 1000),
    note: note.slice(0, 1000),
  });
  try {
    // Which gates prove something here, asked before any model is paid: each gate must fail on the commit with only
    // the held-out tests (the test files the task's own change adds or changes) put in place, and pass with the whole
    // change. (When every one passes as it was, the task's own change can't make one count.)
    const ownPatch = await keptPatch(node, c.artifact, "the task's own change");
    const heldOut = heldOutTestsOf(ownPatch);
    const before = await gatesOn(node, c, job, heldOut.length ? [{ patch: ownPatch, only: heldOut }] : [], heldOut);
    const withOwn = before.exits.some((exit) => exit !== 0) ? await gatesOn(node, c, job, ownPatch.length ? [{ patch: ownPatch }] : [], heldOut) : before;
    if (job.signal?.aborted) return null;
    const judged = judgeNotes(c.gates, before, withOwn);
    counted = judged.counted;
    if (!counted.length) return unscored(fitNote("not graded: no gate proves anything here (", judged.uncounted, ")"));

    // A task's own gates run in the quest unless the run's variant turns gates off; they grade it either way.
    const gates = (job.harness ? job.harness.gates : true) ? c.gates : [];
    const evidence = [`git status --short | head -40; git diff --stat ${c.base} | tail -20`, ...(job.harness?.diff ? [`git add -A -N . 2>/dev/null; git diff --no-ext-diff --no-textconv ${c.base} | head -c 24000`] : [])];
    const { outcome, artifact } = await runNodeQuest(
      node,
      {
        goal: c.goal,
        network: job.network,
        ...(job.isolation ? { isolation: job.isolation } : {}),
        ...(job.on ? { on: job.on } : {}),
        maxSteps: commandsFor(c),
        instructions: instructions(c),
        evidence,
        workdir: root,
        label: `Trial ${c.id}`,
        remember: false,
        trial: true,
        ...(gates.length ? { gates } : {}),
        ...harnessOptions(job),
        // Nothing the mind learned: the archive keeps the task's own change, and a memory or a skill may hold what it taught.
        archive: false,
        offerSkills: false,
        memories: false,
      },
      {
        signal: job.signal,
        effort: heldToEffort(job.effort),
        ...(job.spent ? { spent: job.spent } : {}),
        ...(job.sandboxSpent ? { sandboxSpent: job.sandboxSpent } : {}),
        emit: (event) => {
          if ((event.type === "plan" || event.type === "thought" || event.type === "review") && event.model) models.add(event.model);
          tellPassedOver(job)(event);
        },
        // Every attempt starts from the commit the task began from, fetched into its own sandbox.
        prepare: async (_exec, { sandbox }) => {
          await node.call("checkoutRepository", { id: sandbox.id, on: sandbox.node, repository: c.repository, commit: c.base, path: root });
        },
        // With effort this is the attempt the reviewer took: what it left, as a patch, kept with its work.
        finished: async (exec) => {
          const made = await exec(`rm -rf /work/out/changes.patch && mkdir -p /work/out && cd ${quote(root)} && git add -A && git diff --cached --binary ${c.base} > /work/out/changes.patch`, 300);
          if (made.exitCode !== 0) throw new Error(`what was left in the repository couldn't be taken out: ${(made.stderr || made.stdout).trim().slice(-300)}`);
        },
      },
    );
    // Your Ctrl-C says nothing about ability; running out of commands does, and is graded.
    if (job.signal?.aborted) return null;
    // Nor does work no model ever answered: a crash, not a 0 (trial-agentic nothingAnswered).
    const unanswered = nothingAnswered(outcome, models);
    if (unanswered) throw new Error(unanswered);
    quest = { status: outcome.status, steps: outcome.steps, revisions: outcome.revisions };
    if (!artifact) throw new Error("what was left in the repository wasn't kept");
    const engineerPatch = await keptPatch(node, artifact.id, "what was left");
    // What the engineer left, with the held-out tests put back over whatever it left in them (their version doesn't
    // count either way); a test file it altered that the task's own change didn't touch still fails its gate.
    const after = await gatesOn(
      node,
      c,
      job,
      [
        ...(engineerPatch.length ? [{ patch: engineerPatch, except: heldOut }] : []),
        ...(heldOut.length ? [{ patch: ownPatch, only: heldOut }] : []),
      ],
      heldOut,
    );
    if (job.signal?.aborted) return null;
    const answers = counted.map((i) => answer(i, passes(after, i) ? 1 : 0));
    const note = fitNote("", [
      { words: `counted: ${counted.map((i) => `gate ${i + 1}`).join(", ")} of ${c.gates.length}`, tail: "" },
      ...judged.uncounted,
      ...counted.filter((i) => !passes(after, i)).map((i) => ({ words: `gate ${i + 1} failed (${failed(after, i)})`, tail: after.tails?.[i] ?? "" })),
    ], "");
    return {
      ...base,
      status: "scored",
      score: trialScore(answers),
      answers,
      quest,
      models: [...models].slice(0, 8),
      seconds: Math.round((Date.now() - started) / 1000),
      artifact: artifact.id,
      note,
    };
  } catch (error) {
    if (job.signal?.aborted) return null;
    return unscored(error instanceof Error ? error.message : String(error));
  }
}

/** A case, as something a run can try. */
export const caseUnit = (c: YourCase): TrialUnit => ({ id: c.id, title: c.title, domain: c.knight, attempt: (node, job) => attemptCase(node, c, job) });
