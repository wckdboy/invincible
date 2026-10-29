---
name: safe-refactor
description: Change structure without changing externally observable behavior. Use for extracting modules, renaming internals, splitting functions, removing duplication, or reorganizing code where tests and contracts must stay green.
---

# Safe refactor

Refactoring is behavior-preserving by definition. If observable behavior changes, it is a feature or
a migration and needs its own contract update.

## Activate when

- Extracting or moving code, renaming internal symbols, simplifying control flow, or removing
  duplication.
- Preparing a module for a feature without changing its current outputs.
- A change is mostly mechanical but spans many files.

## Inputs and assumptions

- A green baseline on the relevant tests, or a documented list of pre-existing failures.
- Known public contracts: API, CLI, serialization, errors, exit codes, logging, performance.
- A way to compare old and new behavior (tests, golden files, differential run).

## Outputs

- A sequence of small, reversible commits or patches.
- Identical results for the contract tests and characterization tests.
- A diff review showing no unintended behavior edits.
- Performance comparison when the refactor touches a hot path.

## Permissions and restrictions

Stay inside the named module. Do not reformat unrelated files, upgrade dependencies, change public
signatures, or "fix" nearby bugs in the same change. Do not delete characterization tests because the
new structure makes them inconvenient.

## Workflow

1. Establish the baseline: fast checks plus the tests that cover the target behavior. Record them.
2. Identify the externally observable surface and freeze it with tests/golden outputs if coverage is
   thin.
3. Make one mechanical step at a time: move, rename, extract, inline. Keep each step reviewable.
4. After each step, run the narrow tests and a compiler/type check. Stop at the first unexplained
   change.
5. Use `git diff --stat` and `git diff -w` to separate whitespace noise from semantic edits.
6. If a public symbol must move, update all consumers and the contract in the same change, or add a
   deprecation shim only when policy requires compatibility.
7. Run the required full gate at the end. Compare performance if the path is sensitive.

## Verification

- Contract and characterization tests produce identical results before and after.
- No public signature, serialized field, error text or default changed unintentionally.
- The diff contains no unrelated edits; `git diff -w` is smaller than the raw diff only for
  whitespace, not hidden logic.
- Fast and full profiles pass; skipped checks are listed.

## Failure and escalation

- Baseline is red: fix or document the pre-existing failure first; do not refactor on an unknown
  base.
- A "pure" refactor changes output: stop, treat it as a behavior change, and get explicit approval.
- The refactor reveals a security or correctness bug: record it, do not silently expand scope; open a
  separate change.
- Merge conflicts during a parallel refactor: rebase the smallest unit, re-run verification, and
  never resolve by discarding the other owner's work.

## Done when

Behavior is demonstrably unchanged for the covered contracts, the change is split into reviewable
steps, the required gate passes, and any newly discovered issue is recorded separately.
