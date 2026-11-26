import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type ChatStreamEvent, parseVariant, type RouteName, TrialRecord, trialProblem, type TrialView, VARIANTS } from "@galahad/core";
import { ENGINEERING_SUITE, pose, TRIAL_INSTRUCTIONS, type TrialProblem } from "@galahad/brain";
import { CLAUDE_CODE_IMAGE } from "@galahad/sandbox";
import { AGENT_TRIAL_MINUTES, chooseProblems, harnessOptions, runTrial, runTrials } from "../src/trial-cli.ts";

/*
 * The trial runner against a fake node: fake models, a fake sandbox. What's checked
 * is the plumbing: the problem reaches the engineer with the answer contract, the
 * answer file is read before the sandbox goes, the grade is what gets recorded,
 * and a stop or a crash is handled honestly.
 */

const cantilever = ENGINEERING_SUITE.find((p) => p.id === "cantilever-beam")!;

function fakeNode(options: { answer?: (goal: string) => string | null; failCreate?: boolean; onEngineer?: (messages: { content: string }[]) => void } = {}) {
  const calls: { name: RouteName; input: any }[] = [];
  const recorded: TrialView[] = [];
  let goal = "";
  let engineerTurns = 0;
  const node = {
    async call<T>(name: RouteName, input?: any): Promise<T> {
      calls.push({ name, input });
      switch (name) {
        case "createSandbox":
          if (options.failCreate) throw new Error("no sandbox host in this fleet");
          return { sandbox: { id: "0123456789", node: "n_ultra", image: "galahad/lab:1", network: input.network, isolation: "vm", cpus: 4, memoryGb: 8, providers: input.search ? ["search"] : [] } } as T;
        case "fleet":
          throw new Error("not needed");
        case "execSandbox": {
          const command: string = input.cmd[2];
          if (command.includes("cat /work/out/answer.json")) {
            const text = options.answer?.(goal) ?? null;
            return (text === null ? { exitCode: 1, stdout: "", stderr: "No such file", durationMs: 1, truncated: false } : { exitCode: 0, stdout: text, stderr: "", durationMs: 1, truncated: false }) as T;
          }
          return { exitCode: 0, stdout: "f1 = 2.29 Hz", stderr: "", durationMs: 5, truncated: false } as T;
        }
        case "saveArtifact":
          return { artifact: { id: "art_AAAAAAAAAAAAAAAAAAAAAA" } } as T;
        case "destroySandbox":
          return {} as T;
        case "recordTrial": {
          const record = TrialRecord.parse(input);
          expect(trialProblem(record)).toBeNull();
          const view = { ...record, id: `tr_${String(recorded.length).padStart(22, "0")}`, recordedAt: Date.now(), nodeName: "ultra" };
          recorded.push(view);
          return { trial: view } as T;
        }
        case "rules":
          // (A node that holds no rules of yours: no command is held to a tripwire.)
          return { rules: [] } as T;
        default:
          throw new Error(`unexpected call ${name}`);
      }
    },
    async *stream(_name: RouteName, input: any): AsyncGenerator<ChatStreamEvent> {
      const role: string = input.role;
      yield { type: "model", ref: `fake/${role}` };
      if (role === "planner") {
        goal = input.messages[0].content;
        yield { type: "text", text: "1. Solve it two ways.\n2. Write answer.json." };
      } else if (role === "engineer") {
        options.onEngineer?.(input.messages);
        engineerTurns += 1;
        yield { type: "text", text: engineerTurns % 2 === 1 ? "Solving.\n```sh\npython3 /work/out/solve.py\n```" : "DONE\nWrote /work/out/answer.json." };
      } else yield { type: "text", text: "PASS\nThe answer file is there." };
    },
  };
  return { node, calls, recorded };
}

const exactAnswers = (problem: TrialProblem, seed: number) => JSON.stringify(Object.fromEntries(pose(problem, seed).expected.map((e) => [e.key, e.value])));
const job = (problem: TrialProblem, seed: number, signal?: AbortSignal) =>
  ({ problem, seed, run: "r-test", suite: "engineering", version: "abc1234", network: "gateway" as const, ...(signal ? { signal } : {}) });

