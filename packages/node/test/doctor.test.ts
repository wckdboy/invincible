import { describe, expect, test } from "bun:test";
import { doctorExit, doctorLines, doctorTally, doctorVerdict } from "@galahad/core";
import { type Diagnosis, type DoctorFacts, diagnose, doctorFindings, reportOf, span, VM_TOOLS_CANT } from "../src/doctor.ts";

/*
 * The doctor's rules, exactly: a healthy node answers ok on every line, and each kind
 * of fault gives its own line, its own state and what to do. Facts in, lines out.
 */

const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function healthy(): DoctorFacts {
  return {
    now: NOW,
    quick: false,
    offline: false,
    self: { id: "n_self", name: "ultra", fleetName: "camelot", active: true, role: "full", alwaysOn: true, startedAt: NOW - 3 * DAY },
    keys: { keystore: "file", keyFile: { exists: true, mode: 0o600 }, home: { exists: true, mode: 0o700 }, adminToken: { exists: true, mode: 0o600 } },
    mind: {
      events: 41_250,
      integrity: "ok",
      head: "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg",
      forks: [],
      newestEventAt: NOW - 20_000,
      timeSynced: true,
      peers: [{ name: "rack", alwaysOn: true, online: true, lastSeen: NOW - 4000, error: null, clockOffsetMs: 300 }],
      backup: { dir: "/var/lib/galahad/backups", exists: true, newestAt: NOW - 9 * HOUR, files: 14 },
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
      { name: "heartbeat", enabled: true, runner: "ultra", runnerOnline: true, problem: null, recent: ["ok", "ok", "ok"], lastAt: NOW - 12 * MIN, next: NOW + 18 * MIN },
      { name: "nightly", enabled: true, runner: "ultra", runnerOnline: true, problem: null, recent: ["ok"], lastAt: NOW - 15 * HOUR, next: NOW + 9 * HOUR },
    ],
    connectors: [{ id: "github", label: "GitHub", host: "api.github.com", key: "ready", problem: null, reach: { ok: true, ms: 120, error: null } }],
    app: { missing: [], published: "https://ultra.tail1234.ts.net:8443", local: "http://127.0.0.1:7778" },
    disk: { freeGb: 412, totalGb: 1800 },
    service: { restarts: 0, warnings: [] },
    notify: { devices: 2, failing: [], keyProblem: null },
  };
}

const byId = (checks: Diagnosis[], id: string): Diagnosis => {
  const found = checks.find((c) => c.id === id);
  if (!found) throw new Error(`no check ${id}; there are: ${checks.map((c) => c.id).join(", ")}`);
  return found;
};
/** One fault on an otherwise healthy node: the line it gives, and that nothing else changed state. */
function fault(change: (f: DoctorFacts) => void, id: string): Diagnosis {
  const facts = healthy();
  change(facts);
  const checks = diagnose(facts);
  const hit = byId(checks, id);
  const others = checks.filter((c) => c.id !== id && c.state !== "ok");
  expect(others.map((c) => `${c.id}: ${c.state}`)).toEqual([]);
  return hit;
}

describe("a healthy node", () => {
  test("every line is ok, in the report's order, and the exit code is 0", () => {
    const checks = diagnose(healthy());
    expect(checks.filter((c) => c.state !== "ok")).toEqual([]);
    expect(checks.every((c) => c.fix === undefined && c.finding === undefined)).toBe(true);
    const report = reportOf("ultra", healthy(), checks, 1234);
    expect(doctorExit(report.tally)).toBe(0);
    expect(report.tally).toEqual({ ok: checks.length, needsYou: 0, broken: 0, skipped: 0 });
    expect(doctorVerdict(report.tally)).toBe(`All is well: ${checks.length} checks passed.`);
    // Every area the brief names has at least a line.
    for (const area of ["node", "mind", "vault", "models", "archive", "sandbox", "compute", "loops", "connectors", "app", "notify", "disk", "service"]) {
      expect(checks.some((c) => c.area === area)).toBe(true);
    }
    const lines = doctorLines(report);
    expect(lines.at(-1)).toStartWith("All is well");
    expect(lines).toContain("The mind");
    expect(lines.join("\n")).toContain("ok        planner: deepseek/deepseek-chat answered (840 ms)");
    // The report itself carries no heartbeat fields.
    expect(report.checks.every((c) => !("finding" in c))).toBe(true);
  });

  test("a role nobody hired says nothing, and a role that doesn't chat isn't asked", () => {
    const checks = diagnose(healthy());
    expect(checks.some((c) => c.id === "role.decider")).toBe(false);
    expect(byId(checks, "role.embedder").line).toContain("isn't asked");
  });
});

