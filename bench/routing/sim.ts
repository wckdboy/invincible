import { type Agent, costOf, type ExecResult, newNodeIdentity, type Prices, type TeamTask, type UsageLine } from "../../packages/core/src/index.ts";
import { foundFleet, LedgerStore, Vault } from "../../packages/ledger/src/index.ts";
import { type TeamRunContext, teamRuntime, type TeamRuntimeDeps } from "../../packages/agents/src/index.ts";
import { intBelow, rng, subSeed } from "../lib.ts";

/*
 * Smart routing with stand-in models (docs/BENCHMARKS.md, routing). A seeded set of an agent's tasks, each run as the
 * node runs one: the team runtime's executeTask, so its plan, its work loop with the escalation ladder (run.ts
 * escalate), its gates before and after, its audits, the independent review and its budget are the real code, and so
 * is every call's way to a model (chat(): the roster's roles, an agent's own models). Only the models and the VM are
 * stand-ins, and they answer from each task's hidden truth:
 *
 * - a task is of a kind and a level. Its kind is how a model it is too hard for fails it: its fix leaves the gate failing
 *   (`gate`), passes the gate but not the reviewer, who finds what it missed (`review`), or never comes: it reads the
 *   same files again and again (`stall`). Its level is how hard it is: a model does a task at or below its capability.
 * - the worker (the engineer's model) can do levels 1 and 2, the lead (the planner's) up to 3, and nothing does a 4:
 *   that task needs you, whoever is asked.
 * - the judge (the reviewer's model) passes the work only when it is done, and an audit of it steers it only when no
 *   change was made since the last audit (it is going round). It sees the truth: what is measured is the routing,
 *   not how well a reviewer reads evidence (the reviewer eval suite's).
 *
 * Every task has the primary's own budget ($3), so work that goes round is ended when it is spent, as it is on a node.
 * Prices, speeds and capabilities are the stand-ins' own (TIERS), never a vendor's: the lead costs ten times the
 * worker's price and is slower. Each caches a prompt's unchanged beginning as providers do (CACHE_FROM). Time is virtual: each call and command counted at its stand-in seconds.
 */

export type Kind = "gate" | "review" | "stall";

export interface SimTask {
  id: string;
  kind: Kind;
  /** How hard it is: a model does it when this is at most its capability (1 to 4; nothing does a 4). */
  level: number;
  /** The agent it is given to (absent: the one stand-in agent). Its tasks before it are its memory's (core's routing.ts beginFor). */
  agent?: string;
  /** A fix of a pull request's checks: its kind, as its routing is kept, is a fix (core's routing.ts); absent, a task. */
  fix?: boolean;
}

/**
 * The stand-ins: what each can do, what it costs (stand-in $ per million tokens; a prompt's cached beginning at a tenth of
 * its input's, CACHE_FROM) and how long a call takes.
 */
export const TIERS = {
  worker: { capability: 2, price: { input: 3, output: 12, cached: 0.3 }, callSeconds: 6 },
  lead: { capability: 3, price: { input: 30, output: 120, cached: 3 }, callSeconds: 20 },
  judge: { capability: 0, price: { input: 10, output: 40, cached: 1 }, callSeconds: 15 },
} as const;

/**
 * A stand-in caches as a provider does: a prompt's beginning that is the same as its last prompt's (in the same task) is
 * read from its cache, once there are this many tokens of it (Anthropic's and OpenAI's least), and is billed at the
 * cached price. So a conversation that only grows at its end costs what is new in it, as on a node (run.ts compact).
 */
export const CACHE_FROM = 1024;

/** How many characters two prompts begin with alike. */
const samePrefix = (a: string, b: string): number => {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
};
export type Tier = keyof typeof TIERS;

/** Seconds a command takes in the stand-in VM, and a gate's run (a test suite). */
export const COMMAND_SECONDS = 4;
export const GATE_SECONDS = 10;

/** The primary's own tasks' budget (TEAM_LIMITS.ownTaskUsd): what ends work that goes round. */
export const BUDGET_USD = 3;

export const PRICES: Prices = Object.fromEntries(Object.entries(TIERS).map(([tier, t]) => [`sim/${tier}`, t.price]));

/**
 * How the agent's work is routed:
 * - `routed`: the roles as a node has them, the engineer's models cheap and the planner's strong, and the agent on its
 *   role's models: the ladder may move its work up;
 * - `pinned`: the same, the agent pinned by you to the cheap model: its work stays on it (the rule), so the ladder
 *   never moves it, the all-cheap bound;
 * - `strong`: every turn of the work on the strong model, the all-strong bound.
 */
export type Policy = "routed" | "pinned" | "strong";
export const POLICIES: readonly Policy[] = ["routed", "pinned", "strong"];

