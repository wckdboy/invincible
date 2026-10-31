---
name: release-verifier
description: Validate release readiness before publishing or tagging. Use when preparing a version, artifact, app build, package or deployment; when checking provenance, signatures, compatibility, security findings, rollback and final evidence.
---

# Release verifier

A release is a claim that a specific artifact is fit to ship. Verify the artifact, not the branch
you remember testing. Shipping requires human approval; this skill prepares the evidence.

## Activate when

- Preparing a tag, package, binary, container, app build or deployment.
- A release checklist or signing/provenance step is required.
- A rollback plan must be validated before a production change.

## Inputs and assumptions

- The exact revision and artifact digest to release.
- The release policy: versioning, changelog, signing, provenance, supported platforms, compatibility
  window, approval owners.
- Credentials for signing/publishing must be injected at runtime; none are read from the repository.

## Outputs

- A release evidence bundle: revision, artifact hashes, full-gate result, security result, SBOM or
  dependency inventory where available, signature/provenance status, compatibility results.
- A changelog and version check consistent with the artifact.
- A tested rollback procedure and an owner.
- An explicit list of unverified items and residual risks.

## Permissions and restrictions

Do not publish, tag, sign, deploy or rotate credentials without explicit human approval. Do not
release from a dirty tree or an unverified artifact. Do not skip a failed check to meet a date; do not
edit the changelog to hide a breaking change. Never commit signing keys or tokens.

## Workflow

1. Freeze the candidate: exact commit, clean tree (or documented dirty build), artifact digest.
2. Run `./.agents/bin/eng verify --profile full --ci`. Confirm the evidence record is for the
   candidate revision, not an earlier one.
3. Run `./.agents/bin/eng release-check --version <v> --artifact <path> --notes <file> --rollback <file>`.
   It refuses a dirty tree, missing version/notes/rollback, or evidence for another HEAD.
4. Verify the version, changelog, compatibility notes and migration steps. Check that generated
   artifacts match their source.
5. Check security: required scanners ran, findings are resolved or explicitly accepted by the owner,
   dependency/license policy is satisfied.
6. Verify artifact integrity and provenance: hashes, signatures, SBOM, reproducible build or
   attestation. Record what is unavailable.
7. Test the rollback on a copy or staging environment; record the command and expected state.
8. Obtain human approval for the publish/deploy step. Publish through the approved channel.
9. After publishing, verify the public artifact hash/signature and a smoke test. Record the result.

## Verification

- Evidence is bound to the released digest, not just a branch name.
- All required checks pass; skipped/blocked checks are listed and accepted explicitly.
- Version and changelog match the artifact.
- Signing/provenance verified with the project's public key/policy where available.
- Rollback was exercised, not merely described.
- Public artifact re-downloaded and hash-checked after upload.

## Failure and escalation

- Dirty tree or mismatched digest: stop; rebuild from the tagged revision.
- Required check blocked: do not release; report the blocker and owner.
- Security finding unresolved: stop; require an explicit risk acceptance from the owner.
- Signing key or credential unavailable: stop; do not substitute an unsigned artifact silently.
- Post-publish verification fails: trigger rollback, preserve evidence, notify the owner.

## Done when

The exact artifact is identified and hashed, the full gate and security checks have evidence, the
changelog/version/compatibility are consistent, rollback is tested, human approval is recorded, and
remaining risks are stated.