describe("running a trial", () => {
  test("posed in the Lab with the answer contract; graded from the sandbox's answer file; recorded, not remembered", async () => {
    let briefing = "";
    const { node, calls, recorded } = fakeNode({ answer: () => exactAnswers(cantilever, 11), onEngineer: (m) => (briefing ||= m[0]!.content) });
    const trial = await runTrial(node, job(cantilever, 11));
    expect(trial).toMatchObject({ problem: "cantilever-beam", seed: 11, status: "scored", score: 1, artifact: "art_AAAAAAAAAAAAAAAAAAAAAA", quest: { status: "done" } });
    expect(trial!.models).toEqual(["fake/planner", "fake/engineer", "fake/reviewer"]);
    expect(calls.find((c) => c.name === "createSandbox")!.input).toMatchObject({ lab: true, network: "gateway" });
    // Its quest is of a trial's kind (t-…): what it keeps is archived as a trial's, and never offered to a model as context.
    expect(calls.find((c) => c.name === "createSandbox")!.input.quest).toMatch(/^t-[a-z0-9]+$/);
    expect(briefing).toContain(TRIAL_INSTRUCTIONS);
    expect(briefing).toContain('"tip_deflection_mm"');
    // The answer file is read before the work is kept and the sandbox goes.
    const order = calls.map((c) => (c.name === "execSandbox" && c.input.cmd[2].includes("answer.json") ? "read" : c.name));
    expect(order.lastIndexOf("read")).toBeLessThan(order.indexOf("saveArtifact"));
    expect(order.indexOf("saveArtifact")).toBeLessThan(order.indexOf("destroySandbox"));
    expect(calls.some((c) => c.name === ("remember" as RouteName))).toBe(false);
    expect(recorded).toHaveLength(1);
  });

  test("wrong numbers are scored as wrong; no answer file scores nothing and says so", async () => {
    const wrong = fakeNode({ answer: () => JSON.stringify({ tip_deflection_mm: 1, max_bending_stress_mpa: 2, f1_hz: 3 }) });
    expect((await runTrial(wrong.node, job(cantilever, 11)))!.score).toBe(0);
    const none = fakeNode({ answer: () => null });
    expect(await runTrial(none.node, job(cantilever, 11))).toMatchObject({ status: "scored", score: 0, note: "no /work/out/answer.json" });
  });

  test("a run that can't start is recorded as crashed, which the Index doesn't count", async () => {
    const { node } = fakeNode({ failCreate: true });
    expect(await runTrial(node, job(cantilever, 11))).toMatchObject({ status: "crashed", score: 0, note: "no sandbox host in this fleet" });
  });

  test("stopped by you: nothing is recorded", async () => {
    const controller = new AbortController();
    controller.abort();
    const { node, recorded } = fakeNode({ answer: () => exactAnswers(cantilever, 11) });
    expect(await runTrial(node, job(cantilever, 11, controller.signal))).toBeNull();
    expect(recorded).toHaveLength(0);
  });
});

describe("a run", () => {
  test("every problem, repeated, a few at a time, under one run id; a given seed poses the same problems", async () => {
    const problems = chooseProblems("engineering", ["cantilever-beam", "electrical"]);
    expect(problems.map((p) => p.id)).toEqual(["rlc-step", "diode-resistor", "cantilever-beam"].sort((a, b) => ENGINEERING_SUITE.findIndex((p) => p.id === a) - ENGINEERING_SUITE.findIndex((p) => p.id === b)));
    const { node } = fakeNode({ answer: () => "{}" });
    const { run, trials } = await runTrials(node, { suite: "engineering", problems, repeat: 2, parallel: 3, network: "gateway", seed: 100 });
    expect(trials).toHaveLength(6);
    expect(new Set(trials.map((t) => t.run))).toEqual(new Set([run]));
    expect(trials.filter((t) => t.problem === "rlc-step").map((t) => t.seed).sort()).toEqual([100, 101]);
    expect(() => chooseProblems("engineering", ["warp-drive"])).toThrow(/no such problem or domain: warp-drive/);
  });
});

describe("a run's harness", () => {
  test("a trial's quest escalates only when its variant says so: a run without a variant is measured as trials always were", () => {
    expect(harnessOptions({}).escalate).toBe(false);
    expect(harnessOptions({ harness: VARIANTS.baseline! }).escalate).toBe(false);
    expect(harnessOptions({ harness: VARIANTS.escalate! }).escalate).toBe(true);
  });

  test("nor is a contract written first unless its variant says so", () => {
    expect(harnessOptions({}).contract).toBeUndefined();
    expect(harnessOptions({ harness: VARIANTS.baseline! }).contract).toBeUndefined();
    expect(harnessOptions({ harness: VARIANTS.contract! })).toMatchObject({ contract: true, proposeGates: false });
  });

  test("a coding tool the workshop image has works there; Claude Code, in the image made for trials of it", () => {
    expect(harnessOptions({ harness: VARIANTS.opencode! }).agent).toEqual({ name: "opencode", minutes: AGENT_TRIAL_MINUTES });
    const claude = parseVariant("claude-code:agent=claude,gates=off,archive=off,revisions=0,planner=off,review=off");
    expect(harnessOptions({ harness: claude.options }).agent).toEqual({ name: "claude", minutes: AGENT_TRIAL_MINUTES, image: CLAUDE_CODE_IMAGE });
    expect(harnessOptions({ harness: VARIANTS.baseline! }).agent).toBeUndefined();
  });
});

describe("the CLI", () => {
  test("`galahad trial problems` lists the suite on a machine that isn't a node", () => {
    const home = mkdtempSync(join(tmpdir(), "galahad-trial-cli-"));
    try {
      const run = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "../src/cli.ts"), "trial", "problems", "--home", join(home, "none")], {
        env: { ...process.env, GALAHAD_KEYSTORE: "file" },
        stdin: "ignore",
      });
      expect(new TextDecoder().decode(run.stderr)).toBe("");
      expect(run.exitCode).toBe(0);
      const listed = new TextDecoder().decode(run.stdout);
      for (const problem of ENGINEERING_SUITE) expect(listed).toContain(problem.id);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
