import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawned } from "../../../bench/spawned.ts";

// (Each case runs its gates in sh beside git, as the node does: real processes, which take more than bun's default
// 5 s on a loaded machine. Bun then ends the test and kills the gate it was waiting on, "1 dangling process".)
setDefaultTimeout(30_000);
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvalRecord, evalProblem } from "@invincible/core";
import type { EvalJob } from "../src/eval-cli.ts";
import { attemptCase, heldOutTestsOf } from "../src/eval-yours.ts";
import { GATES, widgetsCase, WIDGETS, YoursStandIn } from "./yours-standin.ts";

/*
 * PLAN #9, held-out tests. A task's own change may add or change the test files its gates run; those tests are held
 * out from the engineer. A gate counts only when it fails on the commit with just those tests in place and passes with
 * the whole change; what the engineer left is graded with the agent's version of those tests put back over whatever
 * it left in them.
 */

const git = async (dir: string, ...args: string[]) => {
  const run = await spawned(["git", "-C", dir, "-c", "user.email=k@example.invalid", "-c", "user.name=agent", ...args]);
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
};

/** An invented repository at a base commit, and the agent's change as a patch (the working tree back at base). */
async function repoOf(base: Record<string, string>, agent: Record<string, string>): Promise<{ dir: string; base: string; patch: Uint8Array; remove(): void }> {
  const dir = mkdtempSync(join(tmpdir(), "invincible-heldout-"));
  const write = (path: string, content: string) => {
    mkdirSync(join(dir, ...path.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  for (const [p, c] of Object.entries(base)) write(p, c);
  await git(dir, "init", "-q");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-qm", "base");
  const baseSha = await git(dir, "rev-parse", "HEAD");
  for (const [p, c] of Object.entries(agent)) write(p, c);
  await git(dir, "add", "-A");
  const patch = (await spawned(["git", "-C", dir, "diff", "--binary", "--cached", baseSha])).stdout;
  await git(dir, "reset", "--hard", "-q", baseSha);
  return { dir, base: baseSha, patch: new Uint8Array(patch), remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The sum, but negatives are dropped (a bug the base test never meets). */
const TOTAL_POSITIVE = `#!/bin/sh
# The sum of a file's positive numbers.
awk '$1 > 0 { s += $1 } END { print s }' "$1"
`;

/** The sum of every number. */
const TOTAL_ALL = `#!/bin/sh
# The sum of a file's numbers, one a line.
awk '{ s += $1 } END { print s }' "$1"
`;

/** The base test: 1 + 2 + 3 is 6 (passes against either total.sh). */
const TEST_SUM = `#!/bin/sh
# 1 + 2 + 3 is 6.
printf '1\\n2\\n3\\n' > "\${TMPDIR:-/tmp}/numbers.txt"
got=$(sh total.sh "\${TMPDIR:-/tmp}/numbers.txt")
[ "$got" = 6 ] || { echo "expected 6, got $got"; exit 1; }
`;

/** The agent's test: the sum's test plus one that negatives count too (fails until total.sh is fixed). */
const TEST_NEGATIVE = `#!/bin/sh
# 1 + 2 + 3 is 6.
printf '1\\n2\\n3\\n' > "\${TMPDIR:-/tmp}/numbers.txt"
got=$(sh total.sh "\${TMPDIR:-/tmp}/numbers.txt")
[ "$got" = 6 ] || { echo "expected 6, got $got"; exit 1; }
# Negatives are numbers too.
printf '1\\n-2\\n3\\n' > "\${TMPDIR:-/tmp}/negatives.txt"
got2=$(sh total.sh "\${TMPDIR:-/tmp}/negatives.txt")
[ "$got2" = 2 ] || { echo "expected 2, got $got2"; exit 1; }
`;

/** A test-only change that also passes on the commit as it was: another sum, 5 + 6 is 11. */
const TEST_MORE_PASSING = `#!/bin/sh
printf '1\\n2\\n3\\n' > "\${TMPDIR:-/tmp}/numbers.txt"
got=$(sh total.sh "\${TMPDIR:-/tmp}/numbers.txt")
[ "$got" = 6 ] || { echo "expected 6, got $got"; exit 1; }
printf '5\\n6\\n' > "\${TMPDIR:-/tmp}/more.txt"
got2=$(sh total.sh "\${TMPDIR:-/tmp}/more.txt")
[ "$got2" = 11 ] || { echo "expected 11, got $got2"; exit 1; }
`;

/** What fixes total.sh, and nothing else. */
const FIX_SUM_ALL = `sed -i.orig 's/\\$1 > 0 //' total.sh && rm -f total.sh.orig`;
/** What weakens the held-out test the engineer never saw, and leaves the bug. */
const WEAKEN = `printf '#!/bin/sh\\nexit 0\\n' > test/total_test.sh`;

describe("held-out tests", () => {
  const nodes: YoursStandIn[] = [];
  const repos: { remove(): void }[] = [];
  const keep = <T extends { remove(): void }>(r: T): T => {
    repos.push(r);
    return r;
  };
  afterAll(() => {
    for (const node of nodes) node.remove();
    for (const repo of repos) repo.remove();
  });
  const standIn = (repo: { dir: string; patch: Uint8Array }, work: string | null = null): YoursStandIn => {
    const node = new YoursStandIn({ [WIDGETS]: repo.dir }, repo.patch);
    node.work = work;
    nodes.push(node);
    return node;
  };
  const job = (over: Partial<EvalJob> = {}): EvalJob => ({ seed: 7, run: "r-heldout", suite: "yours", version: "abc1234", network: "online", ...over });
  const valid = (record: EvalRecord) => {
    expect(EvalRecord.parse(record)).toEqual(record);
    expect(evalProblem(record)).toBeNull();
  };

  test("heldOutTestsOf reads the test files a patch adds or changes, and only those", () => {
    const patch = [
      "diff --git a/total.sh b/total.sh",
      "index 0000000..1111111 100644",
      "--- a/total.sh",
      "+++ b/total.sh",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/test/kept.test.ts b/test/kept.test.ts",
      "index 0000000..2222222 100644",
      "--- a/test/kept.test.ts",
      "+++ b/test/kept.test.ts",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "diff --git a/test/gone.test.ts b/test/gone.test.ts",
      "deleted file mode 100644",
      "index 3333333..0000000",
      "--- a/test/gone.test.ts",
      "+++ /dev/null",
      "diff --git a/test/new.test.ts b/test/new.test.ts",
      "new file mode 100644",
      "index 0000000..4444444",
      "--- /dev/null",
      "+++ b/test/new.test.ts",
      "@@ -0,0 +1 @@",
      "+new",
    ].join("\n");
    expect(heldOutTestsOf(Buffer.from(patch))).toEqual(["test/kept.test.ts", "test/new.test.ts"]);
  });

  test("a case whose kept patch adds tests to a test file its gate runs now counts that gate", async () => {
    const repo = keep(await repoOf({ "total.sh": TOTAL_POSITIVE, "test/total_test.sh": TEST_SUM }, { "total.sh": TOTAL_ALL, "test/total_test.sh": TEST_NEGATIVE }));
    const node = standIn(repo, FIX_SUM_ALL);
    const record = (await attemptCase(node, widgetsCase(repo.base, { gates: [GATES.test] }), job()))!;
    valid(record);
    expect(heldOutTestsOf(repo.patch)).toEqual(["test/total_test.sh"]);
    expect(record).toMatchObject({ status: "scored", score: 1, answers: [{ key: "gate_1", got: 1, ok: true }] });
    expect(record.note).toBe("counted: gate 1 of 1");
    expect(node.chats.length).toBeGreaterThan(0);
    // The engineer starts from the commit as it was: the held-out test never reaches its workshop.
    expect(node.workshops()).toHaveLength(1);
    expect(node.workshops()[0]!.commands.some((command) => command.includes("/work/.eval/"))).toBe(false);
  });

  test("an engineer's patch that edits those tests is graded by the agent's version of them", async () => {
    const repo = keep(await repoOf({ "total.sh": TOTAL_POSITIVE, "test/total_test.sh": TEST_SUM }, { "total.sh": TOTAL_ALL, "test/total_test.sh": TEST_NEGATIVE }));
    const node = standIn(repo, WEAKEN);
    const record = (await attemptCase(node, widgetsCase(repo.base, { gates: [GATES.test] }), job()))!;
    valid(record);
    expect(record).toMatchObject({ status: "scored", score: 0, answers: [{ key: "gate_1", got: 0, ok: false }] });
    // The agent's test, not the engineer's weakened one, decides; touching a held-out test doesn't fail the gate as altering it.
    expect(record.note).toBe("counted: gate 1 of 1; gate 1 failed (exit 1): expected 2, got 4");
  });

  test("a held-out test whose name holds a glob's characters is put in place as it is named (a route's [id].test.ts)", async () => {
    // git apply reads --include and --exclude as patterns: unescaped, [n] would match only "n", the agent's test would
    // never be put in place, and the gate would pass before any work and not count.
    const named = "test/[n]_total_test.sh";
    const repo = keep(await repoOf({ "total.sh": TOTAL_POSITIVE, [named]: TEST_SUM }, { "total.sh": TOTAL_ALL, [named]: TEST_NEGATIVE }));
    const node = standIn(repo, FIX_SUM_ALL);
    const record = (await attemptCase(node, widgetsCase(repo.base, { gates: [`sh '${named}'`] }), job()))!;
    valid(record);
    expect(heldOutTestsOf(repo.patch)).toEqual([named]);
    expect(record).toMatchObject({ status: "scored", score: 1, answers: [{ key: "gate_1", got: 1, ok: true }] });
    expect(record.note).toBe("counted: gate 1 of 1");
  });

  test("a case whose kept change is only tests, which pass on the commit as it was, still isn't graded and says why", async () => {
    const repo = keep(await repoOf({ "total.sh": TOTAL_ALL, "test/total_test.sh": TEST_SUM }, { "test/total_test.sh": TEST_MORE_PASSING }));
    const node = standIn(repo);
    const record = (await attemptCase(node, widgetsCase(repo.base, { gates: [GATES.test] }), job()))!;
    valid(record);
    expect(heldOutTestsOf(repo.patch)).toEqual(["test/total_test.sh"]);
    expect(record).toMatchObject({ status: "crashed", score: 0, answers: [] });
    expect(record.note).toBe("not graded: no gate proves anything here (gate 1 passes before any work)");
    expect(node.chats).toEqual([]);
  });
});
