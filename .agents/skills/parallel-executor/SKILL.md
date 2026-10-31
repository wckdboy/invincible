---
name: parallel-executor
description: Split independent work across isolated agents or worktrees and integrate it safely. Use for multi-part features, independent bug fixes, research plus implementation, or any task where concurrent edits risk conflicts, shared build artifacts or duplicated effort.
---

# Parallel executor

Optimize for accepted, independently verified changes per unit of time and cost — not for the number
of agents started. Parallelism is allowed only for genuinely independent units.

## Activate when

- A task has two or more units that can be implemented and verified without ordering.
- Research or investigation can run while implementation proceeds.
- A large change would otherwise serialize unrelated work.

## Inputs and assumptions

- A git repository with a clean baseline, or a documented dirty state.
- The task decomposed into units with non-overlapping file or module ownership.
- A budget: maximum concurrent worktrees, wall-clock limit, token/cost limit if the harness exposes
  it.
- `.agents/engineering.json` configured with `parallel.max_worktrees` (default 4).

## Outputs

- A unit table: id, scope, owned files/modules, verification command, dependencies, owner.
- One worktree and branch per implementing unit: `.worktrees/<id>`, `eng/<id>`.
- Evidence per unit and a final integration record after revalidation on the target revision.
- Cleanup: merged worktrees removed; abandoned branches listed with a reason.

## Permissions and restrictions

- No two agents write the same file unless one explicitly owns integration and the others hand off.
- Shared schema, ABI, lockfile, generated code, migrations and release metadata are coordination
  points; sequence them.
- Do not run concurrent writes to a shared build cache, database, device, port or test fixture.
- Integration is sequential. A model's "done" is not merge approval.

## Workflow

1. Decompose by deliverable and verification, not by file count. A unit is ready when it has a
   command that can prove it.
2. Identify shared files and interfaces. Move them into an integration unit that runs first or last,
   never concurrently.
3. Record the baseline for each unit's verification command.
4. For each unit: `./.agents/bin/eng worktree create <id> --owner <agent>`. The CLI refuses a dirty
   tree by default and enforces the worktree budget.
5. Give each owner its scope, contract, verification command and handoff format. Owners must not edit
   outside their scope without asking.
6. Run independent units concurrently. Keep resource-heavy validation sequential if it contends for
   CPU, ports or devices.
7. On completion, review the diff, run the unit's checks in its worktree, and record evidence.
8. Integrate one unit at a time onto the latest target. Rebase, resolve conflicts explicitly, and
   re-run the full required gate after each integration.
9. Remove merged worktrees with `eng worktree remove <id>` after the branch is integrated. Do not
   force-remove dirty work.

## Verification

- Each unit's evidence record exists and its required checks pass in isolation.
- The integration revision passes the full gate, not just the union of unit tests.
- Conflict resolutions preserve both owners' intent and are reviewed by a human or a separate agent.
- No shared-state corruption: no concurrent writes to the same worktree, cache, port or database.
- Budget consumption and abandoned work are reported.

## Failure and escalation

- Dependency discovered between units: stop the dependent unit; re-plan; do not merge out of order.
- Two units need the same file: assign ownership to one; the other proposes a patch or waits.
- Integration fails: bisect by unit, revert the offending unit, keep the evidence.
- Budget exhausted: stop launching units, finish or discard cleanly, report partial results.
- Security or contract change: pause parallel work; load the relevant guardian skill; sequence it.

## Done when

All accepted units are integrated, the latest target revision has a passing full gate with evidence,
unmerged work is accounted for, and worktrees/branches are cleaned up or explicitly retained.
