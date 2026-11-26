#!/usr/bin/env bun
/*
 * Why each test failed, from an Xcode result bundle: every failure message, with its test. xcodebuild's -quiet prints
 * only the failing tests' names, so CI's log once said "PerfTests.testRequestsAtRest()" and nothing of what it measured
 * (26 November 2026). The performance budgets' messages carry their numbers, so CI prints these when a test fails. Read
 * against a real bundle of a failing XCTest (Xcode 27.2): its message is XCTest's own words, then the test's.
 *
 *   bun apps/apple/scripts/test-failures.ts <result.xcresult>
 */
interface ResultNode {
  name?: string;
  nodeType?: string;
  children?: ResultNode[];
}

/** Each failure message under the tests, as "<suite>.<test>: <message>", named as xcodebuild names a failing test (pure:
 * the JSON xcresulttool prints). */
export function failureLines(results: { testNodes?: ResultNode[] }): string[] {
  const lines: string[] = [];
  const walk = (node: ResultNode, suite: string, test: string): void => {
    const inSuite = node.nodeType === "Test Suite" ? (node.name ?? suite) : suite;
    const inTest = node.nodeType === "Test Case" ? [inSuite, node.name ?? ""].filter(Boolean).join(".") : test;
    if (node.nodeType === "Failure Message") lines.push(`${test || "(no test)"}: ${(node.name ?? "").slice(0, 1000)}`);
    for (const child of node.children ?? []) walk(child, inSuite, inTest);
  };
  for (const node of results.testNodes ?? []) walk(node, "", "");
  return lines;
}

if (import.meta.main) {
  const path = Bun.argv[2];
  if (!path) {
    console.error("usage: bun apps/apple/scripts/test-failures.ts <result.xcresult>");
    process.exit(2);
  }
  const run = Bun.spawnSync(["xcrun", "xcresulttool", "get", "test-results", "tests", "--path", path], { stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) {
    console.error(`xcresulttool couldn't read ${path}: ${run.stderr.toString().slice(0, 300)}`);
    process.exit(1);
  }
  const lines = failureLines(JSON.parse(run.stdout.toString()));
  console.log(lines.length ? lines.join("\n") : "no failure messages in the result bundle");
}
