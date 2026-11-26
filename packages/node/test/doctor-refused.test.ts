import { describe, expect, test } from "bun:test";
import { newNodeIdentity } from "@galahad/core";
import { foundFleet, MindStore, Vault } from "@galahad/mind";
import { refusedKeysOf, refusalsStillSaid } from "@galahad/brain";
import { type Diagnosis, type DoctorFacts, diagnose } from "../src/doctor.ts";

/*
 * A provider that refuses its key: the doctor says each one still remembered, as needs you, with what to do. A refusal
 * from before the provider's key was last set is not said (the key was replaced since). Its heartbeat finding is raised
 * once, as the doctor's other findings are.
 */

const NOW = Date.UTC(2026, 10, 22, 1, 28);

function base(): DoctorFacts {
  return {
    now: NOW,
    quick: false,
    offline: false,
    self: { id: "n_self", name: "ultra", fleetName: "camelot", active: true, role: "full", alwaysOn: true, startedAt: NOW - 3 * 86_400_000 },
    keys: { keystore: "file", keyFile: { exists: true, mode: 0o600 }, home: { exists: true, mode: 0o700 }, adminToken: { exists: true, mode: 0o600 } },
    mind: { events: 1000, integrity: "ok", head: null, forks: [], newestEventAt: NOW - 1000, timeSynced: true, peers: [], backup: null },
    vault: { unlocked: true, secrets: 3, requests: [] },
    providers: { setUp: 2, byDefault: ["deepseek", "mimo-token"] },
    roles: [
      { role: "planner", chats: true, models: [{ ref: "deepseek/deepseek-chat", problem: null }], probe: { ref: "deepseek/deepseek-chat", ok: true, ms: 800, error: null } },
      { role: "engineer", chats: true, models: [{ ref: "deepseek/deepseek-chat", problem: null }], probe: { ref: "deepseek/deepseek-chat", ok: true, ms: 800, error: null } },
    ],
    archive: null,
    sandbox: { host: null, others: [] },
    compute: null,
    loops: [],
    connectors: [],
    app: { missing: [], published: null, local: "http://127.0.0.1:7778" },
    disk: null,
    service: { restarts: 0, warnings: [] },
  };
}

const byId = (checks: Diagnosis[], id: string): Diagnosis => {
  const found = checks.find((c) => c.id === id);
  if (!found) throw new Error(`no check ${id}; there are: ${checks.map((c) => c.id).join(", ")}`);
  return found;
};
const hasId = (checks: Diagnosis[], id: string): boolean => checks.some((c) => c.id === id);

describe("a provider that refused its key", () => {
  test("no refusal remembered: no refused-key lines", () => {
    const checks = diagnose(base());
    expect(checks.filter((c) => c.id.startsWith("models.key."))).toEqual([]);
  });

  test("a coding plan that names other regions: said once, needs you, with the key add and its region's address", () => {
    const facts = base();
    facts.refused = [{ provider: "mimo-token", at: NOW, said: "401: Invalid API Key" }];
    const checks = diagnose(facts);
    expect(checks.filter((c) => c.id === "models.key.mimo-token")).toHaveLength(1);
    const refused = byId(checks, "models.key.mimo-token");
    expect(refused.area).toBe("models");
    expect(refused.state).toBe("needs-you");
    expect(refused.line).toBe("mimo-token refused its key at 01:28 UTC: 401: Invalid API Key");
    expect(refused.fix).toContain("galahad key add --provider mimo-token");
    expect(refused.fix).toContain("--base-url");
    expect(refused.finding).toMatchObject({ severity: "warn", title: "mimo-token refused its key" });
    expect(refused.finding!.body).toContain("mimo-token refused its key at 01:28 UTC: 401: Invalid API Key");
    expect(refused.finding!.key).toBe("doctor:models.key.mimo-token:n_self");
  });

  test("an ordinary provider: the key add, and no word of a plan's region", () => {
    const facts = base();
    facts.refused = [{ provider: "deepseek", at: NOW, said: "403: Forbidden" }];
    const refused = byId(diagnose(facts), "models.key.deepseek");
    expect(refused.state).toBe("needs-you");
    expect(refused.line).toBe("deepseek refused its key at 01:28 UTC: 403: Forbidden");
    expect(refused.fix).toBe("Replace the key: galahad key add --provider deepseek.");
    expect(refused.fix).not.toContain("--base-url");
    expect(hasId(diagnose(facts), "models.key.mimo-token")).toBe(false);
  });
});

