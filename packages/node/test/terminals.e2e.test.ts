import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bodyFingerprint, ceilingThreads, KERNEL, type LedgerEntry, REFERENCE_SINGLE, type RouteName, routes, type SandboxView, type TerminalEvent, type TerminalView } from "@galahad/core";
import { foundFleet, MindStore } from "@galahad/mind";
import { containerName, spawnTerminal } from "@galahad/sandbox";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { fakeDocker } from "./fake-docker.ts";
import { freePort } from "./ports.ts";

// The real node over HTTP; Docker is a stand-in, and the terminal's process a local shell where `docker exec` would run.
const root = mkdtempSync(join(tmpdir(), "galahad-terminals-"));
const home = new Home(join(root, "node"));
const port = freePort();
const caps: Capabilities = { os: "linux", arch: "x64", hostname: "terminals-test", cores: 8, cpu: "test", memoryGb: 16, hasBattery: false, gpu: [], docker: true, vm: { kvm: false, tools: [] }, tools: ["docker"], localModels: [], tailscale: null, sandbox: { image: true, networks: true } };
const docker = fakeDocker();
/** What each terminal's process was started as. */
const started: string[][] = [];
let daemon: Daemon;
let arm: string;
/** The one sandbox the terminals here are opened in (a node's slots are few). */
let sandbox: SandboxView;

async function call(name: RouteName, input: unknown, token = home.adminToken()): Promise<Response> {
  const route = routes[name];
  return fetch(`http://127.0.0.1:${port}${route.path}`, {
    method: route.method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined,
  });
}
async function api<T = any>(name: RouteName, input?: unknown): Promise<T> {
  const response = await call(name, input);
  const body = (await response.json()) as { error?: string; status?: number };
  // (A long answer that fails after it began is `{ error, status }` under a 200.)
  if (!response.ok || body.error) throw new Error(`${name}: ${response.status} ${body.error ?? "request failed"}`);
  return body as T;
}

/** A watched terminal: its events as they come, and what it has shown as text. */
function watching(response: Response) {
  const events: TerminalEvent[] = [];
  let ended = false;
  const done = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of response.body!) {
        buffer += decoder.decode(chunk, { stream: true });
        let at: number;
        while ((at = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          if (block.startsWith("data: ")) events.push(JSON.parse(block.slice(6)) as TerminalEvent);
        }
      }
    } catch {
      // (Watching that was let go, or the node stopping: the watching ends, as it does for a phone.)
    }
    ended = true;
  })();
  const shown = () => events.map((e) => (e.type === "output" ? Buffer.from(e.data, "base64").toString("utf8") : `[exit ${e.code}]`)).join("");
  return { events, shown, done, ended: () => ended };
}

async function until(what: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

beforeAll(async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const mind = new MindStore(home.mindPath);
  const fleet = foundFleet(mind, identity, { fleetName: "camelot", nodeName: "keep" });
  mind.close();
  home.writeConfig({ v: 1, name: "keep", fleet, port, keystore, advertise: "127.0.0.1" });
  daemon = await startDaemon(home, {
    capabilities: caps,
    proxyPort: freePort(),
    log: () => {},
    docker: docker.runner,
    spawnTerminal: (argv, size, onData) => {
      started.push(argv);
      return spawnTerminal(["sh"], size, onData);
    },
    measure: async (reason, body, limit) => {
      const threads = ceilingThreads(body, limit);
      return { at: Date.now(), tookMs: 1, reason, body: bodyFingerprint(body, limit), cpu: { single: REFERENCE_SINGLE, multi: REFERENCE_SINGLE * threads, threads, kernel: KERNEL } };
    },
    shutdownGraceMs: 100,
    defaultHeartbeat: false,
    archiveIntervalMs: false,
  });
  // Its sandbox slots follow from what it measured of itself.
  await until(() => daemon.store.lww(`calibration:${daemon.identity.id}`) !== null);
  arm = (await api<{ token: string }>("mintArm", { label: "outside-agent", scopes: ["sandbox"] })).token;
  sandbox = (await api<{ sandbox: SandboxView }>("createSandbox", { network: "isolated" })).sandbox;
}, 30_000);

afterAll(async () => {
  await daemon?.stop();
  rmSync(root, { recursive: true, force: true });
});

