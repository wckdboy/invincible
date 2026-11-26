import { describe, expect, test } from "bun:test";
import { changesOf, checkOf, contentsOf, readOf, readsOf, testFilesOf, writesOf } from "../src/shell-paths.ts";

describe("which test files a gate names", () => {
  test("a file by a test's name, or a file in a tests folder, is one", () => {
    for (const [command, paths] of [
      ["bun test src/sum.test.ts", ["src/sum.test.ts"]],
      ["npx vitest run ./src/a.spec.tsx src/b.test.js", ["src/a.spec.tsx", "src/b.test.js"]],
      ["python3 -m pytest tests/test_parse.py -q", ["tests/test_parse.py"]],
      ["go test ./... && node test/check.mjs", ["test/check.mjs"]],
      ["cargo test --test integration && cat __tests__/x.json", ["__tests__/x.json"]],
    ] as const) expect(testFilesOf(command), command).toEqual([...paths]);
  });

  test("a gate that names no test file locks nothing: a bare test run, a folder, a pattern", () => {
    for (const command of ["bun test", "npm test", "pytest tests", "go test ./...", "bun test src/*.test.ts", "make check", "test -f out.txt"]) expect(testFilesOf(command), command).toEqual([]);
  });
});

describe("which file a command shows", () => {
  test("a plain read of one file names it", () => {
    for (const [command, path] of [
      ["cat src/x.ts", "src/x.ts"],
      ["cat -n ./src/x.ts", "src/x.ts"],
      ["head -n 40 src/x.ts", "src/x.ts"],
      ["head -40 src/x.ts", "src/x.ts"],
      ["tail -n 20 'src/my file.ts'", "src/my file.ts"],
      ["sed -n '1,80p' src/x.ts", "src/x.ts"],
      ["sed -n \"10,20p\" src/x.ts", "src/x.ts"],
      ["nl -ba src/x.ts", "src/x.ts"],
    ] as const) expect(readOf(command)).toBe(path);
  });

  test("anything more than one plain read names nothing: what it showed may not be the file", () => {
    for (const command of [
      "cat src/x.ts | grep foo",
      "cat src/a.ts src/b.ts",
      "cat src/x.ts && bun test",
      "cat $(ls src | head -1)",
      "cat src/*.ts",
      "sed 's/a/b/' src/x.ts",
      "sed -n '1,10p' src/a.ts src/b.ts",
      "head -n",
      "cat",
      "grep -n foo src/x.ts",
      "cat <<'EOF'\nhello\nEOF",
    ]) expect(readOf(command)).toBeNull();
  });
});

describe("which files a command only shows (keep-reads)", () => {
  test("a command made only of showings is a read, with the files it shows: the ways a knight reads code", () => {
    for (const [command, files] of [
      ["cat src/a.ts", ["src/a.ts"]],
      ["cd /work/tasks/t && awk 'NR>=75 && NR<=122 {printf \"%d\\t%s\\n\", NR, $0}' packages/node/test/ci-watch.test.ts && echo \"=====CI-BACK=====\" && sed -n '1,72p' packages/node/src/ci-back.ts", ["packages/node/test/ci-watch.test.ts", "packages/node/src/ci-back.ts"]],
      ["grep -rn \"CI_FIXES\" packages/node/src packages/core/src | head -40", ["packages/node/src", "packages/core/src"]],
      ["sed -n '215,250p' packages/node/src/ci-watch.ts; echo; sed -n '725,742p' packages/node/src/daemon.ts", ["packages/node/src/ci-watch.ts", "packages/node/src/daemon.ts"]],
      ["git show HEAD:src/a.ts && git diff -- src/b.ts", ["src/b.ts"]],
      ["ls -la && pwd && wc -l src/a.ts 2>/dev/null", ["src/a.ts"]],
    ] as const) expect(readsOf(command), command).toEqual([...files]);
  });

  test("anything that might change something, or that can't be read for certain, is no read", () => {
    for (const command of [
      "sed -i 's/a/b/' src/a.ts",
      "cat src/a.ts > src/b.ts",
      "cat > src/new.ts <<'EOF'\nexport const x = 1;\nEOF",
      "awk '{print > \"out.txt\"}' src/a.ts",
      "awk 'BEGIN { system(\"rm -rf x\") }'",
      "bun test packages/node/test/ci-back.test.ts",
      "python3 edit.py",
      "find . -name '*.tmp' -delete",
      "git checkout -- src/a.ts",
      "cat $FILE",
      "sort -o out.txt in.txt",
      "uniq in.txt out.txt",
    ]) expect(readsOf(command), command).toBeNull();
  });
});

