import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientCall, ExecResult } from "@galahad/core";
import { applyEdit, ENGINEER_TOOLS, type EngineerStep, engineerStep, keptInput } from "../src/engineer-tools.ts";
import { changesOf, readOf, writesOf } from "../src/shell-paths.ts";
import { tripOf } from "../src/tripwires.ts";

/*
 * The engineer's tools: what a call is said as (for your rules and the trail), how an edit finds its place, and the
 * commands each runs, run for real by bash in a folder of their own.
 */

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A sandbox stand-in: bash in a fresh folder, every command it was given kept. */
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "galahad-engineer-tools-"));
  dirs.push(dir);
  const commands: string[] = [];
  const exec = async (command: string, _timeoutSec: number): Promise<ExecResult> => {
    commands.push(command);
    const proc = Bun.spawn(["bash", "-c", command], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { exitCode, stdout, stderr, durationMs: 1, truncated: false };
  };
  return { dir, exec, commands };
}

const shown = (result: ExecResult): string => `exit ${result.exitCode}\n${result.stdout}${result.stderr}`;
const call = (name: string, input: Record<string, unknown>): ClientCall => ({ id: "c1", name, input });
const step = (name: string, input: Record<string, unknown>): EngineerStep => {
  const read = engineerStep(call(name, input), shown);
  if ("problem" in read) throw new Error(read.problem);
  return read;
};

describe("an edit's place in a file", () => {
  const file = "function add(a, b) {\n  return a + b;\n}\n\nfunction sub(a, b) {\n  return a - b;\n}\n";

  test("found exactly once, it is replaced, and the line it starts at is said", () => {
    const edit = applyEdit(file, "  return a - b;", "  return a - b; // checked");
    expect(edit).toEqual({ text: file.replace("a - b;", "a - b; // checked"), lines: [6], forgiven: false, size: 1 });
  });

  test("found more than once, it is refused with where it is, unless all are meant", () => {
    expect(applyEdit(file, "(a, b)", "(x, y)")).toEqual({ problem: "old_string is there 2 times (at lines 1, 5): give more of the lines around it, so it is found once, or set replace_all." });
    const all = applyEdit(file, "(a, b)", "(x, y)", true);
    expect("text" in all && all.text.match(/\(x, y\)/g)).toHaveLength(2);
    expect("lines" in all && all.lines).toEqual([1, 5]);
  });

  test("read's line numbers copied in with every line are taken out", () => {
    const edit = applyEdit(file, "     5\tfunction sub(a, b) {\n     6\t  return a - b;", "function sub(a, b) {\n  return b - a;");
    expect("text" in edit && edit.text).toBe(file.replace("a - b", "b - a"));
  });

  test("whole lines are found with their indentation, spacing and quotes forgiven, and take the file's indentation", () => {
    const code = "if (ok) {\n    say(\"it's done\");\n    stop();\n}\n";
    const edit = applyEdit(code, "say(\u201Cit\u2019s done\u201D);\nstop();\n", "say(\"done\");\nreturn;\n");
    expect(edit).toEqual({ text: "if (ok) {\n    say(\"done\");\n    return;\n}\n", lines: [2], forgiven: true, size: 2 });
  });

  test("a file whose lines end in CRLF keeps them", () => {
    const edit = applyEdit("one\r\ntwo\r\nthree\r\n", "two\nthree", "2\n3");
    expect("text" in edit && edit.text).toBe("one\r\n2\r\n3\r\n");
  });

  test("not found, it says the lines most like it, and when the change may be made already", () => {
    const missing = applyEdit(file, "  return a * b;", "  return a / b;");
    expect("problem" in missing && missing.problem).toBe(`old_string isn't in the file. The lines most like it:\n     1\tfunction add(a, b) {\n     2\t  return a + b;\n     3\t}\n     4\t\nRead the file again and copy old_string from it exactly.`);
    const made = applyEdit(file, "return a + c;", "return a + b;");
    expect("problem" in made && made.problem).toStartWith("old_string isn't in the file (new_string is, at line 2: the change may be made already).");
  });

  test("an empty old_string, or one the same as new_string, changes nothing", () => {
    expect(applyEdit(file, "", "x")).toEqual({ problem: "old_string is empty. To make a file, or replace one whole, use write." });
    expect(applyEdit(file, "add", "add")).toEqual({ problem: "old_string and new_string are the same: nothing would change." });
  });
});