describe("each fault gives its own line and advice", () => {
  test("this node: revoked, a key file others can read, a missing key file, an open home", () => {
    const revoked = fault((f) => (f.self.active = false), "node.identity");
    expect(revoked.state).toBe("broken");
    expect(revoked.fix).toContain("galahad join");

    const open = fault((f) => (f.keys.keyFile = { exists: true, mode: 0o644 }), "node.keys");
    expect(open.state).toBe("broken");
    expect(open.line).toContain("mode 644");
    expect(open.fix).toContain("chmod 600");

    expect(fault((f) => (f.keys.keyFile = { exists: false, mode: null }), "node.keys").state).toBe("broken");
    // The notification key is a key too: open to others is broken; not there yet is nothing to say.
    const pushKey = fault((f) => (f.keys.pushKeyFile = { exists: true, mode: 0o640 }), "node.keys");
    expect(pushKey.state).toBe("broken");
    expect(pushKey.line).toContain("push-key.json, mode 640");
    expect(pushKey.fix).toContain("makes a new key");
    expect(fault((f) => (f.keys.pushKeyFile = { exists: false, mode: null }), "node.keys").state).toBe("ok");
    const home = fault((f) => (f.keys.home = { exists: true, mode: 0o755 }), "node.home");
    expect(home.state).toBe("needs-you");
    expect(home.line).toContain("mode 755");
    expect(fault((f) => (f.keys.adminToken = { exists: true, mode: 0o644 }), "node.home").line).toContain("admin token");
    // Where there are no permission bits to read (Windows), nothing is claimed either way.
    expect(fault((f) => (f.keys = { keystore: "file", keyFile: { exists: true, mode: null }, home: { exists: true, mode: null }, adminToken: { exists: true, mode: null } }), "node.keys").state).toBe("ok");
    expect(fault((f) => (f.keys = { keystore: "os", keyFile: null, home: null, adminToken: null }), "node.keys").line).toContain("keychain");
  });

  test("the mind: a damaged database, a fork, a clock behind, out of step, unsynchronised", () => {
    const damaged = fault((f) => (f.mind.integrity = "*** in database main ***\nPage 12: btree page count mismatch"), "mind.integrity");
    expect(damaged.state).toBe("broken");
    expect(damaged.fix).toContain("backup");

    const fork = fault((f) => (f.mind.forks = [{ id: "n_old", name: "old-laptop" }]), "mind.chain");
    expect(fork.state).toBe("broken");
    expect(fork.line).toContain("old-laptop");
    expect(fork.fix).toContain("galahad revoke");

    const behind = fault((f) => (f.mind.newestEventAt = NOW + 20 * MIN), "mind.clock");
    expect(behind.state).toBe("broken");
    expect(behind.line).toContain("20 minutes");
    expect(behind.finding).toMatchObject({ severity: "alert", key: "doctor:mind.clock:n_self" });

    const step = fault((f) => (f.mind.peers[0]!.clockOffsetMs = 45_000), "mind.clock");
    expect(step.state).toBe("needs-you");
    expect(step.line).toContain("45 seconds behind rack's");
    expect(step.finding?.severity).toBe("warn");
    expect(fault((f) => (f.mind.peers[0]!.clockOffsetMs = -45_000), "mind.clock").line).toContain("ahead of rack's");

    const unsynced = fault((f) => (f.mind.timeSynced = false), "mind.clock");
    expect(unsynced.state).toBe("needs-you");
    expect(unsynced.fix).toContain("timedatectl set-ntp true");
    // A heartbeat finding's words don't move with the clock: an unchanged problem writes nothing.
    const again = healthy();
    again.now += 7 * MIN;
    again.mind.peers[0]!.clockOffsetMs = 52_000;
    expect(byId(diagnose(again), "mind.clock").finding).toEqual(step.finding!);
  });

  test("the mind: a server offline, a peer that refuses, a laptop asleep, no backup, an old backup", () => {
    const offline = fault((f) => (f.mind.peers[0] = { name: "rack", alwaysOn: true, online: false, lastSeen: NOW - 3 * HOUR, error: "fetch failed", clockOffsetMs: null }), "mind.sync.rack");
    expect(offline.state).toBe("needs-you");
    expect(offline.line).toContain("3 hours ago");
    const refused = fault((f) => (f.mind.peers[0] = { name: "rack", alwaysOn: true, online: false, lastSeen: NOW - 3 * HOUR, error: "POST /link/sync → 401 sign the request", clockOffsetMs: null }), "mind.sync.rack");
    expect(refused.line).toContain("refuses");
    // A laptop that's away isn't news.
    const asleep = healthy();
    asleep.mind.peers = [{ name: "laptop", alwaysOn: false, online: false, lastSeen: NOW - 2 * DAY, error: null, clockOffsetMs: null }];
    expect(byId(diagnose(asleep), "mind.sync.laptop").state).toBe("ok");
    const alone = healthy();
    alone.mind.peers = [];
    expect(byId(diagnose(alone), "mind.sync").line).toContain("only node");

    const none = fault((f) => (f.mind.backup = { dir: "/var/lib/galahad/backups", exists: false, newestAt: null, files: 0 }), "mind.backup");
    expect(none.state).toBe("needs-you");
    expect(none.fix).toContain("GALAHAD_BACKUP_DIR");
    expect(none.finding).toBeUndefined(); // the doctor says it; the heartbeat doesn't nag about a choice
    const old = fault((f) => (f.mind.backup!.newestAt = NOW - 12 * DAY), "mind.backup");
    expect(old.line).toContain("12 days old");
    expect(old.finding?.severity).toBe("info");
    // A node that started minutes ago hasn't missed its first (it's kept ten minutes after the start): not asked for yet.
    const young = healthy();
    young.self.startedAt = NOW - 2 * MIN;
    young.mind.backup = { dir: "/var/lib/galahad/backups", exists: false, newestAt: null, files: 0 };
    expect(byId(diagnose(young), "mind.backup")).toMatchObject({ state: "ok", line: "no backup of the mind yet: the node keeps its first ten minutes after it starts, in /var/lib/galahad/backups" });
    young.self.startedAt = NOW - 20 * MIN;
    expect(byId(diagnose(young), "mind.backup").state).toBe("needs-you");
  });

  test("a node with no provider set up yet says so once, with what to add, rather than once a role", () => {
    const fresh = healthy();
    fresh.providers = { setUp: 0, byDefault: ["anthropic", "openrouter", "deepseek"] };
    for (const role of fresh.roles) {
      role.models = role.models.map((m) => ({ ref: m.ref, problem: `provider "${m.ref.slice(0, m.ref.indexOf("/"))}" is not configured` }));
      role.probe = null;
    }
    const checks = diagnose(fresh);
    const models = checks.filter((c) => c.area === "models");
    expect(models.map((c) => c.id)).toEqual(["models.none"]);
    expect(models[0]).toMatchObject({ state: "broken", line: "no provider is set up here yet, so no model can answer" });
    expect(models[0]!.fix).toContain("A key for anthropic, openrouter or deepseek is enough");
    expect(models[0]!.fix).toContain("galahad key add");
    // One provider set up, and the roles are judged one by one, as ever.
    fresh.providers = { setUp: 1, byDefault: ["anthropic"] };
    expect(diagnose(fresh).filter((c) => c.area === "models").map((c) => c.id)).toEqual(["role.planner", "role.engineer", "role.reviewer", "role.embedder"]);
    // One on its defaults, none of whose providers is the one set up (an OpenAI key, say): its providers, said once.
    fresh.roles[0]!.models = ["anthropic/claude-opus-5-5", "openrouter/anthropic/claude-opus-5.5", "deepseek/deepseek-v4-pro"].map((ref) => ({ ref, problem: `provider "${ref.slice(0, ref.indexOf("/"))}" is not configured` }));
    fresh.roles[0]!.unset = true;
    expect(byId(diagnose(fresh), "role.planner")).toMatchObject({ state: "broken", line: "no model can play planner: its defaults name anthropic, openrouter and deepseek, none of them set up here" });
    expect(byId(diagnose(fresh), "role.planner").fix).toBe("Add a key for one of them (galahad key add), or hire a model you have a key for: galahad roster set planner <provider/model>.");
  });

  test("the vault: locked, and keys he's waiting for", () => {
    const locked = fault((f) => (f.vault.unlocked = false), "vault.open");
    expect(locked.state).toBe("broken");
    const asked = fault((f) => (f.vault.requests = ["github", "cloudflare"]), "vault.requests");
    expect(asked.state).toBe("needs-you");
    expect(asked.line).toContain("2 keys: github, cloudflare");
  });

  test("models: a coding plan on a role does his coding and nothing else, and is never a model he lacks", () => {
    // The roster `galahad key add` suggests for a plan: the plan first for the tools, a model of his own behind it.
    const planned = healthy();
    planned.roles[1]!.models = [{ ref: "zai-coding/glm-5.3", problem: null, plan: true }, ...planned.roles[1]!.models];
    const checks = diagnose(planned);
    expect(checks.some((c) => c.id === "role.engineer.first")).toBe(false);
    const engineer = byId(checks, "role.engineer");
    expect(engineer.state).toBe("ok");
    expect(engineer.line).toContain("his coding and the knights' tools use zai-coding/glm-5.3");
    expect(engineer.line).not.toContain("zai-coding/glm-5.3 has what it needs");
    expect(engineer.line).not.toContain("zai-coding/glm-5.3 answered");
    // The engineer's work is all coding: a plan alone can play it, and is asked no word (a word is no coding).
    const only = healthy();
    only.roles[1]!.models = [{ ref: "zai-coding/glm-5.3", problem: null, plan: true }];
    only.roles[1]!.probe = null;
    const coder = byId(diagnose(only), "role.engineer");
    expect(coder.state).toBe("ok");
    expect(coder.line).toBe("engineer: zai-coding/glm-5.3 does his coding (a coding plan: it is asked nothing else, so not a word)");
    // The planner also talks with you, which a plan doesn't do: alone on it, nobody answers you.
    const mute = fault((f) => {
      f.roles[0]!.models = [{ ref: "zai-coding/glm-5.3", problem: null, plan: true }];
      f.roles[0]!.probe = null;
    }, "role.planner");
    expect(mute.state).toBe("broken");
    expect(mute.line).toContain("coding plan");
    expect(mute.line).toContain("coding work only");
    expect(mute.fix).toContain("galahad roster set planner");
    // A plan with no key is said once, as the tools' lack and not his: the role itself is still well.
    const unkeyed = healthy();
    unkeyed.roles[1]!.models = [{ ref: "zai-coding/glm-5.3", problem: 'provider "zai-coding" has no key in the vault', plan: true }, { ref: "kimi-coding/k3", problem: 'provider "kimi-coding" is not configured', plan: true }, ...unkeyed.roles[1]!.models];
    const lack = byId(diagnose(unkeyed), "role.engineer.plan");
    expect(lack.state).toBe("needs-you");
    expect(lack.line).toContain("zai-coding/glm-5.3");
    expect(lack.line).toContain("kimi-coding/k3");
    expect(lack.fix).toBe("Add the plan's key: galahad key add --provider zai-coding.");
    expect(byId(diagnose(unkeyed), "role.engineer").state).toBe("ok");
    expect(byId(diagnose(unkeyed), "role.engineer").line).not.toContain("tools use");
    // A plan behind a model he lacks is still not the model that answers instead.
    const lacking = fault((f) => {
      f.roles[0]!.models = [{ ref: "anthropic/claude-opus-5-5", problem: 'provider "anthropic" has no key in the vault' }, { ref: "zai-coding/glm-5.3", problem: null, plan: true }];
      f.roles[0]!.probe = null;
    }, "role.planner");
    expect(lacking.state).toBe("broken");
    expect(lacking.line).toContain("no model can play planner");
  });

  test("models: a role you made is a knight's, whose talk and tasks are all coding, so coding plans alone play it", () => {
    const mine = healthy();
    mine.roles.push({ role: "plan-coder", custom: true, chats: true, models: [{ ref: "mimo-token/mimo-v2.6-pro", problem: null, plan: true }, { ref: "opencode-go/deepseek-v4-pro", problem: null, plan: true }], probe: null });
    const check = byId(diagnose(mine), "role.plan-coder");
    expect(check.state).toBe("ok");
    expect(check.line).toBe("plan-coder: mimo-token/mimo-v2.6-pro does the work of the knights on it (a coding plan: it is asked nothing else, so not a word)");
  });

  test("models: a VM's eyes are asked by its tools, so a plan they may use plays them alone; one they may not is said once, with whom to hire", () => {
    const seeing = healthy();
    seeing.roles.push({ role: "eyes", chats: true, models: [{ ref: "opencode-go/gpt-6-luna", problem: null, plan: true }], probe: null });
    expect(byId(diagnose(seeing), "role.eyes")).toMatchObject({
      state: "ok",
      line: "eyes: opencode-go/gpt-6-luna looks at the VMs' screens, asked by their tools through the gateway (a coding plan: it is asked nothing else, so not a word)",
    });
    const blind = healthy();
    blind.roles.push({ role: "eyes", chats: true, models: [{ ref: "kimi-coding/k3", problem: VM_TOOLS_CANT, plan: true }], probe: null });
    const said = diagnose(blind).filter((c) => c.id.startsWith("role.eyes"));
    expect(said.map((c) => [c.id, c.state])).toEqual([["role.eyes.plan", "needs-you"]]);
    expect(said[0]!.line).toBe(`kimi-coding/k3 (${VM_TOOLS_CANT}): on eyes, which can't use it`);
    expect(said[0]!.fix).toBe("Hire a model a VM's tools may use: galahad roster set eyes <provider/model>.");
  });

  test("models: the first model skipped on every answer, none usable, a refusal, a filter, a refused key, a timeout", () => {
    const skipped = fault((f) => {
      f.roles[0]!.models = [{ ref: "anthropic/claude-opus-5-5", problem: 'provider "anthropic" has no key in the vault' }, { ref: "deepseek/deepseek-chat", problem: null }];
    }, "role.planner.first");
    expect(skipped.state).toBe("needs-you");
    expect(skipped.line).toContain("skipped on every answer");
    expect(skipped.line).toContain("deepseek/deepseek-chat answers instead");
    expect(skipped.fix).toContain("galahad roster set planner deepseek/deepseek-chat");
    expect(skipped.finding?.severity).toBe("info");

    const none = fault((f) => {
      f.roles[0]!.models = [{ ref: "anthropic/claude-opus-5-5", problem: 'provider "anthropic" is not configured' }];
      f.roles[0]!.probe = null;
    }, "role.planner");
    expect(none.state).toBe("broken");
    expect(none.line).toContain("is not configured");
    // A role that isn't one of the three a quest needs is yours to look at, not broken.
    const swift = healthy();
    swift.roles.push({ role: "swift", chats: true, models: [{ ref: "ollama/*", problem: "its local runtime isn't running" }], probe: null });
    expect(byId(diagnose(swift), "role.swift").state).toBe("needs-you");

    const filtered = fault((f) => (f.roles[2]!.probe = { ref: "mistral/mistral-large", ok: false, ms: 2100, error: "the provider's content filter ended the reply" }), "role.reviewer");
    expect(filtered.state).toBe("broken"); // the only reviewer
    expect(filtered.fix).toContain("Filters aren't steady");
    const withFallback = healthy();
    withFallback.roles[2]!.models.push({ ref: "deepseek/deepseek-chat", problem: null });
    withFallback.roles[2]!.probe = { ref: "mistral/mistral-large", ok: false, ms: 300, error: "401 Unauthorized" };
    const key = byId(diagnose(withFallback), "role.reviewer");
    expect(key.state).toBe("needs-you");
    expect(key.line).toContain("deepseek/deepseek-chat is next in line");
    expect(key.fix).toContain("refused the key");
    // A 403 of what was asked, not of the key, isn't the key's (brain's refusesKey, the one rule): a 403 of the key is.
    withFallback.roles[2]!.probe = { ref: "mistral/mistral-large", ok: false, ms: 300, error: "mistral → 403: Your chosen model requires moderation and your input was flagged" };
    expect(byId(diagnose(withFallback), "role.reviewer").fix).not.toContain("refused the key");
    expect(byId(diagnose(withFallback), "role.reviewer").fix).toContain("not its key");
    withFallback.roles[2]!.probe = { ref: "mistral/mistral-large", ok: false, ms: 300, error: "mistral → 403: Your API key does not have permission to use the specified resource." };
    expect(byId(diagnose(withFallback), "role.reviewer").fix).toContain("refused the key");
    expect(fault((f) => (f.roles[2]!.probe = { ref: "mistral/mistral-large", ok: false, ms: 20_000, error: "no answer within 20 s (timed out)" }), "role.reviewer").fix).toContain("No answer in time");
    expect(fault((f) => (f.roles[2]!.probe = { ref: "mistral/mistral-large", ok: false, ms: 200, error: "429 rate limit" }), "role.reviewer").fix).toContain("limiting");

    const nobody = healthy();
    for (const role of nobody.roles) role.models = [];
    expect(byId(diagnose(nobody), "role.none").state).toBe("broken");
  });

  test("a key in a provider's error never reaches a line", () => {
    const facts = healthy();
    facts.roles[2]!.probe = { ref: "mistral/mistral-large", ok: false, ms: 200, error: "401: bad key sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE" };
    const line = byId(diagnose(facts), "role.reviewer").line;
    expect(line).not.toContain("sk-ant-api03");
  });

  test("offline and quick: a model that has what it needs isn't asked, and the line says why", () => {
    const offline = healthy();
    offline.offline = true;
    for (const role of offline.roles) role.probe = null;
    expect(byId(diagnose(offline), "role.planner").line).toContain("not asked: offline");
    const quick = healthy();
    quick.quick = true;
    quick.mind.integrity = null;
    quick.sandbox.host!.start = null;
    for (const role of quick.roles) role.probe = null;
    const checks = diagnose(quick);
    expect(byId(checks, "role.planner").state).toBe("ok");
    expect(byId(checks, "mind.integrity").state).toBe("skipped");
    expect(byId(checks, "sandbox.start").state).toBe("skipped");
    // Skipped checks don't make a healthy node fail.
    expect(doctorExit(doctorTally(checks))).toBe(0);
    expect(doctorVerdict(doctorTally(checks))).toContain("2 not looked at");
  });

  test("the archive: the embedder not running, failing, off, a source that can't be read, damage, a stale check", () => {
    const down = fault((f) => (f.archive!.embedder.probe = { ok: false, ms: 3, error: "connection refused (127.0.0.1:11434)" }), "archive.embedder");
    expect(down.state).toBe("needs-you");
    expect(down.line).toContain("connection refused");
    expect(down.fix).toContain("galahad-ollama");
    expect(down.finding?.severity).toBe("warn");
    const failing = fault((f) => (f.archive!.embedder = { model: "openrouter/embed", state: "failing", error: "503 from provider", local: false, probe: null }), "archive.embedder");
    expect(failing.fix).toContain("galahad provider list");
    expect(fault((f) => (f.archive!.embedder = { model: null, state: "none", error: null, local: null, probe: null }), "archive.embedder").state).toBe("ok");

    expect(fault((f) => (f.archive!.off = true), "archive.index").fix).toContain("GALAHAD_ARCHIVE=off");
    expect(fault((f) => (f.archive!.sourceErrors = [{ name: "chats", error: "database is locked" }]), "archive.index").line).toContain("chats (database is locked)");
    const waiting = healthy();
    waiting.archive!.backlog = 300;
    expect(byId(diagnose(waiting), "archive.index").line).toContain("300 waiting for a vector");

    const damaged = fault((f) => (f.archive!.integrity = { lastAt: NOW - HOUR, ok: false, problems: 2 }), "archive.integrity");
    expect(damaged.state).toBe("broken");
    expect(damaged.fix).toContain("nothing is mended by deleting");
    expect(fault((f) => (f.archive!.integrity.lastAt = NOW - 6 * DAY), "archive.integrity").line).toContain("6 days ago");
  });

  test("sandboxes: Docker down, the image pruned, a network gone, a start that fails, no slot, no firewall, no disk limit, no microVMs", () => {
    const docker = healthy();
    docker.sandbox.host = { ...docker.sandbox.host!, docker: false, start: null };
    const checks = diagnose(docker);
    expect(byId(checks, "sandbox.docker").state).toBe("broken");
    expect(checks.some((c) => c.id === "sandbox.image")).toBe(false); // nothing to say about an image Docker can't be asked for

    const image = healthy();
    image.sandbox.host = { ...image.sandbox.host!, image: false, start: null };
    const pruned = diagnose(image);
    expect(byId(pruned, "sandbox.image")).toMatchObject({ state: "needs-you" });
    expect(byId(pruned, "sandbox.image").line).toContain("cleanup may have pruned it");
    expect(byId(pruned, "sandbox.image").fix).toContain("galahad sandbox build");
    expect(byId(pruned, "sandbox.start").line).toContain("the image is missing");

    expect(fault((f) => (f.sandbox.host!.networks = false), "sandbox.networks").state).toBe("needs-you");
    const failed = fault((f) => (f.sandbox.host!.start = [{ kind: "container", ok: false, ms: 4000, error: "docker: Error response from daemon: no space left on device" }, { kind: "vm", ok: true, ms: 1700, error: null }]), "sandbox.start.container");
    expect(failed.state).toBe("broken");
    expect(failed.line).toContain("no space left on device");
    expect(fault((f) => (f.sandbox.host!.start = [{ kind: "container", ok: true, ms: 900, error: null }, { kind: "vm", ok: false, ms: 9000, error: "kata shim not found" }]), "sandbox.start.vm").fix).toContain("Kata");
    const busy = healthy();
    busy.sandbox.host!.start = "busy";
    expect(byId(diagnose(busy), "sandbox.start")).toMatchObject({ state: "skipped" });

    const firewall = fault((f) => (f.sandbox.host!.firewall = "inactive"), "sandbox.firewall");
    expect(firewall.state).toBe("broken");
    expect(firewall.fix).toContain("systemctl restart galahad-firewall");
    expect(firewall.finding?.severity).toBe("warn");
    expect(fault((f) => (f.sandbox.host!.firewall = "missing"), "sandbox.firewall").state).toBe("needs-you");
    expect(fault((f) => (f.sandbox.host!.diskLimited = false), "sandbox.disk").fix).toContain("--sudo");
    expect(fault((f) => (f.sandbox.host = { ...f.sandbox.host!, microVMs: false, start: [{ kind: "container", ok: true, ms: 900, error: null }] }), "sandbox.microvm").state).toBe("needs-you");

    // A node without Docker: fine while another hosts sandboxes, yours to fix when none does.
    const none = healthy();
    none.sandbox = { host: null, others: [] };
    expect(byId(diagnose(none), "sandbox.host").state).toBe("needs-you");
    none.sandbox.others = [{ name: "rack", online: true, image: true }];
    expect(byId(diagnose(none), "sandbox.host").line).toContain("they run on rack");
  });

  test("a Mac's sandboxes: said in container's words, and a Mac whose container isn't running is told how to start it", () => {
    const mac = healthy();
    mac.sandbox.host = { ...mac.sandbox.host!, engine: "container", kvm: false, firewall: null, start: [{ kind: "vm", ok: true, ms: 1200, error: null }] };
    const checks = diagnose(mac);
    expect(checks.filter((c) => c.state !== "ok").map((c) => c.id)).toEqual([]);
    expect(byId(checks, "sandbox.docker").line).toBe("Apple's container answers: every sandbox here is a VM of its own");
    expect(byId(checks, "sandbox.networks").line).toBe("both sandbox networks are there, each held up by a VM of the node's own");
    const down = healthy();
    down.sandbox.host = { ...down.sandbox.host!, engine: "container", docker: false, kvm: false, firewall: null, start: null };
    expect(byId(diagnose(down), "sandbox.docker")).toMatchObject({ state: "broken", line: "Apple's container isn't answering on this Mac", fix: expect.stringContaining("galahad sandbox setup starts its service") });
    const failed = healthy();
    failed.sandbox.host = { ...failed.sandbox.host!, engine: "container", kvm: false, firewall: null, start: [{ kind: "vm", ok: false, ms: 3000, error: "Error: failed to boot" }] };
    expect(byId(diagnose(failed), "sandbox.start.vm").fix).toContain("container system logs");
    // A Mac with container found but not running hosts nothing: the line says why, and how.
    const stopped = healthy();
    stopped.sandbox = { host: null, others: [], container: { version: "1.7.1", running: false } };
    expect(byId(diagnose(stopped), "sandbox.host")).toMatchObject({ state: "needs-you", fix: expect.stringContaining("run galahad sandbox setup here: it starts Apple's container (1.7.1 is installed)") });
    // Running with no kernel, no VM starts: said, and how to fetch it. With one, nothing is said of it.
    const bare = healthy();
    bare.sandbox = { ...bare.sandbox, host: { ...bare.sandbox.host!, engine: "container", kvm: false, firewall: null, start: null }, container: { version: "1.7.1", running: true, kernel: false } };
    expect(byId(diagnose(bare), "sandbox.kernel")).toMatchObject({ state: "needs-you", line: "Apple's container has no kernel for its VMs yet, so none starts here", fix: expect.stringContaining("galahad sandbox setup") });
    bare.sandbox.container!.kernel = true;
    expect(diagnose(bare).some((c) => c.id === "sandbox.kernel")).toBe(false);
  });

  test("a Mac's sandbox firewall: on, not installed, off for a moment, off", () => {
    const mac = (wall: { on: boolean; installed: boolean; soon: boolean; why: string | null; release?: "current" | "other" | "none" }) => {
      const f = healthy();
      f.sandbox.host = { ...f.sandbox.host!, engine: "container", kvm: false, firewall: null, macFirewall: wall, start: null };
      return byId(diagnose(f), "sandbox.firewall");
    };
    expect(mac({ on: true, installed: true, soon: false, why: null })).toMatchObject({ state: "ok", line: expect.stringContaining("never this Mac or your networks") });
    // On, and this release's (or not looked at): ok. On with another release's rules: put this release's in place.
    expect(mac({ on: true, installed: true, soon: false, why: null, release: "current" }).state).toBe("ok");
    expect(mac({ on: true, installed: true, soon: false, why: null, release: "other" })).toMatchObject({ state: "needs-you", line: "this Mac's sandbox firewall is on, with another release's rules", fix: expect.stringContaining("galahad sandbox setup") });
    const missing = mac({ on: false, installed: false, soon: false, why: "isn't installed" });
    expect(missing).toMatchObject({ state: "needs-you", line: expect.stringContaining("makes no sandboxes"), fix: "galahad sandbox setup, or This Mac in the app (it asks for your password once)." });
    expect(missing.finding?.severity).toBe("info");
    expect(mac({ on: false, installed: true, soon: true, why: "the galahad-gw network has no bridge on this Mac yet" })).toMatchObject({ state: "needs-you", line: expect.stringContaining("no bridge on this Mac yet") });
    const off = mac({ on: false, installed: true, soon: false, why: "pf isn't on, so the sandbox firewall's rules hold nothing" });
    expect(off).toMatchObject({ state: "broken", fix: expect.stringContaining("galahad firewall status") });
    expect(off.finding).toMatchObject({ severity: "warn", title: expect.stringContaining("The sandbox firewall is off on") });
  });

  test("compute: never measured, stale, old", () => {
    expect(fault((f) => (f.compute!.lastAt = null), "compute.calibration").line).toContain("hasn't measured itself");
    const stale = fault((f) => (f.compute!.due = "changed"), "compute.calibration");
    expect(stale.state).toBe("needs-you");
    expect(stale.line).toContain("stale");
    expect(stale.fix).toContain("galahad compute calibrate");
    expect(fault((f) => (f.compute!.lastAt = NOW - 45 * DAY), "compute.calibration").line).toContain("45 days ago");
    const waiting = healthy();
    waiting.compute!.waiting = 2;
    expect(byId(diagnose(waiting), "compute.slots").line).toBe("1 of 4 sandbox slots in use, 2 waiting for one");
  });

  test("loops: orphaned, unreadable, failing, a failed run, its node offline, no heartbeat", () => {
    expect(fault((f) => (f.loops[1]!.runner = null), "loop.nightly").state).toBe("broken");
    expect(fault((f) => (f.loops[1]!.problem = "schedule: not a schedule"), "loop.nightly").state).toBe("needs-you");
    const failing = fault((f) => (f.loops[1]!.recent = ["failed", "failed", "failed"]), "loop.nightly");
    expect(failing.state).toBe("broken");
    expect(failing.fix).toContain("galahad loop runs nightly");
    expect(fault((f) => (f.loops[1]!.recent = ["failed", "ok"]), "loop.nightly").state).toBe("needs-you");
    expect(fault((f) => (f.loops[1]!.recent = ["interrupted"]), "loop.nightly").line).toContain("interrupted");
    expect(fault((f) => (f.loops[1]!.runnerOnline = false), "loop.nightly").line).toContain("offline");
    const paused = healthy();
    paused.loops[1]!.enabled = false;
    expect(byId(diagnose(paused), "loop.nightly")).toMatchObject({ state: "ok" });
    expect(byId(diagnose(healthy()), "loop.heartbeat").line).toBe("heartbeat on ultra: last ran 12 minutes ago (ok), next in 18 minutes");
    expect(fault((f) => (f.loops = f.loops.filter((l) => l.name !== "heartbeat")), "loops.heartbeat").fix).toContain("galahad loop add heartbeat");
  });

  test("connectors: invalid, no key, a key pinned elsewhere, unreachable, not probed", () => {
    expect(fault((f) => (f.connectors[0]!.problem = "tools.issues.path: must start with /"), "connector.github").state).toBe("broken");
    expect(fault((f) => (f.connectors[0]!.key = "missing"), "connector.github").fix).toContain("--connector github");
    expect(fault((f) => (f.connectors[0]!.key = "wrong-origin"), "connector.github").line).toContain("never sent");
    const down = fault((f) => (f.connectors[0]!.reach = { ok: false, ms: 5000, error: "no answer within 5 s" }), "connector.github");
    expect(down.state).toBe("needs-you");
    expect(down.line).toContain("api.github.com");
    const offline = healthy();
    offline.offline = true;
    offline.connectors[0]!.reach = null;
    expect(byId(diagnose(offline), "connector.github").line).toContain("not probed: offline");
    const none = healthy();
    none.connectors = [];
    expect(byId(diagnose(none), "connectors.none").state).toBe("ok");
  });

  test("the app: a build that failed, and Tailscale not publishing it", () => {
    const build = fault((f) => (f.app.missing = ["/app.js", "/sw.js"]), "app.bundle");
    expect(build.state).toBe("broken");
    expect(build.fix).toContain("bun install");
    expect(build.finding?.severity).toBe("warn");
    const serve = fault((f) => (f.app.published = null), "app.published");
    expect(serve.state).toBe("needs-you");
    expect(serve.fix).toContain("galahad expose");
    expect(serve.finding?.severity).toBe("warn");
    // A laptop that isn't published is a personal machine, not a fault; a node that can't tell says so.
    const laptop = healthy();
    laptop.self.alwaysOn = false;
    laptop.app.published = null;
    expect(byId(diagnose(laptop), "app.published").state).toBe("ok");
    const unknown = healthy();
    unknown.app.published = undefined;
    expect(byId(diagnose(unknown), "app.published").state).toBe("ok");
  });

  test("notifications: nobody subscribed is said plainly; a device that can't be reached needs you; a key that can't be used is broken", () => {
    const none = healthy();
    none.notify = { devices: 0, failing: [], keyProblem: null };
    expect(byId(diagnose(none), "notify.devices")).toMatchObject({ state: "ok" });
    expect(fault((f) => (f.notify = { devices: 2, failing: [{ device: "iPhone", error: "the push service answered 403" }], keyProblem: null }), "notify.devices").state).toBe("needs-you");
    expect(fault((f) => (f.notify = { devices: 2, failing: [], keyProblem: "the key file is not a P-256 key" }), "notify.key").state).toBe("broken");
  });

  test("notifications: he can't reach you is a finding for your Inbox once it matters; a node nobody uses isn't nagged", () => {
    const reach = (notify: NonNullable<DoctorFacts["notify"]>) => {
      const facts = healthy();
      facts.notify = notify;
      return byId(diagnose(facts), "notify.devices");
    };
    const unreachable = {
      // A notice of its own (the line's id is notify.devices): it is never told as the failing device's is.
      key: `doctor:notify.reach:${healthy().self.id}`,
      severity: "warn",
      title: "Galahad can't reach you when the app is closed",
      body: "No device of yours has notifications on, so what needs you waits here until you look. iPhone or iPad: More → Notifications. Web app: Settings → Notifications. Android: More → Notifications.",
    };
    // Nobody on, nothing lost and nothing waiting for an answer: said, but not a finding.
    expect(reach({ devices: 0, failing: [], keyProblem: null, lost: 0, asks: 0 })).toMatchObject({ state: "ok" });
    expect(reach({ devices: 0, failing: [], keyProblem: null, lost: 0, asks: 0 }).finding).toBeUndefined();
    // Something waits for your answer, or a device's subscription was dropped by its push service: it needs you.
    const asks = reach({ devices: 0, failing: [], keyProblem: null, lost: 0, asks: 2 });
    expect(asks).toMatchObject({ state: "needs-you", line: "no device has notifications on, so he can't reach you when the app is closed, and 2 things wait for your answer" });
    expect(asks.finding).toEqual(unreachable as never);
    const lost = reach({ devices: 0, failing: [], keyProblem: null, lost: 1, asks: 0 });
    expect(lost).toMatchObject({ state: "needs-you", line: "no device has notifications on, so he can't reach you when the app is closed: a device's were dropped by its push service" });
    expect(lost.fix).toContain("More → Notifications");
    expect(lost.finding).toEqual(unreachable as never);
    // Its words don't change while it stands (how many wait isn't in them), so an unchanged problem writes nothing.
    expect(reach({ devices: 0, failing: [], keyProblem: null, lost: 3, asks: 7 }).finding).toEqual(unreachable as never);
    // A device that keeps failing: the other devices are told which (the heartbeat's titles are told), and what to do.
    const failing = reach({ devices: 3, failing: [{ device: "iPhone", error: "Apple's push service answered 500" }, { device: "iPad", error: "Apple's push service answered 500" }], keyProblem: null, lost: 0, asks: 1 });
    expect(failing.state).toBe("needs-you");
    expect(failing.finding).toEqual({ key: `doctor:notify.devices:${healthy().self.id}`, severity: "warn", title: "Notifications aren't reaching iPhone and iPad", body: "The last ones didn't arrive. On that device, turn notifications off and on again; galahad notify test sends one." });
    // Facts from before these were known read as before.
    expect(reach({ devices: 0, failing: [], keyProblem: null }).finding).toBeUndefined();
  });

  test("disk and the service: low, nearly full, restarts, trouble in the log", () => {
    expect(fault((f) => (f.disk = { freeGb: 80, totalGb: 1800 }), "disk.home").state).toBe("needs-you");
    expect(fault((f) => (f.disk = { freeGb: 0.6, totalGb: 1800 }), "disk.home").state).toBe("broken");
    const restarts = fault((f) => (f.service.restarts = 3), "service.unit");
    expect(restarts.state).toBe("needs-you");
    expect(restarts.fix).toContain("journalctl -u galahad");
    const log = fault((f) => (f.service.warnings = [{ at: NOW - 5 * MIN, text: "outbox: fetch failed" }, { at: NOW - 3 * HOUR, text: "ledger write failed: disk" }]), "service.log");
    expect(log.state).toBe("needs-you");
    expect(log.line).toContain("1 line of trouble in its log in the last hour, the latest: outbox: fetch failed");
    const old = healthy();
    old.service.warnings = [{ at: NOW - 3 * HOUR, text: "ledger write failed: disk" }];
    expect(byId(diagnose(old), "service.log").state).toBe("ok");
  });
});

