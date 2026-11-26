import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { b64u, clientIdFromKey, MAX_RULES, newNodeIdentity, type RouteName, routes, type RuleView, type Scope, signRequest, utf8 } from "@galahad/core";
import { requestPairing, signedFetch, waitForApproval } from "@galahad/link";
import { foundFleet, MindStore } from "@galahad/mind";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { freePort } from "./ports.ts";

/*
 * Your rules over real HTTP: set and removed by you alone (a terminal, a paired device of yours), read by anyone who
 * may read the mind, never written by an agent or by another node; and a trip said by whoever runs a quest's sandbox
 * becomes a line in the ledger only when the rule really stops that command.
 */

const caps: Capabilities = {
  os: "linux",
  arch: "x64",
  hostname: "rules-test",
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

const root = mkdtempSync(join(tmpdir(), "galahad-rules-"));
const home = new Home(join(root, "node"));
const port = freePort();
let daemon: Daemon;
let armToken: string;

type Caller = <T = any>(name: RouteName, input?: unknown) => Promise<{ status: number; body: T }>;
const answer = async <T,>(response: Response): Promise<{ status: number; body: T }> => ({ status: response.status, body: (await response.json().catch(() => ({}))) as T });
const withToken =
  (token: () => string): Caller =>
  async (name, input) => {
    const route = routes[name];
    return answer(await fetch(`http://127.0.0.1:${port}${route.path}`, { method: route.method, headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" }, body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined }));
  };
const admin = withToken(() => home.adminToken());
const arm = withToken(() => armToken);

/** A browser paired with the node, holding the scopes given. */
async function pair(name: string, scopes: Scope[]): Promise<{ id: string; call: Caller }> {
  const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
  const id = clientIdFromKey(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)));
  const { invite } = (await admin<{ invite: string }>("createInvite", { kind: "client", scopes })).body;
  const joining = await requestPairing(invite, { device: id, name, kind: "client" });
  const { pairings } = (await admin<{ pairings: { invite: string; device: string }[] }>("pairings")).body;
  const mine = pairings.find((p) => p.device === id)!;
  expect((await admin("approvePairing", { invite: mine.invite, device: mine.device })).status).toBe(200);
  await waitForApproval(joining, { intervalMs: 20 });
  const call: Caller = async (route, input) => {
    const r = routes[route];
    const bytes = r.method === "POST" ? utf8(JSON.stringify(input ?? {})) : new Uint8Array();
    const headers = await signRequest(id, async (m) => new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, m)), r.method, r.path, bytes);
    return answer(await fetch(`http://127.0.0.1:${port}${r.path}`, { method: r.method, headers: { ...headers, "content-type": "application/json" }, body: r.method === "POST" ? bytes : undefined }));
  };
  return { id, call };
}

const rulesNow = async (): Promise<RuleView[]> => (await admin<{ rules: RuleView[] }>("rules")).body.rules;
const trips = () => daemon.store.ledger(200).map((e) => e.body).filter((b) => b.resource === "rule");

beforeAll(async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const store = new MindStore(home.mindPath);
  const fleet = foundFleet(store, identity, { fleetName: "camelot", nodeName: "ultra" });
  store.close();
  home.writeConfig({ v: 1, name: "ultra", fleet, port, keystore, advertise: "127.0.0.1" });
  daemon = await startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {} });
  armToken = (await admin<{ token: string }>("mintArm", { label: "test-arm" })).body.token;
});

afterAll(async () => {
  await daemon?.stop();
  rmSync(root, { recursive: true, force: true });
});

