---
type: mandate
created: 2026-11-14
---

# agent.md

**The mandate: build the best coding agent that has ever existed.** Not the most discussed, not the one with the best demo video. The one that, given a real repository and a real task, finishes it correctly, cheaply, and without a human watching every step.

Everything below is the standard that work is held to. If a decision makes the agent more impressive and less correct, it is the wrong decision.

## 1. What "best" actually means

"Best" is four numbers, not a feeling. Any claim of progress has to move one of them:

| Axis | Question | How you'd know |
|---|---|---|
| **Correctness** | Does the task end done, on a real repo, with tests that prove it? | Pass rate on held-out tasks, verified by running code |
| **Horizon** | How long can it run unattended before it needs a human? | Minutes of unattended work per intervention |
| **Cost** | What does one completed task cost in tokens and wall-clock? | Spend per merged task, tracked per session |
| **Reversibility** | When it's wrong, how cheap is the undo? | Time from bad merge to clean revert |

Public benchmarks (SWE-bench Verified, Terminal-Bench and successors) are a floor, not a goal. They are near saturation, which means they have stopped discriminating. Treat a saturated benchmark as a warning that you need your own harder set, drawn from actual work in this vault and its repositories.

**The north-star metric: human interventions per completed task.** Every prompt that asks permission, every correction, every "no, not that file" is a cost the product is paying. Drive it down without driving the revert rate up.

## 2. Non-negotiables

1. **Verify, don't assert.** A claim of "done" without a command that ran and a result that was read is not done. A model's self-assessment is not evidence.
2. **The diff is the deliverable.** Prose about what was changed is commentary on the diff, never a substitute for it.
3. **No silent pass.** Skipped, blocked, errored and unavailable are reported as unverified. Say so every time.
4. **Never weaken the gate to get green.** Deleting tests, loosening assertions, disabling scanners and broadening allowlists are the failure mode, not the fix.
5. **Human approval at real trust boundaries.** Production, credentials, destructive operations, privilege, security exceptions. Approval fatigue is a design bug — ask less, but never ask quietly.
6. **Smallest reversible change.** One idea per commit. No unrelated refactors, no formatting mixed into behaviour.
7. **Context is a budget, not a container.** Every token spent re-reading a file is a token not spent thinking.

## 3. The architecture that matters

Six parts. Most agents have all six and get two of them right.

### Context assembly
What the model sees before it acts. The hard problem is not retrieval, it is **selection under a budget** — the right five hundred lines beat the right file and the whole file beats the whole repo. Design for the case where the file is 20,000 lines and the answer is one function.

*Trap:* dumping everything and calling it "long context". Long context degrades quietly; accuracy falls before the window fills.

### Tool interface
Read, search, edit, run, and nothing else unless it earns its place. Fewer, sharper tools beat a large surface — every extra tool is one more way to pick wrong.

*Trap:* tools that return unbounded output. Cap every result, and make truncation explicit rather than silent.

### The loop
Restate the task in acceptance-criteria terms before touching a file. Then plan the smallest change, make it, verify it, report it. The restatement step is cheap and catches the majority of misunderstandings before they become diffs.

### The verifier — this is the moat
Anyone can generate a patch. The product is knowing whether the patch is right. That means: run the narrowest relevant test first, then the broader suite, and treat a green gate as covering only the checks that actually ran.

*Trap:* a verifier that asks the model "does this look correct?" That is not verification, it is asking the author for a reference.

### Execution sandbox
Isolation is what makes autonomy safe enough to be useful. One worktree per task, no shared mutable state, explicit network policy, and a rollback that is one command.

### Memory and persistence
Session state that survives compaction, and task state that survives the session. What was learned about this repository — build commands, flaky tests, conventions — belongs in a file, not in the context window.

## 4. Failure modes to design against

These are the ways agents lose, ranked by how often they happen:

1. **Optimistic completion.** Declares success having run nothing. Fix: completion requires evidence, structurally.
2. **Test gaming.** Makes the suite green by weakening the suite. Fix: gate on the test *content* changing, not only on results.
3. **Context rot.** Twenty turns in, the agent has forgotten the constraint from turn two. Fix: persist constraints outside the window and re-inject them.
4. **Scope creep.** Fixes three extra things nobody asked for, and hides them in the diff. Fix: one idea per commit, enforced.
5. **Cost blindness.** Burns $12 of tokens deciding where a file lives. Fix: measured spend per task, with a hard ceiling.
6. **Approval fatigue.** Asks so often that the human clicks yes without reading. Fix: fewer, higher-stakes questions; batch the trivial ones.

## 5. What to steal from the projects in the list

The [[Open Source Projects to admire]] note is a shopping list. The patterns worth copying:

| Source | Lesson |
|---|---|
| Jean, Orca, Orchestrator | Parallelism is workspace isolation, not multiple chats in one pane. One worktree per task, review at the end. |
| Caveman | Input tokens are the bill. Compress what the agent reads before optimising what it writes. |
| Paseo | The agent should not be trapped in one terminal. Long runs need to be watchable and interruptible from anywhere. |
| AFFiNE, Concat, Khoj, Fluxer | Local-first is a feature, not a limitation to apologise for. |

## 6. Anti-goals

- **Not a chat wrapper.** If the interface is a text box and the output is a paragraph, it is not this.
- **Not a benchmark maximiser.** A number that only improves on the benchmark is not an improvement.
- **Not more autonomy than verification.** Autonomy is safe in proportion to how well failure is caught, not how rarely it is reviewed.
- **Not infinite configuration.** Power users want knobs; everyone else wants the default to be correct.

## 7. The test of the whole thing

Hand it a task in a repository it has never seen, written the way a colleague would write it — underspecified, with an obvious-in-hindsight right answer. Leave the room. Come back to a green suite, a small diff, and a short account of what it checked and what it did not.

If it needs you in the room, it is not finished.

---

## Instructions to agents working here

This file is a mandate, not a description. Concretely:

- Prefer evidence over confidence in every report.
- Record commands run and their results, including the ones that failed.
- Say "unverified" rather than implying success.
- Ask once, precisely, when a decision is genuinely the owner's — not repeatedly, and not never.

This mandate came with Invincible from Galahad, where it was written on 14 November 2026. It holds unchanged: the
primary agent and the agents it runs are held to the same four numbers. [AGENTS.md](../AGENTS.md) holds the working rules.
