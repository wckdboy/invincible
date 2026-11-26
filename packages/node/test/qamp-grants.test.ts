import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNER_SCOPES, type QampTool } from "@galahad/core";
import type { LedgerEntryInput } from "@galahad/sandbox";
import { ArmTokens } from "../src/arms.ts";
import { Home } from "../src/home.ts";
import { grantScopes, mayGrant, QampGrantError, QampGrants, type QampProcess, type QampRunner, unspecified } from "../src/qamp-grants.ts";
import { type GalahadTool, TOOLS } from "../src/tools.ts";

/*
 * A grant to an agent on another machine, with a stand-in for Q-AMP's binary: what each step asks of `qamp`, what it
 * leaves on the node (an arm, a 0600 token, a row), what the ledger says, and how a grant ends: revoked, or its time up,
 * its arm deleted first and its bridge stopped. The real binary is driven in qamp.e2e.test.ts.
 */

/** Public keys, for names: the did:key spec's example (the bridge) and one made for this test (the agent). */
const BRIDGE = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const AGENT = "did:key:z6Mkg6rJ6LnB4z2LqAFGGMCgLaJDq6KuLLSRXwwCV5RpjyBW";
const FAKE_CHAIN = "qdt1.FAKE-CHAIN-FOR-TESTS";

/** A bridge as the stand-in starts it: it listens at once (unless told not to), and stops when signalled (unless told not to). */
class FakeBridge {
  readonly signals: string[] = [];
  private end: (how: number | string | null) => void = () => {};
  readonly process: QampProcess;
  constructor(
    readonly args: string[],
    readonly env: Record<string, string>,
    readonly line: (text: string) => void,
    behaviour: { listens: boolean; obeys: boolean },
  ) {
    const exited = new Promise<number | string | null>((resolve) => (this.end = resolve));
    const listen = args[args.indexOf("--listen") + 1];
    this.process = {
      ready: behaviour.listens ? Promise.resolve(`qamp://${BRIDGE}@${listen}`) : exited.then(() => null),
      exited,
      kill: (signal) => {
        this.signals.push(signal);
        if (signal === "SIGKILL" || behaviour.obeys) this.end(signal);
      },
    };
  }
  /** It stops by itself (a crash). */
  crash(code = 101): void {
    this.end(code);
  }
}

class FakeQamp implements QampRunner {
  readonly runs: string[][] = [];
  readonly bridges: FakeBridge[] = [];
  listens = true;
  obeys = true;
  async run(args: string[]) {
    this.runs.push(args);
    if (args[0] === "keygen") {
      writeFileSync(args[2]!, "qamp-sk1.FAKE-KEY-FOR-TESTS\n", { mode: 0o644 });
      return { code: 0, stdout: `${BRIDGE}\n`, stderr: "" };
    }
    if (args[0] === "id") return { code: 0, stdout: `${BRIDGE}\n`, stderr: "" };
    if (args[0] === "delegate") return { code: 0, stdout: `${FAKE_CHAIN}\n`, stderr: "" };
    return { code: 2, stdout: "", stderr: `unexpected: ${args.join(" ")}` };
  }
  serve(args: string[], env: Record<string, string>, line: (text: string) => void): QampProcess {
    const bridge = new FakeBridge(args, env, line, { listens: this.listens, obeys: this.obeys });
    this.bridges.push(bridge);
    return bridge.process;
  }
}

const you = { kind: "admin" as const, scopes: OWNER_SCOPES };

let root: string;
let home: Home;
let db: Database;
let arms: ArmTokens;
let qamp: FakeQamp;
let lines: LedgerEntryInput[];
let logged: string[];
let clock: number;
let free: (address: string, port: number) => boolean;
let address: string;
const made: QampGrants[] = [];