describe("the report", () => {
  test("exit codes: 1 when something needs you, 2 when something is broken", () => {
    const needs = healthy();
    needs.vault.requests = ["github"];
    expect(doctorExit(doctorTally(diagnose(needs)))).toBe(1);
    needs.vault.unlocked = false;
    const checks = diagnose(needs);
    expect(doctorExit(doctorTally(checks))).toBe(2);
    expect(doctorVerdict(doctorTally(checks))).toStartWith("1 broken, 1 needs you;");
    // Within an area the worst comes first, and the advice sits under its line.
    const lines = doctorLines(reportOf("ultra", needs, checks, 10));
    const vault = lines.indexOf("The vault");
    expect(lines[vault + 1]).toContain("broken");
    expect(lines[vault + 2]).toContain("→ ");
    expect(lines[vault + 3]).toContain("needs you");
  });

  test("the heartbeat takes only what it doesn't check itself, and only while it's wrong", () => {
    expect(doctorFindings(diagnose(healthy()))).toEqual([]);
    const facts = healthy();
    facts.vault.unlocked = false; // the heartbeat already says this itself
    facts.app.published = null;
    facts.sandbox.host!.firewall = "inactive";
    expect(doctorFindings(diagnose(facts)).map((f) => f.key).sort()).toEqual(["doctor:app.published:n_self", "doctor:sandbox.firewall:n_self"]);
  });

  test("spans read plainly", () => {
    expect(span(45_000)).toBe("45 seconds");
    expect(span(12 * MIN)).toBe("12 minutes");
    expect(span(3 * HOUR)).toBe("3 hours");
    expect(span(12 * DAY)).toBe("12 days");
  });
});

