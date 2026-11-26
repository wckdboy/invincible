import { describe, expect, test } from "bun:test";
import type { RouteName, TeamTask, TeamTrailEntry } from "@invincible/core";
import type { NodeClient } from "../../src/inv/client.ts";
import type { Connection } from "../../src/inv/connect.ts";
import { EXIT } from "../../src/inv/exit.ts";
import type { Flags } from "../../src/inv/io.ts";
import { giveCommand, watchCommand } from "../../src/inv/work.ts";
import { action, gated, reviewed, snapshot, task, testIo, trail, worked } from "./fixtures.ts";

/*
 * inv give and inv watch as a script reads them (docs/CLI.md): one object with --json, NDJSON with --stream, and the
 * exit code the verdict, against a node scripted look by look. When inv leaves first, the object's exit is the code it
 * exits with.
 */

const flags = (over: Partial<Flags> = {}): Flags => ({ json: false, stream: false, wait: false, noAsk: false, gate: [], forTask: false, needsYou: false, working: false, done: false, week: false, forget: false, help: false, ...over });

/** A node whose task stands as `looks` say, one look after another (a look ends when its trail is read). */
function scripted(looks: { task: Partial<TeamTask>; entries?: TeamTrailEntry[]; asks?: boolean }[]) {
  let look = 0;
  const asked: RouteName[] = [];
  const now = () => looks[Math.min(look, looks.length - 1)]!;
  const client: NodeClient = {
    label: "a scripted node",
    async call<T>(name: RouteName, input?: unknown): Promise<T> {
      asked.push(name);
      switch (name) {
        case "team":
          return snapshot([task(now().task)]) as T;
        case "teamTrail": {
          const after = (input as { after: number }).after;
          const page = { entries: (now().entries ?? []).filter((entry) => entry.n > after), more: false };
          look += 1;
          return page as T;
        }
        case "actions":
          return { actions: now().asks ? [action()] : [] } as T;
        case "directAgent":
          return { room: { id: "dm-ada" } } as T;
        case "createTeamTask":
          return { task: task({ status: "queued" }) } as T;
        case "usage":
          return { node: "keep", since: "", rows: [], prices: {} } as T;
        case "fleet":
          return { fleet: "f", name: "home", self: "n_keep", devices: [], peers: [], events: 0, digest: "" } as T;
        case "projects":
          return { projects: [] } as T;
        default:
          return {} as T;
      }
    },
    async *events(): AsyncGenerator<string> {},
  };
  return { conn: async (): Promise<Connection> => ({ client, how: "paired", pairing: null }), asked };
}

const lines = trail([...worked([1]), ...gated([0]), ...reviewed("pass")]);

describe("inv give, as a script reads it", () => {
  test("--wait --json: one object, the proof, and the verdict as the exit code", async () => {
    const node = scripted([{ task: { status: "running" }, entries: lines.slice(0, 4) }, { task: { status: "done", verified: true }, entries: lines }]);
    const io = testIo({});
    expect(await giveCommand(node.conn, ["Fix it"], flags({ agent: "ada", wait: true, json: true }), io)).toBe(EXIT.ok);
    const out = io.stdout().trim().split("\n");
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toMatchObject({ state: "verified", exit: 0, task: "task-a1b2c3d4e5f6" });
  });

  test("--timeout: it leaves, the task goes on, and the object's exit is the code inv exits with (21)", async () => {
    const node = scripted([{ task: { status: "running" }, entries: lines.slice(0, 4), asks: true }]);
    const io = testIo({});
    expect(await giveCommand(node.conn, ["Fix it"], flags({ agent: "ada", timeout: "0.05s", json: true }), io)).toBe(EXIT.stillRunning);
    expect(JSON.parse(io.stdout())).toMatchObject({ state: "needs-you", exit: 21 });
    expect(node.asked).not.toContain("controlTeam");
  });

  test("--no-ask: a task that comes to need you is stopped, and it exits 20", async () => {
    const node = scripted([{ task: { status: "running" }, entries: lines.slice(0, 4) }, { task: { status: "running" }, entries: lines.slice(0, 4), asks: true }]);
    const io = testIo({});
    expect(await giveCommand(node.conn, ["Fix it"], flags({ agent: "ada", noAsk: true, json: true }), io)).toBe(EXIT.needsYou);
    expect(JSON.parse(io.stdout())).toMatchObject({ state: "needs-you", exit: 20 });
    expect(node.asked).toContain("controlTeam");
  });

  test("--stream: NDJSON alone on stdout, task.started first, the end last with the proof", async () => {
    const node = scripted([{ task: { status: "queued" } }, { task: { status: "running" }, entries: lines.slice(0, 6) }, { task: { status: "done", verified: true }, entries: lines }]);
    const io = testIo({});
    expect(await giveCommand(node.conn, ["Fix it"], flags({ agent: "ada", stream: true }), io)).toBe(EXIT.ok);
    const events = io.stdout().trim().split("\n").map((line) => JSON.parse(line));
    expect(events[0]).toMatchObject({ v: 1, type: "task.started", task: "task-a1b2c3d4e5f6", agent: "ada", room: "dm-ada", why: null, gates: ["bun test packages/link"] });
    expect(events.at(-1)).toMatchObject({ type: "task.verified", exit: 0, proof: { state: "verified" } });
    expect(events.map((event) => event.type)).toContain("gate.result");
    expect(events.filter((event) => event.type === "task.state").map((event) => event.state)).toEqual(["queued", "running", "done"]);
    expect(io.stderr()).toBe("");
  });
});

describe("inv watch", () => {
  test("piped: its steps folded as they finish, then the proof; the exit code is the verdict", async () => {
    const node = scripted([{ task: { status: "running" }, entries: lines.slice(0, 5) }, { task: { status: "failed", error: "unverified" }, entries: trail([...worked([1]), ...gated([1])]) }]);
    const io = testIo({});
    expect(await watchCommand(node.conn, ["task-a1b2c3d4e5f6"], flags(), io)).toBe(EXIT.gateFailed);
    const out = io.stdout();
    expect(out).toContain("· Planned the work");
    expect(out).toContain("· Read sync.ts");
    expect(out).toContain("✗ Gate 1 of 1 · failed, exit 1 · bun test packages/link");
    expect(out).toContain("Failed · gate 1 · gate 1 of 1 didn't pass");
    expect(out).not.toContain("\x1b");
  });
});