function grants(extra: Partial<ConstructorParameters<typeof QampGrants>[0]> = {}): QampGrants {
  const g = new QampGrants({
    db,
    arms,
    home,
    address: () => address,
    port: 7777,
    runner: qamp,
    mcpCommand: (label, tools) => ["/fake/bun", "/fake/cli.ts", "mcp", "--arm", label, "--tools", tools.join(","), "--home", home.dir],
    ledger: (entry) => void lines.push(entry),
    log: (message) => void logged.push(message),
    now: () => clock,
    ports: { first: 17781, last: 17783 },
    portFree: async (a, p) => free(a, p),
    startMs: 500,
    stopGraceMs: 200,
    ...extra,
  });
  made.push(g);
  return g;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "galahad-qamp-grants-"));
  home = new Home(join(root, "node"));
  home.ensureDir();
  db = new Database(":memory:");
  arms = new ArmTokens(db);
  qamp = new FakeQamp();
  lines = [];
  logged = [];
  clock = Date.UTC(2026, 10, 25, 12, 0);
  free = () => true;
  address = "127.0.0.1";
});

afterEach(async () => {
  await Promise.all(made.splice(0).map((g) => g.stop()));
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("who may grant", () => {
  test("you, at a terminal or on a paired device of yours with fleet:admin; never an agent, a knight, Galahad himself or another node", () => {
    expect(mayGrant(you)).toBe(true);
    expect(mayGrant({ kind: "client", scopes: ["mind:read", "fleet:admin"] })).toBe(true);
    for (const p of [
      { kind: "client" as const, scopes: ["mind:read", "sandbox"] },
      // A full node holds every scope and still isn't you.
      { kind: "node" as const, scopes: OWNER_SCOPES },
      { kind: "arm" as const, label: "claude-code", scopes: ["mind:read", "mind:write"] },
      // Even an arm that somehow held fleet:admin: an arm is an agent.
      { kind: "arm" as const, label: "claude-code", scopes: OWNER_SCOPES },
      { kind: "arm" as const, label: "galahad", scopes: ["mind:read", "mind:write", "sandbox", "chat"] },
      { kind: "arm" as const, label: "team.percival", scopes: ["mind:read", "mind:write", "sandbox", "connect"] },
      { kind: "arm" as const, label: "qamp.0a1b2c3d4e", scopes: ["mind:read"] },
    ]) {
      expect([p.kind, p.label, mayGrant(p)]).toEqual([p.kind, p.label, false]);
    }
  });

  test("the service holds to it too: a refused principal gets nothing minted and nothing started", async () => {
    const g = grants();
    const refused = await g.grant({ agent: AGENT, tools: ["fleet"], ttlSeconds: 3600 }, { kind: "node", scopes: OWNER_SCOPES }).catch((e: QampGrantError) => e);
    expect(refused).toBeInstanceOf(QampGrantError);
    expect((refused as QampGrantError).status).toBe(403);
    expect(arms.list()).toEqual([]);
    expect(qamp.runs).toEqual([]);
    expect(qamp.bridges).toEqual([]);
  });
});

describe("a grant's scopes", () => {
  test("the union of its tools' route scopes: the four read-only tools need mind:read alone", () => {
    expect(grantScopes(["fleet"])).toEqual(["mind:read"]);
    expect(grantScopes(["fleet", "compute", "place", "ledger"])).toEqual(["mind:read"]);
  });

  test("one no arm may hold is refused, not trimmed; so is a tool of Galahad's own, and one that doesn't exist", () => {
    const listAgents: GalahadTool = { name: "list_agents", title: "t", description: "d", input: {}, routes: ["arms"], run: async () => "" };
    const table = [...TOOLS, listAgents];
    const refused = (() => {
      try {
        grantScopes(["fleet", "list_agents"], table);
      } catch (error) {
        return error as QampGrantError;
      }
    })();
    expect(refused?.status).toBe(400);
    expect(refused?.message).toBe("refused: fleet, list_agents would need fleet:admin, which no agent may ever hold");
    expect(() => grantScopes(["team"])).toThrow("team is Galahad's own: no agent is ever given it");
    expect(() => grantScopes(["about_you"])).toThrow("about_you is Galahad's own");
    expect(() => grantScopes(["no_such_tool"])).toThrow("there's no tool named no_such_tool");
  });

  test("a device can't give what it doesn't hold itself", async () => {
    const refused = await grants()
      .grant({ agent: AGENT, tools: ["fleet"], ttlSeconds: 3600 }, { kind: "client", scopes: ["fleet:admin"] })
      .catch((e: QampGrantError) => e);
    expect((refused as QampGrantError).message).toBe("this device doesn't hold mind:read, which those tools need");
    expect(arms.list()).toEqual([]);
  });
});

describe("a grant made", () => {
  test("its arm holds only its tools' scopes, its token is a 0600 file, its chain is the agent's, its bridge lets that key alone in", async () => {
    const g = grants();
    const { grant, proof } = await g.grant({ agent: AGENT, tools: ["fleet", "compute"], ttlSeconds: 3600 }, you);
    expect(proof).toBe(FAKE_CHAIN);
    expect(grant).toMatchObject({ label: `qamp.${grant.id}`, agent: AGENT, tools: ["fleet", "compute"], scopes: ["mind:read"], createdAt: clock, endsAt: clock + 3_600_000, url: `qamp://${BRIDGE}@127.0.0.1:17781`, bridge: { state: "up", why: null } });
    expect(grant.id).toMatch(/^[0-9a-f]{10}$/);
    expect(arms.get(grant.label)?.scopes).toEqual(["mind:read"]);
    const tokenFile = home.armTokenPath(grant.label);
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    expect(arms.verify(readFileSync(tokenFile, "utf8").trim())?.label).toBe(grant.label);
    // The bridge key: made once, 0600, in a folder of the node's own, never the node's key.
    const key = join(home.dir, "qamp", "bridge.qamp-key");
    expect(qamp.runs[0]).toEqual(["keygen", "--out", key]);
    expect(statSync(key).mode & 0o777).toBe(0o600);
    expect(statSync(join(home.dir, "qamp")).mode & 0o777).toBe(0o700);
    expect(qamp.runs[1]).toEqual(["delegate", "--key", key, "--to", AGENT, "--cmd", "/tool/galahad", "--ttl", "3600"]);
    const bridge = qamp.bridges[0]!;
    expect(bridge.args).toEqual([
      "serve", "--key", key, "--listen", "127.0.0.1:17781", "--allow", AGENT, "--mcp-stdio", "--only", "fleet,compute", "--prefix", "galahad",
      "--", "/fake/bun", "/fake/cli.ts", "mcp", "--arm", grant.label, "--tools", "fleet,compute", "--home", home.dir,
    ]);
    // Its environment is what its MCP server needs to reach this node, nothing else of the daemon's.
    expect(Object.keys(bridge.env).sort()).toEqual(["GALAHAD_HOME", "GALAHAD_PORT", "HOME", "PATH", ...(process.env.TMPDIR ? ["TMPDIR"] : [])].sort());
    expect(bridge.env.GALAHAD_PORT).toBe("7777");
    expect(g.list()).toEqual([grant]);
  });

  test("a second grant: the bridge key is read, not made again, and the bridge gets a port of its own", async () => {
    const g = grants();
    await g.grant({ agent: AGENT, tools: ["fleet"], ttlSeconds: 60 }, you);
    // Port 17782 is something else's on this machine: passed over.
    free = (_a, port) => port !== 17782;
    const second = await g.grant({ agent: AGENT, tools: ["ledger"], ttlSeconds: 60 }, you);
    expect(second.grant.url).toEndWith("@127.0.0.1:17783");
    expect(qamp.runs.filter((r) => r[0] === "keygen")).toHaveLength(1);
    // A node started again reads its key's name back.
    const again = grants();
    await again.grant({ agent: AGENT, tools: ["place"], ttlSeconds: 60 }, { kind: "client", scopes: OWNER_SCOPES }).catch((e: Error) => e);
    expect(qamp.runs.filter((r) => r[0] === "id")).toHaveLength(1);
  });

  test("no port left: refused, saying so, and nothing is minted", async () => {
    const g = grants({ ports: { first: 17781, last: 17781 } });
    await g.grant({ agent: AGENT, tools: ["fleet"], ttlSeconds: 60 }, you);
    const refused = await g.grant({ agent: AGENT, tools: ["compute"], ttlSeconds: 60 }, you).catch((e: QampGrantError) => e);
    expect((refused as QampGrantError).status).toBe(409);
    expect((refused as QampGrantError).message).toContain("every Q-AMP port of this node is in use (17781–17781, one a grant)");
    expect(arms.list()).toHaveLength(1);
  });

  test("every way of writing every interface is one, and refused; a real address is none of them", () => {
    for (const any of ["0.0.0.0", "0", "::", "::0", "0:0::0", "0:0:0:0:0:0:0:0", "[::]", "::ffff:0.0.0.0", "", "not an address"]) expect([any, unspecified(any)]).toEqual([any, true]);
    for (const one of ["192.0.2.7", "127.0.0.1", "fd7a:115c:a1e0::1", "::1", "[fd7a:115c:a1e0::1]"]) expect([one, unspecified(one)]).toEqual([one, false]);
  });

  test("never on every interface: with no address but 0.0.0.0 or ::, refused before anything is made", async () => {
    for (const any of ["0.0.0.0", "::", "::0", ""]) {
      address = any;
      const refused = await grants().grant({ agent: AGENT, tools: ["fleet"], ttlSeconds: 60 }, you).catch((e: QampGrantError) => e);
      expect([any, (refused as QampGrantError).status]).toEqual([any, 424]);
    }
    expect(arms.list()).toEqual([]);
    expect(qamp.bridges).toEqual([]);
  });

  test("an IPv6 tailnet address is bracketed, where it listens and in the agent's URL", async () => {
    address = "fd7a:115c:a1e0::1";
    const { grant } = await grants().grant({ agent: AGENT, tools: ["fleet"], ttlSeconds: 60 }, you);
    expect(qamp.bridges[0]!.args).toContain("[fd7a:115c:a1e0::1]:17781");
    expect(grant.url).toBe(`qamp://${BRIDGE}@[fd7a:115c:a1e0::1]:17781`);
  });

  test("a bridge that never listens: the grant isn't made, and its arm and token are gone again", async () => {
    qamp.listens = false;
    const g = grants();
    const refused = await g.grant({ agent: AGENT, tools: ["fleet"], ttlSeconds: 60 }, you).catch((e: QampGrantError) => e);
    expect((refused as QampGrantError).status).toBe(502);
    expect((refused as QampGrantError).message).toStartWith("the grant's bridge didn't start: it didn't start listening in time");
    expect(qamp.bridges[0]!.signals).toEqual(["SIGKILL"]);
    expect(arms.list()).toEqual([]);
    expect(g.list()).toEqual([]);
    const label = lines.at(-1)!.target;
    expect(existsSync(home.armTokenPath(label))).toBe(false);
    expect(lines.at(-1)).toMatchObject({ class: "delete", resource: "qamp", reason: "the grant wasn't made, so its arm was deleted" });
  });
});

describe("the ledger", () => {
  test("a line for each step: the bridge key (once), the arm, the chain, the bridge; and at its end, the arm deleted, the bridge stopped", async () => {
    const g = grants();
    const { grant } = await g.grant({ agent: AGENT, tools: ["fleet", "compute"], ttlSeconds: 3600 }, you);
    expect(lines.map((l) => [l.class, l.resource, l.target, l.verdict])).toEqual([
      ["create", "qamp", "bridge key", "allow"],
      ["create", "qamp", grant.label, "allow"],
      ["create", "qamp", grant.label, "allow"],
      ["create", "qamp", grant.label, "allow"],
    ]);
    expect(lines[0]!.detail).toBe(BRIDGE);
    expect(lines[1]!.detail).toBe(`agent ${AGENT} · tools fleet, compute · scopes mind:read · until 2026-11-25T13:00:00.000Z`);
    expect(lines[2]!.detail).toBe(`to ${AGENT} · ends 2026-11-25T13:00:00.000Z`);
    expect(lines[3]!.detail).toBe("listening on 127.0.0.1:17781");
    // Nothing secret in any of them: no token, no chain.
    expect(JSON.stringify(lines)).not.toContain("arm_");
    expect(JSON.stringify(lines)).not.toContain("qdt1.");
    lines = [];
    await g.revoke(grant.id);
    expect(lines.map((l) => [l.class, l.target, l.reason])).toEqual([
      ["delete", grant.label, "the grant ended (you revoked it): its arm is deleted, so the agent's next call is refused"],
      ["delete", grant.label, "the grant ended (you revoked it): its bridge stopped"],
    ]);
  });
});

describe("a grant ended", () => {
  test("revoked: its arm is gone (its token no longer opens the door), its token file too, then its bridge is told to stop", async () => {
    const g = grants();
    const { grant } = await g.grant({ agent: AGENT, tools: ["fleet"], ttlSeconds: 3600 }, you);
    const token = readFileSync(home.armTokenPath(grant.label), "utf8").trim();
    expect(await g.revoke(grant.id)).toBe(true);
    expect(arms.get(grant.label)).toBeNull();
    expect(arms.verify(token)).toBeNull();
    expect(existsSync(home.armTokenPath(grant.label))).toBe(false);
    expect(qamp.bridges[0]!.signals).toEqual(["SIGTERM"]);
    expect(g.list()).toEqual([]);
    expect(await g.revoke(grant.id)).toBe(false);
  });

  test("its time up: the next look ends it, and its bridge is stopped; one still in force is left alone", async () => {
    const g = grants();
    const short = await g.grant({ agent: AGENT, tools: ["fleet"], ttlSeconds: 60 }, you);
    const long = await g.grant({ agent: AGENT, tools: ["ledger"], ttlSeconds: 3600 }, you);
    clock += 59_999;
    expect(await g.sweep()).toBe(0);
    clock += 1;
    expect(await g.sweep()).toBe(1);
    expect(qamp.bridges[0]!.signals).toEqual(["SIGTERM"]);
    expect(qamp.bridges[1]!.signals).toEqual([]);
    expect(arms.get(short.grant.label)).toBeNull();
    expect(arms.get(long.grant.label)).not.toBeNull();
    expect(lines.filter((l) => l.class === "delete").map((l) => l.reason)).toEqual([
      "the grant ended (its time was up): its arm is deleted, so the agent's next call is refused",
      "the grant ended (its time was up): its bridge stopped",
    ]);
  });

  test("every one at once", async () => {
    const g = grants();
    await g.grant({ agent: AGENT, tools: ["fleet"], ttlSeconds: 60 }, you);
    await g.grant({ agent: AGENT, tools: ["ledger"], ttlSeconds: 60 }, you);
    expect(await g.revokeAll()).toBe(2);
    expect(arms.list()).toEqual([]);
    expect(qamp.bridges.map((b) => b.signals)).toEqual([["SIGTERM"], ["SIGTERM"]]);
  });

  test("a bridge that won't stop when told is killed", async () => {
    qamp.obeys = false;
    const g = grants();
    const { grant } = await g.grant({ agent: AGENT, tools: ["fleet"], ttlSeconds: 60 }, you);
    await g.revoke(grant.id);
    expect(qamp.bridges[0]!.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(lines.at(-1)!.detail).toBe("it didn't stop when told to, so it was killed");
  });
});

describe("while the daemon runs, and when it stops and starts", () => {
  test("a bridge that stops by itself is started again, on the same port", async () => {
    const g = grants();
    const { grant } = await g.grant({ agent: AGENT, tools: ["fleet"], ttlSeconds: 3600 }, you);
    qamp.bridges[0]!.crash();
    await Bun.sleep(10);
    expect(g.list()[0]!.bridge.state).toBe("down");
    expect(g.list()[0]!.bridge.why).toStartWith("its bridge stopped (101)");
    await Bun.sleep(1_100);
    expect(qamp.bridges).toHaveLength(2);
    expect(qamp.bridges[1]!.args).toContain("127.0.0.1:17781");
    expect(g.list()[0]!.bridge.state).toBe("up");
    expect(logged.some((l) => l.startsWith(`qamp ${grant.label}: its bridge stopped (101); started again in 1 s`))).toBe(true);
  });

  test("stopping the daemon stops its bridges and keeps its grants; starting it starts them again, ends the ones whose time ran out, and deletes an arm no grant holds", async () => {
    const first = grants();
    const kept = await first.grant({ agent: AGENT, tools: ["fleet"], ttlSeconds: 3600 }, you);
    const lapsing = await first.grant({ agent: AGENT, tools: ["ledger"], ttlSeconds: 60 }, you);
    await first.stop();
    expect(qamp.bridges.map((b) => b.signals)).toEqual([["SIGTERM"], ["SIGTERM"]]);
    expect(arms.list().map((a) => a.label).sort()).toEqual([kept.grant.label, lapsing.grant.label].sort());
    // A grant that was never made, its arm left behind (a node that stopped in the middle of one).
    arms.mint("qamp.ffffffffff", ["mind:read"]);
    clock += 120_000;
    const second = grants();
    await second.resume(0);
    expect(second.list().map((x) => [x.id, x.bridge.state])).toEqual([[kept.grant.id, "up"]]);
    expect(qamp.bridges).toHaveLength(3);
    expect(qamp.bridges[2]!.args).toContain(kept.grant.label);
    expect(arms.list().map((a) => a.label)).toEqual([kept.grant.label]);
    expect(lines.filter((l) => l.target === lapsing.grant.label && l.class === "delete").map((l) => l.reason)).toEqual(["the grant ended (its time was up): its arm is deleted, so the agent's next call is refused"]);
  });

  test("a bridge left running by a node that died (no stop of its own) is stopped when the node starts again, its port freed for the new one", async () => {
    const first = grants();
    const kept = await first.grant({ agent: AGENT, tools: ["fleet"], ttlSeconds: 3600 }, you);
    const lapsing = await first.grant({ agent: AGENT, tools: ["ledger"], ttlSeconds: 60 }, you);
    // The node is killed: its bridges never hear of it (no stop()), and run on.
    const killed: [number, string][] = [];
    const running = new Map(qamp.bridges.map((b, i) => [4100 + i, `qamp serve --key k --listen 127.0.0.1:1 -- bun cli.ts mcp --arm ${b.args[b.args.indexOf("--arm") + 1]} --tools fleet`]));
    // A pid that's now some other process: never touched.
    running.set(4200, "/usr/bin/some-other-thing");
    const strays = { command: (pid: number) => running.get(pid) ?? null, kill: (pid: number, signal: string) => void (killed.push([pid, signal]), running.delete(pid)) };
    db.query("UPDATE qamp_grants SET pid = 4200 WHERE id = ?").run(lapsing.grant.id);
    db.query("UPDATE qamp_grants SET pid = 4100 WHERE id = ?").run(kept.grant.id);
    clock += 120_000;
    const second = grants({ strays });
    await second.resume(0);
    expect(killed).toEqual([[4100, "SIGTERM"]]);
    expect(second.list().map((g) => [g.id, g.bridge.state])).toEqual([[kept.grant.id, "up"]]);
    expect(running.has(4200)).toBe(true);
    expect(logged).toContain(`qamp: stopped qamp.${kept.grant.id}'s bridge, left running by a node that didn't stop it (pid 4100)`);
  });

  test("a stopping node makes no new grant", async () => {
    const g = grants();
    await g.stop();
    const refused = await g.grant({ agent: AGENT, tools: ["fleet" as QampTool], ttlSeconds: 60 }, you).catch((e: QampGrantError) => e);
    expect((refused as QampGrantError).status).toBe(503);
  });
});
