import { afterEach, describe, expect, test } from "bun:test";
import { newNodeIdentity, type ChatStreamEvent, type Prices, type TeamTaskRecord } from "@galahad/core";
import type { chat as Chat, ChatTools } from "@galahad/brain";
import { foundFleet, MindStore } from "@galahad/mind";
import { OUTCOME_LIMITS, OutcomeRunner } from "../src/outcomes.ts";
import { TeamStore } from "../src/team-store.ts";
import { TeamService } from "../src/team.ts";

/*
 * An outcome Galahad owns (PLAN #43): its own room with the knights you named, tasks he gives them on his own within its
 * budget, what its tasks and his looks cost, a look when something of it changes and none when nothing does, your words
 * answered with its tools, his questions in your Inbox, and pause, stop and done. The model is a script that calls the
 * outcome's own tools.
 */

type Step = { calls?: { name: string; input: unknown }[]; text?: string; tokens?: { input: number; output: number }; hang?: boolean };
const fixtures: { store: TeamStore; service: TeamService; runner: OutcomeRunner }[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.runner.stop();
    await f.service.stop();
    f.store.close();
  }
});

function world(steps: Step[] = [], record?: (title: string) => { verified: boolean; record?: TeamTaskRecord; output?: string; error?: string }, hold?: Promise<void>) {
  let now = Date.UTC(2026, 10, 18, 6, 0);
  const identity = newNodeIdentity();
  const mind = new MindStore(":memory:");
  foundFleet(mind, identity, { fleetName: "camelot", nodeName: "ultra" });
  const store = new TeamStore(":memory:", () => now);
  for (const [id, name] of [["ada", "Ada"], ["lin", "Lin"], ["sam", "Sam"]] as const) store.saveTeammate({ id, name });
  const service = new TeamService({
    store,
    respond: async () => "",
    executeTask: async (_teammate, task, context) => {
      // (A held task runs until it's let go, or stopped.)
      if (hold) await Promise.race([hold, new Promise((_, no) => context.signal.addEventListener("abort", () => no(new Error("stopped"))))]);
      const result = record?.(task.title) ?? { verified: true };
      return { verified: result.verified, output: result.output ?? (result.verified ? `Done: ${task.title}` : ""), ...(result.error ? { error: result.error } : {}), ...(result.record ? { record: result.record } : {}) };
    },
    onTaskEnded: (task) => {
      if (task.outcome) runner.nudge();
    },
  });
  const prompts: string[] = [];
  const results: string[] = [];
  const asked: { role?: string; coding?: boolean; budgeted?: boolean }[] = [];
  const fake = (async function* (ctx: { spent?: (call: unknown) => void }, req: { messages: { content: string }[]; tools: ChatTools; role?: string; coding?: boolean; budgeted?: boolean; signal?: AbortSignal }) {
    prompts.push(req.messages[0]!.content);
    asked.push({ role: req.role, coding: req.coding, budgeted: req.budgeted });
    const step = steps.shift() ?? {};
    if (step.tokens) ctx.spent?.({ role: "planner", ref: "stand-in/m", usage: step.tokens });
    // (A model whose answer takes as long as it takes: until the call is cut off.)
    if (step.hang) await new Promise((_, no) => req.signal?.addEventListener("abort", () => no(new Error("the call was cut off")), { once: true }));
    for (const [i, call] of (step.calls ?? []).entries()) results.push((await req.tools.run({ id: `c${i}`, name: call.name, input: call.input })).content);
    if (step.text) yield { type: "text", text: step.text } as ChatStreamEvent;
    yield { type: "done", ref: "stand-in/m" } as ChatStreamEvent;
  }) as unknown as typeof Chat;
  // $10 a million in, $30 out: a look of 10,000 in and 2,000 out costs $0.16.
  const prices: Prices = { "stand-in/m": { input: 10, output: 30 } };
  const make = () => new OutcomeRunner({ store, service: () => service, mind, identity, brain: () => ({ store: mind, vault: undefined as never }), prices: () => prices, log: () => {}, now: () => now, chat: fake });
  const runner = make();
  fixtures.push({ store, service, runner });
  service.start();
  const outcomeNotices = () => mind.lwwPrefix<{ severity: string; title: string; source: string }>("notice:outcome:").map((e) => e.value!);
  return { store, service, runner, make, mind, prompts, results, asked, outcomeNotices, clock: { set: (t: number) => void (now = t), get: () => now } };
}

