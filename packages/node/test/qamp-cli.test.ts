import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { QampGrantMade, QampGrantView, RouteName } from "@galahad/core";
import { agentCommand, qampCommand, ttlSeconds } from "../src/qamp-cli.ts";

/* `galahad qamp` at a terminal: what it sends (exactly what you said, checked first), and what it prints for the agent's machine. */

const AGENT = "did:key:z6Mkg6rJ6LnB4z2LqAFGGMCgLaJDq6KuLLSRXwwCV5RpjyBW";
const BRIDGE = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const at = Date.UTC(2026, 10, 25, 12, 0);

const view = (over: Partial<QampGrantView> = {}): QampGrantView => ({
  id: "0a1b2c3d4e",
  label: "qamp.0a1b2c3d4e",
  agent: AGENT,
  tools: ["fleet", "compute"],
  scopes: ["mind:read"],
  createdAt: at,
  endsAt: at + 3_600_000,
  url: `qamp://${BRIDGE}@192.0.2.7:7781`,
  bridge: { state: "up", why: null },
  ...over,
});

let printed: string[] = [];
const log = console.log;
beforeEach(() => {
  printed = [];
  console.log = (...args: unknown[]) => void printed.push(args.join(" "));
});
afterEach(() => {
  console.log = log;
});

function api(answers: Partial<Record<RouteName, unknown>>) {
  const calls: { name: RouteName; input: unknown }[] = [];
  return {
    calls,
    call: async <T,>(name: RouteName, input?: unknown): Promise<T> => {
      calls.push({ name, input });
      if (!(name in answers)) throw new Error(`unexpected call ${name}`);
      return answers[name] as T;
    },
  };
}

describe("how long", () => {
  test("seconds, minutes, hours or a day; plain seconds; nothing else", () => {
    expect([ttlSeconds("1h"), ttlSeconds("90m"), ttlSeconds("45s"), ttlSeconds("24h"), ttlSeconds("1d"), ttlSeconds("3600"), ttlSeconds(" 2h ")]).toEqual([3600, 5400, 45, 86_400, 86_400, 3600, 7200]);
    for (const text of ["", "1.5h", "1w", "-1h", "h", "1 hour", "1e3"]) expect([text, ttlSeconds(text)]).toEqual([text, null]);
  });
});

