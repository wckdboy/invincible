// The agentic suite, by hand: pose one task into a directory to read it, or verify the whole suite.
//
//   bun scripts/trials-agentic.ts pose <task[-l<level>]> <seed> <dir>
//       writes the repository as given to <dir>/repo, the goal to <dir>/GOAL.md, and (for you, never for a
//       sandbox) the hidden check script, the reference solution and the plausible wrong ones to <dir>/hidden
//   bun scripts/trials-agentic.ts verify [seeds per level, default 3]
//       every task at every level: as given it passes no hidden check, a reference solution passes all of
//       them, a plausible wrong one doesn't. The same as the test suite runs, for more seeds.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AGENTIC_SUITE, agenticProblem, LEVELS, poseTask, problemId } from "../packages/brain/src/index.ts";
import { asGiven, scoreOf } from "../packages/brain/test/agentic-harness.ts";

const [command, ...args] = process.argv.slice(2);

function put(root: string, files: Record<string, string | null>): void {
  for (const [path, text] of Object.entries(files)) {
    if (text === null) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

if (command === "pose") {
  const [name, seedRaw, dir] = args;
  const chosen = name ? agenticProblem(name) : null;
  const seed = Number(seedRaw);
  if (!chosen || !Number.isInteger(seed) || !dir) {
    console.error(`usage: bun scripts/trials-agentic.ts pose <task[-l<level>]> <seed> <dir>\ntasks: ${AGENTIC_SUITE.map((t) => t.id).join(", ")}`);
    process.exit(1);
  }
  const posed = poseTask(chosen.task, seed, chosen.level);
  put(join(dir, "repo"), posed.files);
  writeFileSync(join(dir, "GOAL.md"), `${posed.goal}\n`);
  put(join(dir, "hidden"), { "check.mjs": posed.script, "checks.md": posed.checks.map((c) => `- \`${c.key}\`: ${c.what}`).join("\n") + "\n" });
  put(join(dir, "hidden", "reference"), { ...posed.reference.files, ...(posed.reference.result ? { "result.json": JSON.stringify(posed.reference.result, null, 2) } : {}) });
  posed.wrong.forEach((w, i) => put(join(dir, "hidden", `wrong-${i + 1}`), { ...w.files, "ABOUT.md": `${w.name}\n`, ...(w.result ? { "result.json": JSON.stringify(w.result, null, 2) } : {}) }));
  console.log(`${problemId(chosen.task, chosen.level)} (seed ${seed}) posed in ${dir}: ${Object.keys(posed.files).length} files, ${posed.checks.length} hidden checks, ${posed.maxSteps} commands, gates: ${posed.gates.join(" · ") || "none"}`);
} else if (command === "verify") {
  const seeds = Number(args[0] ?? 3);
  let bad = 0;
  for (const task of AGENTIC_SUITE) {
    for (let level = 1; level <= LEVELS; level++) {
      for (let i = 0; i < seeds; i++) {
        const seed = 1000 + i * 7919;
        const posed = poseTask(task, seed, level);
        const [given, reference, ...wrong] = await Promise.all([scoreOf(posed, null), scoreOf(posed, posed.reference), ...posed.wrong.map((w) => scoreOf(posed, w))]);
        const holds = await asGiven(posed);
        const ok = given.score === (posed.untouched ?? 0) && reference.score === 1 && wrong.every((w) => w.score < 1) && holds === null;
        if (!ok) bad += 1;
        console.log(`${ok ? "ok " : "BAD"} ${problemId(task, level).padEnd(26)} seed ${String(seed).padEnd(6)} ${String(posed.checks.length).padStart(2)} checks · as given ${given.score.toFixed(2)} · reference ${reference.score.toFixed(2)} · wrong ${wrong.map((w) => w.score.toFixed(2)).join(", ")}${holds ? ` · as given: ${holds}` : ""}`);
        if (reference.score < 1) console.log("    the reference fails:", reference.failed);
      }
    }
  }
  console.log(bad ? `${bad} task(s) don't verify` : "every task verifies");
  process.exit(bad ? 1 : 0);
} else {
  console.error("usage: bun scripts/trials-agentic.ts pose <task[-l<level>]> <seed> <dir> | verify [seeds]");
  process.exit(1);
}
