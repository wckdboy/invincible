# Coding-agent harness comparison

Run: 2026-10-28T16:02:31+01:00

| Agent | Model | Version | Passed | Total | Time |
| --- | --- | --- | ---: | ---: | ---: |
| Autobot | `qwen3.8-27b` | autobot 0.0.21 | 6 | 6 | 770.7s |

## Per task

| Task | Autobot |
| --- | --- |
| `write-exact` | pass |
| `fix-failing-test` | pass |
| `multi-file-feature` | pass |
| `rename-refactor` | pass |
| `constraint-edit` | pass |
| `off-by-one` | pass |

A pass means the agent exited 0 and every check passed. Durations include the agent's own thinking and tool time.
