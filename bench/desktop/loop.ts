import { type ChatMessage, type ClientCall, type ExecResult, newNodeIdentity, redact, type Usage } from "../../packages/core/src/index.ts";
import { foundFleet, LedgerStore, Vault } from "../../packages/ledger/src/index.ts";
import { chat, type ModelsContext } from "../../packages/models/src/index.ts";
import { desktopBriefing } from "../../packages/agents/src/desktop-command.ts";
import { COMPUTER_MEMBERS } from "../../packages/agents/src/engineer-tools.ts";
import { type RunDeps, type RunEvent, type RunOutcome, runLoop } from "../../packages/agents/src/run.ts";

/*
 * The four tasks through an agent's own tool loop (C1 step 7): runLoop with its tools and Claude's computer toolset,
 * as team-runtime runs an agent's task on a VM with a desktop, its engineer a Claude model through Anthropic's API and
 * chat(), its actions the VM's desktop commands through the agent's path (BenchVm.agent). Two models:
 *  - the stand-in (no model, no cost): Anthropic's stream in the toolset's own shape (a thinking block, then tool_use
 *    blocks named by member with toolset_name "computer"), its turns written for each task, each place it clicks read
 *    from the truth (the oracle) as the scripted ways read theirs. What it measures is everything but the model: the
 *    adapters, the loop, deskd and the apps, a turn's several actions and its one look;
 *  - a real one (model), through the node's gateway on a token minted for the benchmark: the adapter speaks to the
 *    gateway as to Anthropic's own API, which it forwards to with the key it holds, so the loop runs as it does on the
 *    node (its cache marks and all). Never without the token, and never past the spend it is given.
 */

/** The model the loop's engineer is: the one the owner's agents run on, and one that takes the computer toolset. */
export const MODEL = "claude-opus-5-5";
/** Its list prices, in dollars per million tokens (Anthropic, November 2026): input, a 5-minute cache write, a cache read, output. */
export const PRICES = { input: 4, write: 5, read: 0.2, output: 20 } as const;

/** A turn of the stand-in's: the toolset's calls (and any other tool's), or its words (DONE, GIVE UP). */
export interface Turn {
  calls?: { name: string; input: Record<string, unknown> }[];
  text?: string;
}

/** Where something is, as the bench's oracle says (kit/oracle.py): the truth, never the screen. */
export type Where = (args: string) => Promise<Record<string, any>>;

/** What a task's run through the loop came to: its outcome, and what it took. */
export interface LoopRun {
  outcome: RunOutcome | null;
  error: string | null;
  /** The engineer's model calls (each a turn). */
  calls: number;
  /** The toolset's actions that ran, and the other commands. */
  actions: number;
  commands: number;
  /** Each command it ran, as said (an action as its desktop command), redacted and cut short: what a run did. */
  said: string[];
  /** The calls' tokens, as the provider counted them (the stand-in's are none). */
  usage: Usage;
  ms: number;
}

/** A dollar figure for `usage` at PRICES, every input token not read from the cache priced as a cache write: an upper bound. */
export const dollarsOf = (usage: Usage): number => ((usage.input - (usage.cached ?? 0)) * PRICES.write + (usage.cached ?? 0) * PRICES.read + usage.output * PRICES.output) / 1e6;

/**
 * The stand-in's reply as Anthropic streams one: a thinking block (its signature obviously none), then its words, or its
 * calls as tool_use blocks, each of the toolset's carrying toolset_name "computer", as Claude's do.
 */
