# AGENTS.md

How any coding agent works on this repository, Invincible's own included. These are good defaults, and the owner's
explicit preferences override them.

**The mandate comes first: [docs/MANDATE.md](docs/MANDATE.md).** Every change is held to it: say which of its numbers
(correctness, horizon, cost, reversibility) the change moves and how that was measured. The north star is human
interventions per completed task.

**The design is [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and the order of work is [docs/PLAN.md](docs/PLAN.md).**

## Commands

```sh
bun install
bun run check                          # tsc + the whole suite: green before you say "done"
INVINCIBLE_KEYSTORE=file bun test      # tests never touch the OS keychain
bun test packages/ledger               # one package
bun invincible help                    # the CLI
bun run bench                          # the scorecard against its baselines
```

## Rules

- **The words.** Primary, agent, task, run, project, chat, node, client, fleet, grant, approval, proof. No word of the
  old theme anywhere; the vocabulary check fails CI on one.
- **Contracts live in `packages/core`.** Validate every input at the boundary with zod. Each route and each Q-AMP tool
  declares exactly one scope.
- **Never weaken crypto, auth or a gate** to make a test pass. Fix the code or the test's setup.
- **No secrets** in logs, chat, memory, fixtures or commits. Test keys must be obviously fake.
- **A failing test first** for every bug. **Flaky tests are fixed at the cause, never retried.**
- **Convergence is sacred.** The property tests (any order → the same digest; a rebuild → the same state) stay green. A
  new event kind is deterministic under replay, and unknown kinds are kept and ignored.
- **Every surface.** A contract change updates the server, the CLI, the web app, the native apps' vectors and the docs.
- **The owner's interface bar.** Modern, usable, measured: screenshots beside the benchmarks, no layout shift, nothing
  moving at rest, targets of at least 44 pt.
- **YAGNI.** No machinery because it looks impressive. Complexity belongs at adapter boundaries; orchestration stays
  pure and transports stay thin.
- **Nothing destructive:**
  - no `rm -rf` outside temp dirs, no killing by pattern, no force-push;
  - tests use temp homes, never `~/.invincible`;
  - Galahad keeps running on the owner's machines until the cutover, so leave `~/.galahad`, its ports and its
    service alone.
- **Landing.** The main copy is `sovware.io/amiriteorg/invincible`. Its main takes only pull requests whose checks all
  passed, fast-forward only. Nobody pushes main.
