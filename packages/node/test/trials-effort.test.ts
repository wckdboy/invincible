import { describe, expect, test } from "bun:test";
import { type ChatStreamEvent, type ComputeNodeView, type ComputeView, type NodeCapacity, type RouteName, TrialRecord, type TrialView } from "@galahad/core";
import { ENGINEERING_SUITE, pose, type TrialProblem } from "@galahad/brain";
import { describeEffort, planParallel, runTrials } from "../src/trial-cli.ts";

/*
 * Trials with effort, against a fake node: a run records its effort before its first
 * trial, runs as many trials at once as the slots carry, and grades only the attempt
 * the reviewer took. The grader never tells the reviewer which attempt was right: a
 * wrong pick scores as wrong.
 */

const cantilever = ENGINEERING_SUITE.find((p) => p.id === "cantilever-beam")!;
const exactAnswers = (problem: TrialProblem, seed: number) => JSON.stringify(Object.fromEntries(pose(problem, seed).expected.map((e) => [e.key, e.value])));

const capacity = (sandboxes: number): NodeCapacity => ({ cores: sandboxes * 4, memoryGb: sandboxes * 8, sandboxes, modelCalls: 8, strength: sandboxes * 4, speed: 1, measured: true, reasons: [] });
const host = (name: string, slots: number, free: number | null, online = true): ComputeNodeView => ({
  id: `n_${name}`,
  name,
  self: name === "ultra",
  online,
  body: null,
  calibration: null,
  due: null,
  limit: null,
  capacity: capacity(slots),
  use: free === null ? null : { sandboxes: slots - free, cores: 0, memoryGb: 0, queued: 0, modelCalls: 0, modelQueued: 0 },
  free,
  queue: [],
});

