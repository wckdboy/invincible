import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { type ChatStreamEvent, type RouteName, routes, type TeamSnapshot, type TeamTask, type TeamTaskRecord, type Agent, EvalRecord, evalProblem, type EvalView } from "@invincible/core";
import type { YourCase } from "../src/eval-yours.ts";
import { spawned } from "../../../bench/spawned.ts";

/*
 * A stand-in node for evals of your own work. Its sandboxes are temporary directories where every command really
 * runs (bash, git, the gates), with /work read as the sandbox's own /work; checking a repository out fetches the
 * commit from an invented repository on disk, as the git gateway would from GitHub; kept work is held in memory.
 * The models are stand-ins: the engineer runs the commands a test gives it, then says DONE.
 *
 * The invented repository, example/widgets: `total.sh` sums a file's numbers and is off by one; its test says so.
 * A later commit fixes it, as an agent's task did; that task's own change is the patch between the two.
 */

export const WIDGETS = "https://github.com/example/widgets";
export const AGENT_ARTIFACT = `art_${"k".repeat(22)}`;
/** The gates the invented task was given: its test (fails until the fix), one that passes already, one no fresh sandbox can pass. */
export const GATES = { test: "sh test/total_test.sh", readme: "test -f README.md", tool: "command -v widgetfmt >/dev/null && widgetfmt --check ." };
/** What fixes it, and what doesn't. */
export const FIX = "sed -i.orig 's/print s + 1/print s/' total.sh && rm -f total.sh.orig";

const git = async (dir: string, ...args: string[]) => {
  const run = await spawned(["git", "-C", dir, "-c", "user.email=agent@example.invalid", "-c", "user.name=agent", ...args]);
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
};

/**
 * The invented repository on disk: its first commit (where the task began) and the task's own change as a patch. The
 * change can add files besides its fix (`fixAlso`, path → text), as a large change does.
 */
export async function widgets(fixAlso: Record<string, string> = {}): Promise<{ dir: string; base: string; fixed: string; patch: Uint8Array; remove(): void }> {
  const dir = mkdtempSync(join(tmpdir(), "invincible-widgets-"));
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "README.md"), "Widgets: counts what you give it.\n");
  writeFileSync(join(dir, "total.sh"), "#!/bin/sh\n# The sum of a file's numbers, one a line.\nawk '{ s += $1 } END { print s + 1 }' \"$1\"\n");
  writeFileSync(join(dir, "test", "total_test.sh"), '#!/bin/sh\n# 1 + 2 + 3 is 6.\nprintf \'1\\n2\\n3\\n\' > "${TMPDIR:-/tmp}/numbers.txt"\ngot=$(sh total.sh "${TMPDIR:-/tmp}/numbers.txt")\n[ "$got" = 6 ] || { echo "expected 6, got $got"; exit 1; }\n');
  await git(dir, "init", "-q");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-qm", "Widgets count");
  const base = await git(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "total.sh"), "#!/bin/sh\n# The sum of a file's numbers, one a line.\nawk '{ s += $1 } END { print s }' \"$1\"\n");
  for (const [path, text] of Object.entries(fixAlso)) writeFileSync(join(dir, path), text);
  if (Object.keys(fixAlso).length) await git(dir, "add", "-A");
  await git(dir, "commit", "-qam", "The total is the sum, no more");
  const fixed = await git(dir, "rev-parse", "HEAD");
  const patch = (await spawned(["git", "-C", dir, "diff", "--binary", base, fixed])).stdout;
  return { dir, base, fixed, patch: new Uint8Array(patch), remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** What an agent's task's run took, made up. */
export const runOf = (over: Partial<TeamTaskRecord> = {}): TeamTaskRecord => ({
  startedAt: 1_000,
  endedAt: 1_000 + 18 * 60_000,
  ended: "done",
  commands: 12,
  revisions: 0,
  spent: [{ role: "engineer", model: "example/coder", calls: 10, unknown: 0, input: 90_000, output: 4_000, cached: 0, reasoning: 0 }],
  ...over,
});

/** An agent's task as the team's controller keeps it, made up. */
export const taskOf = (over: Partial<TeamTask> = {}): TeamTask => ({
  id: "task-abc_def-1234",
  room: "dm-max",
  assignee: "max",
  title: "Make the total the sum",
  goal: "total.sh adds one to every total. Make it print the sum.",
  dependsOn: [],
  gates: [GATES.test, GATES.readme],
  status: "done",
  verified: true,
  progress: "",
  output: "",
  error: null,
  chainId: "c1",
  createdAt: 1_000,
  updatedAt: 2_000,
  record: runOf(),
  changes: { artifact: AGENT_ARTIFACT, files: 1, base: "0".repeat(40) },
  ...over,
});

export const agentOf = (over: Partial<Agent> = {}): Agent => ({
  id: "max",
  name: "Max",
  instructions: "",
  role: "engineer",
  harness: "native",
  enabled: true,
  dailyTurns: 40,
  turnsToday: 0,
  repository: WIDGETS,
  workspaceNode: null,
  workspace: null,
  memory: "",
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

export const teamOf = (tasks: TeamTask[], agents: Agent[] = [agentOf()]): TeamSnapshot => ({ agents, rooms: [], tasks, deliveries: [] });

/** The invented task as a case, at the repository's real first commit. */
export const widgetsCase = (base: string, over: Partial<YourCase> = {}): YourCase => ({
  id: "task-abc-def-1234",
  task: "task-abc_def-1234",
  title: "Make the total the sum",
  agent: "max",
  goal: "total.sh adds one to every total. Make it print the sum.",
  gates: [GATES.test, GATES.readme],
  repository: WIDGETS,
  base,
  artifact: AGENT_ARTIFACT,
  record: runOf(),
  desktop: false,
  ...over,
});

interface Box {
  id: string;
  dir: string;
  input: any;
  commands: string[];
}

/** /work as the sandbox's own; a piece of a patch on its way in (its base64 may spell /work) is left as it is. */
const local = (dir: string, command: string): string =>
  command
    .split(/(printf %s '[A-Za-z0-9+/=]*')/)
    .map((part, i) => (i % 2 ? part : part.replaceAll("/work", `${dir}/work`)))
    .join("");

function filesUnder(root: string): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.set(relative(root, path), new Uint8Array(readFileSync(path)));
    }
  };
  try {
    walk(root);
  } catch {
    /* nothing there */
  }
  return out;
}

