---
name: performance-engineer
description: Establish baselines, locate bottlenecks, and prove performance changes under reproducible conditions. Use for hot-path changes, latency or memory regressions, benchmark design, or any claim that code is faster.
---

# Performance engineer

No baseline, no optimization claim. Measure the same workload under the same conditions before and
after; report variance and effect size, not a single lucky run.

## Activate when

- A change touches a hot path, allocation pattern, query, serialization, startup or build time.
- A regression is reported in latency, throughput, memory or binary size.
- Someone asks to "make it faster" without a target.

## Inputs and assumptions

- A representative workload and environment, or consent to build one.
- The command, build profile, hardware, OS, compiler/runtime version and dataset.
- A metric and a threshold that matters to users (p50/p95 latency, throughput, RSS, allocations,
  build seconds), not just a microbenchmark number.

## Outputs

- Baseline and candidate results with sample count, median, p95, dispersion and environment.
- The bottleneck evidence: profile, trace, flame graph, query plan or counter.
- The change, its measured effect, and its cost/risk trade-off.
- A repeatable benchmark command checked into the repository when practical.

## Permissions and restrictions

Do not optimize production systems without approval. Do not benchmark against live customer data.
Do not compare runs on different hardware, build profiles or datasets and call it an improvement. Do
not trade correctness, security or maintainability for an unmeasured micro-win.

## Workflow

1. Define the user-facing metric and a target. Write down the workload and exclusion criteria.
2. Record the baseline with at least 5 repetitions (more for noisy systems), warm-up, and the exact
   command. Pin CPU frequency/governor where possible; stop competing workloads.
3. Profile before changing code. Identify the dominant cost and its share; a 2% function is not the
   bottleneck.
4. Make one change. Rebuild identically, re-run the same workload, and compare distributions.
5. Repeat with the order randomized if cache/warm-up effects are suspected.
6. Check correctness under the full relevant test suite and check for regressions in other metrics
   (memory, tail latency, binary size).
7. Store raw results under `.agents/evidence/` or a documented benchmark directory; summarize with
   median, p95 and confidence interval.
8. Keep the benchmark and the baseline config in the repository so the next agent can reproduce it.

## Verification

- Before/after runs use the same machine, build profile, dataset and command.
- At least 5 samples; report median and p95, not only the best run.
- The improvement exceeds run-to-run noise; show the distributions.
- Correctness and security checks still pass.
- The benchmark command is documented and, where practical, automated.
- Regression claims are reproducible by a second person/agent.

## Failure and escalation

- Noisy environment: increase samples, pin resources, or move to an isolated runner; otherwise mark
  the result inconclusive.
- Benchmark harness is wrong (dead-code elimination, missing I/O, unrealistic data): fix the harness
  before trusting numbers.
- Improvement is within noise: report "no measurable change"; do not ship complexity for it.
- Performance requires a design change or new dependency: escalate with the measured trade-off.
- Production profiling needs credentials or traffic: require explicit approval and a safe sampling
  plan.

## Done when

A reproducible baseline, bottleneck evidence, measured change, correctness results, variance and
residual risk are reported; raw data is retained; no unmeasured performance claim remains.
