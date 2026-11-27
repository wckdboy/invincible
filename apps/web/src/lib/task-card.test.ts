import { describe, expect, test } from "bun:test";
import type { TeamTask } from "@invincible/core/team";
import { gatesLine, givenLine, keptChanges, latestLine, proposedLine, sensitiveLine, steppedLine, taskActions, taskAnswers, taskBadge, taskEnd, taskStanding } from "./task-card.ts";

const task = (status: TeamTask["status"], more: Partial<TeamTask> = {}): TeamTask => ({ id: "task-abcdefghijkl", room: "dm-ada", assignee: "ada", title: "Fix the importer", goal: "Fix it", dependsOn: [], gates: ["bun test"], status, verified: status === "done", progress: "", output: "", error: null, chainId: "c", createdAt: 1, updatedAt: 2, ...more });
/** A task's output as the runner writes it: the agent's summary, then the review and where it worked. */
const output = (summary: string) => `${summary}\n\nReview: gave-up\nWorkspace: /work/tasks/task-abcdefghijkl`;

describe("a task card's badge", () => {
  test("says where the task stands, toned as status is everywhere", () => {
    const badges = (["queued", "running", "failed", "stopped", "interrupted"] as const).map((status) => taskBadge(task(status)));
    expect(badges).toEqual([
      { text: "Queued", tone: "neutral" },
      { text: "Running", tone: "accent" },
      { text: "Failed", tone: "danger" },
      { text: "Stopped", tone: "neutral" },
      { text: "Interrupted", tone: "warn" },
    ]);
    // Done is green only when it was verified.
    expect(taskBadge(task("done"))).toEqual({ text: "Verified", tone: "ok" });
    expect(taskBadge(task("done", { verified: false }))).toEqual({ text: "Not verified", tone: "warn" });
  });
});