export function anthropicReply(turn: Turn, n: number): Response {
  const blocks: [object, object[]][] = [[{ type: "thinking", thinking: "", signature: "" }, [{ type: "thinking_delta", thinking: "The next step, from what is on the screen." }, { type: "signature_delta", signature: `bench-stand-in-${n}` }]]];
  if (turn.text) blocks.push([{ type: "text", text: "" }, [{ type: "text_delta", text: turn.text }]]);
  for (const [i, c] of (turn.calls ?? []).entries()) {
    blocks.push([{ type: "tool_use", id: `toolu_bench_${n}_${i}`, name: c.name, input: {}, ...(COMPUTER_MEMBERS.has(c.name) ? { toolset_name: "computer" } : {}) }, [{ type: "input_json_delta", partial_json: JSON.stringify(c.input) }]]);
  }
  const events: [string, object][] = [["message_start", { type: "message_start", message: { id: `msg_bench_${n}`, type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }]];
  blocks.forEach(([block, deltas], index) => {
    events.push(["content_block_start", { type: "content_block_start", index, content_block: block }]);
    for (const delta of deltas) events.push(["content_block_delta", { type: "content_block_delta", index, delta }]);
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
  });
  events.push(["message_delta", { type: "message_delta", delta: { stop_reason: turn.calls?.length ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } }]);
  events.push(["message_stop", { type: "message_stop" }]);
  return new Response(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

/** What the stand-in was asked, request by request: whether each offered the toolset, and how the turn before came back. */
export interface Asked {
  toolset: boolean;
  /** The last turn's toolset calls given back as the toolset's, and their results with them. */
  echoed: { calls: number; asToolset: number; results: number; resultsAsToolset: number; pictures: number };
}

/** A request to Anthropic's API as Asked: whether it offered the toolset, and how its last turn and what came of it came back. */
export function askedOf(raw: unknown): Asked {
  const body = JSON.parse(String(raw)) as { tools?: { type?: string }[]; messages: { role: string; content: unknown }[] };
  // (Its last turn, and what came of it: a change of effort may stand between them, as a system message.)
  const last = body.messages.findLast((m) => m.role === "assistant");
  const results = body.messages.findLast((m) => m.role === "user");
  const blocks = (m: { content: unknown } | undefined) => (Array.isArray(m?.content) ? (m!.content as Record<string, unknown>[]) : []);
  const calls = blocks(last).filter((b) => b.type === "tool_use");
  const given = blocks(results).filter((b) => b.type === "tool_result");
  return {
    toolset: (body.tools ?? []).some((t) => t.type === "computer_toolset_20260801"),
    echoed: {
      calls: calls.filter((c) => COMPUTER_MEMBERS.has(String(c.name))).length,
      asToolset: calls.filter((c) => c.toolset_name === "computer").length,
      results: given.length,
      resultsAsToolset: given.filter((r) => r.toolset_name === "computer").length,
      pictures: given.flatMap((r) => (Array.isArray(r.content) ? (r.content as { type: string }[]) : [])).filter((p) => p.type === "image").length,
    },
  };
}

/** A fetch whose every request is kept as Asked first. */
export const recording = (via: typeof fetch, asked: Asked[]): typeof fetch =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    asked.push(askedOf(init?.body));
    return via(url, init);
  }) as typeof fetch;

/**
 * The stand-in Anthropic endpoint: each request for the engineer answered with the task's next turn (`turns`, pulled as
 * it is asked), every request kept as Asked. A turn it has none left for is GIVE UP, never a hang.
 */
export function standIn(turns: AsyncGenerator<Turn, void>, asked: Asked[]): typeof fetch {
  let n = 0;
  const reply = async (): Promise<Response> => {
    const next = await turns.next();
    return anthropicReply(next.done ? { text: "GIVE UP\nThe stand-in has no turn left for this task." } : next.value, ++n);
  };
  return recording(reply as unknown as typeof fetch, asked);
}

/**
 * The gateway as Anthropic's own API: each request the adapter sends to api.anthropic.com goes to the node's gateway
 * for its provider instead, with the benchmark's token (which the adapter sends as its key), and nowhere else. A route
 * whose provider's address ends in its API's version already (orcarouter's) takes the path without Anthropic's /v1.
 */
export function throughGateway(gateway: string, route: { versioned?: boolean } = {}): typeof fetch {
  const base = gateway.replace(/\/+$/, "");
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const asked = new URL(url instanceof Request ? url.url : String(url));
    if (asked.origin !== "https://api.anthropic.com") throw new Error(`the bench's model calls go to Anthropic's API alone, not ${asked.origin}`);
    const path = route.versioned ? asked.pathname.replace(/^\/v1\//, "/") : asked.pathname;
    return fetch(`${base}${path}${asked.search}`, { ...init, redirect: "manual" });
  }) as typeof fetch;
}