describe("a terminal in a sandbox, over the node's routes", () => {
  setDefaultTimeout(20_000);

  test("you open one, watch it and type into it; it is `docker exec --tty` into that sandbox; closing it ends the watching", async () => {
    const { terminal } = await api<{ terminal: TerminalView }>("openTerminal", { sandbox: sandbox.id, size: { cols: 90, rows: 25 } });
    expect(terminal).toMatchObject({ sandbox: sandbox.id, name: sandbox.name, cols: 90, rows: 25, exitCode: null });
    expect(started.at(-1)).toEqual(["docker", "exec", "--interactive", "--tty", "--workdir", "/work", "--env", "TERM=xterm-256color", "--env", expect.stringMatching(/^GALAHAD_TERMINAL=[0-9a-f]{16}$/), containerName(sandbox.id), "sh", "-c", "command -v bash >/dev/null 2>&1 && exec bash -l || exec sh -l"]);
    const tag = started.at(-1)![9]!.split("=")[1]!;

    const response = await call("watchTerminal", { terminal: terminal.id });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const screen = watching(response);
    await api("terminalInput", { terminal: terminal.id, data: "echo $((6 * 7)); stty size\n" });
    await until(() => /42\r?\n25 90/.test(screen.shown()));
    await api("terminalInput", { terminal: terminal.id, size: { cols: 100, rows: 30 }, data: "stty size\n" });
    await until(() => /30 100/.test(screen.shown()));
    expect((await api<{ terminals: TerminalView[] }>("terminals")).terminals).toEqual([expect.objectContaining({ id: terminal.id, cols: 100, rows: 30, watchers: 1 })]);

    expect(await api("closeTerminal", { terminal: terminal.id })).toEqual({ closed: true });
    await screen.done;
    expect(screen.events.at(-1)?.type).toBe("exit");
    expect((await api<{ terminals: TerminalView[] }>("terminals")).terminals).toEqual([]);
    // Docker leaves what an exec started running when its client goes: what this terminal started is hung up in there.
    await until(() => docker.execs.some((e) => e.container === containerName(sandbox.id) && e.cmd.at(-1) === tag));
    expect(docker.execs.find((e) => e.cmd.at(-1) === tag)!.cmd.slice(0, 2)).toEqual(["sh", "-c"]);

    // The ledger (newest first) says it was opened and closed, in that sandbox; what was typed and shown is nowhere in it.
    const entries = (await api<{ entries: LedgerEntry[] }>("ledger")).entries.filter((e) => e.resource === "sandbox.terminal");
    expect(entries.map((e) => [e.target, e.detail])).toEqual([
      [sandbox.name, expect.stringMatching(/^closed after 0m \ds: you closed it$/)],
      [sandbox.name, "opened (90×25)"],
    ]);
    expect(JSON.stringify(await api("ledger"))).not.toContain("6 * 7");
  });

  test("a device that leaves and comes back is shown the screen as it was, then what comes", async () => {
    const { terminal } = await api<{ terminal: TerminalView }>("openTerminal", { sandbox: sandbox.id, size: { cols: 80, rows: 24 } });
    const first = new AbortController();
    const away = watching(await fetch(`http://127.0.0.1:${port}${routes.watchTerminal.path}`, { method: "POST", headers: { authorization: `Bearer ${home.adminToken()}`, "content-type": "application/json" }, body: JSON.stringify({ terminal: terminal.id }), signal: first.signal }));
    await api("terminalInput", { terminal: terminal.id, data: "echo the code is WXYZ-$((1000 + 234))\n" });
    await until(() => away.shown().includes("WXYZ-1234"));
    first.abort();
    await away.done;
    const back = watching(await call("watchTerminal", { terminal: terminal.id }));
    await until(() => back.shown().includes("WXYZ-1234"));
    await api("terminalInput", { terminal: terminal.id, data: "exit 7\n" });
    await back.done;
    expect(back.events.at(-1)).toEqual({ type: "exit", code: 7 });
    // Its shell ended by itself: it is still listed a while, with how it ended.
    expect((await api<{ terminals: TerminalView[] }>("terminals")).terminals.find((t) => t.id === terminal.id)?.exitCode).toBe(7);
    expect((await call("terminalInput", { terminal: terminal.id, data: "ls\n" })).status).toBe(409);
  });

  test("a terminal is yours alone: an agent that may use sandboxes opens none and sees none", async () => {
    const refused = await call("openTerminal", { sandbox: sandbox.id, size: { cols: 80, rows: 24 } }, arm);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toMatch(/yours alone/);
    expect((await call("terminals", undefined, arm)).status).toBe(403);
  });

  test("what isn't there is a plain refusal, never an empty stream: an unknown terminal, a sandbox that isn't here", async () => {
    const unknown = await call("watchTerminal", { terminal: "tm_aaaaaaaaaaaaaaaa" });
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("content-type")).toContain("application/json");
    expect((await call("openTerminal", { sandbox: "abcdef0123", size: { cols: 80, rows: 24 } })).status).toBe(404);
    // Sizes and keys are held to their bounds at the boundary.
    expect((await call("openTerminal", { sandbox: "abcdef0123", size: { cols: 9000, rows: 24 } })).status).toBe(400);
    expect((await call("terminalInput", { terminal: "tm_aaaaaaaaaaaaaaaa", data: "x".repeat(70_000) })).status).toBe(400);
  });
});