export class YoursStandIn {
  readonly boxes: Box[] = [];
  readonly destroyed: string[] = [];
  readonly checkouts: any[] = [];
  readonly artifacts = new Map<string, Map<string, Uint8Array>>();
  readonly chats: any[] = [];
  readonly recorded: EvalView[] = [];
  readonly runs: any[] = [];
  /** What the engineer runs on its first turn (none: it only says DONE). */
  work: string | null = null;
  /** No sandbox can be made (a number: none after that many). */
  full: boolean | number = false;
  team: TeamSnapshot = teamOf([]);

  constructor(
    /** Repository address → where it is on disk. */
    private readonly repositories: Record<string, string>,
    agentsPatch?: Uint8Array,
  ) {
    if (agentsPatch) this.artifacts.set(AGENT_ARTIFACT, new Map([["changes.patch", agentsPatch]]));
  }

  box(id: string): Box {
    return this.boxes.find((b) => b.id === id)!;
  }

  /** The sandboxes made to grade (their run's id starts g-), and those the engineer worked in (t-). */
  graders = (): Box[] => this.boxes.filter((b) => String(b.input.run).startsWith("g-"));
  workshops = (): Box[] => this.boxes.filter((b) => String(b.input.run).startsWith("t-"));

  remove(): void {
    for (const b of this.boxes) rmSync(b.dir, { recursive: true, force: true });
    for (const dir of this.made.values()) rmSync(dir, { recursive: true, force: true });
  }

  /**
   * Each commit checked out once, by git as the gateway would (init, a fetch, a checkout), and copied into each sandbox
   * after: a copy is the same repository. An attempt grades in three sandboxes and works in a fourth, and git's
   * processes were most of what a test's time went to on a busy machine.
   */
  private readonly made = new Map<string, string>();

  private async checkedOut(repository: string, commit: string): Promise<string> {
    const key = `${repository}@${commit}`;
    const made = this.made.get(key);
    if (made) return made;
    const root = mkdtempSync(join(tmpdir(), "invincible-yours-checkout-"));
    await spawned(["git", "-C", root, "init", "-q"]);
    const from = this.repositories[repository];
    const fetched = from ? await spawned(["git", "-C", root, "fetch", "-q", "--depth", "50", `file://${from}`, commit]) : null;
    if (!fetched || fetched.exitCode !== 0) {
      rmSync(root, { recursive: true, force: true });
      throw new Error(`couldn't fetch ${commit.slice(0, 12)} of ${repository.replace("https://github.com/", "")}: fatal: remote error: not our ref`);
    }
    await spawned(["git", "-C", root, "-c", "advice.detachedHead=false", "checkout", "-q", "--detach", "FETCH_HEAD"]);
    this.made.set(key, root);
    return root;
  }

