import { describe, expect, test } from "bun:test";
import type { TeamTask } from "@galahad/core/team";
import { givenLine, keptChanges, proposedLine, sensitiveLine, steppedLine, taskActions, taskBadge, taskEnd } from "./task-card.ts";

const task = (status: TeamTask["status"], more: Partial<TeamTask> = {}): TeamTask => ({ id: "task-abcdefghijkl", room: "dm-ada", assignee: "ada", title: "Fix the importer", goal: "Fix it", dependsOn: [], gates: ["bun test"], status, verified: status === "done", progress: "", output: "", error: null, chainId: "c", createdAt: 1, updatedAt: 2, ...more });
/** A task's output as the runner writes it: the knight's summary, then the review and where it worked. */
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

  test("a verified task says what the knight said of it, and nothing went wrong", () => {
    expect(taskEnd(task("done", { output: output("Parsed ISO dates; 4 new tests pass.") }))).toEqual({ why: null, said: "Parsed ISO dates; 4 new tests pass." });
    expect(taskEnd(task("done"))).toEqual({ why: null, said: null });
  });

  test("a quest's own ending is said in words, and the knight's own account follows it", () => {
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

  test("what the knight said is its summary, never the runner's lines after it, and a long one is cut", () => {
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

describe("who gave a task to the Roundtable, and what it kept", () => {
  test("a task given to the Roundtable says by whom; one given to a knight by name says nothing", () => {
    expect(givenLine(task("queued", { givenBy: "owner" }))).toBe("Given to the Roundtable by you");
    expect(givenLine(task("queued", { givenBy: "galahad" }))).toBe("Given to the Roundtable by Galahad");
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

describe("a task a knight proposed", () => {
  test("waits for you: approved, it runs; declined, it never does", () => {
    const proposal = task("proposed", { proposedBy: "kay" });
    expect(taskBadge(proposal)).toEqual({ text: "Waiting for you", tone: "accent" });
    expect(taskEnd(proposal)).toBeNull();
    expect(taskActions(proposal)).toEqual(["approve", "decline"]);
    expect(proposedLine(proposal, "Kay")).toBe("Kay proposes this: it starts when you approve it");
    // Approved, it is work like any other, and says who proposed it.
    expect(proposedLine(task("running", { proposedBy: "kay" }), "Kay")).toBe("Proposed by Kay");
    expect(proposedLine(task("running", { proposedBy: "gone" }), null)).toBe("Proposed by gone");
    // Declined, it says so, and it may still be taken up.
    expect(taskEnd(task("stopped", { proposedBy: "kay", error: "Declined by you.", verified: false }))).toEqual({ why: "Declined by you.", said: null });
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