describe("what a command may have changed, for what was read before it (keep-reads)", () => {
  test("a showing or a run of the project's checks changes nothing; an edit, the files it names; anything else, anything", () => {
    expect(changesOf("cd /work/t && sed -n '1,40p' src/a.ts")).toBe("nothing");
    expect(changesOf("cd /work/t && bun test packages/node/test/ci-back.test.ts")).toBe("nothing");
    expect(changesOf("bun install --frozen-lockfile >/dev/null 2>&1; bun run typecheck")).toBe("anything");
    expect(changesOf("sed -i 's/a/b/' src/a.ts")).toEqual(["src/a.ts"]);
    expect(changesOf("cd /work/t && cat > packages/node/test/new.test.ts <<'EOF'\ntest(\"x\", () => {});\nEOF")).toEqual(["packages/node/test/new.test.ts"]);
    expect(changesOf("python3 - <<'EOF'\nopen('src/a.ts','w').write('x')\nEOF")).toEqual(["src/a.ts"]);
    expect(changesOf("sed -i 's/a/b/' src/a.ts && bun x prettier --write src")).toBe("anything");
  });

  test("an inline python3 script changes only the files it names, when all it does is read and write them: the way a knight edits", () => {
    // As the first real outcome's knight edited (19 November 2026).
    const knight = `cd /work/tasks/task-exr0arcdv_4o && python3 - <<'PY'
import re, pathlib

def sub(path, old, new, count=1):
    p = pathlib.Path(path)
    s = p.read_text()
    assert old in s, f"NOT FOUND in {path}: {old[:80]}"
    p.write_text(s.replace(old, new, count))

# 1. core team.ts: conflict marker on a fix
sub("packages/core/src/team.ts",
\"\"\"  /** The review it answers, by its id (absent: it fixes failing checks). */
  review?: number;
}\"\"\",
\"\"\"  review?: number;
}\"\"\")
sub("packages/node/src/ci-watch.ts", 'import type { CiFailure } from "./ci-watch.ts";', 'x')
PY`;
    expect(changesOf(knight)).toEqual(["packages/core/src/team.ts", "packages/node/src/ci-watch.ts"]);
    expect(changesOf(`python3 -c 'import pathlib; pathlib.Path("src/a.ts").write_text("x")'`)).toEqual(["src/a.ts"]);
    // One that only reads changes nothing.
    expect(changesOf(`python3 -c 'print(open("src/a.ts").read()[:400])'`)).toBe("nothing");
  });

  test("a python3 script that may run or find something by itself, or name a path it builds, may have changed anything", () => {
    for (const command of [
      "python3 - <<'PY'\nimport subprocess\nsubprocess.run(['bun', 'x', 'prettier', '--write', '.'])\nPY",
      "python3 - <<'PY'\nimport glob\nfor f in glob.glob('src/*.ts'): open(f, 'a').write('')\nPY",
      "python3 - <<'PY'\nimport os\nos.remove('src/a.ts')\nPY",
      "python3 - <<'PY'\nopen(f'src/{name}.ts', 'w').write('x')\nPY",
      "python3 - <<'PY'\nimport sys\nopen(sys.argv[1], 'w').write('x')\nPY",
      // The shell fills in what an unquoted here-document's end lets it.
      "python3 - <<PY\nopen('$FILE', 'w').write('x')\nPY",
      // A script from a file is read by nobody here.
      "python3 edit.py",
      "python3 - <<'PY' > out.txt\nprint(1)\nPY",
    ]) expect(changesOf(command), command).toBe("anything");
  });
});

