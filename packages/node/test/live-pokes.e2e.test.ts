import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RouteName, routes } from "@invincible/core";
import { foundFleet, LedgerStore } from "@invincible/ledger";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { LOOK_MS } from "../src/live.ts";
import { freePort } from "./ports.ts";

/*
 * What moves in the background reaches your devices' live streams as it moves (speed, 28 November 2026): a turn that
 * ends while nobody asks anything is told within a few milliseconds, not at the stream's next look. Before, only the
 * mind's events and requests poked the stream, and it looked every LOOK_MS (250 ms) for the rest: a task's change reached
 * a client 144 ms after it at the median (Ultra), a uniform wait of up to a look.
 */

const caps: Capabilities = {
  os: "linux",
  arch: "x64",
  hostname: "live-pokes-test",
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

const root = mkdtempSync(join(tmpdir(), "invincible-live-pokes-"));
const home = new Home(join(root, "node"));
const port = freePort();
let daemon: Daemon;

/** A model that answers after a while, as one does: the turn ends then, with nothing asked of the node. */
const model = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch() {
    await Bun.sleep(40);
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "Done." } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  },
});

const admin = (name: RouteName, input?: unknown, signal?: AbortSignal) => {
  const route = routes[name];
  return fetch(`http://127.0.0.1:${port}${route.path}`, { method: route.method, headers: { authorization: `Bearer ${home.adminToken()}`, "content-type": "application/json" }, ...(route.method === "POST" ? { body: JSON.stringify(input ?? {}) } : {}), ...(signal ? { signal } : {}) });
};

/** A device's live stream: each message with when it came. */
async function listen(signal: AbortSignal) {
  const told: { at: number; type: string; topics: string[] }[] = [];
  const response = await admin("live", undefined, signal);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let held = "";
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        held += decoder.decode(value, { stream: true });
        for (let cut = held.indexOf("\n\n"); cut >= 0; cut = held.indexOf("\n\n")) {
          const frame = held.slice(0, cut);
          held = held.slice(cut + 2);
          if (!frame.startsWith("data: ")) continue;
          const message = JSON.parse(frame.slice(6)) as { type: string; topics?: string[] };
          told.push({ at: performance.now(), type: message.type, topics: message.topics ?? [] });
        }
      }
    } catch {
      /* closed */
    }
  })();
  const deadline = Date.now() + 5000;
  while (!told.some((m) => m.type === "hello") && Date.now() < deadline) await Bun.sleep(5);
  return told;
}

beforeAll(async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const store = new LedgerStore(home.ledgerPath);
  const fleet = foundFleet(store, identity, { fleetName: "homelab", nodeName: "keep" });
  store.close();
  home.writeConfig({ v: 1, name: "keep", fleet, port, keystore, advertise: "127.0.0.1" });
  daemon = await startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {}, loopIntervalMs: 60_000, archiveIntervalMs: false, defaultHeartbeat: false, backups: false, measure: false, syncIntervalMs: 3_600_000, push: { tickMs: false } });
  for (const [name, input] of [["setProvider", { id: "stand-in", kind: "openai", baseUrl: `http://127.0.0.1:${model.port}/v1` }], ["setRoster", { role: "planner", models: ["stand-in/m"] }]] as const) {
    const response = await admin(name, input);
    if (!response.ok) throw new Error(`${name}: ${response.status} ${await response.text()}`);
  }
});

afterAll(async () => {
  await daemon?.stop();
  model.stop(true);
  rmSync(root, { recursive: true, force: true });
});

describe("the live stream's look", () => {
  test("reads none of the fleet's devices while a device listens: which peers are online is what sync last found of each", async () => {
    const stop = new AbortController();
    await listen(stop.signal);
    try {
      const read = daemon.store.devices.bind(daemon.store);
      let devicesRead = 0;
      daemon.store.devices = () => (devicesRead++, read());
      try {
        // Four looks and more, with nothing else here that reads the devices (sync's ticks and the notifications' are off).
        await Bun.sleep(LOOK_MS * 4 + 100);
        expect(devicesRead).toBe(0);
      } finally {
        daemon.store.devices = read;
      }
    } finally {
      stop.abort();
    }
  });
});

describe("the live stream, as the background moves", () => {
  test("a turn's end is told within a few milliseconds of it, five times in five, not at the stream's next look", async () => {
    const stop = new AbortController();
    const told = await listen(stop.signal);
    try {
      const after: number[] = [];
      for (let i = 0; i < 5; i++) {
        const asked = await admin("chat", { messages: [{ role: "user", content: `Say done (${i}).` }] });
        expect(asked.ok).toBe(true);
        // The turn's answer, to its end: then the turn has ended, and nothing more is asked of the node.
        await asked.text();
        const ended = performance.now();
        // Its end, as the stream tells it: the last word of `turns` within the next look (none comes but its own).
        await Bun.sleep(LOOK_MS + 100);
        const last = told.filter((m) => m.type === "changed" && m.topics.includes("turns")).at(-1);
        expect(last).toBeDefined();
        after.push(last!.at - ended);
      }
      // (Told by its poke, a few milliseconds after its end, give or take the answer's own last bytes. A look's wait is
      // uniform up to LOOK_MS: five in five under 100 ms by looks alone is one chance in a hundred.)
      for (const ms of after) expect(ms).toBeLessThan(100);
    } finally {
      stop.abort();
    }
  }, 30_000);
});
