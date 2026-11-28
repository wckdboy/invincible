import { expect, spyOn, test } from "bun:test";
import { primaryRevision } from "../src/revision.ts";
import {  } from "../../../bench/spawned.ts";

/*
 * The checkout's revision is asked of git without holding the process (28 November 2026). `bun run check` hung on the
 * Mac mini: one worker of eight spun at 91 % of a core for 58 minutes inside Bun.spawnSync (bun 1.4.2), in
 * evals-budget's run. Its child, `git describe`, had ended and was never reaped, and spawnSync's wait went round
 * without end. A synchronous spawn holds the JS thread, so no timeout fires. Every eval run asked this, and so do the
 * doctor, a model's check and the node's start.
 */

test("the revision is asked of git without a synchronous spawn, once a process, and is one", async () => {
  const sync = spyOn(Bun, "spawnSync");
  try {
    const first = await primaryRevision();
    const again = await primaryRevision();
    expect(sync).not.toHaveBeenCalled();
    expect(again).toBe(first);
    // A deploy's REVISION, git's describe of a checkout (a tag's, or a commit's, +dirty for one with changes), or none.
    expect(first).toMatch(/^([0-9a-f]{7,40}|[0-9A-Za-z._\/-]{1,63}(\+dirty)?|unknown)$/);
  } finally {
    sync.mockRestore();
  }
});