describe("a knight's own setup", () => {
  const check = (facts: DoctorFacts, id: string) => diagnose(facts).find((d) => d.id === id);
  test("in sensitive mode with none of its models usable here, its work can't run, and it never goes elsewhere: broken, with what to do", () => {
    const facts = { ...healthy(), knights: [{ id: "ada", name: "Ada", sensitive: [{ ref: "nearai/Qwen/Qwen3.8-27B-abliterated", problem: 'provider "nearai" has no key in the vault' }], keys: [] }] };
    const line = check(facts, "knight.ada.sensitive")!;
    expect(line).toMatchObject({ area: "models", state: "broken" });
    expect(line.line).toContain("Ada is in sensitive mode, and none of its models can be used here");
    expect(line.fix).toContain("galahad key add --provider");
    expect(line.finding).toMatchObject({ severity: "warn", title: "Ada can't work in sensitive mode" });
    // With one that can, it is well, and says how many can't.
    const some = { ...healthy(), knights: [{ id: "ada", name: "Ada", sensitive: [{ ref: "nearai/a", problem: null }, { ref: "heabsy/b", problem: "no key" }], keys: [] }] };
    expect(check(some, "knight.ada.sensitive")).toMatchObject({ state: "ok", line: "Ada is in sensitive mode, on nearai/a (1 model of its own can't be used here)" });
  });

  test("a key of yours given to a knight that can go nowhere now needs you; one that can is well", () => {
    const facts = { ...healthy(), knights: [{ id: "ada", name: "Ada", sensitive: null, keys: [{ secret: "stripe", problem: null }, { secret: "acme", problem: "acme is pinned to no address, so there is nowhere it may go" }] }] };
    expect(check(facts, "knight.ada.key.stripe")).toMatchObject({ area: "vault", state: "ok" });
    expect(check(facts, "knight.ada.key.acme")).toMatchObject({ area: "vault", state: "needs-you", fix: "Pin it again (galahad secret set acme --base-url https://…), or take it back (galahad roundtable keys ada rm acme)." });
    // A node with no Roundtable, or no knight set up so, says nothing of knights.
    expect(diagnose(healthy()).some((d) => d.id.startsWith("knight."))).toBe(false);
  });
});
