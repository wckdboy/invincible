import { type DecisionAnswer, type DecisionRequest, type DecisionView, redact } from "@galahad/core";
import { type BrainContext } from "./chat.ts";
import { onPlan, originOf, resolveProvider, type ResolvedProvider } from "./providers.ts";
import { parseRef, roleModels } from "./roster.ts";

/*
 * Decisions from a decision model (TypeSafe's System One: Jev), hired by role:
 * `galahad roster set decider <provider>/<model> …`, fallbacks in order, like every role.
 *
 *   cloudflare-ai/typesafe/jev   through your Cloudflare AI Gateway: Cloudflare's
 *                                unified ai/run API, model typesafe/jev, your gateway named
 *                                in cf-aig-gateway-id, TypeSafe's key stored with Cloudflare
 *   typesafe/jev-latest          TypeSafe directly (a provider with base URL https://api.typesafe.ai)
 */

const CF_GATEWAY = "https://gateway.ai.cloudflare.com";

export interface DecisionCall {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Where a decision goes for a provider and model. A Cloudflare gateway token (pinned to
 * the gateway's origin) also goes to Cloudflare's ai/run for that one account: a route
 * fixed here, never a configuration's say.
 */
export function decisionCall(provider: Pick<ResolvedProvider, "baseUrl" | "apiKey">, model: string, request: DecisionRequest): DecisionCall {
  if (!provider.apiKey) throw new Error("no key");
  if (originOf(provider.baseUrl) === CF_GATEWAY) {
    const m = new URL(provider.baseUrl).pathname.match(/^\/v1\/([0-9a-f]{32})\/([A-Za-z0-9_-]{1,64})(?:\/|$)/);
    if (!m) throw new Error("the Cloudflare provider's base URL doesn't name an account and a gateway");
    return {
      url: `https://api.cloudflare.com/client/v4/accounts/${m[1]}/ai/run`,
      headers: { authorization: `Bearer ${provider.apiKey}`, "cf-aig-gateway-id": m[2]!, "content-type": "application/json" },
      body: { model, input: { state: request.state, questions: request.questions } },
    };
  }
  return {
    url: `${provider.baseUrl.replace(/\/(v1\/?)?$/, "")}/v1/systemone`,
    headers: { authorization: `Bearer ${provider.apiKey}`, "content-type": "application/json" },
    body: { model, state: request.state, questions: request.questions },
  };
}

/** System One's answer, bare or wrapped by Cloudflare (live: { result: { state, result: … } }). */
export function readDecision(json: unknown): { model: string; answers: Record<string, DecisionAnswer> } | null {
  let inner = json && typeof json === "object" ? (json as Record<string, unknown>) : null;
  for (let depth = 0; inner && !("answers" in inner) && depth < 3; depth++) {
    inner = inner.result && typeof inner.result === "object" ? (inner.result as Record<string, unknown>) : null;
  }
  if (!inner || typeof inner.answers !== "object" || !inner.answers) return null;
  return { model: typeof inner.model === "string" ? inner.model : "", answers: inner.answers as Record<string, DecisionAnswer> };
}

export class DecisionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Ask the decider role, walking its fallbacks. */
export async function decide(ctx: BrainContext, request: DecisionRequest, signal?: AbortSignal): Promise<DecisionView> {
  const refs = roleModels(ctx.store, "decider");
  if (!refs.length) throw new DecisionError(424, "no decision model yet: galahad roster set decider cloudflare-ai/typesafe/jev (or typesafe/jev-latest)");
  const problems: string[] = [];
  for (const ref of refs) {
    let provider: ResolvedProvider | null;
    let model: string;
    try {
      ({ model } = parseRef(ref));
      provider = resolveProvider(ctx.store, ctx.vault, parseRef(ref).provider);
    } catch (error) {
      problems.push(`${ref}: ${(error as Error).message}`);
      continue;
    }
    if (!provider?.apiKey) {
      problems.push(`${ref}: ${provider ? (onPlan(ref) ? "on a coding plan, whose key is for coding tools" : "no key") : "no such provider"}`);
      continue;
    }
    try {
      const call = decisionCall(provider, model, request);
      const response = await (ctx.fetch ?? fetch)(call.url, {
        method: "POST",
        headers: call.headers,
        body: JSON.stringify(call.body),
        redirect: "manual",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
      });
      const text = await response.text();
      const parsed = response.ok ? readDecision(JSON.parse(text)) : null;
      if (parsed) return { ref, model: parsed.model || model, answers: parsed.answers };
      problems.push(`${ref}: ${response.status} ${redact(text, [provider.apiKey]).slice(0, 300)}`);
    } catch (error) {
      problems.push(`${ref}: ${redact(String((error as Error).message ?? error), [provider.apiKey]).slice(0, 300)}`);
    }
  }
  throw new DecisionError(502, `no decision model could answer: ${problems.join("; ")}`);
}
