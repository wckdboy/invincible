---
name: repo-intelligence
description: Build an evidence-based map of an unfamiliar or changing repository before planning work. Use when starting in a repo, locating ownership or entry points, finding tests and CI commands, or answering "where does this live" without reading the whole tree.
---

# Repository intelligence

Produce the smallest map that lets a change be planned safely. Facts need a path, command or
record; mark inferences as inferences.

## Activate when

- Starting work in a repository or an unfamiliar module.
- A task names a feature but not its files, owners or verification commands.
- You need the authoritative build, test or release command.
- A previous summary may be stale compared with the current source.

## Inputs and assumptions

- Read access to the repository; `git` available. No network needed.
- `./.agents/bin/eng` installed; if absent, say so and fall back to `git ls-files`, manifests and
  `rg` without pretending the map is complete.

## Outputs

- Stack, manifests, build systems, test frameworks, CI workflows and security policy files.
- Top-level modules, their file counts, manifests and ownership (`CODEOWNERS` if present).
- Entry points and interface candidates (libraries, CLIs, schemas, public API directories).
- Authoritative verification commands, taken from `AGENTS.md` and `.agents/engineering.json`.
- A short list of unknowns that require build-graph, LSP or human confirmation.

## Permissions and restrictions

Read-only. Do not edit files, install tools, start services or fetch remote content. Do not dump
large files or entire directories into context; quote the relevant lines.

## Workflow

1. Read `AGENTS.md` (or the repository's equivalent) and `.agents/engineering.json`. They outrank
   inferences from file names.
2. Run `./.agents/bin/eng detect` (add `--json` for machine use). It inventories stacks, manifests,
   modules, tests, CI and interface candidates.
3. Read the build manifests and the CI workflow that runs on pull requests. Extract the exact
   commands, not a paraphrase.
4. For the task's feature, use `rg` for the symbol or user-facing string. Read the defining file and
   one representative consumer; follow imports only as far as needed.
5. Identify the narrowest test target and the broadest required gate. Record both.
6. Check `git log -n 20 -- <path>` for recent churn and `git status` for uncommitted work.
7. Report the map with paths. Put "observed" and "inferred" in separate lists.

## Verification

- Every claimed command was found in a file or executed with `--help`/`--version`.
- Every module boundary cites a manifest or directory.
- At least one test and one consumer were located for the target symbol.
- Staleness check: compare any existing summary with `git log -1` and the current file content; the
  source wins.

## Failure and escalation

- Not a git repository: use `eng detect` fallback; state that history and ignore rules are
  unavailable.
- Huge or generated tree: scope to the module; exclude `target`, `node_modules`, `.venv`, build
  output and vendored code.
- Conflicting instructions between `AGENTS.md` and a README: `AGENTS.md` wins; flag the conflict.
- Missing build metadata: stop before proposing commands; ask for the authoritative command.

## Done when

The task's relevant modules, entry points, consumers, tests and commands are identified with
evidence; unknowns and stale summaries are listed; no files were modified.
