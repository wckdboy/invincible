import { describe, expect, test } from "bun:test";
import { beginFor, Bodies, type InterventionKind, northStar, PROBE_AFTER, ROUND_SOURCE, roundKey, roundNotice, roundTask, type RoutedTaskRead, type RoutingRead, routingReport, type RoutingReportTask, TASK_KINDS, type TaskKind, taskKindOf, TeamTaskRecord, TeamTaskRouting } from "../src/index.ts";

/*
 * Smart routing's memory, by kind of task (routing.ts): an agent's tasks of a kind begin on the tier that last verified
 * one of them, the engineer's until one has been; and after PROBE_AFTER in a row begun on the planner's by it, one tries
 * the engineer's again, so a kind the cheaper models can do now goes back to them. The same tasks give the same tier.
 */

let n = 0;
const id = () => `task-${String(++n).padStart(12, "0")}`;
/** One of an agent's finished tasks of a kind: where its work began, why, and whether it moved up or was verified. */
const finished = (kind: TaskKind, began: "engineer" | "planner", opts: { moved?: boolean; verified?: boolean; because?: "plan" | "memory" | "probe" } = {}): RoutedTaskRead => ({
  id: id(),
  status: opts.verified === false ? "failed" : "done",
  verified: opts.verified !== false,
  record: { routing: { began, kind, ...(opts.because ? { because: opts.because } : {}), ...(opts.moved ? { moved: "gate" } : {}) } },
});

describe("a task's kind", () => {
  test("a fix of a pull request's checks, else desktop work, else code in a repository, else a task", () => {
    expect(taskKindOf({ fix: true, desktop: true, repository: true })).toBe("fix");
    expect(taskKindOf({ fix: false, desktop: true, repository: true })).toBe("desktop");
    expect(taskKindOf({ fix: false, desktop: false, repository: true })).toBe("code");
    expect(taskKindOf({ fix: false, desktop: false, repository: false })).toBe("task");
  });

  test("the record says it as the contract does: the kinds, and a beginning that was a try of the cheaper models", () => {
    expect([...TeamTaskRouting.shape.kind.unwrap().options]).toEqual([...TASK_KINDS]);
    expect(TeamTaskRouting.safeParse({ began: "engineer", because: "probe", kind: "code" }).success).toBe(true);
    expect(TeamTaskRouting.safeParse({ began: "engineer", kind: "chores" }).success).toBe(false);
    // A record from before kinds were kept still reads.
    expect(TeamTaskRouting.safeParse({ began: "planner", because: "memory" }).success).toBe(true);
  });
});

describe("where a task of a kind begins", () => {
  test("on the engineer's models until one of its kind has been verified", () => {
    expect(beginFor([], "code")).toEqual({ tier: "engineer", because: null, why: "none of its code tasks has been verified yet: the engineer's models first", from: null });
    // A failure isn't one verified, wherever it ran.
    expect(beginFor([finished("code", "planner", { verified: false })], "code").tier).toBe("engineer");
  });

  test("on the tier that last verified one: the engineer's, or the planner's when it began there or moved up to it", () => {
    const cheap = finished("code", "engineer");
    expect(beginFor([cheap], "code")).toEqual({ tier: "engineer", because: null, why: "its last code task was verified on the engineer's models", from: cheap.id });
    const moved = finished("code", "engineer", { moved: true });
    expect(beginFor([moved, cheap], "code")).toEqual({ tier: "planner", because: "memory", why: "its last code task was verified on the planner's models", from: moved.id });
    expect(beginFor([finished("fix", "planner", { because: "plan" })], "fix").tier).toBe("planner");
    // The last verified is what counts: one that failed after it says nothing.
    expect(beginFor([finished("code", "engineer", { moved: true, verified: false }), cheap], "code").tier).toBe("engineer");
  });

  test("by its own kind alone: another kind's tasks, and records from before kinds were kept, say nothing of it", () => {
    const old: RoutedTaskRead = { id: id(), status: "done", verified: true, record: { routing: { began: "planner", because: "memory" } } };
    const fix = finished("fix", "engineer");
    expect(beginFor([finished("code", "engineer", { moved: true }), old, fix], "fix")).toEqual({ tier: "engineer", because: null, why: "its last fix was verified on the engineer's models", from: fix.id });
    expect(beginFor([old], "code").tier).toBe("engineer");
  });

  test(`after ${PROBE_AFTER} in a row begun on the planner's by it, the next tries the engineer's again; where that is verified, it stays`, () => {
    const remembered = () => finished("desktop", "planner", { because: "memory" });
    const run = [remembered(), remembered(), finished("desktop", "engineer", { moved: true })];
    expect(beginFor(run, "desktop")).toEqual({ tier: "engineer", because: "probe", why: "its last 2 desktop tasks began on the planner's models: this one tries the engineer's again", from: run[0]!.id });
    // The try moved up: back to the planner's. It was verified on the engineer's: the engineer's it is.
    expect(beginFor([finished("desktop", "engineer", { because: "probe", moved: true }), ...run], "desktop").tier).toBe("planner");
    expect(beginFor([finished("desktop", "engineer", { because: "probe" }), ...run], "desktop").tier).toBe("engineer");
    // One begun so is no try yet; nor two begun on the planner's by their plan.
    expect(beginFor(run.slice(1), "desktop").tier).toBe("planner");
    expect(beginFor([finished("desktop", "planner", { because: "plan" }), finished("desktop", "planner", { because: "plan" })], "desktop").tier).toBe("planner");
  });

  test("the task itself is never its own history", () => {
    const self = finished("code", "engineer", { moved: true });
    expect(beginFor([self], "code", self.id).tier).toBe("engineer");
  });
});

