# Evidence and verification records

`eng verify` writes one record per run under `.agents/evidence/`. Records are local and
gitignored; CI uploads them as artifacts. Do not edit, reorder or delete records to make a run look
successful. `eng evidence verify` recomputes content hashes and checks the chain.

## Record shape (`eng-evidence/v1`)

- `id`, `started_at`, `finished_at`, `profile`, `command`, `tool.version`
- `git`: HEAD, branch, dirty state, diff hash, untracked count/hash; `git_before` records the state
  before commands ran, so a check that modified the tree is visible
- `config`: path, content hash, whether it existed
- `commands[]`: name, exact command, required flag, status, exit code, duration, full-output hash,
  log path, last 30 lines
- `security[]`: scanner, version, status, finding count, log, reason
- `impact`: changed files, symbols, references, likely tests, contract surfaces (optional)
- `verdict`: `pass`, `fail` or `blocked`; required failures; explicit `unverified` list
- `sha256`: hash of the record without this field; each index entry also records the previous hash

## Status meanings

| Status | Meaning |
| --- | --- |
| `pass` | Every required command and required scanner completed successfully. |
| `fail` | A required command failed, timed out, or a required scanner reported findings. |
| `blocked` | A required check could not run (missing tool/config), so the gate is unknown. |
| `skipped` | An optional check was not applicable or not installed. It is never a pass. |
| `error` | The check ran but did not produce a trustworthy result. |

## Rules

- A check that did not execute is `skipped`, `blocked` or absent, never `pass`.
- Exit codes are evidence; prose summaries are not.
- Security findings fail the gate. Missing required scanners block it.
- A dirty working tree is recorded; the evidence describes those bytes, not a commit.
- Preserve logs with the record. If attaching evidence to a review, attach the JSON and the
  failing log, not a screenshot of a terminal.
- Logs redact high-signal credential patterns before writing. They can still contain other sensitive
  data from test output; treat evidence artifacts as confidential.
- `eng evidence verify` failure means the record or chain was altered. Investigate; do not
  regenerate over it.