describe("how many trials at once", () => {
  test("auto: what the free slots carry at this effort", () => {
    expect(planParallel({ nodes: [host("ultra", 4, 4)] }, "auto", 1, 14)).toMatchObject({ parallel: 4 });
    expect(planParallel({ nodes: [host("ultra", 6, 6)] }, "auto", 3, 14)).toMatchObject({ parallel: 2 });
    expect(planParallel({ nodes: [host("ultra", 6, 2)] }, "auto", 3, 14).parallel).toBe(1);
    // Every host that's online counts; one that's off doesn't.
    expect(planParallel({ nodes: [host("ultra", 3, 3), host("rack", 6, 6), host("attic", 9, 9, false)] }, "auto", 1, 14).parallel).toBe(8);
    expect(planParallel({ nodes: [host("ultra", 3, 3), host("rack", 6, 6)] }, "auto", 1, 14, "rack").parallel).toBe(6);
    expect(planParallel({ nodes: [host("ultra", 4, 4)] }, "auto", 1, 2).parallel).toBe(2);
  });

  test("a number is kept within what the slots carry, and says when it was cut", () => {
    expect(planParallel({ nodes: [host("ultra", 4, 4)] }, 3, 1, 14)).toMatchObject({ parallel: 3 });
    const cut = planParallel({ nodes: [host("ultra", 4, 0)] }, 8, 2, 14);
    expect(cut.parallel).toBe(2);
    expect(cut.why).toMatch(/2 at once, not 8/);
  });

  test("a fleet that can't carry one trial at the effort asked can't measure it", () => {
    expect(() => planParallel({ nodes: [host("ultra", 2, 2)] }, "auto", 3, 14)).toThrow(/carries 2 sandboxes at once: effort 3 can't be measured/);
    expect(() => planParallel({ nodes: [] }, "auto", 1, 14)).toThrow(/carries 0 sandboxes/);
  });

  test("a node that doesn't say what it carries: as asked", () => {
    expect(planParallel(null, 5, 1, 14).parallel).toBe(5);
    expect(planParallel(null, "auto", 1, 14).parallel).toBe(3);
  });
});

function fakeNode(options: { pick: string; slots?: number }) {
  const calls: { name: RouteName; input: any }[] = [];
  const recorded: TrialView[] = [];
  const runs: { run: string; suite: string; effort: number; parallel?: number; seed?: number }[] = [];
  const turns = new Map<string, number>();
  let created = 0;
  let live = 0;
  let peak = 0;
  const node = {
    async call<T>(name: RouteName, input?: any): Promise<T> {
      calls.push({ name, input });
      switch (name) {
        case "compute":
          return { nodes: [host("ultra", options.slots ?? 4, options.slots ?? 4)] } as unknown as ComputeView as T;
        case "startTrialRun":
          runs.push(input);
          return { run: input.run } as T;
        case "effort":
          return { quest: input.quest, attempts: input.effort, asked: input.effort, host: "ultra", reasons: [], budget: { perDay: 12, usedToday: 0 } } as T;
        case "createSandbox": {
          created += 1;
          live += 1;
          peak = Math.max(peak, live);
          // The sandbox's id says which attempt it is.
          const id = `${String(created).padStart(9, "0")}${input.attempt?.index ?? 1}`;
          node.questOf.set(id, input.attempt?.quest ?? input.quest);
          return { sandbox: { id, node: "n_ultra", image: "galahad/lab:1", network: input.network, isolation: "container", cpus: 4, memoryGb: 8, providers: [] } } as T;
        }
        case "fleet":
          throw new Error("not needed");
        case "execSandbox": {
          const command: string = input.cmd[2];
          await Bun.sleep(5);
          if (command.includes("cat /work/out/answer.json")) {
            // Attempt 1 has the exact answers; attempt 2 is wrong.
            const right = String(input.id).endsWith("1");
            const seed = node.seedOf.get(node.questOf.get(input.id) ?? "") ?? 11;
            return { exitCode: 0, stdout: right ? exactAnswers(cantilever, seed) : JSON.stringify({ tip_deflection_mm: 1, max_bending_stress_mpa: 2, f1_hz: 3 }), stderr: "", durationMs: 1, truncated: false } as T;
          }
          return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 5, truncated: false } as T;
        }
        case "saveArtifact":
          return { artifact: { id: `art_${"A".repeat(21)}${String(input.sandbox).slice(-1)}` } } as T;
        case "destroySandbox":
          live -= 1;
          return {} as T;
        case "recordTrial": {
          const view = { ...TrialRecord.parse(input), id: `tr_${String(recorded.length).padStart(22, "0")}`, recordedAt: Date.now(), nodeName: "ultra" };
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
    /** Which quest a sandbox is for, and which seed posed that quest's problem (read from the goal its planner got). */
    questOf: new Map<string, string>(),
    seedOf: new Map<string, number>(),
    async *stream(_name: RouteName, input: any): AsyncGenerator<ChatStreamEvent> {
      const first: string = input.messages[0].content;
      const role: string = input.role;
      yield { type: "model", ref: `fake/${role}` };
      if (first.startsWith("You are choosing between")) yield { type: "text", text: `PICK ${options.pick}\nOn the evidence.` };
      else if (role === "planner") {
        for (const seed of [11, 12, 13]) if (first.includes(pose(cantilever, seed).goal)) node.seedOf.set(input.attempt?.quest ?? "", seed);
        yield { type: "text", text: "1. Solve it.\n2. Write answer.json." };
      }
      else if (role === "engineer") {
        const key = `${input.attempt?.quest}#${input.attempt?.index}`;
        const turn = (turns.get(key) ?? 0) + 1;
        turns.set(key, turn);
        yield { type: "text", text: turn === 1 ? "Solving.\n```sh\npython3 /work/out/solve.py\n```" : "DONE\nWrote /work/out/answer.json." };
      } else yield { type: "text", text: "PASS\nThe answer file is there." };
    },
  };
  return { node, calls, recorded, runs, peak: () => peak };
}

describe("a run with effort", () => {
  test("records its effort first, runs within the slots, and grades only the attempt the reviewer took", async () => {
    // Attempt A (1) is right, attempt B (2) is wrong. The reviewer takes A: full marks.
    const right = fakeNode({ pick: "A" });
    const a = await runTrials(right.node, { suite: "engineering", problems: [cantilever], repeat: 2, parallel: "auto", network: "gateway", seed: 11, effort: 2 });
    expect(a.trials.map((t) => t.score)).toEqual([1, 1]);
    // (And the seed it was given: a second run with the same seed poses the same problems.)
    expect(right.runs).toEqual([{ run: a.run, suite: "engineering", effort: 2, parallel: 2, seed: 11 }]);
    // On record before any sandbox exists.
    const order = right.calls.map((c) => c.name);
    expect(order.indexOf("startTrialRun")).toBeLessThan(order.indexOf("createSandbox"));
    expect(order.indexOf("compute")).toBeLessThan(order.indexOf("startTrialRun"));
    // Two trials of two attempts in four slots: never more than four sandboxes.
    expect(right.peak()).toBe(4);
    // Each attempt's sandbox carried its tag; the kept work is the taken attempt's.
    expect(right.calls.filter((c) => c.name === "createSandbox").map((c) => c.input.attempt.index).sort()).toEqual([1, 1, 2, 2]);
    expect(a.trials.every((t) => t.artifact?.endsWith("1"))).toBe(true);

    // The reviewer takes B, the wrong one: the trial is scored as wrong. Nobody told it which was right.
    const wrong = fakeNode({ pick: "B" });
    const b = await runTrials(wrong.node, { suite: "engineering", problems: [cantilever], repeat: 1, parallel: 1, network: "gateway", seed: 11, effort: 2 });
    expect(b.trials[0]).toMatchObject({ score: 0, status: "scored" });
    expect(b.trials[0]!.artifact?.endsWith("2")).toBe(true);
  });

  test("a fleet with too few slots for the effort doesn't start the run", async () => {
    const small = fakeNode({ pick: "A", slots: 1 });
    await expect(runTrials(small.node, { suite: "engineering", problems: [cantilever], repeat: 1, parallel: "auto", network: "gateway", effort: 2 })).rejects.toThrow(/effort 2 can't be measured/);
    expect(small.runs).toEqual([]);
    expect(small.recorded).toEqual([]);
  });

  test("without effort nothing changes: no census, no run record, one sandbox a trial", async () => {
    const plain = fakeNode({ pick: "A" });
    const { trials } = await runTrials(plain.node, { suite: "engineering", problems: [cantilever], repeat: 1, parallel: 3, network: "gateway", seed: 11 });
    expect(trials).toHaveLength(1);
    expect(plain.calls.some((c) => c.name === "compute" || c.name === "startTrialRun" || c.name === "effort")).toBe(false);
    expect(plain.calls.filter((c) => c.name === "createSandbox")).toHaveLength(1);
  });
});

describe("the report", () => {
  const trial = (run: string, score: number): TrialView => ({ id: `tr_${run}`, run, suite: "engineering", problem: "p", title: "P", domain: "physics", seed: 1, status: "scored", score, answers: [], models: [], version: "v", seconds: 1, recordedAt: 0, nodeName: "ultra" });

  test("says when more effort measurably helped, and when it didn't", () => {
    const one = Array.from({ length: 14 }, (_, i) => trial("r-one", i < 4 ? 1 : 0));
    const helped = describeEffort([...one, ...Array.from({ length: 14 }, (_, i) => trial("r-three", i < 13 ? 1 : 0))], { "r-three": { effort: 3 }, "r-one": { effort: 1 } });
    expect(helped).toContain("effort 1");
    expect(helped).toContain("effort 3");
    expect(helped).toMatch(/More effort measurably helps/);
    const flat = describeEffort([...one, ...Array.from({ length: 14 }, (_, i) => trial("r-three", i < 5 ? 1 : 0))], { "r-three": { effort: 3 } });
    expect(flat).toMatch(/No measurable difference/);
    expect(flat).toMatch(/hasn't been shown to help/);
    // No run above effort 1: nothing to say.
    expect(describeEffort(one, {})).toBe("");
    expect(describeEffort(one, { "r-one": { effort: 1 } })).toBe("");
  });
});
