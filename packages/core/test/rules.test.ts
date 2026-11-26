import { describe, expect, test } from "bun:test";
import { Bodies, MAX_RULE_GLOBS, readRule, RuleInput, ruleOf, RuleToldInput, RuleTrippedInput } from "../src/index.ts";

/*
 * Your rules, as the contract holds them: data you write (globs and a piece of text), never code. What the API takes is
 * checked strictly; what the log holds is open, so a newer node's rule never makes an older one refuse the event, and
 * an older node applies only what it understands.
 */

describe("a rule, as you give it", () => {
  test("a name, what it does, and globs or a piece of text (or both)", () => {
    expect(RuleInput.safeParse({ name: "no-locks", does: "halt", words: ["*.lock", "package-lock.json"] }).success).toBe(true);
    expect(RuleInput.safeParse({ name: "no-push", does: "refuse", words: [], contains: "git push" }).success).toBe(true);
    expect(RuleInput.safeParse({ name: "no-force", does: "refuse", words: ["git"], contains: "--force" }).success).toBe(true);
  });

  test("one that would match nothing, or everything it isn't told, is refused", () => {
    expect(RuleInput.safeParse({ name: "empty", does: "halt", words: [] }).success).toBe(false);
    expect(RuleInput.safeParse({ name: "no-locks", does: "ask", words: ["*.lock"] }).success).toBe(false);
    expect(RuleInput.safeParse({ name: "no-locks", words: ["*.lock"] }).success).toBe(false);
    // Not a regular expression, not code: a field it doesn't know is refused at the door.
    expect(RuleInput.safeParse({ name: "no-locks", does: "halt", words: ["*.lock"], run: "rm -rf /" }).success).toBe(false);
  });

  test("a check: what to run after a command it matches has run, one line of yours", () => {
    const check = { name: "types", does: "check", words: ["*.ts"], run: "bunx tsc --noEmit" };
    expect(RuleInput.safeParse(check).success).toBe(true);
    expect(RuleInput.safeParse({ ...check, words: [], contains: "git commit", run: "bun test && bun run lint" }).success).toBe(true);
    // A check runs something, and only a check does.
    expect(RuleInput.safeParse({ ...check, run: undefined }).success).toBe(false);
    expect(RuleInput.safeParse({ ...check, does: "refuse" }).success).toBe(false);
    for (const run of ["", "   ", "bun test\nrm -rf /", "x".repeat(1001)]) expect(RuleInput.safeParse({ ...check, run }).success).toBe(false);
    expect(RuleInput.safeParse({ ...check, words: [] }).success).toBe(false);
  });

  test("a rule that tells you: globs or a piece of text, and nothing to run", () => {
    const tell = { name: "migrations", does: "tell", words: ["migrations/**"] };
    expect(RuleInput.safeParse(tell).success).toBe(true);
    expect(RuleInput.safeParse({ ...tell, words: [], contains: "git push" }).success).toBe(true);
    // Only a check runs something; a rule that tells you still has to match something.
    expect(RuleInput.safeParse({ ...tell, run: "bun test" }).success).toBe(false);
    expect(RuleInput.safeParse({ ...tell, words: [] }).success).toBe(false);
  });

  test("as the log holds it: a tripwire before a command, a check or a tell after one", () => {
    expect(ruleOf({ name: "no-locks", does: "refuse", words: ["*.lock"], contains: "git add" })).toEqual({ on: "command", does: "refuse", words: ["*.lock"], contains: "git add" });
    expect(ruleOf({ name: "types", does: "check", words: ["*.ts"], run: "bunx tsc --noEmit" })).toEqual({ on: "after", does: "check", run: "bunx tsc --noEmit", words: ["*.ts"] });
    expect(ruleOf({ name: "pushes", does: "tell", words: [], contains: "git push" })).toEqual({ on: "after", does: "tell", words: [], contains: "git push" });
  });

  test("its name is lowercase, short, and safe to say anywhere", () => {
    for (const name of ["no-locks", "env.files", "a", "rule_2"]) expect(RuleInput.safeParse({ name, does: "halt", words: ["x"] }).success).toBe(true);
    for (const name of ["", "No-Locks", "-x", "a b", "x".repeat(41), "../x"]) expect(RuleInput.safeParse({ name, does: "halt", words: ["x"] }).success).toBe(false);
  });

  test("a glob is one short line, and a rule has a few of them", () => {
    const rule = (words: string[], contains?: string) => RuleInput.safeParse({ name: "r", does: "halt", words, ...(contains !== undefined ? { contains } : {}) }).success;
    expect(rule(["migrations/**", ".env*", "rm", "my file.txt"])).toBe(true);
    expect(rule([""])).toBe(false);
    expect(rule(["a\nb"])).toBe(false);
    expect(rule(["a\u0000"])).toBe(false);
    expect(rule(["x".repeat(101)])).toBe(false);
    expect(rule(Array.from({ length: MAX_RULE_GLOBS + 1 }, (_, i) => `g${i}`))).toBe(false);
    expect(rule([], "")).toBe(false);
    expect(rule([], "x".repeat(201))).toBe(false);
    expect(rule([], "line\nbreak")).toBe(false);
  });
});

