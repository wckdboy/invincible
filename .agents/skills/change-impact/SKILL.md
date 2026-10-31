---
name: change-impact
description: Estimate the blast radius of a proposed or in-progress change before implementation or review. Use when touching shared symbols, public interfaces, schemas, persistence, configuration or dependency manifests, and when deciding which tests and consumers must be checked.
---

# Change impact

Estimate affected components and required verification. The analysis is textual and heuristic;
treat it as a checklist to confirm, not proof of completeness.

## Activate when

- Planning a change to a symbol, type, CLI flag, schema, file format, config key or dependency.
- Reviewing a diff for downstream effects.
- Choosing the minimum test set for a change.
- A public API, ABI, migration or serialization format may change.

## Inputs and assumptions

- A git revision range or working-tree change. Default base is `HEAD` (uncommitted work); for a
  branch use `origin/main` or the merge base.
- The build graph may be richer than text search. Dynamic dispatch, reflection, generated code and
  external consumers are not fully visible.

## Outputs

- Changed files and the symbols they define.
- Reference sites per symbol, with test files marked.
- Likely tests and contract surfaces.
- Risk flags: public interface, schema/wire format, security-sensitive path, dependency/build
  change.
- A verification plan: targeted tests first, then the required gate.

## Permissions and restrictions

Read-only. Do not edit code or tests while analyzing. Do not claim a consumer is unaffected because
a text search found no reference.

## Workflow

1. Confirm the baseline: `./.agents/bin/eng verify --profile fast` or the repository's documented
   fast command. Record pre-existing failures.
2. Run `./.agents/bin/eng impact --base <ref>` (add `--json` for a record). Read the caveat.
3. For each changed symbol, confirm the reference list with `rg -n -w <symbol>` or the compiler/LSP.
   Read at least one non-test consumer and one test consumer.
4. Check the contract surfaces: serialized fields, CLI output, exit codes, HTTP routes, database
   columns, file formats, ABI, feature flags and defaults.
5. Check generated artifacts and vendored copies; regenerate them with the documented command.
6. Select verification: narrow tests for each affected symbol, integration tests for consumers,
   compatibility fixtures for contracts, benchmark for hot paths.
7. State what remains unknown (dynamic callers, external clients, production data).

## Verification

- Every affected module has a cited reference or an explicit "no reference found; confirm
  dynamically".
- The chosen commands come from repository policy, not invention.
- For a contract change, at least one old-format fixture and one new-format fixture are tested.
- The plan distinguishes required checks from optional/advisory ones.

## Failure and escalation

- No git history: ask for a diff or base revision; do not guess.
- `eng impact` extracts no symbols for the language: identify symbols manually with the compiler or
  LSP and say the tool was insufficient.
- A change touches auth, payments, persistence, cryptography, build signing or public API:
  escalate to `security-auditor` or `contract-guardian` before editing.
- Reference search is truncated: narrow by module and re-run; report the limit.

## Done when

Changed symbols, consumers, contract surfaces, risk flags, targeted tests and unknowns are listed;
the minimum safe verification set is justified; no files were modified.