/**
 * Four agents' tasks, in turn, for the memory (core's routing.ts beginFor, by kind of task): `ada`'s are all ones its
 * worker can do (levels 1 and 2), `bo`'s all need the lead (level 3), `cy`'s any level, and `di`'s are fixes its worker
 * can do and tasks that need the lead, one and the other: a memory of one kind for all would begin its fixes on the lead
 * after each task. Each kind of failing in turn, the levels drawn from the seed: di's from a seed of their own, so ada's,
 * bo's and cy's are what they were before di's were added.
 */
export function memoryTasks(seed: number, each = 12): SimTask[] {
  const random = rng(subSeed(seed, "routing.memory"));
  const kinds: readonly Kind[] = ["gate", "review", "stall"];
  const agents = [
    { agent: "ada", level: () => 1 + intBelow(random, 2) },
    { agent: "bo", level: () => 3 },
    { agent: "cy", level: () => 1 + intBelow(random, 4) },
  ];
  const three: SimTask[] = Array.from({ length: each * agents.length }, (_, i) => {
    const who = agents[i % agents.length]!;
    return { id: `task-m${String(i).padStart(11, "0")}`, kind: kinds[Math.floor(i / agents.length) % kinds.length]!, level: who.level(), agent: who.agent };
  });
  const mixed = rng(subSeed(seed, "routing.memory.mixed"));
  const di = (k: number): SimTask => ({ id: `task-d${String(k).padStart(11, "0")}`, kind: kinds[k % kinds.length]!, level: k % 2 === 0 ? 1 + intBelow(mixed, 2) : 3, agent: "di", ...(k % 2 === 0 ? { fix: true } : {}) });
  return Array.from({ length: each }, (_, k) => [...three.slice(k * agents.length, (k + 1) * agents.length), di(k)]).flat();
}

/** The tasks of a seed: as many of each kind, each at a level drawn from the seed. */
export function simTasks(seed: number, n = 24): SimTask[] {
  const random = rng(subSeed(seed, "routing.tasks"));
  const kinds: readonly Kind[] = ["gate", "review", "stall"];
  return Array.from({ length: n }, (_, i) => ({ id: `task-${String(i).padStart(12, "0")}`, kind: kinds[i % kinds.length]!, level: 1 + intBelow(random, 4) }));
}

export interface TaskResult {
  task: SimTask;
  verified: boolean;
  /** Stand-in dollars, from the tokens its record says each model spent, at the stand-ins' prices. */
  usd: number;
  /** Virtual minutes: its calls, commands and gate runs at their stand-in seconds. */
  minutes: number;
  /** Why its work moved up, as its trail said it (each an "Escalated ·" line). */
  escalations: string[];
  /** Turns of its work answered by a model other than the agent's own, when the agent has models of its own. */
  movedOffPins: number;
  /** Model calls, by tier. */
  calls: Record<Tier, number>;
  /** Tokens by tier, as its record says them: the prompts' (`input`, of them `cached`: read from a cache) and the answers'. */
  tokens: Record<Tier, { input: number; cached: number; output: number }>;
  /** Whose models its work began on, as its record kept it (absent: not kept, its work held to models). */
  began?: "engineer" | "planner";
  /** Its kind as its record kept it (core's routing.ts), and why it began where it did. */
  routed?: { kind?: string; because?: string };
}

export interface PolicyResult {
  policy: Policy;
  tasks: TaskResult[];
  verified: number;
  /** Tasks that ended without being verified: each needs you (an intervention). */
  interventions: number;
  usd: number;
  minutes: number;
}

const text = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "")).join("") : "";

/** A stand-in pull request whose checks failed: what makes a task a fix (its agent has no repository here, so only its kind). */
const SIM_FIX = { connector: "sim", owner: "sim", repo: "sim", branch: "sim-fix", pr: 7, head: "a".repeat(40) } as const;