  async call<T>(name: RouteName, input?: any): Promise<T> {
    switch (name) {
      case "createSandbox": {
        routes.createSandbox.input.parse(input);
        if (this.full === true || (typeof this.full === "number" && this.boxes.length >= this.full)) throw new Error("no sandbox host has a free slot");
        const id = String(this.boxes.length + 1).padStart(10, "0");
        const dir = mkdtempSync(join(tmpdir(), "invincible-yours-box-"));
        mkdirSync(join(dir, "work"));
        this.boxes.push({ id, dir, input, commands: [] });
        // (As the node does: a sandbox asked for with a desktop is made from the desktop image.)
        return { sandbox: { id, name: `primary-${id}`, node: "n_ultra", run: input.run, image: input.desktop ? "invincible/desktop:1" : "invincible/workshop:1", network: input.network, isolation: "vm", cpus: 4, memoryGb: 8, status: "running", ephemeral: true, providers: [] } } as T;
      }
      case "checkoutRepository": {
        routes.checkoutRepository.input.parse(input);
        this.checkouts.push(input);
        const box = this.box(input.id);
        const root = local(box.dir, input.path);
        const made = await this.checkedOut(input.repository, input.commit);
        mkdirSync(dirname(root), { recursive: true });
        cpSync(made, root, { recursive: true });
        return { commit: input.commit } as T;
      }
      case "execSandbox": {
        routes.execSandbox.input.parse(input);
        const box = this.box(input.id);
        box.commands.push(input.cmd[2]);
        // (Under the command's own deadline, as a sandbox's exec is: never the helper's own, which a starved gate may pass.)
        const run = await spawned(["bash", "-c", local(box.dir, input.cmd[2])], { cwd: join(box.dir, "work"), timeout: (input.timeoutSec ?? 600) * 1000 });
        return { exitCode: run.exitCode ?? -1, stdout: run.stdout.toString(), stderr: run.stderr.toString(), durationMs: 1, truncated: false } as T;
      }
      case "saveArtifact": {
        const box = this.box(input.sandbox);
        const files = filesUnder(join(box.dir, "work", "out"));
        if (!files.size) return { artifact: null } as T;
        const id = `art_${String(this.artifacts.size + 1).padStart(22, "0")}`;
        this.artifacts.set(id, files);
        return { artifact: { id, label: input.label ?? "", run: box.input.run, sandbox: box.id, node: "n_ultra", nodeName: "ultra", bytes: 0, count: files.size, files: [...files.keys()].map((path) => ({ path, size: 0, sha256: "" })), savedAt: 0, here: true } } as T;
      }
      case "destroySandbox":
        this.destroyed.push(input.id);
        return {} as T;
      case "recordEval": {
        const { spent, ...record } = routes.recordEval.input.parse(input);
        if (evalProblem(record)) throw new Error(`a replica would refuse it: ${evalProblem(record)}`);
        const view = { ...EvalRecord.parse(record), id: `tr_${String(this.recorded.length).padStart(22, "0")}`, recordedAt: this.recorded.length, nodeName: "ultra", ...(spent ? { spent: { lines: spent } } : {}) };
        this.recorded.push(view);
        return { evalCase: view } as T;
      }
      case "startEvalRun":
        this.runs.push(routes.startEvalRun.input.parse(input));
        return { run: input.run } as T;
      case "effort":
        return { run: input.run, attempts: input.effort, asked: input.effort, host: "ultra", reasons: [], budget: { perDay: 12, usedToday: 0 } } as T;
      case "team":
        return this.team as T;
      case "evals":
        return { evals: this.recorded, runs: {} } as T;
      case "prices":
        return { prices: { "example/coder": { input: 1, output: 4 } } } as T;
      case "rules":
        return { rules: [] } as T;
      case "runProgress":
        return {} as T;
      default:
        throw new Error(`unexpected call ${name}`);
    }
  }

  async bytes(name: string, input: { id: string; path: string }): Promise<{ bytes: Uint8Array; type: string }> {
    if (name !== "artifactFile") throw new Error(`unexpected bytes ${name}`);
    const bytes = this.artifacts.get(input.id)?.get(input.path);
    if (!bytes) throw new Error(`404: no such file in ${input.id}`);
    return { bytes, type: "text/x-diff" };
  }

  async *stream(_name: RouteName, input: any): AsyncGenerator<ChatStreamEvent> {
    // (As the node's chat route does: a request it can't take is refused, never answered.)
    routes.chat.input.parse(input);
    this.chats.push(input);
    const first: string = input.messages[0].content;
    yield { type: "model", ref: `fake/${input.role}` };
    let text: string;
    if (first.startsWith("You are choosing between")) text = "PICK A\nOn the evidence.";
    else if (input.role === "planner") text = "1. Read total.sh and its test.\n2. Fix it.\nDone when: the gates pass.";
    else if (input.role === "engineer") {
      // (Its first turn is the one it is only briefed for: every run's, and every attempt's.)
      text = input.messages.length === 1 && this.work ? `Doing the work.\n\`\`\`sh\n${this.work}\n\`\`\`` : "DONE\nThat is what I have.";
    } else text = "PASS\nThe gates passed and the change does what was asked.";
    yield { type: "text", text };
    yield { type: "usage", ref: `fake/${input.role}`, usage: { input: 2000, output: 150 } };
  }
}
