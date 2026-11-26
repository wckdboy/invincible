import { expect, test } from "bun:test";
import { gatewayValues, meterDollars, routeOf } from "./model-runs.ts";

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

test("the node's meter is read for the token's label alone, its colours aside; one it says nothing of is null", () => {
  const usage = [
    "Model calls on node since 2026-11-26 (UTC) · tokens as the providers reported them",
    "",
    "By who asked",
    "  arm:team.0123456789.curator                      59 calls     2.29M in     57.6k out  $0",
    "  \x1b[1marm:c1-bench\x1b[0m                                    12 calls      211k in      4.1k out  $1,204.37",
    "  you                                              39 calls      621k in     32.3k out  $0.34",
  ].join("\n");
  expect(meterDollars(usage, "c1-bench")).toBe(1204.37);
  expect(meterDollars(usage, "c1")).toBeNull();
  expect(meterDollars(usage, "elsewhere")).toBeNull();
});