describe("a rule, as the log holds it", () => {
  const written = { on: "command", does: "refuse", words: ["*.lock"], contains: "git add" };

  test("the event takes the rule open: a newer node's field never makes this one refuse it", () => {
    expect(Bodies["rule.set"].safeParse({ name: "no-locks", rule: written }).success).toBe(true);
    expect(Bodies["rule.set"].safeParse({ name: "no-locks", rule: { ...written, only: ["ada"], on: "answer" } }).success).toBe(true);
    expect(Bodies["rule.set"].safeParse({ name: "No Locks", rule: written }).success).toBe(false);
    expect(Bodies["rule.removed"].safeParse({ name: "no-locks" }).success).toBe(true);
    expect(Bodies["rule.removed"].safeParse({ name: "no-locks", rule: written }).success).toBe(false);
  });

  test("this node reads what it understands; a field it doesn't know is set aside, the rest stands (never less strict)", () => {
    expect(readRule(written)).toEqual({ on: "command", does: "refuse", words: ["*.lock"], contains: "git add" });
    expect(readRule({ ...written, only: ["ada"] })).toEqual({ on: "command", does: "refuse", words: ["*.lock"], contains: "git add" });
  });

  test("a check is read after a command, with what it runs", () => {
    const check = { on: "after" as const, does: "check" as const, run: "bunx tsc --noEmit", words: ["*.ts"] };
    expect(readRule(check)).toEqual(check);
    expect(readRule({ ...check, only: ["ada"] })).toEqual(check);
    // Each point has its own effects, and a check has something to run.
    expect(readRule({ ...check, does: "halt" })).toBeNull();
    expect(readRule({ ...written, does: "check", run: "bun test" })).toBeNull();
    expect(readRule({ ...check, run: undefined })).toBeNull();
    expect(readRule({ ...check, run: "a\nb" })).toBeNull();
  });

  test("a tell is read after a command, and only there", () => {
    const tell = { on: "after" as const, does: "tell" as const, words: ["migrations/**"] };
    expect(readRule(tell)).toEqual(tell);
    expect(readRule({ ...tell, only: ["ada"] })).toEqual(tell);
    expect(readRule({ ...written, does: "tell" })).toBeNull();
    expect(readRule({ ...tell, words: [] })).toBeNull();
  });

  test("a rule at a point or with an effect this node doesn't have is not applied here, and says so (null)", () => {
    expect(readRule({ ...written, on: "answer" })).toBeNull();
    expect(readRule({ ...written, does: "ask" })).toBeNull();
    expect(readRule({ on: "command", does: "halt", words: [] })).toBeNull();
    for (const junk of [null, "rm", 3, [], { words: ["*.lock"] }]) expect(readRule(junk)).toBeNull();
  });
});

test("a tell is said to the node with the quest, the command, whole, and how it ended", () => {
  expect(RuleToldInput.safeParse({ quest: "q-m1abc", rule: "pushes", command: "git push origin main", exitCode: 0 }).success).toBe(true);
  expect(RuleToldInput.safeParse({ quest: "q-m1abc", rule: "pushes", command: "git push origin main", exitCode: 128 }).success).toBe(true);
  expect(RuleToldInput.safeParse({ quest: "q-m1abc", rule: "pushes", command: "git push origin main" }).success).toBe(false);
  expect(RuleToldInput.safeParse({ quest: "q-m1abc", rule: "pushes", command: "git push", exitCode: 0.5 }).success).toBe(false);
  expect(RuleToldInput.safeParse({ quest: "q-m1abc", rule: "pushes", command: "git push", exitCode: 0, body: "x" }).success).toBe(false);
});

test("a trip is said to the node with the quest it stopped and the command, whole", () => {
  expect(RuleTrippedInput.safeParse({ quest: "q-m1abc", rule: "no-locks", command: "rm bun.lock" }).success).toBe(true);
  expect(RuleTrippedInput.safeParse({ quest: "q-m1abc", rule: "no-locks", command: "bun test", gate: true }).success).toBe(true);
  expect(RuleTrippedInput.safeParse({ quest: "q m1abc", rule: "no-locks", command: "rm bun.lock" }).success).toBe(false);
  expect(RuleTrippedInput.safeParse({ quest: "q-m1abc", rule: "no-locks", command: "" }).success).toBe(false);
});