/**
 * A node's mind for the loop's model: one provider, Anthropic's, its key the one given (the stand-in's is obviously
 * none), on the roster as `model` (a router's name for it where the route is a router's).
 */
export function modelsContext(key: string, fetchVia: typeof fetch, model: string = MODEL): ModelsContext {
  const identity = newNodeIdentity();
  const store = new LedgerStore(":memory:");
  foundFleet(store, identity, { fleetName: "bench", nodeName: "bench" });
  const vault = new Vault(store, identity);
  vault.set("claude", key, { provider: "claude", origin: "https://api.anthropic.com" });
  store.emit(identity, "provider.set", { id: "claude", kind: "anthropic", baseUrl: "https://api.anthropic.com", secret: "claude" });
  for (const role of ["planner", "engineer", "reviewer"]) store.emit(identity, "roster.set", { role, models: [`claude/${model}`] });
  return { store, vault, fetch: fetchVia };
}

/**
 * The loop's ask, as team-runtime's: the engineer's turn through chat(), its calls and what its provider needs back.
 * The reviewer isn't asked a model: the bench's own gate, which reads what the task was for, decides.
 */
export function loopAsk(ctx: ModelsContext, counted: { calls: number; usage: Usage; unknown?: number }): RunDeps["ask"] {
  return async (role, messages: ChatMessage[], turn) => {
    if (role === "reviewer") return { text: "PASS\nThe bench's own gate decides.", model: "bench/gate" };
    counted.calls++;
    let text = "";
    let model = "";
    let called: { calls: ClientCall[]; carry?: string } | null = null;
    for await (const event of chat(ctx, { role, messages, coding: true, ...(turn?.loop ? { loop: true } : {}), ...(turn?.tools ? { clientTools: [...turn.tools] } : {}) })) {
      if (event.type === "text") text += event.text;
      else if (event.type === "model") model = event.ref;
      else if (event.type === "usage") {
        // (A call its provider said nothing of is counted as one it didn't count: never as no spend.)
        if (!event.usage) counted.unknown = (counted.unknown ?? 0) + 1;
        else counted.usage = { input: counted.usage.input + event.usage.input, output: counted.usage.output + event.usage.output, cached: (counted.usage.cached ?? 0) + (event.usage.cached ?? 0) };
      }
      else if (event.type === "calls") called = { calls: event.calls, ...(event.carry ? { carry: event.carry } : {}) };
      else if (event.type === "error") throw new Error(event.error);
    }
    return { text, model, ...(called ?? {}) };
  };
}

/** The environment an agent's task is told it works in, as team-runtime tells it, for a VM with a desktop. */
export const ENVIRONMENT = `Your persistent Linux VM; your workspace is /work.${desktopBriefing()}`;

/** One task through the loop: its goal, the model's way (ask), the VM's commands (exec). Never throws: an error is said. */
export async function viaLoop(goal: string, ask: RunDeps["ask"], exec: (command: string, timeoutSec: number) => Promise<ExecResult>, counted: { calls: number; usage: Usage; unknown?: number }, maxSteps = 40, signal?: AbortSignal): Promise<LoopRun> {
  const events: RunEvent[] = [];
  const t0 = performance.now();
  let outcome: RunOutcome | null = null;
  let error: string | null = null;
  try {
    outcome = await runLoop(
      { goal, environment: ENVIRONMENT, plan: "", tools: true, computer: true, maxSteps, maxRevisions: 0, commandTimeoutSec: 120 },
      { ask, exec, emit: (event) => events.push(event), sleep: async () => {}, ...(signal ? { signal } : {}) },
    );
  } catch (e) {
    error = String((e as Error).message ?? e).slice(0, 300);
  }
  const commands = events.filter((e): e is Extract<RunEvent, { type: "command" }> => e.type === "command").map((e) => e.command);
  const actions = commands.filter((c) => COMPUTER_MEMBERS.has(c.split(" ")[1] ?? "") && c.startsWith("desktop ")).length;
  return { outcome, error, calls: counted.calls, actions, commands: commands.length - actions, said: commands.map((c) => redact(c).slice(0, 200)), usage: counted.usage, ms: performance.now() - t0 };
}
