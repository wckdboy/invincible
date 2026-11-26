// The trial suite's problems for N seeds, with their exact answers, as JSON:
// the input to scripts/trials-crosscheck.py, which re-solves each one by an
// independent method in the Lab.   bun scripts/trials-cases.ts 25 > cases.json
import { ENGINEERING_SUITE, pose } from "../packages/brain/src/index.ts";

const seeds = Number(process.argv[2] ?? 20);
const cases = ENGINEERING_SUITE.flatMap((problem) =>
  Array.from({ length: problem.id === "lid-driven-cavity" ? 1 : seeds }, (_, i) => {
    const posed = pose(problem, 1000 + i);
    return { problem: problem.id, seed: posed.seed, params: posed.params, expected: Object.fromEntries(posed.expected.map((e) => [e.key, e.value])) };
  }),
);
console.log(JSON.stringify(cases));
