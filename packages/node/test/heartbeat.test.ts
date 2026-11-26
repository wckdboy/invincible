import { describe, expect, test } from "bun:test";
import { b64u, newNodeIdentity } from "@galahad/core";
import { enrollDevice, foundFleet, MindStore } from "@galahad/mind";
import { assess, type HeartbeatSnapshot, loopNotice, OFFLINE_AFTER_MS, readChecklistReply, reconcile } from "../src/heartbeat.ts";

const NOW = Date.parse("2026-11-09T12:00:00Z");

const calm = (over: Partial<HeartbeatSnapshot> = {}): HeartbeatSnapshot => ({
  now: NOW,
  self: { id: "n_self", name: "ultra", startedAt: NOW - 60 * 60_000 },
  nodes: [],
  vaultUnlocked: true,
  roles: [{ role: "planner", usable: true, models: ["deepseek/deepseek-v4-pro"] }],
  sandboxes: [],
  loops: [],
  forks: [],
  connectors: [],
  orders: [],
  sandboxHost: null,
  disk: { freeGb: 900, totalGb: 1800 },
  ...over,
});

const keys = (s: HeartbeatSnapshot) => assess(s).map((f) => f.key);

describe("the heartbeat's checks", () => {
  test("a calm fleet finds nothing", () => {
    expect(assess(calm())).toEqual([]);
  });

  test("a silent server is news; a laptop that's away isn't", () => {
    const silent = NOW - OFFLINE_AFTER_MS - 1;
    const snapshot = calm({
      nodes: [
        { id: "n_server", name: "rack", alwaysOn: true, online: false, lastSeen: silent },
        { id: "n_laptop", name: "laptop", alwaysOn: false, online: false, lastSeen: silent },
        { id: "n_fresh", name: "blip", alwaysOn: true, online: false, lastSeen: NOW - 60_000 },
        { id: "n_up", name: "up", alwaysOn: true, online: true, lastSeen: NOW },
      ],
    });
    expect(keys(snapshot)).toEqual(["node-offline:n_server"]);
    // Never reached since this node started counts from the start.
    expect(keys(calm({ nodes: [{ id: "n_x", name: "x", alwaysOn: true, online: false, lastSeen: null }] }))).toEqual(["node-offline:n_x"]);
    expect(keys(calm({ self: { id: "n_self", name: "ultra", startedAt: NOW - 1000 }, nodes: [{ id: "n_x", name: "x", alwaysOn: true, online: false, lastSeen: null }] }))).toEqual([]);
  });

  test("the text of a finding is stable from beat to beat", () => {
    const snapshot = calm({ nodes: [{ id: "n_server", name: "rack", alwaysOn: true, online: false, lastSeen: NOW - 20 * 60_000 }] });
    const first = assess(snapshot);
    const later = assess({ ...snapshot, now: NOW + 30 * 60_000 });
    expect(later).toEqual(first);
  });

  test("a locked vault and a stolen key are alerts", () => {
    const findings = assess(calm({ vaultUnlocked: false, forks: [{ id: "n_bad", name: "laptop" }] }));
    expect(findings.map((f) => [f.key, f.severity])).toEqual([
      ["vault-locked:n_self", "alert"],
      ["equivocation:n_bad", "alert"],
    ]);
    expect(findings[0]!.node).toBe("n_self");
  });

  test("roles without a usable model: core roles warn, others inform", () => {
    const findings = assess(
      calm({
        roles: [
          { role: "engineer", usable: false, models: ["anthropic/claude-opus-5-5"] },
          { role: "swift", usable: false, models: ["ollama/*"] },
          // Roles nobody has hired (the decider, the archive's embedder) are a choice, not a problem.
          { role: "decider", usable: false, models: [] },
          { role: "embedder", usable: false, models: [] },
        ],
      }),
    );
    expect(findings.map((f) => [f.key, f.severity])).toEqual([
      ["no-model:engineer", "warn"],
      ["no-model:swift", "info"],
    ]);
  });

  test("loops: orphaned, or failing three times running", () => {
    const findings = keys(
      calm({
        loops: [
          { name: "orphan", runner: null, recent: [] },
          { name: "flaky", runner: "n_self", recent: ["failed", "failed", "failed"] },
          { name: "recovered", runner: "n_self", recent: ["ok", "failed", "failed"] },
          { name: "new", runner: "n_self", recent: ["failed", "failed"] },
        ],
      }),
    );
    expect(findings).toEqual(["loop-orphaned:orphan", "loop-failing:flaky"]);
  });

  test("sandboxes the reaper missed, connectors without keys, low disk", () => {
    const findings = assess(
      calm({
        sandboxes: [
          { id: "aaaaaaaaaa", expiresAt: NOW - OFFLINE_AFTER_MS - 1, ephemeral: true },
          { id: "bbbbbbbbbb", expiresAt: NOW - 60_000, ephemeral: true },
          { id: "cccccccccc", expiresAt: NOW - 10 * OFFLINE_AFTER_MS, ephemeral: false },
        ],
        connectors: [
          { id: "github", label: "GitHub", key: "optional-missing", problem: null },
          { id: "cloudflare", label: "Cloudflare", key: "missing", problem: null },
          { id: "weird", label: "weird", key: "none-needed", problem: "tools: required" },
        ],
        disk: { freeGb: 0.5, totalGb: 100 },
      }),
    );
    expect(findings.map((f) => [f.key, f.severity])).toEqual([
      ["sandbox-overdue:aaaaaaaaaa", "warn"],
      ["connector-key:cloudflare", "info"],
      ["connector-broken:weird", "warn"],
      ["disk:n_self", "alert"],
    ]);
  });

  test("a sandbox host without disk limits warns; a missing sandbox image informs", () => {
    expect(keys(calm({ sandboxHost: { diskLimited: true, image: true } }))).toEqual([]);
    const found = assess(calm({ sandboxHost: { diskLimited: false, image: false } }));
    expect(found.map((f) => [f.key, f.severity])).toEqual([
      ["sandbox-disk:n_self", "warn"],
      ["sandbox-image:n_self", "info"],
    ]);
    expect(found[0]!.node).toBe("n_self"); // about this node's body
  });

  test("a host with KVM but without microVMs says it could have them", () => {
    expect(keys(calm({ sandboxHost: { diskLimited: true, image: true, kvm: true, microVMs: true } }))).toEqual([]);
    expect(keys(calm({ sandboxHost: { diskLimited: true, image: true, kvm: false, microVMs: false } }))).toEqual([]);
    expect(keys(calm({ sandboxHost: { diskLimited: true, image: true, kvm: true, microVMs: false } }))).toEqual(["sandbox-vm:n_self"]);
  });

  test("standing orders: one that went stale warns, one about to expire informs", () => {
    const DAY = 24 * 60 * 60_000;
    const found = assess(
      calm({
        orders: [
          { id: "o_1", label: "PRs from feat/*", tool: "github.pr.create", stale: true, until: NOW + 30 * DAY },
          { id: "o_2", label: "Release posts", tool: "forge.post", stale: false, until: NOW + DAY },
          { id: "o_3", label: "Fine", tool: "forge.post", stale: false, until: NOW + 30 * DAY },
        ],
      }),
    );
    expect(found.map((f) => [f.key, f.severity])).toEqual([
      ["order-stale:o_1", "warn"],
      ["order-expiring:o_2", "info"],
    ]);
  });

  test("the checklist model's answer: HEARTBEAT_OK means quiet", () => {
    expect(readChecklistReply("HEARTBEAT_OK")).toBeNull();
    expect(readChecklistReply("  **HEARTBEAT_OK.**\n")).toBeNull();
    expect(readChecklistReply("The site is down.\nSecond.\nThird.\nFourth.")).toBe("The site is down.\nSecond.\nThird.");
  });
});

