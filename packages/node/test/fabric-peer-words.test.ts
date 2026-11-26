import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { didKeyOfEd25519, doctorLines, type FleetView, newNodeIdentity, type Presence, signingPublicKey } from "@invincible/core";
import { type Device, foundFleet, LedgerStore } from "@invincible/ledger";
import { type DoctorFacts, diagnose, reportOf } from "../src/doctor.ts";
import { fleetStatusLines } from "../src/fabric-cli.ts";
import { Fabric } from "../src/fabric/service.ts";
import type { Sidecar } from "../src/fabric/sidecar.ts";
import { type Call, SidecarError } from "../src/fabric/socket.ts";
import { transportKeyOf } from "../src/home.ts";

/*
 * Another node's words reach your terminal as plain text in `invincible doctor` and `invincible status` too (the
 * fabric re-review, N3; L5's class). A peer that answers a Q-AMP call with an error of its own has its message kept as
 * this node's reason for HTTP, and a device's name and capabilities are its own words in the ledger. Each of them
 * carried an OSC 52 clipboard write and cursor moves to the terminal. Test keys only; addresses from 192.0.2.0/24.
 */

const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ESC = "\x1b";
const hostile = `${ESC}]52;c;ZWNobyBydW4gbWU=${ESC}\\${ESC}[2K${ESC}[1Ain sync with rack over Q-AMP`;
const escapes = (text: string) => [...text].filter((c) => c === ESC || c === "\x9b").length;

function healthy(): DoctorFacts {
  return {
    now: NOW,
    quick: false,
    offline: false,
    self: { id: "n_self", name: "node-a", fleetName: "homelab", active: true, role: "full", alwaysOn: true, startedAt: NOW - 3 * DAY },
    keys: { keystore: "file", keyFile: { exists: true, mode: 0o600 }, home: { exists: true, mode: 0o700 }, adminToken: { exists: true, mode: 0o600 } },
    mind: {
      events: 41_250,
      integrity: "ok",
      head: "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg",
      forks: [],
      newestEventAt: NOW - 20_000,
      timeSynced: true,
      peers: [{ name: "rack", alwaysOn: true, online: true, lastSeen: NOW - 4000, error: null, clockOffsetMs: 300 }],
      backup: { dir: "/var/lib/invincible/backups", exists: true, newestAt: NOW - 9 * HOUR, files: 14 },
    },
    vault: { unlocked: true, secrets: 6, requests: [] },
    roles: [
      { role: "planner", chats: true, models: [{ ref: "deepseek/deepseek-chat", problem: null }], probe: { ref: "deepseek/deepseek-chat", ok: true, ms: 840, error: null } },
      { role: "engineer", chats: true, models: [{ ref: "deepseek/deepseek-chat", problem: null }], probe: { ref: "deepseek/deepseek-chat", ok: true, ms: 840, error: null } },
      { role: "reviewer", chats: true, models: [{ ref: "mistral/mistral-large", problem: null }], probe: { ref: "mistral/mistral-large", ok: true, ms: 1200, error: null } },
      { role: "decider", chats: false, models: [], probe: null },
      { role: "embedder", chats: false, models: [{ ref: "ollama/qwen3-embedding:0.6b", problem: null }], probe: null },
    ],
    archive: {
      off: false,
      entries: 1200,
      chunks: 5400,
      backlog: 0,
      embedder: { model: "ollama/qwen3-embedding:0.6b", state: "ready", error: null, local: true, probe: { ok: true, ms: 40, error: null } },
      integrity: { lastAt: NOW - 5 * HOUR, ok: true, problems: 0 },
      sourceErrors: [],
    },
    sandbox: {
      host: { docker: true, image: true, networks: true, diskLimited: true, kvm: true, microVMs: true, firewall: "active", start: [{ kind: "container", ok: true, ms: 900, error: null }, { kind: "vm", ok: true, ms: 1700, error: null }] },
      others: [],
    },
    compute: { canMeasure: true, lastAt: NOW - 2 * DAY, due: null, slots: 4, inUse: 1, waiting: 0 },
    loops: [
      { name: "heartbeat", enabled: true, runner: "node-a", runnerOnline: true, problem: null, recent: ["ok", "ok", "ok"], lastAt: NOW - 12 * MIN, next: NOW + 18 * MIN },
      { name: "nightly", enabled: true, runner: "node-a", runnerOnline: true, problem: null, recent: ["ok"], lastAt: NOW - 15 * HOUR, next: NOW + 9 * HOUR },
    ],
    connectors: [{ id: "github", label: "GitHub", host: "api.github.com", key: "ready", problem: null, reach: { ok: true, ms: 120, error: null } }],
    app: { missing: [], published: "https://node-a.example.test:8443", local: "http://127.0.0.1:7401" },
    disk: { freeGb: 412, totalGb: 1800 },
    service: { restarts: 0, warnings: [] },
    notify: { devices: 2, failing: [], keyProblem: null },
  };
}

