---
name: failure-investigator
description: Reproduce a failure, find its root cause, and leave a permanent regression check. Use for crashes, failing tests, flaky behavior, production incidents, build breaks and unexplained regressions; also use when a fix is proposed without a confirmed cause.
---

# Failure investigator

Separate symptom from cause. A fix without a reproduced failure is a guess; a cause without a
regression check will return.

## Activate when

- A test, build, deployment or runtime failure is reported.
- Behavior is flaky, intermittent or environment-dependent.
- A proposed fix does not explain the observed failure.
- A production incident needs a timeline and a durable guard.

## Inputs and assumptions

- The failing command, input, version, platform and full error output.
- Access to the revision(s) where it fails and, if possible, where it last passed.
- Permission boundaries for production logs/data; redact before sharing.

## Outputs

- A minimal reproduction with exact commands and environment.
- A timeline and a root-cause statement tied to code or configuration.
- A regression test that fails before the fix and passes after.
- The fix, its verification, and any related latent issues found.
- A short incident note when users were affected.

## Permissions and restrictions

Do not run destructive experiments on production. Do not paste secrets, personal data or full
production payloads into issues. Do not "fix" by suppressing the error, widening a catch, adding a
retry, or skipping the test unless that is the documented desired behavior.

## Workflow

1. Capture the failure exactly: command, revision, environment, input, exit code, full trace. Save it
   under `.agents/evidence/` or an incident folder.
2. Reproduce locally or in an isolated environment. Reduce the input while the failure persists.
3. Determine the failing layer: input, parsing, state, concurrency, dependency, environment, build,
   deployment. Use logs, traces, debuggers, `git bisect` and instrumentation.
4. Form one hypothesis at a time and test it. Record negative results; they narrow the cause.
5. Write the regression test at the lowest layer that reproduces the cause, not only the symptom.
6. Implement the smallest fix. Verify the reproduction, the new test, neighboring tests and the full
   gate.
7. Search for the same pattern elsewhere; report siblings without silently expanding scope.
8. If users were affected, document impact, detection, response and prevention.

## Verification

- The reproduction fails on the pre-fix revision for the stated reason.
- The regression test fails without the fix and passes with it.
- The fix does not rely on a broader catch, a longer timeout, a retry or disabled validation.
- The full gate passes; any unrelated failure is recorded separately.
- Evidence includes the command, revision and log hash.

## Failure and escalation

- Cannot reproduce after a bounded effort: report the evidence, environment gap and next data needed;
  do not guess a fix.
- Flaky: measure the failure rate under repetition, identify the race or shared state, and fix the
  cause; do not call a single pass a fix.
- Production-only: request a safe trace/sample and approval; preserve chain of custody.
- Security incident: stop, load `security-auditor`, follow the disclosure process, do not publish
  exploit details.

## Done when

The failure is reproduced, the cause is evidenced, the regression test is red-then-green, the fix and
full gate pass, and the residual uncertainty is stated.
