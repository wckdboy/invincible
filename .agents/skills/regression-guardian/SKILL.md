---
name: regression-guardian
description: Preserve existing behavior while changing code. Use for bug fixes, refactors, dependency upgrades, and any change where a regression test or characterization test is needed; also use when a fix must be proven to address the reported failure.
---

# Regression guardian

Make the failure reproducible and the fix provable. A test that passes after the fix but was never
seen failing is weak evidence; prefer a red-then-green demonstration.

## Activate when

- Fixing a reported bug or crash.
- Changing behavior that existing tests do not cover.
- Refactoring or upgrading a dependency where output must stay identical.
- A reviewer asks "what stops this from happening again?"

## Inputs and assumptions

- The failing input, stack trace, issue, or a description sufficient to reproduce.
- A revision before the fix (the current `HEAD` or a worktree) and after the fix.
- Test framework and commands from `AGENTS.md` / `.agents/engineering.json`.

## Outputs

- A minimal reproduction or characterization test committed with the fix.
- Evidence that the test fails on the pre-fix revision and passes on the fixed revision.
- The targeted suite result and the required broader gate result.
- Any behavior intentionally changed, with its contract update.

## Permissions and restrictions

Do not delete, skip, quarantine or weaken existing tests to get green. Do not change expected values
unless the task explicitly changes the behavior. Temporary local experiments are fine; they must not
be committed. Production data and credentials are out of scope.

## Workflow

1. Reproduce with the smallest input. Record the command, exit code and relevant output.
2. Add the regression test in the existing test file for that area. Use the project's naming and
   fixture style; avoid a new file named after the issue unless policy says otherwise.
3. Run the test against the unfixed revision. Use `git stash`/a worktree, not a hand-edited
   expectation, to prove it fails for the reported reason.
4. Implement the smallest fix. Do not combine it with a refactor.
5. Run the new test, the neighboring tests, then the fast profile and the required full gate.
6. Re-run the original reproduction. Confirm the failure mode is gone, not merely hidden.
7. Record the before/after evidence in the final report.

## Verification

- The regression test fails on the pre-fix revision with the expected assertion/error.
- It passes on the post-fix revision.
- The failure is not masked by a broad `catch`, a timeout, a retry, or a skipped test.
- `eng verify --profile fast` passes; full gate passes for shared or risky surfaces.
- No existing test was removed or weakened without an explicit contract change.

## Failure and escalation

- Cannot reproduce: gather the exact version, platform, input and environment; ask for a trace or
  artifact. Do not write a speculative fix.
- Test is flaky: record the failure rate under repetition, fix or quarantine with an owner and a
  tracking issue; never call one green run proof.
- Pre-existing suite failure: record it separately; do not fix unrelated failures silently.
- The bug is security-sensitive: stop and load `security-auditor`; do not publish exploit details
  in a public issue.

## Done when

The regression test exists, was observed failing before the fix and passing after, the relevant
suites pass, and the evidence record is linked.