const give = (knight: string, title: string, budgetUsd: number, extra: object = {}) => ({ name: "start_task", input: { knight, title, goal: `${title}, and show it`, budgetUsd, gates: ["bun test"], ...extra } });
const until = async (ready: () => boolean) => {
  for (let i = 0; i < 400 && !ready(); i++) await Bun.sleep(5);
  expect(ready()).toBe(true);
};

describe("an outcome he owns", () => {
  test("is made with a room of its own holding the knights you named; he says what he'll do there, waking no knight", async () => {
    const w = world();
    const made = w.runner.create({ title: "Android app", goal: "Port the iPhone app to Android.", knights: ["ada", "lin"], budgetUsd: 20 });
    expect(made).toMatchObject({ room: made.id, status: "active", knights: ["ada", "lin"], budgetUsd: 20, spentUsd: 0, committedUsd: 0, reportHour: 9 });
    expect(made.id).toMatch(/^out-[a-z0-9_-]{12}$/);
    expect(w.store.room(made.room)).toMatchObject({ name: "Android app", members: ["ada", "lin"], direct: false });
    const [said] = w.store.messages(made.room);
    expect(said).toMatchObject({ speaker: "galahad" });
    expect(said!.text).toContain("I own this now: Android app");
    // A note for you: no knight was woken by it.
    expect(w.store.deliveries().length).toBe(0);
    await w.runner.stop();
  });

  test("a look gives tasks to its knights only, within what's left, a few at a time; each is a step of the outcome", async () => {
    const w = world(
      [{ calls: [give("sam", "Not his", 1), give("ada", "Set up the Gradle project", 2), give("lin", "Too dear", 50), give("lin", "More than is left", 19), give("lin", "Port the login screen", 3)] }],
      undefined,
      new Promise(() => {}),
    );
    const made = w.runner.create({ title: "Android app", goal: "Port the iPhone app to Android.", knights: ["ada", "lin"], budgetUsd: 20 });
    await until(() => w.results.length === 5);
    expect(w.results[0]).toMatch(/@sam isn't one of this outcome's knights/);
    expect(w.results[1]).toMatch(/^Given: task-.+ to @ada/);
    expect(w.results[2]).toMatch(/a task's budget is at most \$25/);
    expect(w.results[3]).toMatch(/more than is left/);
    expect(w.results[4]).toMatch(/^Given: task-.+ to @lin/);
    const tasks = w.store.tasks(made.room).sort((a, b) => a.assignee.localeCompare(b.assignee));
    expect(tasks.map((t) => [t.assignee, t.outcome, t.budgetUsd, t.gates])).toEqual([
      ["ada", made.id, 2, ["bun test"]],
      ["lin", made.id, 3, ["bun test"]],
    ]);
    // What they hold of its budget until they run.
    expect(w.runner.view(w.store.outcome(made.id)!).committedUsd).toBe(5);
    expect(w.prompts[0]).toContain("Done when: not said yet");
    expect(w.prompts[0]).toContain("@ada");
  });

  test("a look plans coding work and spends its budget: a coding plan may give it, and only a model the budget can count", async () => {
    const w = world([{ text: "Planned." }]);
    w.runner.create({ title: "Android app", goal: "Port the iPhone app to Android.", knights: ["ada"], budgetUsd: 5 });
    await until(() => w.asked.length === 1);
    expect(w.asked[0]).toEqual({ role: "planner", coding: true, budgeted: true });
    // What it's told of money says so.
    expect(w.prompts[0]).toContain("its work runs only on models it can count");
    await w.runner.stop();
  });

  test("a look is told each knight's repository and the gates that passed in its VM before: it names commands that VM has", async () => {
    const w = world([{ text: "Planned." }]);
    w.store.saveTeammate({ id: "ada", name: "Ada", repository: "https://github.com/acme/app" });
    // Ada's verified work elsewhere: its gates ran in her VM. Lin's that wasn't verified shows nothing of what Lin's runs.
    const workshop = w.store.saveRoom({ name: "Workshop", members: ["ada", "lin"] });
    w.service.createTask({ room: workshop.id, assignee: "ada", title: "Older", goal: "Older work", gates: ["bun test packages/core"] }, "owner");
    await until(() => w.store.tasks(workshop.id).every((t) => t.status === "done"));
    w.clock.set(w.clock.get() + 60_000);
    w.service.createTask({ room: workshop.id, assignee: "ada", title: "Newer", goal: "Newer work", gates: ["bun install --frozen-lockfile && bun test packages/node/test/ci-back.test.ts"] }, "owner");
    await until(() => w.store.tasks(workshop.id).filter((t) => t.status === "done").length === 2);
    w.runner.create({ title: "Android app", goal: "Port the iPhone app to Android.", knights: ["ada", "lin"], budgetUsd: 5 });
    await until(() => w.prompts.length === 1);
    const prompt = w.prompts[0]!;
    expect(prompt).toContain("Its VM's repository: https://github.com/acme/app");
    expect(prompt).toContain("Gates that passed in its VM before: `bun install --frozen-lockfile && bun test packages/node/test/ci-back.test.ts`; `bun test packages/core`");
    // One line of what Lin's VM runs, and none for a VM nothing has passed in.
    expect(prompt.match(/Gates that passed in its VM before/g)).toHaveLength(1);
    expect(prompt).toContain("name only commands its VM has");
    await w.runner.stop();
  });

  test("stopping cuts a look off rather than waiting for its answer: what it spent is counted, and the next start looks again", async () => {
    const w = world([{ tokens: { input: 10_000, output: 2_000 }, hang: true }, { text: "Planned." }]);
    const made = w.runner.create({ title: "Android app", goal: "Port the iPhone app to Android.", knights: ["ada"], budgetUsd: 5 });
    await until(() => w.prompts.length === 1);
    const began = performance.now();
    await w.runner.stop();
    // (A node's stop waits for this: one that waited for the model's answer was killed by its service manager.)
    expect(performance.now() - began).toBeLessThan(1000);
    const kept = w.store.outcome(made.id)!;
    expect(kept.leadUsd).toBeCloseTo(0.16, 5);
    // That it looked isn't kept: the node, started again, looks again.
    expect(kept.lastLookAt).toBeNull();
    const again = w.make();
    fixtures.push({ store: w.store, service: w.service, runner: again });
    await again.tick();
    await until(() => w.prompts.length === 2);
    await again.settled();
    expect(w.store.outcome(made.id)!.lastLookAt).not.toBeNull();
  });

  test(`at most ${OUTCOME_LIMITS.inFlight} of its tasks wait or run at once`, async () => {
    const w = world([{ calls: Array.from({ length: OUTCOME_LIMITS.inFlight + 1 }, (_, i) => give(i % 2 ? "ada" : "lin", `Step ${i}`, 0.5)) }], undefined, new Promise(() => {}));
    const made = w.runner.create({ title: "Many", goal: "Many steps.", knights: ["ada", "lin"], budgetUsd: 100 });
    await until(() => w.results.length === OUTCOME_LIMITS.inFlight + 1);
    expect(w.results.at(-1)).toMatch(new RegExp(`${OUTCOME_LIMITS.inFlight} of its tasks already wait or run`));
    expect(w.store.tasks(made.room)).toHaveLength(OUTCOME_LIMITS.inFlight);
  });

  test("its spend counts its tasks' runs and his looks; with too little left and nothing running, it has spent what it may", async () => {
    const spent: TeamTaskRecord = { startedAt: 1, endedAt: 2, ended: "done", commands: 3, revisions: 0, spent: [{ role: "engineer", model: "stand-in/m", calls: 2, unknown: 0, input: 100_000, output: 10_000, cached: 0, reasoning: 0 }] };
    // 100k in and 10k out at those prices: $1.30. His looks: $0.16, then $0.32.
    const w = world([{ calls: [give("ada", "Build it", 1.5)], tokens: { input: 10_000, output: 2_000 } }, { tokens: { input: 20_000, output: 4_000 } }], () => ({ verified: true, record: spent }));
    const made = w.runner.create({ title: "Small", goal: "A small thing.", knights: ["ada"], budgetUsd: 1.9 });
    await until(() => w.store.tasks(made.room)[0]?.status === "done");
    await until(() => w.prompts.length === 2);
    await w.runner.settled();
    // The task's run and both looks: $1.78 of $1.90.
    expect(w.store.outcome(made.id)!.status).toBe("active");
    expect(w.runner.view(w.store.outcome(made.id)!).spentUsd).toBeCloseTo(1.78, 2);
    // $0.12 left, nothing running: the next tick says it has spent what it may, with no look to say it.
    await w.runner.tick();
    await until(() => w.store.outcome(made.id)!.status === "spent");
    expect(w.prompts).toHaveLength(2);
    expect(w.store.outcome(made.id)!.ended).toMatch(/It has spent what it may/);
    expect(w.outcomeNotices().some((n) => n.title === "Small: its budget is spent" && n.source === `outcome:${made.id}`)).toBe(true);
  });

  test("its budget is yours to raise: one that had spent what it may goes on, he is told in its room, and looks again; never below what it spent", async () => {
    const spent: TeamTaskRecord = { startedAt: 1, endedAt: 2, ended: "done", commands: 3, revisions: 0, spent: [{ role: "engineer", model: "stand-in/m", calls: 2, unknown: 0, input: 100_000, output: 10_000, cached: 0, reasoning: 0 }] };
    // As above: $1.78 of $1.90 spent, and it ends; then a look that gives the rest of the work.
    const w = world([{ calls: [give("ada", "Build it", 1.5)], tokens: { input: 10_000, output: 2_000 } }, { tokens: { input: 20_000, output: 4_000 } }, { calls: [give("ada", "Finish it", 1)] }], () => ({ verified: true, record: spent }));
    const made = w.runner.create({ title: "Small", goal: "A small thing.", knights: ["ada"], budgetUsd: 1.9 });
    await until(() => w.store.tasks(made.room)[0]?.status === "done");
    await until(() => w.prompts.length === 2);
    await w.runner.settled();
    await w.runner.tick();
    await until(() => w.store.outcome(made.id)!.status === "spent");
    // Below what it has spent: refused, saying how much that is.
    expect(() => w.runner.control({ id: made.id, action: "budget", budgetUsd: 1 })).toThrow("its budget can't go below $1.78");
    // Raised by $2: it goes on, its end undone, said in its room, and he looks again and gives the rest.
    const raised = w.runner.control({ id: made.id, action: "budget", budgetUsd: 3.9 });
    expect(raised).toMatchObject({ status: "active", budgetUsd: 3.9, ended: null });
    expect(w.store.messages(made.room).some((m) => m.text.startsWith("Your liege set this outcome's budget to $3.90: $2.12 is left. It had spent what it might; I take it up again"))).toBe(true);
    await until(() => w.store.tasks(made.room).some((t) => t.title === "Finish it"));
    // A paused one stays paused at its new budget; one that ended stays ended.
    w.runner.control({ id: made.id, action: "pause" });
    expect(w.runner.control({ id: made.id, action: "budget", budgetUsd: 10 })).toMatchObject({ status: "paused", budgetUsd: 10 });
    w.runner.control({ id: made.id, action: "stop" });
    expect(() => w.runner.control({ id: made.id, action: "budget", budgetUsd: 20 })).toThrow("it has ended (stopped)");
  });

  test("a task of it ending brings a look; when nothing changed there is none", async () => {
    let release!: () => void;
    const w = world([{ calls: [give("ada", "One step", 1)] }, { text: "" }], undefined, new Promise<void>((go) => (release = go)));
    const made = w.runner.create({ title: "Steps", goal: "Steps.", knights: ["ada"], budgetUsd: 10 });
    await until(() => w.prompts.length === 1);
    await w.runner.settled();
    await w.runner.tick();
    await Bun.sleep(30);
    expect(w.prompts).toHaveLength(1);
    release();
    await until(() => w.store.tasks(made.room)[0]?.status === "done");
    await until(() => w.prompts.length === 2);
    expect(w.prompts[1]).toContain("a task of it ended");
    expect(w.prompts[1]).toMatch(/One step/);
  });

  test("your words in its room are answered by its look, with its tools", async () => {
    const w = world([{ text: "" }, { calls: [{ name: "keep_notes", input: { notes: "Login first, then the feed." } }], text: "Login first: I'll give @ada the screen next." }]);
    const made = w.runner.create({ title: "Android app", goal: "Port it.", knights: ["ada"], budgetUsd: 10 });
    await until(() => w.prompts.length === 1);
    w.store.post({ room: made.room, text: "Do the login screen before anything else." });
    const said = await w.runner.answer(made.room, new AbortController().signal);
    expect(said).toBe("Login first: I'll give @ada the screen next.");
    expect(w.prompts[1]).toContain("Do the login screen before anything else.");
    expect(w.prompts[1]).toContain("Your liege just wrote here");
    expect(w.store.outcome(made.id)!.notes).toBe("Login first, then the feed.");
  });

  test("his words in its room wake no knight, even when they name one: a note to you is no message to them", async () => {
    const w = world([{ calls: [{ name: "tell_liege", input: { kind: "note", text: "I've given @ada the first task, and @lin waits." } }] }]);
    w.runner.create({ title: "Android app", goal: "Port it.", knights: ["ada", "lin"], budgetUsd: 10 });
    await until(() => w.results.length === 1);
    expect(w.store.deliveries().length).toBe(0);
  });

  test("a task that ended unverified reaches the next look with its account: why it stopped, and what its review said", async () => {
    const account = "Stopped by an independent audit: it was steered and is still not closer.\n\nReview: What is missing or wrong, from the evidence: the required tests do not exist.";
    const w = world([{ calls: [give("ada", "First try", 2)] }, { text: "Seen." }], () => ({ verified: false, error: "stopped", output: account }));
    w.runner.create({ title: "Android app", goal: "Port it.", knights: ["ada"], budgetUsd: 10 });
    await until(() => w.prompts.length === 2);
    expect(w.prompts[1]).toContain("stopped: Stopped by an independent audit: it was steered and is still not closer.");
    expect(w.prompts[1]).toContain("the required tests do not exist.");
  });

  test("a question waits in your Inbox; a report is posted, kept, and told", async () => {
    const w = world([{ calls: [{ name: "tell_liege", input: { kind: "question", text: "Kotlin or Flutter?" } }, { name: "tell_liege", input: { kind: "report", text: "Day one: the plan, two tasks." } }] }]);
    const made = w.runner.create({ title: "Android app", goal: "Port it.", knights: ["ada"], budgetUsd: 10 });
    await until(() => w.results.length === 2);
    const notices = w.outcomeNotices();
    expect(notices.find((n) => n.severity === "warn")).toMatchObject({ title: "Android app: a decision for you", source: `outcome:${made.id}` });
    expect(notices.find((n) => n.severity === "info")).toMatchObject({ title: "Android app: his daily report" });
    expect(w.store.outcome(made.id)!.lastReportAt).not.toBeNull();
    expect(w.store.messages(made.room).map((m) => m.text)).toEqual(expect.arrayContaining(["Kotlin or Flutter?", "Day one: the plan, two tasks."]));
    expect(w.store.deliveries().length).toBe(0);
  });

  test("its report comes due at its hour, once a day", async () => {
    const w = world([{ text: "" }, { calls: [{ name: "tell_liege", input: { kind: "report", text: "Report." } }] }, { text: "" }]);
    const made = w.runner.create({ title: "Daily", goal: "Keep going.", knights: ["ada"], budgetUsd: 10, reportHour: 9, tz: "UTC" });
    await until(() => w.prompts.length === 1);
    await w.runner.settled();
    w.clock.set(Date.UTC(2026, 10, 18, 9, 1));
    await w.runner.tick();
    await until(() => w.prompts.length === 2);
    expect(w.prompts[1]).toContain("its report is due");
    expect(w.prompts[1]).toContain("Your daily report is due");
    await until(() => w.store.outcome(made.id)!.lastReportAt !== null);
    await w.runner.settled();
    w.clock.set(Date.UTC(2026, 10, 18, 12, 0));
    await w.runner.tick();
    await Bun.sleep(30);
    expect(w.prompts).toHaveLength(2);
  });

  test("paused it waits; stopped, its waiting work is stopped; finished, it ends", async () => {
    const w = world([{ calls: [give("ada", "Waiting work", 1)] }, { calls: [{ name: "finish_outcome", input: { summary: "All verified." } }] }], undefined, new Promise(() => {}));
    const made = w.runner.create({ title: "Stop me", goal: "Something.", knights: ["ada"], budgetUsd: 10 });
    await until(() => w.store.tasks(made.room).length === 1);
    expect(w.runner.control({ id: made.id, action: "pause" }).status).toBe("paused");
    w.clock.set(w.clock.get() + 7 * 3600_000);
    await w.runner.tick();
    await Bun.sleep(30);
    expect(w.prompts).toHaveLength(1);
    expect(w.runner.control({ id: made.id, action: "stop" })).toMatchObject({ status: "stopped", ended: "You stopped it." });
    expect(w.store.tasks(made.room)[0]!.status).toBe("stopped");
    expect(() => w.runner.control({ id: made.id, action: "resume" })).toThrow(/it has ended/);

    const done = world([{ calls: [{ name: "finish_outcome", input: { summary: "The app is in open testing." } }] }]);
    const other = done.runner.create({ title: "Finish", goal: "Finish it.", knights: ["ada"], budgetUsd: 10 });
    await until(() => done.store.outcome(other.id)!.status === "done");
    expect(done.store.outcome(other.id)!.ended).toBe("The app is in open testing.");
    expect(done.store.messages(other.room).at(-1)!.text).toBe("Done. The app is in open testing.");
  });
  test("the north star per outcome says how often you stepped in on its own tasks, per one done and verified (#43)", async () => {
    const w = world([{ calls: [give("ada", "Set up", 1), give("ada", "Build it", 1)] }]);
    const made = w.runner.create({ title: "Android app", goal: "Port the iPhone app to Android.", knights: ["ada"], budgetUsd: 20 });
    await until(() => w.results.length === 2);
    await until(() => w.store.tasks(made.room).filter((t) => t.status === "done").length === 2);
    // You stepped in twice on one of its two done tasks: once by an approval, once by a message.
    const first = w.store.tasks(made.room)[0]!;
    expect(w.store.intervene(first.id, "approval", "approved its work")).toBe(true);
    expect(w.store.intervene(first.id, "message", "a message while it worked")).toBe(true);
    const star = w.runner.view(w.store.outcome(made.id)!).northStar;
    expect(star.completed).toBe(2);
    expect(star.interventions).toBe(2);
    expect(star.perCompleted).toBe(1);
  });

  test("an outcome with none of its tasks done yet has no ratio (#43)", async () => {
    const w = world();
    const made = w.runner.create({ title: "Fresh", goal: "Nothing of it has run.", knights: ["ada"], budgetUsd: 10 });
    const star = w.runner.view(w.store.outcome(made.id)!).northStar;
    expect(star.completed).toBe(0);
    expect(star.perCompleted).toBeNull();
    await w.runner.stop();
  });

});