describe("the same trail, the same tier", () => {
  /** A kind's tasks run in turn: each begins as beginFor says, and the next sees how it ended (latest first). */
  const replay = (outcomes: readonly { moved: boolean; verified: boolean }[]) => {
    const tasks: RoutedTaskRead[] = [];
    return outcomes.map((o) => {
      const begin = beginFor(tasks, "code");
      tasks.unshift({ id: id(), status: o.verified ? "done" : "failed", verified: o.verified, record: { routing: { began: begin.tier, kind: "code", ...(begin.because ? { because: begin.because } : {}), ...(o.moved && begin.tier === "engineer" ? { moved: "rereads" } : {}) } } });
      return `${begin.tier}${begin.because ? `:${begin.because}` : ""}`;
    });
  };
  const trail = [
    { moved: false, verified: true },
    { moved: true, verified: true },
    { moved: false, verified: true },
    { moved: false, verified: true },
    { moved: true, verified: true },
    { moved: false, verified: false },
    { moved: false, verified: true },
  ];

  test("replayed, a kind's trail begins each task on the same tier, every time", () => {
    const once = replay(trail);
    expect(replay(trail)).toEqual(once);
    expect(once).toEqual(["engineer", "engineer", "planner:memory", "planner:memory", "engineer:probe", "planner:memory", "planner:memory"]);
  });

  test("cy's case: one kind at any level, one hard task among easy ones: the planner's for the next two, then a try of the engineer's, kept where it is verified", () => {
    // cy's levels in the routing suite (bench/routing/sim.ts memoryTasks, the default seed): its worker does 1 and 2, the
    // lead does 3, and nothing does a 4. Begun on the engineer's, a 3 moves up and is verified, a 4 moves up and fails.
    const levels = [2, 2, 1, 4, 2, 1, 3, 1, 1, 1, 2, 1];
    const run = () => {
      const tasks: RoutedTaskRead[] = [];
      return levels.map((level) => {
        const begin = beginFor(tasks, "code");
        const moved = begin.tier === "engineer" && level > 2;
        const verified = level <= 3;
        tasks.unshift({ id: id(), status: verified ? "done" : "failed", verified, record: { routing: { began: begin.tier, kind: "code", ...(begin.because ? { because: begin.because } : {}), ...(moved ? { moved: "gate" } : {}) } } });
        return `${level} ${begin.tier}${begin.because ? `:${begin.because}` : ""}`;
      });
    };
    const once = run();
    expect(run()).toEqual(once);
    // (The 4 failed: the last verified is still the engineer's. After the 3, two easy ones on the planner's: the price of
    // beginning where the last was verified; the try brings the kind back down.)
    expect(once).toEqual(["2 engineer", "2 engineer", "1 engineer", "4 engineer", "2 engineer", "1 engineer", "3 engineer", "1 planner:memory", "1 planner:memory", "1 engineer:probe", "2 engineer", "1 engineer"]);
  });

  test("other kinds' tasks among them change nothing of it, and neither does asking again", () => {
    const own = [finished("code", "engineer", { moved: true }), finished("code", "engineer")];
    const mixed = [finished("fix", "engineer"), own[0]!, finished("desktop", "planner", { because: "memory" }), own[1]!, finished("task", "engineer", { moved: true })];
    expect(beginFor(mixed, "code")).toEqual(beginFor(own, "code"));
    expect(beginFor(mixed, "code")).toEqual(beginFor(mixed, "code"));
  });
});

