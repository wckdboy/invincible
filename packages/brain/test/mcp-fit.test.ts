import { expect, test } from "bun:test";
import type { McpTool } from "@galahad/core";
import { fitMcpTools } from "../src/mcp-connectors.ts";

/* A big MCP server's tools as the mind keeps them (fitMcpTools): whole when they fit, in short when they don't. */

const tool = (i: number, words: number): McpTool => ({ remote: `t${i}`, description: "w".repeat(words), params: { a: { type: "string", description: "p".repeat(300), required: true } }, class: "read", schema: `pin-${i}` });
const size = (tools: Record<string, McpTool>) => JSON.stringify(tools).length;

test("whole when they fit; in short when they don't, each tool's name, class, pin and arguments kept; none when even the shortest won't fit", () => {
  const few = { t0: tool(0, 900) };
  expect(fitMcpTools(few, size, 10_000)).toBe(few);
  const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`t${i}`, tool(i, 1000)]));
  const fitted = fitMcpTools(many, size, 20_000)!;
  expect(size(fitted)).toBeLessThanOrEqual(20_000);
  expect(Object.keys(fitted)).toEqual(Object.keys(many));
  for (const [name, t] of Object.entries(fitted)) {
    expect(t).toMatchObject({ remote: many[name]!.remote, class: "read", schema: many[name]!.schema, params: { a: { type: "string", required: true } } });
    expect(t.description.length).toBeLessThan(1000);
  }
  expect(fitMcpTools(many, size, 1_000)).toBeNull();
});