describe("your rules", () => {
  test("set from a terminal or a paired device, listed as this node reads them, replaced and removed by name", async () => {
    const set = await admin<{ rule: RuleView }>("setRule", { name: "no-locks", does: "halt", words: ["*.lock", "package-lock.json"] });
    expect(set.status).toBe(200);
    expect(set.body.rule).toMatchObject({ name: "no-locks", rule: { on: "command", does: "halt", words: ["*.lock", "package-lock.json"] }, setVia: null });
    const phone = await pair("phone", ["mind:read", "fleet:admin"]);
    expect((await phone.call("setRule", { name: "no-push", does: "refuse", words: [], contains: "git push" })).status).toBe(200);
    expect((await rulesNow()).map((r) => [r.name, r.rule?.does, r.setVia])).toEqual([
      ["no-locks", "halt", null],
      ["no-push", "refuse", phone.id],
    ]);
    // The same name replaces it.
    expect((await phone.call("setRule", { name: "no-locks", does: "refuse", words: ["*.lock"] })).status).toBe(200);
    expect((await rulesNow()).find((r) => r.name === "no-locks")).toMatchObject({ rule: { does: "refuse", words: ["*.lock"] }, setVia: phone.id });
    expect((await admin("removeRule", { name: "no-push" })).status).toBe(200);
    expect((await rulesNow()).map((r) => r.name)).toEqual(["no-locks"]);
    expect((await admin("removeRule", { name: "no-push" })).status).toBe(404);
  });

  test("a check: set with the command it runs after a command it matches, and read back as one; a key in it is refused", async () => {
    const set = await admin<{ rule: RuleView }>("setRule", { name: "types", does: "check", words: ["*.ts"], run: "bunx tsc --noEmit" });
    expect(set.status).toBe(200);
    expect(set.body.rule).toMatchObject({ name: "types", rule: { on: "after", does: "check", run: "bunx tsc --noEmit", words: ["*.ts"] }, setVia: null });
    expect((await admin("setRule", { name: "types", does: "check", words: ["*.ts"] })).status).toBe(400);
    expect((await admin("setRule", { name: "types", does: "check", words: ["*.ts"], run: "bunx tsc\nrm -rf /" })).status).toBe(400);
    expect((await admin("setRule", { name: "keyed", does: "check", words: ["*.ts"], run: `curl -H 'x-api-key: sk-ant-api03-${"FAKE".repeat(8)}' https://example.com` })).status).toBe(422);
    // A check stops nothing, so no trip of it is ever a line in the ledger.
    const before = trips().length;
    expect((await admin("ruleTripped", { quest: "q-check", rule: "types", command: "touch a.ts" })).status).toBe(400);
    expect(trips().length).toBe(before);
    expect((await admin("removeRule", { name: "types" })).status).toBe(200);
  });

  test("checked at the door: one that would match nothing, a glob that isn't one line, a key, one too many", async () => {
    expect((await admin("setRule", { name: "empty", does: "halt", words: [] })).status).toBe(400);
    expect((await admin("setRule", { name: "lines", does: "halt", words: ["a\nb"] })).status).toBe(400);
    expect((await admin("setRule", { name: "sneaky", does: "halt", words: ["*.lock"], run: "rm -rf /" })).status).toBe(400);
    const key = await admin<{ error: string }>("setRule", { name: "key", does: "refuse", words: [], contains: `sk-ant-api03-${"FAKE".repeat(8)}` });
    expect(key.status).toBe(422);
    expect((await rulesNow()).some((r) => r.name === "key")).toBe(false);
    const held = (await rulesNow()).length;
    for (let i = held; i < MAX_RULES; i++) expect((await admin("setRule", { name: `r${i}`, does: "refuse", words: [`*.x${i}`] })).status).toBe(200);
    const more = await admin<{ error: string }>("setRule", { name: "one-more", does: "refuse", words: ["*.y"] });
    expect(more.status).toBe(400);
    expect(more.body.error).toContain(`at most ${MAX_RULES}`);
    // Replacing one you have is never one too many.
    expect((await admin("setRule", { name: "r31", does: "halt", words: ["*.x31"] })).status).toBe(200);
    for (let i = held; i < MAX_RULES; i++) expect((await admin("removeRule", { name: `r${i}` })).status).toBe(200);
  });

  test("an agent can never set or remove one (refused by its scope), nor another node of the fleet, nor a device you didn't give fleet:admin", async () => {
    expect((await arm("setRule", { name: "agents-rule", does: "refuse", words: ["*"] })).status).toBe(403);
    expect((await arm("removeRule", { name: "no-locks" })).status).toBe(403);
    // It may read them: they are what its commands are held to.
    expect((await arm<{ rules: RuleView[] }>("rules")).body.rules.map((r) => r.name)).toEqual(["no-locks"]);
    const other = newNodeIdentity();
    daemon.store.emit(daemon.identity, "device.enrolled", { device: other.id, name: "server", kind: "node", role: "full", box: b64u(other.boxPublic), scopes: [] });
    for (const [route, body, why] of [
      ["setRule", { name: "nodes-rule", does: "refuse", words: ["*"] }, "only you can set a rule"],
      ["removeRule", { name: "no-locks" }, "only you can remove a rule"],
    ] as const) {
      // (A full node holds every scope: it is refused for who it is, after its signature was checked.)
      const refused = await signedFetch(other, `http://127.0.0.1:${port}`, routes[route].path, body);
      expect({ status: refused.status, error: ((await refused.json()) as { error: string }).error }).toEqual({ status: 403, error: why });
    }
    const reader = await pair("tablet", ["mind:read"]);
    expect((await reader.call("setRule", { name: "tablets-rule", does: "refuse", words: ["*"] })).status).toBe(403);
    expect((await rulesNow()).map((r) => r.name)).toEqual(["no-locks"]);
  });
});

