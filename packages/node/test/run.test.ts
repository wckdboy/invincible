import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { foundFleet, MindStore } from "@galahad/mind";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { runWithToken, STOP_SIGNALS, WAIT_SIGNALS } from "../src/run-tool.ts";
import { freePort } from "./ports.ts";

/*
 * `galahad run -- <tool>` gives the tool a scoped gateway token and revokes it when the
 * tool exits, and also when galahad run itself is stopped by a signal. Against a real
 * daemon in a temp home. (Signals can't be caught on Windows, so this runs elsewhere.)
 */

const caps: Capabilities = {
  os: "linux",
  arch: "x64",
  hostname: "run-test",
  cores: 4,
  cpu: "test",
  memoryGb: 8,
  hasBattery: false,
  gpu: [],
  docker: false,
  vm: { kvm: false, tools: [] },
  tools: [],
  localModels: [],
  tailscale: null,
};

const root = mkdtempSync(join(tmpdir(), "galahad-run-"));
const home = new Home(join(root, "node"));
const port = freePort();
let daemon: Daemon;

beforeAll(async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const store = new MindStore(home.mindPath);
  const fleet = foundFleet(store, identity, { fleetName: "camelot", nodeName: "run-node" });
  store.close();
  home.writeConfig({ v: 1, name: "run-node", fleet, port, keystore, advertise: "127.0.0.1" });
  daemon = await startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {} });
});

afterAll(async () => {
  await daemon?.stop();
  rmSync(root, { recursive: true, force: true });
});

/** Whether the gateway still takes a token: a live one gets past the token check (to "not configured"). */
async function live(token: string): Promise<boolean> {
  const response = await fetch(`http://127.0.0.1:${port}/gw/nowhere/v1/models`, { headers: { authorization: `Bearer ${token}` } });
  return response.status !== 401;
}

describe("a tool's token lives as long as the tool", () => {
  /** A tool that runs until it's stopped, and the signals galahad run listens to. */
  function fakes() {
    let exit: (code: number) => void = () => {};
    const child = { exited: new Promise<number>((r) => (exit = r)), killed: [] as string[], kill: (signal?: string) => void (child.killed.push(signal ?? "SIGTERM"), exit(143)) };
    const signals = new EventEmitter();
    const revoked: string[] = [];
    return { child, signals, revoked, exit: (code: number) => exit(code), revoke: async () => void revoked.push("token") };
  }

  test("the tool exits: the token is revoked, once, before galahad run returns its code", async () => {
    const f = fakes();
    const done = runWithToken(() => f.child, f.revoke, f.signals);
    f.exit(3);
    expect(await done).toBe(3);
    expect(f.revoked).toEqual(["token"]);
    expect([...STOP_SIGNALS, ...WAIT_SIGNALS].every((s) => f.signals.listenerCount(s) === 0)).toBe(true);
  });

  test("Ctrl+C is the tool's to take: galahad run outlives it, and revokes when the tool exits", async () => {
    const f = fakes();
    const done = runWithToken(() => f.child, f.revoke, f.signals);
    f.signals.emit("SIGINT", "SIGINT");
    await Bun.sleep(10);
    // An interactive tool cancelled what it was doing and carries on, with its token.
    expect(f.child.killed).toEqual([]);
    expect(f.revoked).toEqual([]);
    f.exit(130);
    expect(await done).toBe(130);
    expect(f.revoked).toEqual(["token"]);
  });

  for (const signal of STOP_SIGNALS) {
    test(`galahad run gets ${signal}: the tool is stopped the same way, and the token revoked`, async () => {
      const f = fakes();
      const done = runWithToken(() => f.child, f.revoke, f.signals);
      f.signals.emit(signal, signal);
      f.signals.emit(signal, signal); // pressed twice: still one revocation
      expect(await done).toBe(143);
      expect(f.child.killed[0]).toBe(signal);
      expect(f.revoked).toEqual(["token"]);
    });
  }

  test("a node that doesn't answer can't keep galahad run from exiting", async () => {
    const f = fakes();
    const done = runWithToken(() => f.child, () => new Promise(() => {}), f.signals, 50);
    f.exit(0);
    expect(await done).toBe(0);
  });
});

describe("galahad run", () => {
  test("the tool gets a live token, and it's dead once the tool is done", async () => {
    // The tool checks its own token while it runs, then exits.
    const check = `const r = await fetch("http://127.0.0.1:${port}/gw/nowhere/v1/models", { headers: { authorization: "Bearer " + process.env.OPENAI_API_KEY } }); console.log(process.env.OPENAI_API_KEY, r.status)`;
    const proc = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/cli.ts"), "run", "--home", home.dir, "--", process.execPath, "-e", check], {
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, GALAHAD_KEYSTORE: "file" },
    });
    const [token, status] = (await new Response(proc.stdout).text()).trim().split(" ") as [string, string];
    expect(await proc.exited).toBe(0);
    expect(token).toMatch(/^gw_/);
    expect(status).not.toBe("401");
    expect(await live(token)).toBe(false);
  });

  // A terminal's Ctrl+C reaches the whole foreground group, the tool included; a kill or a hang-up reaches galahad run.
  for (const [signal, toTool] of [["SIGTERM", false], ["SIGHUP", false], ["SIGINT", true]] as const) {
    test.skipIf(process.platform === "win32")(`stopped by ${signal}, it revokes the tool's token`, async () => {
      const proc = Bun.spawn(
        [process.execPath, resolve(import.meta.dir, "../src/cli.ts"), "run", "--home", home.dir, "--", process.execPath, "-e", "console.log(process.env.OPENAI_API_KEY, process.pid); setInterval(() => {}, 1000)"],
        { stdout: "pipe", stderr: "ignore", env: { ...process.env, GALAHAD_KEYSTORE: "file" } },
      );
      const reader = proc.stdout.getReader();
      let out = "";
      while (!out.includes("\n")) {
        const { value, done } = await reader.read();
        if (done) break;
        out += new TextDecoder().decode(value);
      }
      const [token, pid] = out.trim().split(" ") as [string, string];
      expect(token).toMatch(/^gw_/);
      expect(await live(token)).toBe(true);
      proc.kill(signal);
      if (toTool) process.kill(Number(pid), signal);
      await proc.exited;
      expect(await live(token)).toBe(false);
    });
  }
});

describe("galahad provider presets", () => {
  test("its columns stay in line, however long a preset's id", async () => {
    const proc = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/cli.ts"), "provider", "presets", "--home", home.dir], {
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, GALAHAD_KEYSTORE: "file" },
    });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    // Where each row's kind begins: the same column on every row, the longest id's (volcengine-coding) included.
    const starts = out.split("\n").flatMap((line) => {
      const row = /^ {2}(\S+)( +)(?:openai|anthropic)\b/.exec(line);
      return row ? [row[1]!.length + row[2]!.length] : [];
    });
    expect(starts.length).toBeGreaterThan(20);
    expect(new Set(starts).size).toBe(1);
  });
});
