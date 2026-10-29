# eng — repository engineering controls

This directory is a self-contained copy of the `eng` kit. It gives an agent, a human and CI the
same answers about what to run, what changed, what was verified, and what remains unverified.

It is deliberately small: Python standard library plus git, with optional external scanners. It does
not run a background service, require a database, or call a model.

## Layout

```text
.agents/
  bin/eng                 entry point
  lib/eng.py              one dependency-free CLI
  skills/                 ten task skills (SKILL.md)
  references/             lifecycle, evidence and trust policy
  config/                 semgrep, gitleaks and guard allowlist
  hooks/                  pre-commit and pre-push
  ci/                     standalone workflow template
  engineering.json        this repository's authoritative commands
  evidence/               hash-chained run records (gitignored)
```

`AGENTS.md` remains the repository's policy. `engineering.json` holds commands; this file explains
the generic workflow. Do not duplicate the same rule in three places.

## Daily loop

1. **Map** — `./.agents/bin/eng detect` and read `AGENTS.md`.
2. **Impact** — `./.agents/bin/eng impact --base origin/main` before editing shared code.
3. **Baseline** — `./.agents/bin/eng verify --profile fast`; record pre-existing failures.
4. **Isolate** — `./.agents/bin/eng worktree create <task>` for parallel or risky work.
5. **Implement** — smallest reversible change; add the regression test.
6. **Verify** — fast profile, targeted tests, then full profile for risky surfaces.
7. **Report** — commands run, results, skips, residual risk, evidence id.

## Commands

| Command | Purpose |
| --- | --- |
| `eng detect [--json]` | Stacks, manifests, modules, tests, CI, interfaces, ownership. |
| `eng init [--force] [--hooks] [--ci]` | Write config, AGENTS section, harness links, hooks, CI. |
| `eng verify --profile fast` | Run configured fast commands; write evidence. |
| `eng verify --profile full` | Fast/full commands + required security scans. |
| `eng impact --base <ref>` | Changed files, symbols, references, likely tests, contracts. |
| `eng security [--json] [--require]` | gitleaks, semgrep, OSV, actionlint, zizmor when installed. |
| `eng audit-actions` | Require every `uses:` to be a 40-hex commit SHA (or a reviewed exception). |
| `eng artifact <paths...>` | SHA-256 and size for release artifacts. |
| `eng release-check ...` | Require clean HEAD, passing full evidence, version, notes, rollback and artifacts; write release evidence. |
| `eng guard staged` | Pre-commit guard: secrets, conflict markers, sensitive/large files. |
| `eng worktree create/list/remove` | Isolated `.worktrees/<name>` with an owner record. |
| `eng evidence verify/list/show` | Recompute hashes and check the evidence chain. |
| `eng doctor [--json]` | Tool and repository readiness. |

`--json` works before or after the subcommand. `--root <path>` selects another repository.

## Skills

| Skill | Use |
| --- | --- |
| `repo-intelligence` | Map an unfamiliar repository with evidence. |
| `change-impact` | Estimate blast radius and required verification. |
| `regression-guardian` | Red-then-green regression tests. |
| `security-auditor` | Threat model, scanners, findings, remediation. |
| `safe-refactor` | Behavior-preserving structural change. |
| `parallel-executor` | Isolated units, ownership, sequential integration. |
| `performance-engineer` | Baseline, profile, measure, detect regressions. |
| `contract-guardian` | APIs, schemas, formats, migrations. |
| `failure-investigator` | Reproduce, root-cause, permanent guard. |
| `release-verifier` | Artifact-bound release evidence and rollback. |

Skills activate from their frontmatter description. They are task-specific; repository rules stay in
`AGENTS.md`.

## Evidence

Every `verify` writes `.agents/evidence/<id>.json` plus logs under `<id>/`. The JSON records exact
commands, exit codes, durations, output hashes, git state, config hash, scanner versions and the
verdict. Each record is linked to the previous one by hash.

```sh
./.agents/bin/eng evidence verify   # integrity and chain
./.agents/bin/eng evidence list
./.agents/bin/eng evidence show <id>
```

Evidence is local and gitignored; CI uploads it. Never edit a record to change a verdict. A check
that did not run is `skipped` or `blocked`, never `pass`. See `references/evidence.md`.

## Worktrees and parallelism

```sh
./.agents/bin/eng worktree create api-fix --owner agent-a
./.agents/bin/eng worktree list
./.agents/bin/eng worktree remove api-fix
```

The CLI refuses a dirty tree by default (uncommitted changes are not copied), refuses duplicate
names/branches, enforces `parallel.max_worktrees`, and refuses to remove a dirty worktree without
`--force`. Integration is sequential; re-run the full gate on the latest target revision.

## Release checks

```sh
./.agents/bin/eng artifact dist/app.tar.gz --json
./.agents/bin/eng release-check \
  --version 1.2.3 \
  --artifact dist/app.tar.gz \
  --notes notes/1.2.3.md \
  --rollback docs/rollback-1.2.3.md
```

The check refuses a dirty tree, a version absent from `CHANGELOG.md`, missing notes or rollback, a
missing artifact, or a full evidence record that is not for the current HEAD. On success it writes a
hash-chained release record containing the artifact digest and the evidence it relied on. It does
not publish, sign or deploy; human approval remains required. `--require-sbom` and `--sbom`,
`--signature`, `--provenance` record optional artifact material.

## Security

- `gitleaks` scans tracked files only (a hard-linked tree), so build output and evidence logs are not
  scanned. History scanning is opt-in (`security.gitleaks_history`).
- `semgrep` uses the high-signal rules in `.agents/config/semgrep.yml`; add a test with every rule.
- `osv-scanner` needs a lockfile; "no package sources" is reported as skipped, not pass.
- `actionlint` checks `.github/workflows`. `zizmor` is used when installed.
- The pre-commit guard is a narrow, offline backstop — not a replacement for the scanners.
- Missing required scanners make a full run `blocked`; they are never silently skipped.

## CI

`.agents/ci/agent-verify.yml` is a standalone template. It installs pinned scanner versions, runs
`eng verify --profile full --ci`, and uploads evidence. Repositories with an existing workflow should
add the verify step after their toolchain setup instead of replacing working CI. Actions are pinned
to commit SHAs in the template; update them deliberately.

## Harnesses

- Claude Code: `.claude/skills` symlinks to `.agents/skills` (created by `init`).
- OpenCode: `.opencode/skills` symlinks to `.agents/skills`.
- Codex CLI and other AGENTS.md readers: discover the controls through `AGENTS.md`.
- Any harness: `./.agents/bin/eng` is a plain executable.

## Upgrade and rollback

Install/upgrade with `install.sh --target <repo>`; kit-owned code and skills are replaced, while
`engineering.json` and `guard-allow.txt` are preserved unless `--force`. Rollback is a git checkout of
the previous `.agents/` directory; evidence records remain valid because their schema is versioned.

## Known limits

- Impact analysis is textual, not a build graph.
- Secret scanning covers tracked files (and optionally history), not untracked files.
- OSV needs network and a supported lockfile.
- The agent evaluation harness is a separate, opt-in layer; it is not a model benchmark.
- A green gate is evidence about the checks that ran, not a proof of correctness or security.
