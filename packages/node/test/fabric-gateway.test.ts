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

describe("what a VM may send its node's gateway for its giver's tools (I6)", () => {
  test("a body past 1 MiB is refused before it is read whole: by the length it says, or as it comes", async () => {
    const g = gateway("sandbox:1a2b3c4d5e");
    // It says its length: refused at once, its body never read.
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({ pull: (c) => void (pulled++, c.enqueue(new Uint8Array(64 * 1024).fill(0x20))) });
    const said = await handleFabricTool(new Request("http://10.89.0.1:7402/fabric/tool/fleet", { method: "POST", body: endless, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "content-length": String(64 << 20) } }), { tokens: { liveLabel: () => "sandbox:1a2b3c4d5e" }, handoffs: { callGiver: async () => ({ status: 200, body: {} }) } });
    expect(said.status).toBe(413);
    expect(pulled).toBeLessThan(4);
    // It says nothing of its length: read as it comes, and refused once past the bound, the rest never read.
    pulled = 0;
    const streamed = new ReadableStream<Uint8Array>({ pull: (c) => void (pulled++, c.enqueue(new Uint8Array(64 * 1024).fill(0x20))) });
    const past = await handleFabricTool(new Request("http://10.89.0.1:7402/fabric/tool/fleet", { method: "POST", body: streamed, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" } }), { tokens: { liveLabel: () => "sandbox:1a2b3c4d5e" }, handoffs: { callGiver: async () => ({ status: 200, body: {} }) } });
    expect(past.status).toBe(413);
    expect(pulled).toBeLessThan(40);
    expect(g.asked).toEqual([]);
  });

  test("its calls are counted, as its token is never spent: past 60 a minute from one VM, refused until the minute passes", async () => {
    const g = gateway("sandbox:2b3c4d5e6f");
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await g.post("/fabric/tool/fleet", "{}")).status);
    expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true);
    const refused = await g.post("/fabric/tool/fleet", "{}");
    expect(refused.status).toBe(429);
    expect((await refused.json()) as { error: string }).toEqual({ error: "at most 60 calls a minute from one VM to the tools its task was given" });
    // Another VM's are its own.
    expect((await gateway("sandbox:3c4d5e6f7a").post("/fabric/tool/fleet", "{}")).status).toBe(200);
  });
});