describe("which files' contents a command shows (keep-reads shows them whole)", () => {
  test("cat, nl, head, tail, sed -n and awk, with cd, echo and printf between, and pipes through them", () => {
    for (const [command, files] of [
      ["cat -n packages/node/src/ci-back.ts", ["packages/node/src/ci-back.ts"]],
      ["cd /work/t && sed -n '1,160p' a.ts && echo --- && awk 'NR<9' b.ts", ["a.ts", "b.ts"]],
      ["cat a.ts | head -50", ["a.ts"]],
      ["nl -ba src/x.ts | tail -n 40", ["src/x.ts"]],
    ] as const) expect(contentsOf(command), command).toEqual([...files]);
  });

  test("a search, a listing, a log or anything that might change something shows no file to read whole", () => {
    for (const command of ["grep -rn x packages", "cat a.ts | grep x", "git show HEAD:a.ts", "ls src", "find . -name '*.ts'", "cat a.ts > b.ts", "sed -i 's/a/b/' a.ts", "bun test"]) expect(contentsOf(command), command).toBeNull();
  });
});

describe("which files a command changes", () => {
  test("redirects, in-place edits, tee, moves, copies, removals and restores", () => {
    for (const [command, paths] of [
      ["printf 'x\\n' > src/x.ts", ["src/x.ts"]],
      ["echo y >> ./src/x.ts", ["src/x.ts"]],
      ["cat > src/x.ts <<'EOF'\nexport const a = 1;\nEOF", ["src/x.ts"]],
      ["sed -i 's/a/b/' src/x.ts", ["src/x.ts"]],
      ["sed -i.bak -e 's/a/b/' -e 's/c/d/' src/x.ts src/y.ts", ["src/x.ts", "src/y.ts"]],
      ["sed -i '' 's/a/b/' src/x.ts", ["src/x.ts"]],
      ["bun run gen | tee src/out.json", ["src/out.json"]],
      ["mv src/old.ts src/new.ts", ["src/old.ts", "src/new.ts"]],
      ["cp src/a.ts src/b.ts", ["src/b.ts"]],
      ["rm -f src/x.ts", ["src/x.ts"]],
      ["git checkout -- src/x.ts", ["src/x.ts"]],
      ["git restore src/x.ts", ["src/x.ts"]],
      ["cd src && sed -i 's/a/b/' x.ts && bun test", ["x.ts"]],
      ["bun test 2> err.log", ["err.log"]],
    ] as const) expect(writesOf(command), command).toEqual([...paths]);
  });

  test("a here-string is one line, not a here-document: the lines after it are commands", () => {
    expect(writesOf("grep -c x <<< 'ab'\nprintf y > out.txt")).toEqual(["out.txt"]);
    expect(testFilesOf("wc -w <<< hello\nbun test src/sum.test.ts")).toEqual(["src/sum.test.ts"]);
  });

  test("reads, tests and searches change nothing", () => {
    for (const command of ["cat src/x.ts", "bun test", "grep -rn foo src", "sed -n '1,5p' src/x.ts", "ls -la", "echo '> not a redirect'", "git diff -- src/x.ts"]) expect(writesOf(command), command).toEqual([]);
  });
});

describe("the check a command runs", () => {
  test("a test run, a typecheck, a lint or a build, wherever it runs and however its output is piped: its program and what it names", () => {
    expect(checkOf("cd /work/tasks/t-1 && bun test packages/node/test/ci-watch.test.ts 2>&1 | tail -80")).toEqual({ program: "bun test", targets: ["packages/node/test/ci-watch.test.ts"] });
    expect(checkOf("bunx tsc --noEmit 2>&1 | head -40")).toEqual({ program: "bunx tsc", targets: [] });
    expect(checkOf("CI=1 npm run lint -- --fix; echo EXIT=$?")).toEqual({ program: "npm run lint", targets: [] });
    expect(checkOf("python3 -m pytest tests/test_api.py -q > /tmp/out.txt")).toEqual({ program: "python3 -m pytest", targets: ["tests/test_api.py"] });
    expect(checkOf("cargo test --workspace")).toEqual({ program: "cargo test", targets: [] });
  });

  test("anything else is no check: a read, a search, an edit, a script", () => {
    for (const command of ["cat src/a.ts", "grep -rn x src", "sed -i 's/a/b/' x.ts", "echo bun test", "python3 - <<'PY'\nprint(1)\nPY", "bun install"]) expect([command, checkOf(command)]).toEqual([command, null]);
  });
});