describe("a call, said as a command", () => {
  test("each is said as the shell says it, for your rules and the reviewer", () => {
    const read = step("read", { path: "src/a.ts", offset: 10, limit: 20 });
    expect(read.said).toBe("sed -n '10,29p' 'src/a.ts'");
    expect(readOf(read.said)).toBe("src/a.ts");
    const write = step("write", { path: "src/new.ts", content: "export const x = 1;\n" });
    expect(writesOf(write.said)).toEqual(["src/new.ts"]);
    const edit = step("edit", { path: "src/a.ts", old_string: "a", new_string: "b" });
    expect(edit.said).toBe("edit 'src/a.ts' <<'EOF'\n-a\n+b\nEOF");
    expect(changesOf(edit.said)).toEqual(["src/a.ts"]);
    expect(step("bash", { command: "bun test" }).said).toBe("bun test");
  });

  test("your tripwires see what it changes, and what it writes", () => {
    const rules = [{ name: "no-secrets", on: "command" as const, does: "refuse" as const, words: ["*.env"] }];
    expect(tripOf(rules, step("edit", { path: ".env", old_string: "A=1", new_string: "A=2" }).said)?.rule).toBe("no-secrets");
    expect(tripOf(rules, step("read", { path: "config/.env" }).said)?.rule).toBe("no-secrets");
    const text = [{ name: "no-drop", on: "command" as const, does: "halt" as const, words: [], contains: "DROP TABLE" }];
    expect(tripOf(text, step("write", { path: "m.sql", content: "DROP TABLE users;" }).said)?.does).toBe("halt");
  });

  test("a call that can't be run says why, as its result", () => {
    expect(engineerStep(call("browse", {}), shown)).toEqual({ problem: 'There is no tool "browse": there is bash, read, edit, write.' });
    expect(engineerStep(call("bash", { command: " " }), shown)).toEqual({ problem: "bash needs a command." });
    expect(engineerStep(call("read", { path: "a", offset: 0 }), shown)).toEqual({ problem: "read's offset and limit are whole numbers from 1." });
    expect(engineerStep(call("edit", { path: "a", old_string: "x" }), shown)).toEqual({ problem: "edit needs old_string and new_string." });
    expect(ENGINEER_TOOLS.map((t) => t.name)).toEqual(["bash", "read", "edit", "write"]);
  });

  test("a path that starts with - is a path, never an option", () => {
    expect(step("read", { path: "-n" }).said).toBe("sed -n '1,2000p' './-n'");
  });
});

