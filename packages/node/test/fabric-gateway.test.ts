import { describe, expect, test } from "bun:test";
import { handleFabricTool } from "../src/fabric/handoff.ts";

/*
 * A VM's way to the tools its handed task was given (POST /fabric/tool/<name> on its node's gateway): its own gateway
 * token or nothing, a tool's name and a JSON object, carried on to the giver by the node (callGiver; end to end in
 * fabric-handoff.e2e.test.ts).
 */

const TOKEN = `gw_${"A".repeat(43)}`;

function gateway(label: string | null) {
  const asked: { sandbox: string; tool: string; input: Record<string, unknown> }[] = [];
  const ctx = {
    tokens: { liveLabel: (token: string) => (token === TOKEN ? label : null) },
    handoffs: {
      callGiver: async (sandbox: string, tool: string, input: Record<string, unknown>) => {
        asked.push({ sandbox, tool, input });
        return { status: 200, body: { content: "{\"fleet\":\"pair\"}", summary: "the fleet" } };
      },
    },
  };
  const post = (path: string, body: string | null, token: string | null = TOKEN, method = "POST") =>
    handleFabricTool(new Request(`http://10.89.0.1:7402${path}`, { method, ...(body !== null ? { body } : {}), headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" } }), ctx);
  return { asked, post };
}

describe("a VM calling the tools its handed task was given", () => {
  test("with its own token and a tool's input, the call goes on for its VM, and the answer comes back as it was", async () => {
    const g = gateway("sandbox:0a1b2c3d4e");
    const res = await g.post("/fabric/tool/fleet", JSON.stringify({ verbose: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ content: "{\"fleet\":\"pair\"}", summary: "the fleet" });
    expect(g.asked).toEqual([{ sandbox: "0a1b2c3d4e", tool: "fleet", input: { verbose: true } }]);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("no token, another kind of token, or one that is spent is refused before anything goes on", async () => {
    for (const [label, token] of [["sandbox:0a1b2c3d4e", null], ["sandbox:0a1b2c3d4e", "gw_other"], ["arm:someone", TOKEN], [null, TOKEN]] as const) {
      const g = gateway(label);
      expect((await g.post("/fabric/tool/fleet", "{}", token)).status).toBe(401);
      expect(g.asked).toEqual([]);
    }
  });

  test("only POST, only a tool's name, only a JSON object", async () => {
    const g = gateway("sandbox:0a1b2c3d4e");
    expect((await g.post("/fabric/tool/fleet", null, TOKEN, "GET")).status).toBe(405);
    expect((await g.post("/fabric/tool/../../link/sync", "{}")).status).toBe(404);
    expect((await g.post("/fabric/tool/Fleet", "{}")).status).toBe(404);
    expect((await g.post("/fabric/tool/fleet", "[1,2]")).status).toBe(400);
    expect((await g.post("/fabric/tool/fleet", "not json")).status).toBe(400);
    expect((await g.post("/fabric/tool/fleet", "x".repeat((1 << 20) + 1))).status).toBe(413);
    expect(g.asked).toEqual([]);
    // No body at all is an empty input.
    expect((await g.post("/fabric/tool/fleet", null)).status).toBe(200);
    expect(g.asked.at(-1)?.input).toEqual({});
  });
});
