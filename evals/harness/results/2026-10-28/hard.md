# Coding-agent harness comparison

Run: 2026-10-28T15:33:18+01:00

| Agent | Model | Version | Passed | Total | Time |
| --- | --- | --- | ---: | ---: | ---: |
| Autobot | `qwen3.8-27b` | autobot 0.0.21 | 2 | 3 | 884.5s |

## Per task

| Task | Autobot |
| --- | --- |
| `large-file-edit` | pass |
| `spec-implementation` | timeout |
| `cross-file-bug` | pass |

## Failures

- **Autobot / spec-implementation**: timeout; timed out after 450s

A pass means the agent exited 0 and every check passed. Durations include the agent's own thinking and tool time.
