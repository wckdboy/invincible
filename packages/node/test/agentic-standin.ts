import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GRADE, MARK, REPO, RESULT_FILE, type Solution, treeOutput, unpackPayload } from "@galahad/brain";

/*
 * Stand-in sandboxes for agentic trials: each is a set of files in memory, and answers
 * the commands the trial runner sends through a sandbox's exec (putting a repository
 * in, taking a tree out) as a real one would. Two kinds of command really run, with
 * bun, in a temporary directory holding that sandbox's files: the hidden checks, and
 * the repository's own gates (`cd /work/repo && bun …`). So a trial here is graded by
 * the same hidden tests as on a server; only the sandbox is a stand-in.
 *
 * An engineer's own commands do what the test says (`onCommand`): lay a solution over
 * the repository, or nothing.
 */

export interface Answer {
  exitCode: number;
  stdout: string;
  stderr?: string;
}

export interface Box {
  id: string;
  /** Absolute path → text. */
  files: Map<string, string>;
  /** Every command this sandbox was sent, in order. */
  commands: string[];
  /** Lay a way of leaving the work over the repository, with the result file it says. */
  leave(solution: Solution): void;
}

export class StandInSandboxes {
  readonly boxes = new Map<string, Box>();
  private readonly buffers = new Map<string, string>();
  /** What an engineer's own command does (default: nothing, exit 0). */
  onCommand?: (box: Box, command: string) => Answer | void | Promise<Answer | void>;
  /** In place of really running a hidden check (a check that never ends, say). */
  onCheck?: (box: Box, key: string) => Answer | void;

  box(id: string): Box {
    let box = this.boxes.get(id);
    if (!box) {
      const files = new Map<string, string>();
      box = {
        id,
        files,
        commands: [],
        leave(solution) {
          for (const [path, text] of Object.entries(solution.files)) {
            if (text === null) files.delete(`${REPO}/${path}`);
            else files.set(`${REPO}/${path}`, text);
          }
          if (solution.result) files.set(RESULT_FILE, JSON.stringify(solution.result));
          else files.delete(RESULT_FILE);
        },
      };
      this.boxes.set(id, box);
    }
    return box;
  }

  /** The files under a root, by their path from it. */
  under(box: Box, root: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [path, text] of box.files) if (path.startsWith(`${root}/`)) out[path.slice(root.length + 1)] = text;
    return out;
  }

  /** Really run `bun <args>` with the files under `root` laid out in a temporary directory. */
  private async bun(box: Box, root: string, cwd: string, args: string[]): Promise<Answer> {
    const dir = mkdtempSync(join(tmpdir(), "galahad-standin-"));
    try {
      for (const [path, text] of Object.entries(this.under(box, root))) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text);
      }
      mkdirSync(join(dir, cwd), { recursive: true });
      const run = Bun.spawn([process.execPath, ...args.map((a) => (a.startsWith(`${root}/`) ? join(dir, a.slice(root.length + 1)) : a))], { cwd: join(dir, cwd), stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
      return { exitCode, stdout, stderr };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async exec(id: string, command: string): Promise<Answer> {
    const box = this.box(id);
    box.commands.push(command);
    const first = command.split("\n", 1)[0]!;
    if (first.startsWith(MARK)) {
      const [kind, ...rest] = first.slice(MARK.length).split(" ");
      if (kind === "put-reset") this.buffers.set(id, "");
      else if (kind === "put-chunk") this.buffers.set(id, (this.buffers.get(id) ?? "") + (/printf %s '([^']*)'/.exec(command)?.[1] ?? ""));
      else if (kind === "put-apply") {
        for (const [path, text] of Object.entries(unpackPayload(this.buffers.get(id) ?? ""))) box.files.set(`${rest[0]}/${path}`, text);
        this.buffers.delete(id);
      } else if (kind === "tree") return { exitCode: 0, stdout: treeOutput(this.under(box, rest[0]!)) };
      else if (kind === "check") {
        const instead = this.onCheck?.(box, rest[0]!);
        if (instead) return instead;
        return this.bun(box, GRADE.root, ".", [GRADE.script, GRADE.repo, GRADE.result, GRADE.quest, rest[0]!, rest[1]!]);
      }
      return { exitCode: 0, stdout: "" };
    }
    if (command.startsWith(`cat ${RESULT_FILE}`)) {
      const text = box.files.get(RESULT_FILE);
      return text === undefined ? { exitCode: 0, stdout: "" } : { exitCode: 0, stdout: text };
    }
    // The repository's own gates and tests: really run, on what the repository holds now.
    const own = /^cd \/work\/repo && bun ([\w./ -]+?)(?: 2>&1 \| tail -\d+)?$/.exec(command);
    if (own) return this.bun(box, "/work", "repo", own[1]!.split(" "));
    return (await this.onCommand?.(box, command)) ?? { exitCode: 0, stdout: "" };
  }
}
