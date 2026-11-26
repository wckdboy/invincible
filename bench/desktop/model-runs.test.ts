import { expect, test } from "bun:test";
import { gatewayValues, meterDollars, recordOf, routeOf } from "./model-runs.ts";

/* The real model's runs (model-runs.ts): what is read of a gateway token's file, where each route's calls go, and the node's meter. */

const FILE = [
  "a node's gateway token for the benchmark, c1-bench",
  "",
  "ANTHROPIC_BASE_URL=http://192.0.2.10:7811/gw/anthropic",
  "ANTHROPIC_AUTH_TOKEN=gw_FAKE_anthropic_0000000000000000000000000",
  "export OPENAI_BASE_URL='http://192.0.2.10:7811/gw/<provider>'",
  "OPENAI_API_KEY=gw_FAKE_openai_00000000000000000000000000000",
].join("\n");

test("a gateway token's file is read as its KEY=value lines; each route goes where the file says, as its model", () => {
  const values = gatewayValues(FILE);
  expect(Object.keys(values)).toEqual(["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "OPENAI_BASE_URL", "OPENAI_API_KEY"]);
  expect(routeOf(values, "anthropic")).toEqual({ base: "http://192.0.2.10:7811/gw/anthropic", token: "gw_FAKE_anthropic_0000000000000000000000000", model: "claude-opus-5-5", versioned: false });
  expect(routeOf(values, "orcarouter")).toEqual({ base: "http://192.0.2.10:7811/gw/orcarouter", token: "gw_FAKE_openai_00000000000000000000000000000", model: "anthropic/claude-opus-5.5", versioned: true });
  expect(routeOf(values, "elsewhere")).toBeNull();
  expect(routeOf({ ANTHROPIC_BASE_URL: "http://192.0.2.10:7811/gw/anthropic" }, "anthropic")).toBeNull();
});

test("the node's meter is read for the token's label alone (as its by-who lines name a token, with no arm: before it), its colours aside; one it says nothing of is null", () => {
  const usage = [
    "Model calls on node since 2026-11-26 (UTC) · tokens as the providers reported them",
    "",
    "By who asked",
    "  arm:team.0123456789.curator                      59 calls     2.29M in     57.6k out  $0",
    "  \x1b[1mc1-bench\x1b[0m                                         12 calls      211k in      4.1k out  $1,204.37",
    "  arm:c1-bench-old                                  3 calls       10k in       1k out  $9.99",
    "  you                                              39 calls      621k in     32.3k out  $0.34",
  ].join("\n");
  expect(meterDollars(usage, "c1-bench")).toBe(1204.37);
  expect(meterDollars(usage, "c1")).toBeNull();
  expect(meterDollars(usage, "elsewhere")).toBeNull();
});

test("the runs are kept by task as the suite's model baseline: passes against the bar, calls and actions, tokens, dollars and minutes", () => {
  const run = (task: "form" | "editor", n: number, pass: boolean, calls: number, actions: number, meter: number | null) => ({
    task, policy: "model" as const, run: n, pass, why: pass ? "" : "the file holds \"\"", actedMs: 1000, commands: actions + 1, looks: 0,
    loop: { calls, actions, commands: 1, usage: { input: 1000 * calls, cached: 800 * calls, output: 100 * calls }, unknown: 0, shape: null, ms: 20_000 },
    dollars: 0.01 * calls, meter: meter, minutes: 0.3 * calls,
  });
  const record = recordOf({ at: "2026-11-27T00:00:00.000Z", commit: "abc1234", model: "anthropic/claude-opus-5.5", route: "orcarouter", runs: [run("form", 1, true, 4, 8, 0.03), run("form", 2, true, 6, 8, 0.05), run("editor", 1, false, 9, 3, 0.08)] }, { passed: 3, of: 3 });
  expect(record).toMatchObject({ suite: "desktop-model", passed: 2, of: 3, held: false, dollars: { meter: 0.16 } });
  expect(record.tasks.form).toEqual({
    passed: 2, of: 2,
    calls: { median: 5, most: 6 }, actions: { median: 8, most: 8 }, callsPerAction: 0.75,
    tokens: { input: 10_000, cached: 8_000, output: 1_000, unreported: 0 },
    dollars: { meter: 0.08, upperBound: 0.1 }, minutes: { median: 1.5, most: 1.8 },
  });
  expect(record.tasks.editor).toMatchObject({ passed: 0, of: 1, failed: ['run 1: the file holds ""'], callsPerAction: null });
  // A run the meter couldn't say leaves the meter's sum unsaid, never a smaller one.
  expect(recordOf({ at: "x", commit: "y", model: "m", route: "r", runs: [run("form", 1, true, 4, 8, null)] }, { passed: 1, of: 1 }).dollars.meter).toBeNull();
});