/** A record's tokens by stand-in tier (its lines are by role and model; a tier's model is `sim/<tier>`). */
const tokensOf = (spent: readonly UsageLine[]): TaskResult["tokens"] => {
  const out = { worker: { input: 0, cached: 0, output: 0 }, lead: { input: 0, cached: 0, output: 0 }, judge: { input: 0, cached: 0, output: 0 } };
  for (const line of spent) {
    const tier = line.model.replace(/^sim\//, "") as Tier;
    if (!(tier in out)) continue;
    out[tier].input += line.input;
    out[tier].cached += line.cached;
    out[tier].output += line.output;
  }
  return out;
};

const fenced = (command: string) => `Next.\n\`\`\`sh\n${command}\n\`\`\``;

/** A page of code, as a file read prints it. */
const PAGE = `${"export const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);\n".repeat(28)}`;

/** The marks that tell a call's kind: the plan's question, the review's, an audit's (run.ts). A turn of the work has none. */
const PLAN = "Plan this run for an engineer";
const REVIEW = "Reply with PASS on the first line";
const AUDIT = "You audit work that is still going on";

const AGENT: Agent = { id: "sim", name: "Sim", instructions: "Fix what each task asks, and verify it.", role: "engineer", harness: "native", enabled: true, dailyTurns: 1_000, turnsToday: 0, repository: null, workspaceNode: "host", workspace: { node: "host", id: "0123456789" }, memory: "", createdAt: 1, updatedAt: 1 };

/**
 * One policy over a seed's tasks, each run by the team runtime as the node runs an agent's task, in order. `memory`: each
 * agent's tasks so far are its (TeamRuntimeDeps.work, the latest first), as a node's are; off, none are.
 */
export async function runPolicy(policy: Policy, tasks: readonly SimTask[], options: { memory?: boolean } = {}): Promise<PolicyResult> {
  const identity = newNodeIdentity();
  const store = new LedgerStore(":memory:");
  try {
    foundFleet(store, identity, { fleetName: "sim", nodeName: "sim" });
    const vault = new Vault(store, identity);
    // (On this machine's own address, so no key is wanted and a budget can count it: chat.ts countable.)
    store.emit(identity, "provider.set", { id: "sim", kind: "openai", baseUrl: "http://127.0.0.1:9/v1" });
    const roster: Record<string, string[]> = { planner: ["sim/lead"], engineer: [policy === "strong" ? "sim/lead" : "sim/worker"], reviewer: ["sim/judge"] };
    for (const [role, models] of Object.entries(roster)) store.emit(identity, "roster.set", { role, models });
    /** The agent a task is given to, as you set it up: pinned to the worker when `pinned`. */
    const agentOf = (id: string): Agent => ({ ...AGENT, id, ...(policy === "pinned" ? { models: ["sim/worker"] } : {}) });
    let agent: Agent = agentOf(tasks[0]?.agent ?? AGENT.id);
    /** Each agent's tasks so far, the latest first, with their records: its memory's. */
    const history = new Map<string, TeamTask[]>();

    let task: SimTask = tasks[0]!;
    let state = { solved: false, touched: false, changedSinceAudit: false, commands: 0, gates: 0 };
    let calls: Record<Tier, number> = { worker: 0, lead: 0, judge: 0 };
    /** Each tier's last prompt in this task: what its cache holds. */
    let lastPrompt = new Map<Tier, string>();
    let movedOffPins = 0;

    /** A stand-in model's answer to one call: from the task's truth and what it has said in this conversation. */
    const answer = (tier: Tier, messages: { role: string; content: unknown }[]): string => {
      const asked = text(messages.filter((m) => m.role === "user").at(-1)?.content);
      if (asked.includes(PLAN)) return "1. Read the code the task names.\n2. Fix it, and run its tests.\nDone when: the gate passes and the reviewer accepts it.\nEngineer: usual";
      if (asked.includes(AUDIT)) {
        const going = state.changedSinceAudit;
        state.changedSinceAudit = false;
        return going ? "ON\nIt is changing the code the task names." : "STEER\nIt is reading the same files again and again while nothing changes: make the change the task asks for.";
      }
      if (asked.includes(REVIEW)) return state.solved ? "PASS\nThe change does what the task asks, and the evidence shows it." : "REVISE\nThe empty input is still unhandled: the tests the gate runs never reach it.";
      if (tier === "judge") throw new Error(`the judge was asked for a turn of the work: ${asked.slice(0, 120)}`);
      // A turn of the work. Pinned to its own model, an agent's work answered by another is the rule broken.
      if (policy === "pinned" && tier !== "worker") movedOffPins += 1;
      const capable = TIERS[tier].capability >= task.level;
      const said = messages.filter((m) => m.role === "assistant").map((m) => text(m.content));
      // Too hard to see, it goes round: the same three files, again and again, and never DONE.
      if (task.kind === "stall" && !capable) return fenced(`cat src/part${said.length % 3}.ts`);
      // Its own fix is the last thing it did: it says it is done (a fix another model made is not its own).
      if (said.at(-1)?.includes(`sim-fix ${tier}`)) return "DONE\nFixed, and ran its tests.";
      if (!said.length) return fenced("cat src/app.ts");
      return fenced(`sim-fix ${tier} ${capable ? "solid" : "shaky"}`);
    };

    const ok = (stdout = "ok\n", exitCode = 0): ExecResult => ({ exitCode, stdout, stderr: "", durationMs: 1, truncated: false });
    const brain = {
      store,
      vault,
      fetch: (async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { model: string; messages: { role: string; content: unknown }[] };
        const tier = body.model as Tier;
        if (!(tier in TIERS)) throw new Error(`no stand-in for ${body.model}`);
        calls[tier] += 1;
        const reply = answer(tier, body.messages);
        const prompt = body.messages.map((m) => text(m.content)).join("");
        const promptTokens = Math.ceil(prompt.length / 4);
        // (Its beginning as the tier's last prompt in this task had it: read from the cache, past CACHE_FROM tokens.)
        const alike = Math.floor(samePrefix(prompt, lastPrompt.get(tier) ?? "") / 4);
        lastPrompt.set(tier, prompt);
        const usage = { prompt_tokens: promptTokens, completion_tokens: Math.ceil(reply.length / 4), prompt_tokens_details: { cached_tokens: alike >= CACHE_FROM ? Math.min(alike, promptTokens) : 0 } };
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\ndata: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
      }) as typeof fetch,
    };
    const deps: TeamRuntimeDeps = {
      brain: () => brain,
      enter: async () => () => {},
      exec: async (_agent, command) => {
        // The gate: it passes once the work is done (a task the reviewer judges passes it once anything was changed).
        if (command.includes("bun test required-check")) {
          state.gates += 1;
          const passes = task.kind === "review" ? state.touched : state.solved;
          return ok(passes ? "12 pass\n" : "11 pass\n1 fail: the total of the new orders\n", passes ? 0 : 1);
        }
        const fix = /sim-fix (\w+) (solid|shaky)/.exec(command);
        if (fix) {
          state.commands += 1;
          state.touched = state.changedSinceAudit = true;
          if (fix[2] === "solid") state.solved = true;
          return ok("changed src/app.ts\n");
        }
        if (/cat src\/(app|part\d)\.ts/.test(command)) {
          state.commands += 1;
          return ok(PAGE);
        }
        return ok();
      },
      prepare: async () => {},
      tools: () => ({ specs: [], describe: () => ({ title: "unused", input: "" }), run: async () => ({ content: "", isError: true, summary: "no tools here" }) }),
      models: () => [],
      memories: () => "",
      agent: (id) => agentOf(id),
      ...(options.memory ? { work: (id: string) => history.get(id) ?? [] } : {}),
      dependencies: () => [],
      stopWorker: async () => {},
      prices: () => PRICES,
    };
    const runtime = teamRuntime(deps);

    const results: TaskResult[] = [];
    for (const each of tasks) {
      task = each;
      agent = agentOf(each.agent ?? AGENT.id);
      state = { solved: false, touched: false, changedSinceAudit: false, commands: 0, gates: 0 };
      calls = { worker: 0, lead: 0, judge: 0 };
      lastPrompt = new Map();
      movedOffPins = 0;
      const trail: string[] = [];
      const given: TeamTask = { id: each.id, room: "work", assignee: agent.id, title: `A ${each.kind} task at level ${each.level}`, goal: "Fix the total of the new orders, and verify it.", dependsOn: [], gates: ["bun test required-check"], budgetUsd: BUDGET_USD, status: "running", verified: false, progress: "", output: "", error: null, chainId: `chain-${each.id}`, createdAt: 1, updatedAt: 1, ...(each.fix ? { fix: SIM_FIX } : {}) };
      const context: TeamRunContext = {
        signal: new AbortController().signal,
        chainId: given.chainId,
        send: () => { throw new Error("the stand-in agent sends nothing"); },
        remember: () => { throw new Error("the stand-in agent keeps no notes"); },
        delegate: () => { throw new Error("the stand-in agent gives no tasks"); },
        recruit: () => { throw new Error("the stand-in agent makes no agents"); },
        emit: (line) => void trail.push(line),
      };
      const outcome = await runtime.executeTask(agent, given, context);
      const usd = costOf(outcome.record.spent, PRICES).usd;
      const seconds = (Object.keys(TIERS) as Tier[]).reduce((sum, tier) => sum + calls[tier] * TIERS[tier].callSeconds, 0) + state.commands * COMMAND_SECONDS + state.gates * GATE_SECONDS;
      results.push({ task: each, verified: outcome.verified, usd, minutes: seconds / 60, escalations: trail.filter((line) => line.startsWith("Escalated ·")).map((line) => line.split("\n")[0]!), movedOffPins, calls: { ...calls }, tokens: tokensOf(outcome.record.spent), ...(outcome.record.routing ? { began: outcome.record.routing.began, routed: { kind: outcome.record.routing.kind, because: outcome.record.routing.because } } : {}) });
      history.set(agent.id, [{ ...given, status: outcome.verified ? "done" : "failed", verified: outcome.verified, record: outcome.record }, ...(history.get(agent.id) ?? [])]);
    }
    const verified = results.filter((r) => r.verified).length;
    return { policy, tasks: results, verified, interventions: results.length - verified, usd: results.reduce((sum, r) => sum + r.usd, 0), minutes: results.reduce((sum, r) => sum + r.minutes, 0) };
  } finally {
    store.close();
  }
}