describe("notices follow the findings", () => {
  function setup() {
    const a = newNodeIdentity();
    const b = newNodeIdentity();
    const store = new MindStore(":memory:");
    foundFleet(store, a, { fleetName: "camelot", nodeName: "ultra" });
    enrollDevice(store, a, { device: b.id, name: "laptop", kind: "node", box: b64u(b.boxPublic) });
    return { a, b, store };
  }
  const finding = { key: "node-offline:n_rack", severity: "warn" as const, title: "rack is offline", body: "Last reached at 11:00." };

  test("raised once, quiet while unchanged, raised again when it changes, cleared when it's gone", () => {
    const { a, store } = setup();
    const before = store.eventCount();
    expect(reconcile(store, a, [finding], NOW)).toEqual({ raised: 1, cleared: 0 });
    expect(reconcile(store, a, [finding], NOW + 1)).toEqual({ raised: 0, cleared: 0 });
    expect(store.eventCount()).toBe(before + 1);
    expect(reconcile(store, a, [{ ...finding, severity: "alert" }], NOW + 2)).toEqual({ raised: 1, cleared: 0 });
    expect(reconcile(store, a, [], NOW + 3)).toEqual({ raised: 0, cleared: 1 });
    expect(store.lww("notice:node-offline:n_rack")?.value).toBeNull();
  });

  test("a dismissed notice stays quiet until it changes", () => {
    const { a, store } = setup();
    reconcile(store, a, [finding], NOW);
    store.emit(a, "notice.dismissed", { key: finding.key });
    expect(reconcile(store, a, [finding], NOW + 1).raised).toBe(0);
    expect(store.lww<{ dismissed: boolean }>(`notice:${finding.key}`)?.value?.dismissed).toBe(true);
    expect(reconcile(store, a, [{ ...finding, body: "Last reached at 11:30." }], NOW + 2).raised).toBe(1);
    expect(store.lww<{ dismissed: boolean }>(`notice:${finding.key}`)?.value?.dismissed).toBe(false);
  });

  test("a loop that needs a look says so once, and its next good run clears it", () => {
    const { a, store } = setup();
    const before = store.eventCount();
    loopNotice(store, a, "site", "ok", "200", NOW); // nothing to clear: writes nothing
    expect(store.eventCount()).toBe(before);
    loopNotice(store, a, "site", "attention", "site.home → 503 Service Unavailable", NOW);
    loopNotice(store, a, "site", "attention", "site.home → 503 Service Unavailable", NOW + 1);
    expect(store.eventCount()).toBe(before + 1);
    expect(store.lww<{ title: string; severity: string; source: string }>("notice:loop:site")?.value).toMatchObject({
      title: "Loop site needs a look",
      severity: "info",
      source: "loop:site",
    });
    loopNotice(store, a, "site", "failed", "site unreachable: timed out", NOW + 2);
    expect(store.lww<{ severity: string }>("notice:loop:site")?.value?.severity).toBe("warn");
    // The heartbeat leaves a loop's notice alone; the loop's own good run clears it.
    reconcile(store, a, [], NOW + 3);
    expect(store.lww("notice:loop:site")?.value).not.toBeNull();
    loopNotice(store, a, "site", "ok", "site.home → 200", NOW + 4);
    expect(store.lww("notice:loop:site")?.value).toBeNull();
  });

  test("another node's body is that node's business; other sources are theirs", () => {
    const { a, b, store } = setup();
    store.emit(b, "notice.raised", { key: `disk:${b.id}`, severity: "warn", title: "laptop is low on disk", body: "x", source: "heartbeat", node: b.id, at: NOW });
    store.emit(a, "notice.raised", { key: "loop-note", severity: "info", title: "t", body: "b", source: "loop:x", at: NOW });
    reconcile(store, a, [], NOW);
    expect(store.lww(`notice:disk:${b.id}`)?.value).not.toBeNull();
    expect(store.lww("notice:loop-note")?.value).not.toBeNull();
  });
});