describe("a trip", () => {
  test("is a line in the ledger: which rule, what it did and why, the quest, the command with any key taken out", async () => {
    expect((await admin("ruleTripped", { quest: "q-trip1", rule: "no-locks", command: `rm bun.lock && echo sk-ant-api03-${"FAKE".repeat(8)}` })).status).toBe(200);
    expect(trips().at(0)).toMatchObject({ class: "forbidden", resource: "rule", target: "no-locks", verdict: "deny", quest: "q-trip1", reason: "your tripwire refused the command: the word `bun.lock` matches `*.lock`" });
    expect(trips().at(0)!.detail).toStartWith("rm bun.lock && echo ");
    expect(trips().at(0)!.detail).not.toContain("FAKEFAKE");
    expect((await admin("ruleTripped", { quest: "q-trip2", rule: "no-locks", command: "bun test bun.lock", gate: true })).status).toBe(200);
    expect(trips().at(0)).toMatchObject({ quest: "q-trip2", reason: "your tripwire refused the gate: the word `bun.lock` matches `*.lock`" });
  });

  test("said by an agent running its own quest, is recorded under that agent's quest", async () => {
    expect((await arm("ruleTripped", { quest: "q-agent1", rule: "no-locks", command: "rm yarn.lock" })).status).toBe(200);
    expect(trips().at(0)).toMatchObject({ target: "no-locks", quest: "arm.test-arm.q-agent1" });
  });

  test("the rule doesn't stop, or no rule of that name: no line", async () => {
    const before = trips().length;
    expect((await admin("ruleTripped", { quest: "q-trip3", rule: "no-locks", command: "bun test" })).status).toBe(400);
    expect((await admin("ruleTripped", { quest: "q-trip3", rule: "nobody", command: "rm bun.lock" })).status).toBe(404);
    expect(trips().length).toBe(before);
  });
});

describe("a rule that tells you", () => {
  const notice = (key: string) => daemon.store.lww<{ severity: string; title: string; body: string; source: string; dismissed: boolean } | null>(`notice:${key}`)?.value ?? null;

  test("set with --tell (no command of its own); a command it matches has run: a notice in your Inbox, once for each task", async () => {
    expect((await admin("setRule", { name: "pushes", does: "tell", words: ["git"], contains: "push" })).status).toBe(200);
    expect((await rulesNow()).find((r) => r.name === "pushes")?.rule).toEqual({ on: "after", does: "tell", words: ["git"], contains: "push" });
    expect((await admin("setRule", { name: "bad-tell", does: "tell", words: ["git"], run: "echo hi" })).status).toBe(400);
    expect((await admin("ruleTold", { quest: "q-tell1", rule: "pushes", command: `git push origin main && echo sk-ant-api03-${"FAKE".repeat(8)}`, exitCode: 0 })).status).toBe(200);
    expect(notice("rule:pushes:q-tell1")).toMatchObject({ severity: "info", source: "rule:pushes", title: "Your rule pushes: a command it matches has run", dismissed: false });
    // What its title says isn't said again: where it ran, how it ended, and the command.
    expect(notice("rule:pushes:q-tell1")!.body).toStartWith("In one of his quests (q-tell1), and it succeeded:\n$ git push origin main && echo ");
    expect(notice("rule:pushes:q-tell1")!.body).not.toContain("FAKEFAKE");
    const said = notice("rule:pushes:q-tell1")!.body;
    // Again in the same task, as many times as it runs: nothing more is written (the notice says the first; the log
    // holds one event for it, however busy the task).
    const events = daemon.store.eventCount();
    for (const exitCode of [1, 0, 0]) expect((await admin("ruleTold", { quest: "q-tell1", rule: "pushes", command: "git push --force", exitCode })).status).toBe(200);
    expect(daemon.store.eventCount()).toBe(events);
    expect(notice("rule:pushes:q-tell1")!.body).toBe(said);
  });

  test("one you dismissed stays quiet for that task; another task is told again; what it doesn't match, or no such rule: nothing", async () => {
    daemon.store.emit(daemon.identity, "notice.dismissed", { key: "rule:pushes:q-tell1" });
    expect((await admin("ruleTold", { quest: "q-tell1", rule: "pushes", command: "git push", exitCode: 0 })).status).toBe(200);
    expect(notice("rule:pushes:q-tell1")).toMatchObject({ dismissed: true });
    expect((await arm("ruleTold", { quest: "q-agent2", rule: "pushes", command: "git push", exitCode: 0 })).status).toBe(200);
    expect(notice("rule:pushes:arm.test-arm.q-agent2")).toMatchObject({ dismissed: false, source: "rule:pushes" });
    expect((await admin("ruleTold", { quest: "q-tell3", rule: "pushes", command: "git pull", exitCode: 0 })).status).toBe(400);
    expect((await admin("ruleTold", { quest: "q-tell3", rule: "nobody", command: "git push", exitCode: 0 })).status).toBe(404);
    expect(notice("rule:pushes:q-tell3")).toBeNull();
  });
});