describe("work going round on both tiers: a notice, so you are told at once", () => {
  test("its key is the task's, and says which task it is: one notice a task", () => {
    expect(roundKey("task-a1b2c3d4e5f6")).toBe("went-round:task-a1b2c3d4e5f6");
    expect(roundTask(roundKey("task-a1b2c3d4e5f6"))).toBe("task-a1b2c3d4e5f6");
    for (const other of ["disk:n_1", "went-round:", "went-round:../x", "ci:went-round:task-a1b2c3d4e5f6"]) expect(roundTask(other)).toBeNull();
  });

  test("what it says: whose task, that it went round on both tiers, that the work goes on, and how to stop it; a notice the ledger takes", () => {
    const n = roundNotice({ agent: "Ada", task: "Sync survives a dropped connection", id: "task-a1b2c3d4e5f6", rereads: 8, files: ["src/sync.ts", "src/net.ts"] });
    expect(n.title).toBe("Ada's task went round on both tiers");
    expect(n.body).toBe(
      "“Sync survives a dropped connection” went round on the engineer's models, moved up, and has now read the same files again 8 times on the planner's models with nothing changed (src/sync.ts, src/net.ts). It goes on until you stop it or its budget ends it. To stop it: its card's Stop, or invincible agents stop task task-a1b2c3d4e5f6",
    );
    const raised = Bodies["notice.raised"].safeParse({ key: roundKey("task-a1b2c3d4e5f6"), severity: "warn", source: ROUND_SOURCE, at: 1, ...n });
    expect(raised.success).toBe(true);
    // A long title or many files stay within what a notice holds.
    const long = roundNotice({ agent: "Ada", task: "x".repeat(5000), id: "task-a1b2c3d4e5f6", rereads: 8, files: Array.from({ length: 40 }, (_, i) => `src/${"d".repeat(60)}/f${i}.ts`) });
    expect(Bodies["notice.raised"].safeParse({ key: roundKey("task-a1b2c3d4e5f6"), severity: "warn", source: ROUND_SOURCE, at: 1, ...long }).success).toBe(true);
  });

  test("the record keeps that the work went round on both tiers (the store keeps only a record its schema takes), and one without it reads as before", () => {
    const base = { startedAt: 0, endedAt: 1, ended: "done", commands: 0, revisions: 0, spent: [] };
    expect(TeamTaskRecord.safeParse({ ...base, routing: { began: "engineer", moved: "rereads", round: true, kind: "code" } }).success).toBe(true);
    expect(TeamTaskRecord.safeParse({ ...base, routing: { began: "engineer", kind: "code" } }).success).toBe(true);
    expect(TeamTaskRecord.safeParse({ ...base, routing: { began: "engineer", round: "yes" } }).success).toBe(false);
  });
});

