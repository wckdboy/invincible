import { describe, expect, test } from "bun:test";
import { DecisionRequest, newNodeIdentity } from "@galahad/core";
import { foundFleet, MindStore, Vault } from "@galahad/mind";
import { decide, DecisionError, decisionCall, readDecision } from "../src/index.ts";

/*
 * Decisions: typed answers from a decision model (TypeSafe's Jev), hired by the
 * decider role, through Cloudflare's ai/run (your gateway, TypeSafe's key stored with
 * Cloudflare) or TypeSafe directly.
 */

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const CF = `https://gateway.ai.cloudflare.com/v1/${ACCOUNT}/galahad/compat`;
const TOKEN = "cf_aig_FAKE_token_for_tests_0123456789";
const REQUEST = DecisionRequest.parse({
  state: "Help! My payouts have been failing for 3 days.",
  questions: {
    urgent: { type: "noul", instructions: "Does this convey urgency?" },
    team: { type: "choice", instructions: "Which team?", criteria: { billing: "Payments", technical: "Bugs", sales: null } },
    frustration: { type: "score", criteria: ["Calm", "Frustrated", "Very angry"] },
  },
});
const ANSWER = { model: "jev-1.13.0", answers: { urgent: { type: "noul" as const, noul: 0.95 }, team: { type: "choice" as const, choice: "billing", confidence: 0.8, probabilities: { billing: 0.87, technical: 0.13, sales: 0 } } } };

describe("where a decision goes", () => {
  test("through Cloudflare: its ai/run for your account, your gateway by name, the token as the bearer", () => {
    const call = decisionCall({ baseUrl: CF, apiKey: TOKEN }, "typesafe/jev", REQUEST);
    expect(call.url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run`);
    expect(call.headers).toEqual({ authorization: `Bearer ${TOKEN}`, "cf-aig-gateway-id": "galahad", "content-type": "application/json" });
    expect(call.body).toEqual({ model: "typesafe/jev", input: { state: REQUEST.state, questions: REQUEST.questions } });
  });

  test("directly: TypeSafe's /v1/systemone", () => {
    for (const baseUrl of ["https://api.typesafe.ai", "https://api.typesafe.ai/v1", "https://api.typesafe.ai/"]) {
      const call = decisionCall({ baseUrl, apiKey: "k" }, "jev-latest", REQUEST);
      expect(call.url).toBe("https://api.typesafe.ai/v1/systemone");
      expect(call.body).toEqual({ model: "jev-latest", state: REQUEST.state, questions: REQUEST.questions });
    }
  });

  test("a Cloudflare base URL that names no account and gateway is refused", () => {
    expect(() => decisionCall({ baseUrl: "https://gateway.ai.cloudflare.com/v1/compat", apiKey: TOKEN }, "typesafe/jev", REQUEST)).toThrow(/account and a gateway/);
  });

  test("answers bare or wrapped by Cloudflare", () => {
    expect(readDecision(ANSWER)).toEqual(ANSWER);
    expect(readDecision({ success: true, result: ANSWER })).toEqual(ANSWER);
    // As Cloudflare's ai/run answers live: wrapped twice, the inner one with a state.
    expect(readDecision({ result: { state: "Completed", result: ANSWER }, success: true, errors: [], messages: [] })).toEqual(ANSWER);
    expect(readDecision({ success: false, errors: [] })).toBeNull();
  });

  test("questions are checked at the boundary", () => {
    expect(DecisionRequest.safeParse({ state: "x", questions: {} }).success).toBe(false);
    expect(DecisionRequest.safeParse({ state: "x", questions: { q: { type: "score", criteria: ["only one"] } } }).success).toBe(false);
    expect(DecisionRequest.safeParse({ state: "x", questions: { q: { type: "guess" } } }).success).toBe(false);
  });
});

describe("the decider role", () => {
  function setup() {
    const identity = newNodeIdentity();
    const store = new MindStore(":memory:");
    foundFleet(store, identity, { fleetName: "camelot", nodeName: "ultra" });
    const vault = new Vault(store, identity);
    vault.set("cloudflare-ai", TOKEN, { provider: "cloudflare-ai", origin: "https://gateway.ai.cloudflare.com" });
    store.emit(identity, "provider.set", { id: "cloudflare-ai", kind: "openai", baseUrl: CF, secret: "cloudflare-ai" });
    return { identity, store, vault };
  }

  test("none hired: says how", async () => {
    const { store, vault } = setup();
    const error = await decide({ store, vault }, REQUEST).catch((e) => e);
    expect(error).toBeInstanceOf(DecisionError);
    expect(error.message).toContain("galahad roster set decider");
  });

  test("the first that answers wins; the key is redacted from any failure", async () => {
    const { identity, store, vault } = setup();
    store.emit(identity, "roster.set", { role: "decider", models: ["nowhere/jev", "cloudflare-ai/typesafe/jev-1.14.0", "cloudflare-ai/typesafe/jev"] });
    const asked: string[] = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const model = JSON.parse(String(init?.body)).model;
      asked.push(`${url} ${model}`);
      if (model === "typesafe/jev-1.14.0") return new Response(`{"error":"bad token ${TOKEN}"}`, { status: 400 });
      return Response.json({ result: ANSWER, success: true });
    }) as typeof globalThis.fetch;
    const view = await decide({ store, vault, fetch }, REQUEST);
    expect(view).toEqual({ ref: "cloudflare-ai/typesafe/jev", model: "jev-1.13.0", answers: ANSWER.answers });
    expect(asked).toEqual([
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run typesafe/jev-1.14.0`,
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run typesafe/jev`,
    ]);
  });
});