describe("galahad qamp grant", () => {
  test("sends the agent's key, the tools and the lifetime; prints the command its machine runs and an MCP config", async () => {
    const made: QampGrantMade = { grant: view(), proof: "qdt1.FAKE-CHAIN-FOR-TESTS" };
    const node = api({ qampGrant: made });
    await qampCommand(node, "grant", [AGENT], { tools: "fleet,compute", ttl: "1h" }, () => at);
    expect(node.calls).toEqual([{ name: "qampGrant", input: { agent: AGENT, tools: ["fleet", "compute"], ttlSeconds: 3600 } }]);
    const text = printed.join("\n");
    expect(text).toContain(`Granted fleet, compute to ${AGENT}, until `);
    expect(text).toContain("(in 60 min)");
    expect(text).toContain(`  qamp mcp qamp://${BRIDGE}@192.0.2.7:7781 --key <the agent's key file> --proof qdt1.FAKE-CHAIN-FOR-TESTS`);
    const config = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    expect(config).toEqual({ mcpServers: { galahad: { command: "qamp", args: ["mcp", `qamp://${BRIDGE}@192.0.2.7:7781`, "--key", "<the agent's key file>", "--proof", "qdt1.FAKE-CHAIN-FOR-TESTS"] } } });
    expect(text).toContain("galahad qamp revoke 0a1b2c3d4e ends it now");
    expect(agentCommand(made, "~/agent.qamp-key")).toEqual(["qamp", "mcp", `qamp://${BRIDGE}@192.0.2.7:7781`, "--key", "~/agent.qamp-key", "--proof", "qdt1.FAKE-CHAIN-FOR-TESTS"]);
  });

  test("with no tools named, the four you allowed; with no lifetime, an hour", async () => {
    const node = api({ qampGrant: { grant: view({ tools: ["fleet", "compute", "place", "ledger"] }), proof: "qdt1.FAKE" } });
    await qampCommand(node, "grant", [AGENT], {}, () => at);
    expect(node.calls[0]!.input).toEqual({ agent: AGENT, tools: ["fleet", "compute", "place", "ledger"], ttlSeconds: 3600 });
  });

  test("refused before anything is sent, in words: another tool, a lifetime past a day, a lifetime it can't read, a key that isn't one", async () => {
    const node = api({});
    const said = (rest: string[], flags: Record<string, string>) => qampCommand(node, "grant", rest, flags).then(() => "sent", (e: Error) => e.message);
    expect(await said([AGENT], { tools: "fleet,recall" })).toBe('"recall" can\'t be granted: fleet, compute, place and ledger are the tools you have allowed so far');
    expect(await said([AGENT], { ttl: "2d" })).toBe("a grant lasts 24 hours at most: grant again when it ends");
    expect(await said([AGENT], { ttl: "25h" })).toBe("a grant lasts 24 hours at most: grant again when it ends");
    expect(await said([AGENT], { ttl: "soon" })).toBe("--ttl takes how long, such as 30m, 1h or 24h (seconds if it says no unit)");
    expect(await said(["did:key:zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169"], {})).toStartWith("an agent's key as Q-AMP names it: did:key:z6Mk…");
    expect(await said([], {})).toStartWith("usage: galahad qamp grant <did:key:z6Mk…>");
    expect(node.calls).toEqual([]);
  });

  test("a node with no tailnet address says only this machine can reach it", async () => {
    await qampCommand(api({ qampGrant: { grant: view({ url: `qamp://${BRIDGE}@127.0.0.1:7781` }), proof: "qdt1.FAKE" } }), "grant", [AGENT], {}, () => at);
    expect(printed.join("\n")).toContain("only an agent on this machine can reach it");
  });
});

describe("galahad qamp grants and revoke", () => {
  test("each grant: its id, tools, agent, when it ends, its bridge and where it listens", async () => {
    await qampCommand(api({ qampGrants: { grants: [view(), view({ id: "ffffffffff", tools: ["ledger"], bridge: { state: "down", why: "its bridge stopped (101)" }, endsAt: at + 30 * 60_000 })] } }), "grants", [], {}, () => at);
    expect(printed[0]).toBe(`  0a1b2c3d4e  fleet, compute  ${AGENT}`);
    expect(printed[1]).toContain("(in 60 min) · bridge up · qamp://");
    expect(printed[3]).toContain("(in 30 min) · bridge down (its bridge stopped (101))");
    printed = [];
    await qampCommand(api({ qampGrants: { grants: [] } }), undefined, [], {});
    expect(printed[0]).toStartWith("No grants.");
  });

  test("one by its id, or every one", async () => {
    const one = api({ qampRevoke: { revoked: 1 } });
    await qampCommand(one, "revoke", ["0a1b2c3d4e"], {});
    expect(one.calls).toEqual([{ name: "qampRevoke", input: { id: "0a1b2c3d4e" } }]);
    expect(printed[0]).toBe("Ended 0a1b2c3d4e: its arm is deleted (the agent's next call is refused) and its bridge stopped.");
    const all = api({ qampRevoke: { revoked: 2 } });
    await qampCommand(all, "revoke", [], { all: true });
    expect(all.calls).toEqual([{ name: "qampRevoke", input: { all: true } }]);
    expect(printed[1]).toStartWith("Ended 2 grants");
    expect(await qampCommand(api({}), "revoke", [], {}).catch((e: Error) => e.message)).toStartWith("usage: galahad qamp revoke <id>|--all");
  });
});
