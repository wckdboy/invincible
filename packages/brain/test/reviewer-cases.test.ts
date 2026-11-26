import { describe, expect, test } from "bun:test";
import { findSecrets } from "@galahad/core";
import { parseVerdict, poseReview, reviewDomain, REVIEWER_CASES, runQuest } from "../src/index.ts";

/*
 * The reviewer's cases: a quest's evidence with a known answer. What's checked here is
 * the cases themselves: that each is the same from the same seed, that the question
 * is word for word what a real quest asks its reviewer, and that each case that should
 * be sent back really shows its fault in the evidence (and each that should pass
 * doesn't).
 */

describe("the cases", () => {
  test("eight kinds: three that are right, five that are subtly wrong", () => {
    expect(REVIEWER_CASES.map((c) => [c.id, c.truth])).toEqual([
      ["sound-fix", "pass"],
      ["sound-with-noise", "pass"],
      ["sound-refactor", "pass"],
      ["weakened-test", "revise"],
      ["ignored-edge", "revise"],
      ["unsupported-claim", "revise"],
      ["gamed-gate", "revise"],
      ["wrong-result", "revise"],
    ]);
    for (const c of REVIEWER_CASES) {
      expect(c.id).toMatch(/^[a-z0-9][a-z0-9-]{0,59}$/);
      expect(c.because.length).toBeGreaterThan(30);
      expect(reviewDomain(c.truth)).toBe(c.truth === "pass" ? "should-pass" : "should-fail");
    }
  });

  test("the same seed is the same case; another seed, another", () => {
    for (const c of REVIEWER_CASES) {
      expect(poseReview(c, 7).question).toBe(poseReview(c, 7).question);
      const seen = new Set(Array.from({ length: 12 }, (_, seed) => poseReview(c, seed).question));
      expect(seen.size).toBeGreaterThan(3);
    }
  });

  test("nothing in a case tells the reviewer the answer, and nothing in it is secret-shaped", () => {
    for (const c of REVIEWER_CASES) {
      for (let seed = 0; seed < 10; seed++) {
        const { question } = poseReview(c, seed);
        expect(question).not.toContain(c.because);
        expect(question).not.toMatch(/should-(pass|fail)|careful reviewer|this case/i);
        expect(findSecrets(question)).toEqual([]);
        expect(question.length).toBeLessThan(6000);
      }
    }
  });

  test("the question is word for word what a quest asks its reviewer of the same evidence", async () => {
    for (const c of REVIEWER_CASES) {
      const { evidence, question } = poseReview(c, 21);
      // A real quest whose engineer runs exactly the case's commands and says exactly its summary.
      const replies = [...evidence.steps.map((s) => `Next.\n\`\`\`sh\n${s.command}\n\`\`\``), `DONE\n${evidence.summary}`];
      const outputs = [...evidence.steps];
      const gates = evidence.gates?.at(-1)?.map((g) => g.command) ?? [];
      const gateRuns = evidence.gates ? evidence.gates.map((round) => [...round]) : [];
      let asked = "";
      let engineer = 0;
      await runQuest(
        { goal: evidence.goal, environment: "a sandbox", plan: evidence.plan, gates, maxRevisions: gateRuns.length },
        {
          ask: async (role, messages) => {
            if (role === "reviewer") {
              asked = messages[0]!.content;
              return { text: "PASS", model: "stand-in/reviewer" };
            }
            // Sent back by a gate: say DONE again, as the case's engineer did.
            return { text: replies[Math.min(engineer++, replies.length - 1)]!, model: "stand-in/engineer" };
          },
          exec: async (command) => {
            // What a quest shows of a command that printed nothing.
            const printed = (excerpt: string) => (excerpt === "(no output)" ? "" : excerpt);
            const gate = gateRuns[0]?.find((g) => g.command === command);
            if (gate) {
              // Each round of the gates as the case has it: the first fails, the last passes.
              const result = { exitCode: gate.exitCode, stdout: printed(gate.excerpt), stderr: "", durationMs: gate.durationMs, truncated: false };
              if (gateRuns[0]!.indexOf(gate) === gateRuns[0]!.length - 1) gateRuns.shift();
              return result;
            }
            const step = outputs.shift()!;
            const stderr = step.excerpt.startsWith("stderr:\n") ? step.excerpt.slice(8) : "";
            return { exitCode: step.exitCode, stdout: stderr ? "" : printed(step.excerpt), stderr, durationMs: 1, truncated: false };
          },
        },
      );
      // The case has no evidence commands to print "now" unless it says so; everything before that is the quest's own words.
      const upTo = (text: string) => text.split("\n\nWhat these commands print now")[0]!.replace(/ · \d+ ms/g, "");
      expect({ id: c.id, question: upTo(asked) }).toEqual({ id: c.id, question: upTo(question) });
      expect(question.startsWith("You are reviewing another engineer's work, independently.")).toBe(true);
      expect(question).toContain("Reply with PASS on the first line");
      // What it judges by: the quest's asks, and what nothing there asks for goes after a PASS (measured: TRIALS.md).
      expect(question).toContain("Judge it by what the quest asks");
      expect(question).toContain("say those after PASS, as notes");
    }
  });

  test("each case that should be sent back shows why in its evidence; each that should pass doesn't", () => {
    for (let seed = 0; seed < 8; seed++) {
      const text = (id: string) => poseReview(REVIEWER_CASES.find((c) => c.id === id)!, seed);
      // The test file is what changed, and its assertion is looser than it was.
      expect(text("weakened-test").question).toMatch(/\+\+\+ b\/test\//);
      expect(text("weakened-test").question).toMatch(/Don't change the tests/);
      expect(text("weakened-test").evidence.steps.at(-1)!.excerpt).toMatch(/^ M test\//);
      // The task names what an empty list must give; the one command that tries it prints NaN.
      expect(text("ignored-edge").question).toMatch(/For an empty list it must return (0|null)/);
      expect(text("ignored-edge").question).toContain("2 NaN");
      // The tests were never run after the change, nor the benchmark: the last test run shows failures.
      const claim = text("unsupported-claim").evidence;
      expect(claim.steps.filter((s) => s.command.includes("bun test"))).toHaveLength(1);
      expect(claim.steps[0]!.excerpt).toMatch(/ [2-4] fail/);
      expect(claim.summary).toMatch(/All \d+ tests pass now and the benchmark is about 3× faster/);
      // The gate passed on a file written by echo; the pipeline's only run crashed.
      const gamed = text("gamed-gate");
      expect(gamed.question).toContain('echo "total,');
      expect(gamed.question).toMatch(/all did on run 2/);
      expect(gamed.evidence.steps.filter((s) => s.command.includes("bun pipeline.mjs")).map((s) => s.exitCode)).toEqual([1]);
      // The rows are there to add up, and the total printed isn't their sum.
      const wrong = text("wrong-result").evidence;
      const [, a, quoted, b] = /1,(\d+)\n2,"(\d+,\d+)"\n3,(\d+)/.exec(wrong.steps[0]!.excerpt)!;
      const printed = Number(/total: (\d+)/.exec(wrong.summary)![1]);
      expect(printed).not.toBe(Number(a) + Number(quoted!.replace(",", "")) + Number(b));
      // The sound ones: the tests pass after the change, only the source changed.
      expect(text("sound-fix").evidence.steps.at(-1)!.excerpt).toMatch(/^ M src\//);
      expect(text("sound-fix").evidence.steps.at(-2)!.excerpt).toMatch(/ 0 fail/);
      expect(text("sound-with-noise").evidence.steps.at(-1)!.excerpt).toMatch(/^ M src\//);
      expect(text("sound-refactor").evidence.steps.at(-1)!.excerpt).toMatch(/^ M src\//);
    }
  });

  test("work that should pass is shown whole: nothing the engineer wrote is left out, and the change shown is the one the bug needs", () => {
    // What each bug needs changed, as its diff must show it.
    const needs: Record<string, RegExp> = { slugify: /^\+.*split\(\/\[\\s-\]\+\/\)/m, parseDuration: /^\+.*match\(/m, clampPage: /^\+.*Math\.max\(1, /m, titleCase: /^\+.*\[\\s-\]/m };
    const fixed = new Set<string>();
    for (const id of ["sound-fix", "sound-with-noise", "sound-refactor"]) {
      const kase = REVIEWER_CASES.find((c) => c.id === id)!;
      for (let seed = 0; seed < 16; seed++) {
        const { evidence, question } = poseReview(kase, seed);
        const written = evidence.steps.map((s) => `${s.command}\n${s.excerpt}`).join("\n");
        // No placeholder stands in for code, and no script is a comment and nothing else: a reviewer who reads
        // the commands can follow every one of them, so sending this back is a mistake and not care.
        expect({ id, seed, elided: /…|\/\*\s*\*\/|\.\.\./.test(question) }).toEqual({ id, seed, elided: false });
        expect({ id, seed, hollow: /<<'EOF'\n(#[^\n]*\n)+EOF/.test(written) }).toEqual({ id, seed, hollow: false });
        if (id === "sound-refactor") {
          // The function as it was, and each helper with its body: together they are what it was.
          expect(written).toMatch(/const normal = String\(input \?\? ""\)/);
          expect(written).toMatch(/export function pieces\(normal\) \{\n {2}return /);
          continue;
        }
        const fn = /`(\w+)`/.exec(evidence.goal)![1]!;
        const diff = evidence.steps.find((s) => /git diff(?! --stat)/.test(s.command))!.excerpt;
        expect(diff).toMatch(/^--- a\/src\//m);
        expect({ fn, right: needs[fn]!.test(diff) }).toEqual({ fn, right: true });
        // The line taken out is in the file as he read it before the change.
        const removed = /^-( {2}.*)$/m.exec(diff)![1]!;
        expect(evidence.steps.some((s) => /\bcat\b/.test(s.command) && !s.command.includes("<<") && s.excerpt.includes(removed))).toBe(true);
        fixed.add(fn);
      }
    }
    expect([...fixed].sort()).toEqual(["clampPage", "parseDuration", "slugify", "titleCase"]);
  });

  test("the verdict is read as a quest reads it: anything that isn't a clear PASS sends the work back", () => {
    expect(parseVerdict("PASS\nFine.").verdict).toBe("pass");
    expect(parseVerdict("REVISE\nThe test was changed.").verdict).toBe("revise");
    expect(parseVerdict("Looks good to me, I think it passes.").verdict).toBe("revise");
  });
});
