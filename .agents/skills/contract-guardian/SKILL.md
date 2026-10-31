---
name: contract-guardian
description: Protect public APIs, ABIs, schemas, serialization formats, protocols, CLI behavior and migration invariants. Use when a change alters an interface consumers depend on, when adding a schema migration, or when compatibility must be proven with fixtures.
---

# Contract guardian

A contract is anything an external consumer can observe: function signatures, HTTP routes, CLI
flags and output, exit codes, JSON fields, file formats, database schemas, events, ABIs and error
semantics. Protect it explicitly.

## Activate when

- Changing a public API, exported symbol, ABI, wire protocol, event, schema or file format.
- Adding or altering a database migration, index or persisted field.
- Changing CLI flags, defaults, output, exit codes or environment variables.
- A dependency upgrade changes a shared type or serialization behavior.

## Inputs and assumptions

- The contract's owner, versioning policy and compatibility window (from `AGENTS.md`, docs, or the
  maintainer).
- Existing fixtures, golden files, generated clients or consumer tests.
- A migration/rollback path for persisted data.

## Outputs

- A contract inventory: what changed, who consumes it, compatibility classification (compatible,
  conditionally compatible, breaking).
- Old/new fixtures or golden outputs that prove the behavior.
- A migration plan with forward and rollback steps.
- Updated docs, changelog and versioning when the policy requires it.

## Permissions and restrictions

Do not silently break a contract, remove a field, change a default, or tighten validation without an
explicit decision and a migration path. Do not regenerate golden files to make a failing test pass
unless the behavior change is intended and reviewed. Do not edit consumer-owned code without
coordination.

## Workflow

1. Find the authoritative contract definition and its consumers. Use `eng impact`; then confirm with
   the compiler, schema registry, generated client or API docs.
2. Classify the change: additive and optional; behavior-preserving; breaking. Check the repository's
   versioning policy before choosing.
3. Add or update fixtures: one payload/input from the previous version, one from the new version.
   Test both directions where the protocol allows it.
4. For persisted data, write the migration and a rollback. Test on a copy, including a partially
   migrated state.
5. Update the contract source of truth (schema, OpenAPI, docs) and all generated artifacts with the
   documented command.
6. Run compatibility tests, the relevant integration tests, and the full gate.
7. If breaking, require explicit approval; provide a deprecation window and a consumer migration
   guide.

## Verification

- Old-version fixtures still parse/execute where compatibility is promised.
- New-version fixtures round-trip; unknown fields are handled per policy.
- Generated code is reproducible from the checked-in source of truth.
- Migration forward and rollback both tested; data invariants checked.
- The full gate passes; the evidence record lists compatibility checks.

## Failure and escalation

- No owner or compatibility policy: stop and ask; do not infer "nobody uses it".
- A consumer cannot be updated in the same change: use a versioned endpoint/field or a deprecation
  period; coordinate the rollout.
- Migration is irreversible: require a backup/restore plan and explicit approval.
- Golden output changes unexpectedly: treat as a regression until proven intentional.

## Done when

The change is classified, fixtures prove compatibility, migrations have a tested rollback, docs and
generated artifacts are updated, and the required gate passes with evidence.
