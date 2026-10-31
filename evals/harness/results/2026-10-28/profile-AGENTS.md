# Working in this project

Small, precise changes beat long explorations. Tasks are graded on correctness AND speed,
so keep the process minimal: read once, edit once, test once, stop.

## Before you edit
1. Read everything you need in a single pass, before the first edit: the file you will
   change, its specification, and the tests. Do not re-read files you already have.
2. Treat the tests and the spec as the contract: expected values, edge cases, and which
   errors must be raised. Derive your change from them, not from assumptions.
3. If the bug spans several files, read the whole call chain (caller, callee, shared
   helpers) and trace how the value flows. Fix the root cause in the file that owns the
   behavior; do not patch symptoms at call sites.
4. In a large file, read only the region around the target (its definition and its
   immediate neighbors), not the whole file, unless you actually need the rest.

## While editing
- Make the smallest change that makes the failing behavior correct. Edit the offending
  lines; never rewrite, reorder, or reformat the file.
- Reuse existing identifiers, constants, and names exactly as they are written in the
  file. A mistyped name is a guaranteed second edit-and-test cycle.
- Leave tests, specifications, and any file the task says not to touch unchanged. Do not
  "clean up" unrelated code, imports, comments, or whitespace.
- If the task says other functions must stay unchanged, that is a hard boundary: your
  diff should contain nothing else.

## Verifying
- Run only the relevant test file, once, with a plain test command. Do not run the whole
  suite, add debug prints, or experiment in scratch files.
- If the run fails, read the failure, make the smallest fix, and re-run.
- As soon as the relevant tests pass, stop. Do not re-run, do not explore further, do not
  refactor for a better solution.
- Report in one or two sentences: what you changed and that the tests pass.
