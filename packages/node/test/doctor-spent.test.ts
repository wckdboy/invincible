import { describe, expect, test } from "bun:test";
import { type Diagnosis, type DoctorFacts, diagnose, refusalWords } from "../src/doctor.ts";

/*
 * An allowance window that ends by itself is no fault: the doctor says each open window once, in the models area, as ok,
 * and never lets a spent model make a role's plan or first line (so no heartbeat finding or Inbox notice comes of it).
 * Facts are made by hand, as doctor.test.ts makes them.
 */

const NOW = Date.UTC(2026, 10, 22, 12, 0, 0);
const MIN = 60_000;
const UNTIL = NOW + 97 * MIN;
const SPENT_PROBLEM = "its allowance is spent until 13:37 UTC (1h 37m from now), as its provider said: passed over without asking";

function base(): DoctorFacts {
  return {
    now: NOW,
    quick: false,
    offline: false,
    self: { id: "n_self", name: "ultra", fleetName: "camelot", active: true, role: "full", alwaysOn: true, startedAt: NOW - 3 * 86_400_000 },
    keys: { keystore: "file", keyFile: { exists: true, mode: 0o600 }, home: { exists: true, mode: 0o700 }, adminToken: { exists: true, mode: 0o600 } },
    mind: { events: 1000, integrity: "ok", head: null, forks: [], newestEventAt: NOW - 1000, timeSynced: true, peers: [], backup: null },
    vault: { unlocked: true, secrets: 3, requests: [] },
    providers: { setUp: 2, byDefault: ["deepseek", "opencode-go"] },
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

describe("an allowance window that ends by itself", () => {
  test("facts from before the window is known read as now: no spent lines, no spent models", () => {
    const checks = diagnose(base());
    expect(checks.filter((c) => c.id.startsWith("models.spent."))).toEqual([]);
    expect(byId(checks, "role.planner").state).toBe("ok");
  });

  test("two roles naming the same spent plan: one spent line, and no .plan or .first line for it", () => {
    const facts = base();
    facts.spent = [{ provider: "opencode-go", until: UNTIL }];
    facts.roles[0]!.models = [{ ref: "opencode-go/gpt-6-luna", problem: SPENT_PROBLEM, plan: true, spent: true }];
    facts.roles[1]!.models = [{ ref: "opencode-go/gpt-6-luna", problem: SPENT_PROBLEM, plan: true, spent: true }];
    const checks = diagnose(facts);
    expect(checks.filter((c) => c.id === "models.spent.opencode-go")).toHaveLength(1);
    const spent = byId(checks, "models.spent.opencode-go");
    expect(spent.state).toBe("ok");
    expect(spent.fix).toBeUndefined();
    expect(spent.line).toBe("opencode-go's allowance is spent until 13:37 UTC (1h 37m from now), as its provider said: its models are passed over on every role until then");
    expect(hasId(checks, "role.planner.plan")).toBe(false);
    expect(hasId(checks, "role.planner.first")).toBe(false);
    expect(hasId(checks, "role.engineer.plan")).toBe(false);
    expect(hasId(checks, "role.engineer.first")).toBe(false);
    // Each role's only model is spent: still said as now.
    expect(byId(checks, "role.planner").line).toContain("no model can play planner");
    expect(byId(checks, "role.engineer").line).toContain("no model can play engineer");
  });

  test("a window of one model's (a router's or an API's, not a plan's) is said of that model alone", () => {
    const facts = base();
    facts.spent = [{ provider: "orcarouter/anthropic/claude-opus-5.5", until: UNTIL }];
    facts.roles[0]!.models = [
      { ref: "orcarouter/anthropic/claude-opus-5.5", problem: SPENT_PROBLEM, spent: true },
      { ref: "deepseek/deepseek-chat", problem: null },
    ];
    const checks = diagnose(facts);
    expect(byId(checks, "models.spent.orcarouter/anthropic/claude-opus-5.5").line).toBe("orcarouter/anthropic/claude-opus-5.5's allowance is spent until 13:37 UTC (1h 37m from now), as its provider said: it is passed over on every role until then");
    expect(hasId(checks, "role.planner.first")).toBe(false);
  });

  test("a spent first model never makes a .first line: the next usable model answers", () => {
    const facts = base();
    facts.spent = [{ provider: "opencode-go", until: UNTIL }];
    facts.roles[0]!.models = [
      { ref: "opencode-go/gpt-6-luna", problem: SPENT_PROBLEM, spent: true },
      { ref: "deepseek/deepseek-chat", problem: null },
    ];
    const checks = diagnose(facts);
    expect(hasId(checks, "role.planner.first")).toBe(false);
    expect(byId(checks, "role.planner").state).toBe("ok");
    expect(byId(checks, "role.planner").line).toContain("deepseek/deepseek-chat answered");
  });

  test("a plan with no key is still said as now: Add the plan's key", () => {
    const facts = base();
    facts.roles[1]!.models = [
      { ref: "zai-coding/glm-5.3", problem: 'provider "zai-coding" has no key in the vault', plan: true },
      { ref: "deepseek/deepseek-chat", problem: null },
    ];
    const plan = byId(diagnose(facts), "role.engineer.plan");
    expect(plan.state).toBe("needs-you");
    expect(plan.fix).toBe("Add the plan's key: galahad key add --provider zai-coding.");
  });

  test("a role whose only model is spent is still said as now: no model can play", () => {
    const facts = base();
    facts.spent = [{ provider: "opencode-go", until: UNTIL }];
    facts.roles[0]!.models = [{ ref: "opencode-go/gpt-6-luna", problem: SPENT_PROBLEM, spent: true }];
    facts.roles[0]!.probe = null;
    const planner = byId(diagnose(facts), "role.planner");
    expect(planner.line).toContain("no model can play planner");
    expect(planner.line).toContain("opencode-go/gpt-6-luna");
    expect(hasId(diagnose(facts), "role.planner.first")).toBe(false);
  });

  test("a coding role whose only plan is spent: nobody can play it until it resets, said as its work, not as outside coding", () => {
    const facts = base();
    facts.spent = [{ provider: "opencode-go", until: UNTIL }];
    facts.roles.push({ role: "plan-coder", custom: true, chats: true, models: [{ ref: "opencode-go/deepseek-v4-pro", problem: SPENT_PROBLEM, plan: true, spent: true }], probe: null });
    const coder = byId(diagnose(facts), "role.plan-coder");
    expect(coder.line).toBe(`no model can play plan-coder: opencode-go/deepseek-v4-pro (${SPENT_PROBLEM})`);
    expect(hasId(diagnose(facts), "role.plan-coder.plan")).toBe(false);
    // Nothing to add a key for: the window ends by itself (Percival's review, 22 November 2026).
    expect(coder.fix).toBe("It comes back by itself when its allowance resets (said above). To have plan-coder played before then: galahad roster set plan-coder <provider/model>.");
  });
});

describe("a provider's refusal, in its own words", () => {
  test("an HTTP status with a JSON body reads its status and message (error.message)", () => {
    expect(refusalWords('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}')).toBe(
      "400: Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
    );
  });

  test("a JSON body whose error is a list reads error[0].message (Cloudflare's AI Gateway)", () => {
    expect(refusalWords('400 {"error":[{"code":7009,"message":"Insufficient credits"}]}')).toBe("400: Insufficient credits");
  });

  test("a top-level message is read as the body's own words", () => {
    expect(refusalWords('429 {"message":"Rate limit exceeded"}')).toBe("429: Rate limit exceeded");
  });

  test("a long message is cut at a word, never mid-word", () => {
    const long = Array.from({ length: 60 }, () => "word").join(" ");
    const said = refusalWords(`400 {"error":{"message":"${long}"}}`);
    expect(said.length).toBeLessThanOrEqual(200);
    expect(said).toStartWith("400: ");
    expect(said).toMatch(/word$/);
  });

  test("anything else is said as it came", () => {
    expect(refusalWords("no answer within 20 s (timed out)")).toBe("no answer within 20 s (timed out)");
    expect(refusalWords("502 Bad Gateway")).toBe("502 Bad Gateway");
    expect(refusalWords("some\nbroken   spacing")).toBe("some broken spacing");
  });

  test("the probe's didn't-answer line says the provider's own words, and the advice still tells credit from a refused key", () => {
    const credit = base();
    credit.roles[0]!.probe = {
      ref: "deepseek/deepseek-chat",
      ok: false,
      ms: 300,
      error: '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}',
    };
    const out = byId(diagnose(credit), "role.planner");
    expect(out.line).toContain("didn't answer: 400: Your credit balance is too low");
    expect(out.line).not.toContain('"error"');
    expect(out.fix).toContain("out of credit");

    const refused = base();
    refused.roles[0]!.probe = { ref: "deepseek/deepseek-chat", ok: false, ms: 300, error: '401 {"error":{"message":"Incorrect API key provided"}}' };
    expect(byId(diagnose(refused), "role.planner").fix).toContain("refused the key");
  });
});