describe("how a task ended, in words", () => {
  test("work in hand has not ended", () => {
    expect(taskEnd(task("queued"))).toBeNull();
    expect(taskEnd(task("running"))).toBeNull();
  });

  test("a verified task says what the agent said of it, and nothing went wrong", () => {
    expect(taskEnd(task("done", { output: output("Parsed ISO dates; 4 new tests pass.") }))).toEqual({ why: null, said: "Parsed ISO dates; 4 new tests pass." });
    expect(taskEnd(task("done"))).toEqual({ why: null, said: null });
  });

  test("a run's own ending is said in words, and the agent's own account follows it", () => {
    const failed = task("failed", { verified: false, error: "gave-up", output: output("The gate needs a database this VM does not have:\nbun test db/ exits 1 before any work.") });
    expect(taskEnd(failed)).toEqual({ why: "It gave up.", said: "The gate needs a database this VM does not have:\nbun test db/ exits 1 before any work." });
    expect(taskEnd(task("failed", { verified: false, error: "unverified" }))!.why).toBe("Not verified: its gates or the independent review did not pass.");
    expect(taskEnd(task("failed", { verified: false, error: "stopped" }))!.why).toBe("It stopped before the work was done.");
  });

  test("anything else the node said is said as it was, and a failure that said nothing says so", () => {
    expect(taskEnd(task("failed", { verified: false, error: "Workspace not ready: no VM host is online" }))!.why).toBe("Workspace not ready: no VM host is online");
    expect(taskEnd(task("interrupted", { verified: false, error: "The node stopped during this work. Review it before resuming." }))).toEqual({ why: "The node stopped during this work. Review it before resuming.", said: null });
    expect(taskEnd(task("stopped", { verified: false, error: "Stopped by you." }))!.why).toBe("Stopped by you.");
    expect(taskEnd(task("failed", { verified: false }))!.why).toBe("It failed without saying why.");
    expect(taskEnd(task("stopped", { verified: false }))!.why).toBe("Stopped.");
  });

  test("what the agent said is its summary, never the runner's lines after it, and a long one is cut", () => {
    expect(taskEnd(task("failed", { verified: false, error: "gave-up", output: "\n\nReview: gave-up\nWorkspace: /work" }))!.said).toBeNull();
    // Output from before the runner wrote a review line is taken whole.
    expect(taskEnd(task("done", { output: "Done, and checked." }))!.said).toBe("Done, and checked.");
    const long = taskEnd(task("done", { output: output("x".repeat(5000)) }))!.said!;
    expect(long.length).toBe(1000);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("what can be done with a task", () => {
  test("work in hand can be stopped; work that ended without being verified can be resumed or given again", () => {
    expect(taskActions(task("queued"))).toEqual(["stop"]);
    expect(taskActions(task("running"))).toEqual(["stop"]);
    for (const status of ["failed", "stopped", "interrupted"] as const) expect([status, taskActions(task(status, { verified: false }))]).toEqual([status, ["resume", "again"]]);
    expect(taskActions(task("done", { verified: false }))).toEqual(["again"]);
    // Verified work is finished: nothing to press.
    expect(taskActions(task("done"))).toEqual([]);
  });
});

describe("who gave a task to the agents, and what it kept", () => {
  test("a task given to the agents says by whom; one given to an agent by name says nothing", () => {
    expect(givenLine(task("queued", { givenBy: "owner" }))).toBe("Given to the agents by you");
    expect(givenLine(task("queued", { givenBy: "primary" }))).toBe("Given to the agents by your agent");
    // Sensitive mode for a task alone says which models every call of its work is held to.
    expect(sensitiveLine(task("queued", { models: ["nearai/Qwen/Qwen3.8-27B-abliterated"] }))).toBe("Sensitive mode: on nearai/Qwen/Qwen3.8-27B-abliterated alone");
    expect(sensitiveLine(task("queued"))).toBeNull();
    expect(givenLine(task("queued"))).toBeNull();
    expect(givenLine(task("queued", { givenBy: "someone-else" }))).toBeNull();
  });

  test("kept changes say how many files, and which artifact holds them", () => {
    const changes = { artifact: "art_AAAAAAAAAAAAAAAAAAAAAA", files: 3, base: "a".repeat(40) };
    expect(keptChanges(task("done", { changes }))).toEqual({ text: "3 files changed", artifact: "art_AAAAAAAAAAAAAAAAAAAAAA" });
    expect(keptChanges(task("done", { changes: { ...changes, files: 1 } }))!.text).toBe("1 file changed");
    expect(keptChanges(task("done"))).toBeNull();
  });
});

describe("a task an agent proposed", () => {
  test("waits for you: approved, it runs; declined, it never does", () => {
    const proposal = task("proposed", { proposedBy: "noa" });
    expect(taskBadge(proposal)).toEqual({ text: "Waiting for you", tone: "accent" });
    expect(taskEnd(proposal)).toBeNull();
    expect(taskActions(proposal)).toEqual(["approve", "decline"]);
    expect(proposedLine(proposal, "Noa")).toBe("Noa proposes this: it starts when you approve it");
    // Approved, it is work like any other, and says who proposed it.
    expect(proposedLine(task("running", { proposedBy: "noa" }), "Noa")).toBe("Proposed by Noa");
    expect(proposedLine(task("running", { proposedBy: "gone" }), null)).toBe("Proposed by gone");
    // Declined, it says so, and it may still be taken up.
    expect(taskEnd(task("stopped", { proposedBy: "noa", error: "Declined by you.", verified: false }))).toEqual({ why: "Declined by you.", said: null });
    expect(proposedLine(task("queued"), null)).toBeNull();
  });
});

describe("how you stepped in on a task (#28)", () => {
  test("is said in words, or not at all", () => {
    expect(steppedLine({})).toBeNull();
    expect(steppedLine({ interventions: {} })).toBeNull();
    expect(steppedLine({ interventions: { approval: 1, message: 2 } })).toBe("You stepped in: an approval and two messages");
    expect(steppedLine({ interventions: { again: 1 } })).toBe("You stepped in: given again");
  });
});

describe("a task where it was given, as the iPhone's TaskCardView says it (I10)", () => {
  const changes = { artifact: "art_AAAAAAAAAAAAAAAAAAAAAA", files: 2, base: "a".repeat(40) };
  const statuses = ["proposed", "queued", "running", "done", "failed", "stopped", "interrupted"] as const;

  test("one answer in full, the rest a tap further; none for work in hand, nor for verified work with nothing to ship", () => {
    expect(taskAnswers(task("proposed"))).toEqual({ prominent: "approve", rest: ["decline"] });
    expect(taskAnswers(task("queued"))).toEqual({ prominent: null, rest: ["stop"] });
    expect(taskAnswers(task("running"))).toEqual({ prominent: null, rest: ["stop"] });
    expect(taskAnswers(task("done", { verified: false }))).toEqual({ prominent: "again", rest: [] });
    expect(taskAnswers(task("done", { verified: true, changes }))).toEqual({ prominent: "ship", rest: ["again"] });
    expect(taskAnswers(task("done", { verified: true, changes, fix: { connector: "github", owner: "example", repo: "app", branch: "fix-1", pr: 7, head: "b".repeat(40) } }))).toEqual({ prominent: null, rest: ["again"] });
    expect(taskAnswers(task("done", { verified: true }))).toEqual({ prominent: null, rest: ["again"] });
    expect(taskAnswers(task("failed", { verified: false }))).toEqual({ prominent: "again", rest: ["resume"] });
    expect(taskAnswers(task("stopped", { verified: false }))).toEqual({ prominent: "resume", rest: ["again"] });
    expect(taskAnswers(task("interrupted", { verified: false }))).toEqual({ prominent: "resume", rest: ["again"] });
  });

  test("its answers are the ones it always had, and verified work can be given again besides", () => {
    for (const status of statuses) {
      for (const verified of [true, false]) {
        for (const kept of [changes, undefined]) {
          const t = task(status, { verified, ...(kept ? { changes: kept } : {}) });
          const { prominent, rest } = taskAnswers(t);
          const offered = [...(prominent ? [prominent] : []), ...rest].sort();
          const had = [...new Set([...taskActions(t), ...(status === "done" && verified ? (["again"] as const) : [])])].sort();
          expect([status, verified, Boolean(kept), offered]).toEqual([status, verified, Boolean(kept), had]);
          expect(new Set(offered).size).toBe(offered.length);
        }
      }
    }
  });

  test("how it stands: its word while in hand, its verdict as its proof allows once it ended, never Verified", () => {
    expect(taskStanding(task("proposed"))).toEqual({ word: "Waits for you", tone: "active", strong: true });
    expect(taskStanding(task("running"))).toEqual({ word: "Working", tone: "active", strong: false });
    expect(taskStanding(task("queued"))).toEqual({ word: "Queued", tone: "quiet", strong: false });
    expect(taskStanding(task("interrupted", { verified: false }))).toEqual({ word: "Interrupted", tone: "active", strong: true });
    // Verified, with no record of what its gates showed: reviewed, not "Verified".
    expect(taskStanding(task("done", { verified: true }))).toEqual({ word: "Reviewed", tone: "quiet", strong: true });
    expect(taskStanding(task("done", { verified: false }))).toEqual({ word: "Not verified", tone: "quiet", strong: true });
    expect(taskStanding(task("failed", { verified: false, error: "gave-up" }))).toEqual({ word: "Gave up", tone: "failed", strong: true });
    expect(taskStanding(task("failed", { verified: false }))).toEqual({ word: "Failed", tone: "failed", strong: true });
    expect(taskStanding(task("stopped", { verified: false }))).toEqual({ word: "Stopped", tone: "quiet", strong: true });
    for (const status of statuses) expect(taskStanding(task(status)).word).not.toBe("Verified");
  });

  test("a proposal says what proves it in a line; a running task its latest line, the first of its progress", () => {
    expect(gatesLine(["bun test"])).toBe("Done when bun test passes");
    expect(gatesLine(["bun test", "bun run lint"])).toBe("Done when bun test · bun run lint pass");
    expect(gatesLine([])).toBeNull();
    expect(latestLine(task("running", { progress: "  Running bun test\nthen the lint  " }))).toBe("Running bun test");
    expect(latestLine(task("running", { progress: "" }))).toBe("");
  });
});