describe("the routing report: how a node's own finished tasks were routed, by kind and where each began", () => {
  const prices = { "plan/cheap": { input: 1, output: 4 }, "plan/strong": { input: 10, output: 40 } };
  /** One finished task: its kind and routing, verified or not, its minutes, and its tokens on a model (a million: $1 cheap). */
  const done = (n: number, routing: RoutingRead | undefined, opts: { verified?: boolean; minutes?: number; model?: string; status?: string } = {}): RoutingReportTask => ({
    id: `task-${String(n).padStart(12, "0")}`,
    status: opts.status ?? (opts.verified === false ? "failed" : "done"),
    verified: opts.verified !== false,
    record: {
      startedAt: 0,
      endedAt: (opts.minutes ?? 10) * 60_000,
      spent: [{ role: "engineer", model: opts.model ?? "plan/cheap", calls: 1, unknown: 0, input: 1_000_000, output: 0, cached: 0, reasoning: 0 }],
      ...(routing ? { routing } : {}),
    },
  });

  test("by kind, then where each began: its tasks, verified, moved up and why, gone round on both tiers, money and minutes", () => {
    const tasks = [
      done(1, { began: "engineer", kind: "code" }, { minutes: 6 }),
      done(2, { began: "engineer", moved: "gate", kind: "code" }, { minutes: 20, model: "plan/strong" }),
      done(3, { began: "engineer", moved: "rereads", round: true, kind: "code" }, { verified: false, minutes: 30, model: "plan/strong" }),
      done(4, { began: "planner", because: "memory", kind: "code" }, { minutes: 8, model: "plan/strong" }),
      done(5, { began: "engineer", kind: "fix" }, { minutes: 4 }),
    ];
    expect(routingReport(tasks, prices)).toEqual({
      v: 1,
      since: null,
      finished: 5,
      unrouted: 0,
      kinds: [
        {
          kind: "fix",
          tasks: 1,
          verified: 1,
          usd: 1,
          priced: true,
          minutes: 4,
          usdPerVerified: 1,
          minutesPerVerified: 4,
          interventions: 0,
          neededYou: 0,
          interventionsPerVerified: 0,
          groups: [{ began: "engineer", because: null, tasks: 1, verified: 1, movedUp: { gate: 0, review: 0, stall: 0, rereads: 0 }, wentRound: 0, usd: 1, priced: true, minutes: 4, usdPerVerified: 1, minutesPerVerified: 4, interventions: 0, neededYou: 0, interventionsPerVerified: 0 }],
        },
        {
          kind: "code",
          tasks: 4,
          verified: 3,
          usd: 31,
          priced: true,
          minutes: 64,
          usdPerVerified: 31 / 3,
          minutesPerVerified: 64 / 3,
          interventions: 0,
          neededYou: 0,
          interventionsPerVerified: 0,
          groups: [
            // Its money and minutes are every task's of the group, verified or not, per verified task.
            { began: "engineer", because: null, tasks: 3, verified: 2, movedUp: { gate: 1, review: 0, stall: 0, rereads: 1 }, wentRound: 1, usd: 21, priced: true, minutes: 56, usdPerVerified: 10.5, minutesPerVerified: 28, interventions: 0, neededYou: 0, interventionsPerVerified: 0 },
            { began: "planner", because: "memory", tasks: 1, verified: 1, movedUp: { gate: 0, review: 0, stall: 0, rereads: 0 }, wentRound: 0, usd: 10, priced: true, minutes: 8, usdPerVerified: 10, minutesPerVerified: 8, interventions: 0, neededYou: 0, interventionsPerVerified: 0 },
          ],
        },
      ],
      probes: { tried: 0, held: 0 },
    });
  });

  test("tries of the engineer's after the planner's: how many, and how many held, verified there without moving up", () => {
    const tasks = [
      done(1, { began: "engineer", because: "probe", kind: "task" }),
      done(2, { began: "engineer", because: "probe", moved: "gate", kind: "task" }),
      done(3, { began: "engineer", because: "probe", kind: "task" }, { verified: false }),
    ];
    const report = routingReport(tasks, prices);
    expect(report.probes).toEqual({ tried: 3, held: 1 });
    expect(report.kinds[0]!.groups.map((g) => [g.began, g.because, g.tasks])).toEqual([["engineer", "probe", 3]]);
    // A try is one begun on the engineer's: the schema takes a planner's "probe", the runtime never makes one.
    expect(routingReport([done(4, { began: "planner", because: "probe", kind: "task" })], prices).probes).toEqual({ tried: 0, held: 0 });
  });

  test("a task not routed (no kind kept: held to models, a coding tool's, from before kinds) is counted apart; one not finished isn't read", () => {
    const tasks = [
      done(1, undefined),
      done(2, { began: "planner", because: "memory" }),
      { id: "task-running00001", status: "running", verified: false },
      done(4, { began: "engineer", kind: "desktop" }),
    ];
    const report = routingReport(tasks, prices);
    expect([report.finished, report.unrouted, report.kinds.map((k) => k.kind)]).toEqual([3, 2, ["desktop"]]);
  });

  test("money a call has no price for is never guessed: the group says it isn't all priced, and has no money a verified task", () => {
    const report = routingReport([done(1, { began: "engineer", kind: "code" }, { model: "elsewhere/x" }), done(2, { began: "engineer", kind: "code" })], prices);
    const code = report.kinds[0]!;
    expect([code.usd, code.priced, code.usdPerVerified, code.groups[0]!.priced, code.groups[0]!.usdPerVerified]).toEqual([1, false, null, false, null]);
    // None verified: nothing a verified task, of money or minutes.
    const none = routingReport([done(1, { began: "engineer", kind: "fix" }, { verified: false })], prices).kinds[0]!;
    expect([none.usdPerVerified, none.minutesPerVerified]).toEqual([null, null]);
  });

  test("the groups come in one order, whatever order the tasks came in: the same tasks, the same report", () => {
    const tasks = [
      done(1, { began: "planner", because: "plan", kind: "code" }),
      done(2, { began: "planner", because: "memory", kind: "code" }),
      done(3, { began: "engineer", because: "probe", kind: "code" }),
      done(4, { began: "engineer", kind: "code" }),
      done(5, { began: "planner", kind: "code" }),
    ];
    const once = routingReport(tasks, prices);
    expect(once.kinds[0]!.groups.map((g) => `${g.began}${g.because ? `:${g.because}` : ""}`)).toEqual(["engineer", "engineer:probe", "planner:memory", "planner:plan", "planner"]);
    expect(routingReport([...tasks].reverse(), prices)).toEqual(once);
  });

  /** The task, with how you stepped in on it. */
  const stepped = (task: RoutingReportTask, interventions: Partial<Record<InterventionKind, number>>): RoutingReportTask => ({ ...task, interventions });

  test("each time you stepped in, as the north star counts it: by kind and where work began, on how many tasks, and per verified task", () => {
    const tasks = [
      done(1, { began: "engineer", kind: "code" }),
      stepped(done(2, { began: "engineer", moved: "gate", kind: "code" }), { steer: 1 }),
      stepped(done(3, { began: "engineer", moved: "rereads", round: true, kind: "code" }, { verified: false }), { message: 2, stop: 1 }),
      done(4, { began: "planner", because: "memory", kind: "code" }),
      // A kind the north star doesn't count isn't counted here either.
      stepped(done(5, { began: "engineer", kind: "fix" }), { again: 1, poke: 3 } as Partial<Record<InterventionKind, number>>),
      // Not routed, and not finished: neither is read.
      stepped(done(6, undefined), { approval: 1 }),
      { id: "task-running00007", status: "running", verified: false, interventions: { steer: 2 } },
    ];
    const [fix, code] = routingReport(tasks, prices).kinds;
    expect([fix!.interventions, fix!.neededYou, fix!.interventionsPerVerified]).toEqual([1, 1, 1]);
    expect([code!.interventions, code!.neededYou, code!.interventionsPerVerified]).toEqual([4, 2, 4 / 3]);
    expect(code!.groups.map((g) => [g.began, g.because, g.interventions, g.neededYou, g.interventionsPerVerified])).toEqual([
      ["engineer", null, 4, 2, 2],
      ["planner", "memory", 0, 0, 0],
    ]);
    // None verified: nothing per verified task.
    const unverified = routingReport([stepped(done(1, { began: "engineer", kind: "task" }, { verified: false }), { stop: 1 })], prices).kinds[0]!;
    expect([unverified.interventions, unverified.neededYou, unverified.interventionsPerVerified]).toEqual([1, 1, null]);
    // The north star's own count, task by task.
    for (const task of tasks.filter((t) => t.record?.routing?.kind)) expect([task.id, routingReport([task], prices).kinds[0]!.interventions]).toEqual([task.id, northStar([{ ...task, updatedAt: 0 }], 0).interventions]);
  });

  test("since a moment: only the tasks that finished then or after are read, and the report says from when", () => {
    const at = (task: RoutingReportTask, endedAt: number): RoutingReportTask => ({ ...task, record: { ...task.record!, startedAt: endedAt - 60_000, endedAt } });
    const since = Date.UTC(2026, 10, 28, 16, 47);
    const tasks = [at(done(1, { began: "engineer", kind: "code" }), since - 1), at(done(2, { began: "engineer", kind: "code" }), since), at(done(3, undefined), since + 1)];
    const report = routingReport(tasks, prices, since);
    expect([report.since, report.finished, report.unrouted, report.kinds.map((k) => [k.kind, k.tasks])]).toEqual(["2026-11-28T16:47:00.000Z", 2, 1, [["code", 1]]]);
    // Without one: every finished task the node lists, and no moment.
    expect([routingReport(tasks, prices).since, routingReport(tasks, prices).finished]).toEqual([null, 3]);
  });
});
