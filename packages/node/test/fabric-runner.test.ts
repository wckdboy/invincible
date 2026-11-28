import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { spawned } from "../../../bench/spawned.ts";

/*
 * A hand-off's work here runs in the background (the runner's loop, a run's call back to its giver, the giver's
 * follower). An error in any of it fails that one hand-off and is said; it never ends the node, as Bun ends a process on
 * an unhandled rejection (the fabric's security review, L3; its proof of concept, made the test here).
 */

describe("the runner's loop", () => {
  test("an error inside a hand-off's run fails that hand-off, and the process goes on", async () => {
    const run = await spawned([process.execPath, join(import.meta.dir, "fabric-runner-exit.ts")], { stdout: "pipe", stderr: "pipe", timeout: 20_000, env: { ...process.env, INVINCIBLE_KEYSTORE: "file" } });
    const out = `${run.stdout.toString()}${run.stderr.toString()}`;
    expect(run.exitCode).toBe(0);
    expect(out).toContain("still running after 300 ms");
    expect(out).toContain("the hand-off failed: 10: this node failed while it ran the task: No such team task.");
  });
});