describe("a peer's words in this node's own reports", () => {
  test("a peer's error message, kept as this node's reason for HTTP, is kept plain", async () => {
    const self = newNodeIdentity();
    const store = new LedgerStore(":memory:");
    foundFleet(store, self, { fleetName: "f", nodeName: "self" });
    const peerKey = transportKeyOf(randomBytes(32), "n_" + "B".repeat(43));
    const peer = { id: "n_" + "B".repeat(43), name: `rack${ESC}[2K`, kind: "node", role: "full", profile: { endpoint: "http://192.0.2.12:7400", caps: { qamp: { did: peerKey.did, address: `qamp://${peerKey.did}@192.0.2.12:7410`, pop: peerKey.pop } } } } as unknown as Device;
    const call = { id: 1, chunks: { [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ value: undefined, done: true }) }) }, result: Promise.reject(new SidecarError("remote", `remote error UNAUTHORIZED: ${hostile}`, 3)), send() {}, end() {}, cancel() {} } as unknown as Call;
    (call.result as Promise<unknown>).catch(() => {});
    const fabric = new Fabric({ store, identity: self, sidecar: { state: "up", client: { open: true, call: () => call }, did: "did:key:z6Mkself", address: null, pop: null, why: null } as unknown as Sidecar, log: () => {}, presence: async () => ({}) as Presence });
    await fabric.call(peer, "invincible/link/sync", {});
    const why = fabric.pathOf(peer.id)?.why ?? "";
    expect(why).toContain("in sync with rack over Q-AMP");
    expect(escapes(why)).toBe(0);
    fabric.close();
    store.close();
  });

  test("invincible doctor prints every line plain, whatever a peer put in it", () => {
    const facts = healthy();
    const did = didKeyOfEd25519(signingPublicKey(new Uint8Array(32).fill(9)));
    facts.fabric = { state: "up", why: null, did, address: `qamp://${did}@192.0.2.10:7410`, version: "0.2.0" };
    facts.mind.peers[0] = { ...facts.mind.peers[0]!, name: `rack${ESC}[2K`, online: true, path: "https", fallback: hostile, qamp: true };
    const lines = doctorLines(reportOf("self", facts, diagnose(facts), 10)).join("\n");
    expect(lines).toContain("in sync with rack over Q-AMP");
    expect(escapes(lines)).toBe(0);
  });

  test("invincible status prints each name, capability and reason plain", () => {
    const fleet = {
      name: `home${ESC}]0;owned${ESC}\\`,
      fleet: "f_AAAAAAAAAAAAAAAAAAAAAA",
      events: 12,
      digest: "AbCdEfGhIjKlMnOp",
      self: "n_self",
      devices: [
        { id: "n_self", name: "node-a", kind: "node", caps: null, revokedAt: null },
        { id: "n_rack", name: `rack${ESC}[2K${ESC}[1A`, kind: "node", caps: { os: `linux${ESC}[31m`, arch: "x64", cores: 8, memoryGb: 32, gpu: [{ name: `gpu${ESC}]52;c;ZWNobw==${ESC}\\` }] }, revokedAt: null },
      ],
      peers: [{ device: "n_rack", online: true, rttMs: 4, path: "https", fallback: hostile }],
    } as unknown as FleetView;
    const lines = fleetStatusLines(fleet).join("\n");
    expect(lines).toContain("over HTTP:");
    expect(lines).toContain("in sync with rack over Q-AMP");
    expect(escapes(lines)).toBe(0);
  });
});