describe("the commands each runs (bash, in a folder of its own)", () => {
  test("write makes the file and its folders; read numbers its lines and says how many there are", async () => {
    const { dir, exec } = workspace();
    const wrote = await step("write", { path: "src/a b.txt", content: "one\ntwo\nthree\n" }).run(exec, 30);
    expect(wrote.told).toBe("Wrote src/a b.txt: 3 lines, 14 bytes.");
    expect(readFileSync(join(dir, "src/a b.txt"), "utf8")).toBe("one\ntwo\nthree\n");
    const read = await step("read", { path: "src/a b.txt" }).run(exec, 30);
    expect(read.result.exitCode).toBe(0);
    expect(read.told).toBe("src/a b.txt: lines 1–3 of 3\n     1\tone\n     2\ttwo\n     3\tthree");
    const part = await step("read", { path: "src/a b.txt", offset: 2, limit: 1 }).run(exec, 30);
    expect(part.told).toBe("src/a b.txt: lines 2–2 of 3\n     2\ttwo\n(Lines 3–3 aren't shown: read on with offset 3.)");
  });

  test("read says what isn't there, lists a folder, and won't show a binary file", async () => {
    const { dir, exec } = workspace();
    writeFileSync(join(dir, "blob.bin"), Buffer.from([0x50, 0x4b, 0x00, 0x01]));
    const missing = await step("read", { path: "nope.ts" }).run(exec, 30);
    expect([missing.result.exitCode, missing.told]).toEqual([1, "nope.ts: No such file."]);
    const binary = await step("read", { path: "blob.bin" }).run(exec, 30);
    expect([binary.result.exitCode, binary.told]).toEqual([1, "blob.bin: A binary file of 4 bytes: look at it with a command (file, od, xxd)."]);
    const folder = await step("read", { path: "." }).run(exec, 30);
    expect(folder.told).toStartWith(".: a folder\n");
    expect(folder.told).toContain("blob.bin");
  });

  test("edit changes the file in place and shows the lines around the change", async () => {
    const { dir, exec } = workspace();
    writeFileSync(join(dir, "a.ts"), "\uFEFFconst a = 1;\nconst b = 2;\nconst c = 3;\n");
    const edited = await step("edit", { path: "a.ts", old_string: "const b = 2;", new_string: "const b = 20;" }).run(exec, 30);
    expect(edited.result.exitCode).toBe(0);
    expect(edited.told).toBe("Edited a.ts: 1 change, at line 2.\n     1\t\uFEFFconst a = 1;\n     2\tconst b = 20;\n     3\tconst c = 3;\n     4\t");
    // (Its byte-order mark stays where it was.)
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("\uFEFFconst a = 1;\nconst b = 20;\nconst c = 3;\n");
    const missed = await step("edit", { path: "a.ts", old_string: "const d = 4;", new_string: "x" }).run(exec, 30);
    expect(missed.result.exitCode).toBe(1);
    expect(missed.told).toStartWith("a.ts: old_string isn't in the file.");
  });

  test("an edit isn't written over a file that changed after it was read", async () => {
    const { dir, exec } = workspace();
    writeFileSync(join(dir, "a.ts"), "let x = 1;\n");
    let calls = 0;
    const meddled = async (command: string, timeoutSec: number) => {
      const result = await exec(command, timeoutSec);
      if (++calls === 1) writeFileSync(join(dir, "a.ts"), "let x = 99;\n");
      return result;
    };
    const edited = await step("edit", { path: "a.ts", old_string: "let x = 1;", new_string: "let x = 2;" }).run(meddled, 30);
    expect(edited.result.exitCode).toBe(1);
    expect(edited.told).toBe("a.ts was not changed: It changed while it was being edited: read it again.");
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("let x = 99;\n");
  });

  test("a file that isn't UTF-8 text is left for a command to change", async () => {
    const { dir, exec } = workspace();
    writeFileSync(join(dir, "latin.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    const edited = await step("edit", { path: "latin.txt", old_string: "caf", new_string: "tea" }).run(exec, 30);
    expect(edited.told).toBe("latin.txt isn't UTF-8 text: change it with a command.");
  });

  test("a large file goes in several commands, none of them too long for the sandbox, and arrives whole", async () => {
    const { dir, exec, commands } = workspace();
    const content = Array.from({ length: 4_000 }, (_, i) => `line ${i} ${"x".repeat(30)}`).join("\n");
    const wrote = await step("write", { path: "big.txt", content }).run(exec, 30);
    expect(wrote.result.exitCode).toBe(0);
    expect(readFileSync(join(dir, "big.txt"), "utf8")).toBe(content);
    expect(commands.length).toBeGreaterThan(3);
    expect(Math.max(...commands.map((c) => c.length))).toBeLessThan(100_000);
    const edited = await step("edit", { path: "big.txt", old_string: "line 3999 ", new_string: "last line " }).run(exec, 30);
    expect(edited.result.exitCode).toBe(0);
    expect(readFileSync(join(dir, "big.txt"), "utf8")).toBe(content.replace("line 3999 ", "last line "));
  });
});

test("a long input is kept short in the conversation once it has run", () => {
  const content = "y".repeat(50_000);
  const kept = keptInput({ path: "a.txt", content });
  expect(kept?.path).toBe("a.txt");
  expect(String(kept?.content)).toHaveLength(12_000 + 4_000 + "\n… [34,000 characters cut here: the tool had them all] …\n".length);
  expect(keptInput({ path: "a.txt", content: "short" })).toBeNull();
});
