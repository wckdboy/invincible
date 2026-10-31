# Change lifecycle

This is the shared lifecycle for every nontrivial task. Repository policy (`AGENTS.md`) and
`.agents/engineering.json` override anything here. Skills add only their specialization.

## A. Understand

- Restate the requested behavior and acceptance criteria. Separate must-haves from preferences.
- Locate the symbols, modules, tests and contracts involved. Prefer `eng detect`, `eng impact`,
  targeted `rg`, and compiler/LSP results over reading the whole repository.
- Identify behavior that must be preserved, including error text, exit codes, file formats,
  ordering, defaults and performance characteristics.
- List likely downstream consumers. Treat generated code and dynamic references as unknown until
  checked.
- State observed facts and inferred assumptions separately; put a path or command beside each fact.

## B. Plan

- Choose the smallest independently verifiable change. Prefer one reviewable unit over a broad
  rewrite.
- Name the tests and checks that will prove it, including the regression case for a bug.
- Assess security and compatibility risk. Escalate public contracts, persistence, auth, build and
  dependency changes.
- Decide whether work can be parallelized. Independent units get separate worktrees and owners.
- Record the rollback: revert commit, feature flag, or restore procedure.

## C. Baseline

- Run the relevant existing checks before editing. `eng verify --profile fast` is the default.
- Record pre-existing failures separately. Never attribute an existing failure to the new change.
- Add a characterization or regression test when behavior is not already covered.
- For performance-sensitive work, record a reproducible baseline before optimizing.

## D. Implement

- Stay inside the permitted module boundaries. Do not refactor unrelated code.
- Follow local naming, formatting, typing and dependency rules. Do not add a dependency for a
  one-off convenience.
- Preserve documented contracts unless the task explicitly changes them. If it does, update the
  contract, its fixtures and its consumers in the same change.
- Keep the diff reversible. Avoid mixing formatting-only edits with behavior changes.

## E. Verify

- `eng verify --profile fast` for every change; `--profile full` for shared interfaces, security
  boundaries, persistence, build/CI, releases, or when in doubt.
- Run the narrowest relevant tests first, then the broader suite. A green unrelated suite is not
  evidence for a targeted change.
- For a bug fix, demonstrate the new test fails on the pre-fix revision and passes after.
- Review `git diff` for accidental edits, secrets, debug output and generated files.
- Record skipped or unavailable checks. Never report them as passed.

## F. Report

Include: change summary, requirements satisfied, commands actually run with results, tests that
failed or were skipped, security considerations, performance effect, unverified behavior, and
residual risk. Link the evidence record (`eng evidence list`). A model's self-assessment is not a
verification result.