// Its models are still asked, and refused, until the key is replaced: a role's lines name the model that answers
// instead, and the refusal is said once (above), never again as a role's plan or first model (no second Inbox notice).
describe("a role whose model's provider refused its key", () => {
  test("a coding plan that refuses its key isn't said to do the work: the plan behind it is", () => {
    const facts = base();
    facts.roles.push({ role: "plan-coder", custom: true, chats: true, models: [{ ref: "mimo-token/mimo-v2.6-pro", problem: null, plan: true }, { ref: "zai-coding/glm-5.3", problem: null, plan: true }], probe: null });
    facts.refused = [{ provider: "mimo-token", at: NOW, said: "401: Invalid API Key" }];
    const checks = diagnose(facts);
    expect(byId(checks, "role.plan-coder")).toMatchObject({ state: "ok", line: "plan-coder: zai-coding/glm-5.3 does the work of the knights on it (a coding plan: it is asked nothing else, so not a word)" });
    expect(hasId(checks, "role.plan-coder.plan")).toBe(false);
    expect(checks.filter((c) => c.line.includes("mimo-token")).map((c) => c.id)).toEqual(["models.key.mimo-token"]);
  });

  test("a first model whose key was refused makes no first-model line: the next one answers, and one notice is raised", () => {
    const facts = base();
    facts.quick = true;
    facts.roles[0] = { role: "planner", chats: true, models: [{ ref: "deepseek/deepseek-chat", problem: null }, { ref: "mistral/mistral-large-latest", problem: null }], probe: null };
    facts.refused = [{ provider: "deepseek", at: NOW, said: "401: Authentication Fails" }];
    const checks = diagnose(facts);
    expect(hasId(checks, "role.planner.first")).toBe(false);
    expect(byId(checks, "role.planner").line).toBe("planner: mistral/mistral-large-latest has what it needs (not asked: a full check asks it one word)");
    expect(checks.filter((c) => c.area === "models" && c.finding).map((c) => c.id)).toEqual(["models.key.deepseek"]);
  });

  test("a full check asks the refused model its word, and when it is refused again the model behind it is named, as ok", () => {
    // (Percival's review, 22 November 2026: the probe line named the refused model, a second needs-you for one cause.)
    const facts = base();
    facts.roles[0] = { role: "planner", chats: true, models: [{ ref: "deepseek/deepseek-chat", problem: null }, { ref: "mistral/mistral-large-latest", problem: null }], probe: { ref: "deepseek/deepseek-chat", ok: false, ms: 300, error: "deepseek → 401: Authentication Fails" } };
    facts.refused = [{ provider: "deepseek", at: NOW, said: "401: Authentication Fails" }];
    const checks = diagnose(facts);
    expect(byId(checks, "role.planner")).toMatchObject({ state: "ok", line: "planner: mistral/mistral-large-latest has what it needs (not asked: deepseek/deepseek-chat, before it, still refuses its key)" });
    // One cause, said once: the planner's own lines are this one, ok.
    expect(checks.filter((c) => c.id.startsWith("role.planner")).map((c) => [c.id, c.state])).toEqual([["role.planner", "ok"]]);
    // Not answering for another reason (no answer in time) is news of its own, said as it always was.
    facts.roles[0]!.probe = { ref: "deepseek/deepseek-chat", ok: false, ms: 20_000, error: "no answer within 20 s (timed out)" };
    expect(byId(diagnose(facts), "role.planner")).toMatchObject({ state: "needs-you", line: "planner: deepseek/deepseek-chat didn't answer: no answer within 20 s (timed out) (mistral/mistral-large-latest is next in line)" });
  });

  test("a coding role whose own model's key was refused, and whose coding plan works, is played by the plan", () => {
    const facts = base();
    facts.roles[1] = { role: "engineer", chats: true, models: [{ ref: "deepseek/deepseek-chat", problem: null }, { ref: "zai-coding/glm-5.3", problem: null, plan: true }], probe: null };
    facts.refused = [{ provider: "deepseek", at: NOW, said: "401: Authentication Fails" }];
    expect(byId(diagnose(facts), "role.engineer")).toMatchObject({ state: "ok", line: "engineer: zai-coding/glm-5.3 does his coding (a coding plan: it is asked nothing else, so not a word)" });
  });

  test("a role whose every model's key was refused: nobody can play it, said with why, a coding role's not as outside coding", () => {
    const facts = base();
    facts.roles[0] = { role: "planner", chats: true, models: [{ ref: "deepseek/deepseek-chat", problem: null }], probe: null };
    facts.roles.push({ role: "plan-coder", custom: true, chats: true, models: [{ ref: "mimo-token/mimo-v2.6-pro", problem: null, plan: true }], probe: null });
    facts.refused = [
      { provider: "deepseek", at: NOW, said: "401: Authentication Fails" },
      { provider: "mimo-token", at: NOW, said: "401: Invalid API Key" },
    ];
    const checks = diagnose(facts);
    expect(byId(checks, "role.planner")).toMatchObject({ state: "broken", line: "no model can play planner: deepseek/deepseek-chat (its provider refused its key)" });
    expect(byId(checks, "role.plan-coder")).toMatchObject({ state: "needs-you", line: "no model can play plan-coder: mimo-token/mimo-v2.6-pro (its provider refused its key)" });
    // What to do is the key's (said above), or another model.
    expect(byId(checks, "role.planner").fix).toBe("Replace its key (said above), or hire a model that works here: galahad roster set planner <provider/model>.");
  });
});

describe("a refusal from before the key was last set", () => {
  function keyedBrain() {
    const id = "mimo-token";
    const identity = newNodeIdentity();
    const store = new MindStore(":memory:");
    foundFleet(store, identity, { fleetName: "camelot", nodeName: "n" });
    const vault = new Vault(store, identity);
    const baseUrl = "https://plan.invalid/v1";
    vault.set(id, ["FAKE", "mimo", "key"].join("-"), { provider: id, origin: new URL(baseUrl).origin });
    store.emit(identity, "provider.set", { id, kind: "openai", baseUrl, secret: id });
    return { store, vault, baseUrl };
  }

  test("is not said: the key was replaced since", () => {
    const { store, vault } = keyedBrain();
    const refusals = refusedKeysOf(store);
    refusals.now = () => Date.now() - 60_000;
    refusals.note("mimo-token", '401 {"error":{"message":"Invalid API Key"}}');
    // The remembered refusal stays, but what the doctor says leaves it out.
    expect(refusals.list()).toHaveLength(1);
    expect(refusalsStillSaid(store, vault)).toEqual([]);
  });

  test("is said while the key that was refused is still the one set; setting it again leaves it out", async () => {
    const { store, vault, baseUrl } = keyedBrain();
    const refusals = refusedKeysOf(store);
    refusals.now = () => Date.now();
    refusals.note("mimo-token", '401 {"error":{"message":"Invalid API Key"}}');
    expect(refusalsStillSaid(store, vault)).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 10));
    vault.set("mimo-token", ["FAKE", "mimo", "key", "new"].join("-"), { provider: "mimo-token", origin: new URL(baseUrl).origin });
    expect(refusalsStillSaid(store, vault)).toEqual([]);
  });
});
