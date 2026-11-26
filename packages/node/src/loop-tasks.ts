import { type ChatStreamEvent, type NodeIdentity, redact, retriedRuns, type RouteName, routes, SELF_ACTION_RESOURCE, spendLabel, type Usage } from "@galahad/core";
import type { Database } from "bun:sqlite";
import type { BankService } from "./bank/service.ts";
import { bilagSummary, copyBilag, type Mailbox } from "./bilag.ts";
import { chat, commandsRun, excerpt, installedConnector, installedConnectors, keyState, onPlan, parseRef, planOf, resolveProvider, roster, sseData } from "@galahad/brain";
import type { SyncEngine } from "@galahad/link";
import type { MindStore, Vault } from "@galahad/mind";
import type { SandboxHost } from "@galahad/sandbox";
import type { ArmTokens } from "./arms.ts";
import { type Capabilities, isAlwaysOn } from "./capabilities.ts";
import type { ComputeService } from "./compute/service.ts";
import type { ConnectorService } from "./connectors.ts";
import { CODING_ROLES, TOOL_ROLES } from "./doctor.ts";
import { assess, checklistPrompt, diskOf, type Finding, type HeartbeatSnapshot, readChecklistReply, reconcile } from "./heartbeat.ts";
import { hlcMs, loopRecords, type RunContext, type RunnableLoop, type RunResult, selfActionOn } from "./loops.ts";
import { selfAct, type SelfActionOutcome, type SelfSnapshot } from "./self-action.ts";
import { type NodeClient, runNodeQuest } from "./quest-cli.ts";
import { learnedLines } from "./skills-quest.ts";
import { streamedError } from "./server.ts";
import { wokenData } from "./wakes.ts";

/** A quest's goal is at most this long (core's LoopTask), what woke its run included. */
const QUEST_GOAL_CHARS = 4000;

/*
 * What each kind of loop does when it runs. A loop acts as Galahad on his own,
 * never as you: a quest loop works through a short-lived arm token (its sandboxes
 * are its own and ephemeral, and it can't touch the vault, devices or the roster),
 * and a connector call from a loop is an agent's call, so anything outward asks you.
 */

export interface LoopTaskDeps {
  store: MindStore;
  vault: Vault;
  identity: NodeIdentity;
  nodeName: string;
  sync: SyncEngine;
  caps: () => Capabilities | null;
  sandbox: SandboxHost | null;
  connectors: ConnectorService;
  arms: ArmTokens;
  port: number;
  home: string;
  startedAt: number;
  log: (message: string) => void;
  now?: () => number;
  fetch?: typeof fetch;
  bank?: BankService;
  /** This node's own database (local.db): where the bilag copied to Drive are kept track of (bilag.ts). */
  local?: Database;
  /* ---- self-action (set by the daemon) ---- */
  /** Start a run of one of this node's loops now (self-action's retry). */
  runLoop?: (name: string) => void;
  /** Whether one of this node's loops is running now. */
  isRunning?: (name: string) => boolean;
  /** This node's compute: its calibration and the fleet's plan (self-action), what he'd suggest (the heartbeat). */
  compute?: ComputeService;
  /** His skills (skills.ts; set by the daemon): the tidy-up that goes with the heartbeat. */
  skills?: { tidy(mark?: boolean): { stale: number; merges: number } };
  /** What a quick look by the doctor finds that the heartbeat doesn't check itself (doctor.ts; set by the daemon). */
  doctor?: () => Promise<{ key: string; severity: Finding["severity"]; title: string; body: string }[]>;
  /** Told of each model call his upkeep makes here, for this node's count of them (usage.ts; set by the daemon). */
  spent?: (call: { role: string; ref: string; usage: Usage | null }) => void;
}

/** A node that joined this long ago and still hasn't measured itself is worth a line. */
const UNMEASURED_AFTER_MS = 60 * 60_000;

/** A node API client on loopback, holding an arm token. */
export class LocalClient implements NodeClient {
  constructor(
    private readonly base: string,
    private readonly token: string,
  ) {}

  private async request(name: RouteName, input?: unknown): Promise<Response> {
    const route = routes[name];
    const response = await fetch(`${this.base}${route.path}`, {
      method: route.method,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined,
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(`${name}: ${body.error ?? response.statusText}`);
    }
    return response;
  }

  async call<T = any>(name: RouteName, input?: unknown): Promise<T> {
    const body = await (await this.request(name, input)).json();
    const failed = streamedError(body);
    if (failed) throw new Error(`${name}: ${failed.error}`);
    return body as T;
  }

  async *stream(name: RouteName, input: unknown): AsyncGenerator<ChatStreamEvent> {
    const response = await this.request(name, input);
    for await (const data of sseData(response.body!)) yield JSON.parse(data) as ChatStreamEvent;
  }
}

function roleUsable(deps: LoopTaskDeps, models: string[]): boolean {
  const caps = deps.caps();
  return models.some((ref) => {
    let parsed: { provider: string; model: string };
    try {
      parsed = parseRef(ref);
    } catch {
      return false;
    }
    const provider = resolveProvider(deps.store, deps.vault, parsed.provider);
    if (!provider) return false;
    if (provider.local) return (caps?.localModels ?? []).some((r) => r.runtime === parsed.provider && r.models.length > 0);
    return !!provider.apiKey;
  });
}

/**
 * Whether anyone can play a role, for what it does (the doctor's rule): his own words need a model of his own, while a
 * coding plan the knights' tools may use can play a role that is all coding (the engineer, the reviewer) or a VM's
 * eyes, which only its tools ask, and only when its terms let a VM's tools use it unattended.
 */
function rolePlayable(deps: LoopTaskDeps, role: string, models: string[], custom = false): boolean {
  if (roleUsable(deps, models)) return true;
  return models.some((ref) => planMayPlay(role, ref, custom) && !!resolveProvider(deps.store, deps.vault, ref.slice(0, ref.indexOf("/")), "tool")?.apiKey);
}

/**
 * Whether a coding plan's terms let it play a role at all, keyed here or not: one that is all coding (a role you made
 * among them: only knights work on it, and their conversations and tasks are coding work, as the doctor reads it), or a
 * VM's eyes when its tools may use it unattended.
 */
function planMayPlay(role: string, ref: string, custom = false): boolean {
  if (!onPlan(ref)) return false;
  if (CODING_ROLES.has(role) || custom) return true;
  return TOOL_ROLES.has(role) && planOf(ref.slice(0, ref.indexOf("/")))?.allows.tools === "unattended";
}

/** The roles his background writing tries, cheapest first. */
const CHEAPEST_FIRST = ["swift", "reviewer", "planner", "engineer"] as const;

/** The cheapest role with a usable model, or null: what his background writing runs on. */
export function cheapestRole(deps: LoopTaskDeps): string | null {
  const models = roster(deps.store);
  return CHEAPEST_FIRST.find((role) => models[role] && roleUsable(deps, models[role]!.models)) ?? null;
}

/** The bank connection, as the heartbeat sees it: only once it's set up on this node. */
function bankOf(bank: BankService | undefined): HeartbeatSnapshot["bank"] {
  if (!bank) return null;
  const status = bank.status();
  if (!status.configured) return null;
  return { problem: status.problem, connected: !status.reauthorizationRequired && status.accounts.length > 0, daysRemaining: status.daysRemaining, hadSession: status.validUntil !== null };
}

export async function heartbeatSnapshot(deps: LoopTaskDeps): Promise<HeartbeatSnapshot> {
  const now = (deps.now ?? Date.now)();
  const statuses = new Map(deps.sync.status().map((s) => [s.device, s]));
  const devices = deps.store.devices();
  const nameOf = (id: string) => deps.store.device(id)?.name ?? id.slice(0, 12);
  const active = new Set(devices.map((d) => d.id));
  const sandboxes = deps.sandbox ? await deps.sandbox.list().catch(() => null) : null;
  const sandboxHost = deps.sandbox
    ? await Promise.all([deps.sandbox.diskLimited().catch(() => false), deps.sandbox.status().then((s) => s.image).catch(() => true)]).then(
        ([diskLimited, image]) => ({ diskLimited, image, kvm: !!deps.caps()?.vm.kvm, microVMs: !!deps.caps()?.sandbox?.vm }),
      )
    : null;
  return {
    now,
    self: { id: deps.identity.id, name: deps.nodeName, startedAt: deps.startedAt },
    nodes: devices
      .filter((d) => d.kind === "node" && d.id !== deps.identity.id && typeof d.profile?.endpoint === "string")
      .map((d) => {
        const status = statuses.get(d.id);
        const caps = d.profile?.caps as Partial<Capabilities> | undefined;
        return { id: d.id, name: d.name, alwaysOn: isAlwaysOn(caps), online: !!status?.online, lastSeen: status?.lastSeen ?? null };
      }),
    vaultUnlocked: deps.vault.unlocked(),
    roles: Object.entries(roster(deps.store)).map(([role, spec]) => ({
      role,
      models: spec.models,
      usable: rolePlayable(deps, role, spec.models, spec.custom),
      // (Plans alone that their terms keep from it; one that may play it and can't lacks its key, which is said as that.)
      ...(spec.models.length && spec.models.every(onPlan) && !spec.models.some((ref) => planMayPlay(role, ref, spec.custom)) ? { plans: true } : {}),
    })),
    sandboxes: sandboxes?.map((s) => ({ id: s.id, expiresAt: s.expiresAt, ephemeral: s.ephemeral })) ?? null,
    sandboxHost,
    loops: loopRecords(deps.store).map((loop) => ({
      name: loop.name,
      runner: active.has(loop.on) ? loop.on : null,
      recent: deps.store.loopRuns(loop.name, 3).map((r) => r.body.status),
    })),
    forks: deps.store.forks().map((id) => ({ id, name: nameOf(id) })),
    connectors: installedConnectors(deps.store).map((c) => ({
      id: c.id,
      label: c.manifest?.label ?? c.id,
      key: c.manifest ? keyState(deps.vault, c.manifest) : "none-needed",
      problem: c.problem,
    })),
    orders: deps.connectors
      .orders()
      .filter((o) => o.state === "active" || o.state === "stale")
      .map((o) => ({ id: o.id, label: o.label, tool: `${o.connector}.${o.tool}`, stale: o.state === "stale", until: o.until })),
    disk: diskOf(deps.home),
    bank: bankOf(deps.bank),
    compute: deps.compute ? computeOf(deps, now) : null,
  };
}

/**
 * One look around: the heartbeat's own checks, and what the doctor's quick look adds about this node's body
 * (its clock, its app, its firewall: what the heartbeat doesn't check itself). The doctor never stops a beat.
 */
export async function lookAround(deps: LoopTaskDeps): Promise<Finding[]> {
  const findings = assess(await heartbeatSnapshot(deps));
  if (!deps.doctor) return findings;
  try {
    const seen = new Set(findings.map((f) => f.key));
    for (const found of await deps.doctor()) if (!seen.has(found.key)) findings.push({ ...found, node: deps.identity.id });
  } catch (error) {
    deps.log(`doctor (heartbeat): ${redact(String((error as Error).message)).slice(0, 200)}`);
  }
  return findings;
}

/** Compute never stops a heartbeat: if it can't be read, the beat goes on without it and the log says why. */
function quietly<T>(deps: LoopTaskDeps, what: string, read: () => T): T | null {
  try {
    return read();
  } catch (error) {
    deps.log(`${what}: ${(error as Error).message}`);
    return null;
  }
}

/** Compute, as the heartbeat sees it: nodes that should have measured themselves by now, and what he'd suggest. */
function computeOf(deps: LoopTaskDeps, now: number): HeartbeatSnapshot["compute"] {
  return quietly(deps, "compute (heartbeat)", () => {
    const nodes = deps.compute!.nodes();
    return {
      unmeasured: nodes
        .filter((n) => n.online && n.body && !n.calibration && now - hlcMs(deps.store.device(n.id)?.enrolledHlc ?? "") > UNMEASURED_AFTER_MS)
        .map((n) => ({ id: n.id, name: n.name })),
      suggestions: deps.compute!.suggestions(nodes),
    };
  });
}

/** Recent activity for the checklist model: what Galahad did, as data. */
function recentActivity(store: MindStore): string {
  const ledger = store.ledger(8).map((e) => `- ${e.body.class} ${e.body.resource} ${e.body.target}: ${e.body.verdict}`);
  const runs = store
    .loopRuns(undefined, 12)
    .filter((r) => r.body.loop !== "heartbeat")
    .slice(0, 5)
    .map((r) => `- loop ${r.body.loop}: ${r.body.status}, ${r.body.summary.replace(/\s+/g, " ").slice(0, 160)}`);
  return redact([...ledger, ...runs].join("\n"));
}

async function askSwift(deps: LoopTaskDeps, prompt: string, signal: AbortSignal): Promise<string> {
  let text = "";
  for await (const event of chat({ store: deps.store, vault: deps.vault, fetch: deps.fetch, ...(deps.spent ? { spent: deps.spent } : {}) }, { role: "swift", messages: [{ role: "user", content: prompt }], signal })) {
    if (event.type === "text") text += event.text;
    else if (event.type === "error") throw new Error(event.error);
  }
  return text;
}

export async function beat(deps: LoopTaskDeps, checklist: string | undefined, signal: AbortSignal, selfAction = true): Promise<RunResult & { findings: Finding[]; fixed: SelfActionOutcome[] }> {
  const now = (deps.now ?? Date.now)();
  let findings = await lookAround(deps);
  // What's on the allowlist he fixes himself; then he looks again, so a fixed problem never becomes a notice.
  const fixed = selfAction ? await selfAct(await selfSnapshot(deps), () => selfSnapshot(deps), selfHands(deps), (entry) => void deps.store.emit(deps.identity, "ledger.recorded", entry)) : [];
  if (fixed.some((f) => f.ok)) findings = await lookAround(deps);
  let note = "";
  if (checklist?.trim()) {
    try {
      const reply = readChecklistReply(await askSwift(deps, checklistPrompt(checklist, findings, recentActivity(deps.store)), signal));
      if (reply) findings.push({ key: "checklist", severity: "info", title: "From your heartbeat checklist", body: redact(reply) });
    } catch (error) {
      note = ` (checklist skipped: ${redact(String((error as Error).message)).slice(0, 200)})`;
    }
  }
  const { raised, cleared } = reconcile(deps.store, deps.identity, findings, now);
  const serious = findings.filter((f) => f.severity !== "info");
  const summary = findings.length
    ? `${findings.length} finding${findings.length === 1 ? "" : "s"}: ${findings.map((f) => f.title).join("; ")}`
    : "All quiet.";
  const changes = raised || cleared ? ` (${raised} raised, ${cleared} cleared)` : "";
  const fixes = fixed.length ? ` Fixed himself: ${fixed.map((f) => f.title).join("; ")}.` : "";
  return { status: serious.length ? "attention" : "ok", summary: `${summary}${changes}${fixes}${note}`.slice(0, 2000), findings, fixed };
}

/* ---------- self-action: this node as the allowlist's plan reads it, and its hands ---------- */

/** A loop that only reads: one connector tool of class read. */
function readsOnly(deps: LoopTaskDeps, task: RunnableLoop["task"] | null): boolean {
  if (task?.kind !== "call") return false;
  return installedConnector(deps.store, task.connector)?.tools[task.tool]?.class === "read";
}

export async function selfSnapshot(deps: LoopTaskDeps): Promise<SelfSnapshot> {
  const now = (deps.now ?? Date.now)();
  const sandboxes = deps.sandbox ? await deps.sandbox.list().catch(() => null) : null;
  return {
    now,
    sandboxes: sandboxes?.map((s) => ({ id: s.id, expiresAt: s.expiresAt, ephemeral: s.ephemeral, quest: s.quest })) ?? null,
    loops: loopRecords(deps.store)
      .filter((l) => l.on === deps.identity.id && l.enabled && l.task)
      .map((l) => ({
        name: l.name,
        readOnly: readsOnly(deps, l.task),
        running: deps.isRunning?.(l.name) ?? false,
        recent: deps.store.loopRuns(l.name, 2).map((r) => ({ run: r.body.run, status: r.body.status, finished: r.body.finished })),
      })),
    retried: retriedRuns(deps.store.ledger(300).filter((e) => e.body.resource === SELF_ACTION_RESOURCE).map((e) => e.body.target)),
    // The node that runs a heartbeat keeps the fleet's plan; every node measures itself.
    compute: computeSnapshot(deps, true),
  };
}

function computeSnapshot(deps: LoopTaskDeps, adapts: boolean): SelfSnapshot["compute"] {
  const compute = deps.compute;
  if (!compute) return null;
  return quietly(deps, "compute (self-action)", () => {
    const drift = compute.planDrift();
    return { canMeasure: compute.canMeasure(), ...compute.due(), adapts, planDigest: drift.digest, recordedDigest: drift.recorded };
  });
}

/**
 * A node's own upkeep of its compute, between heartbeats (at its start, and when its body changes): it
 * measures itself when that's due. The same allowlist, checks, ledger and owner's switch as after a
 * heartbeat; only the plan is left to the node that runs one.
 */
export async function computeUpkeep(deps: LoopTaskDeps): Promise<SelfActionOutcome[]> {
  if (!deps.compute || !selfActionOn(deps.store).on) return [];
  const snapshot = (): SelfSnapshot => ({ now: (deps.now ?? Date.now)(), sandboxes: null, loops: [], retried: [], compute: computeSnapshot(deps, false) });
  return selfAct(snapshot(), async () => snapshot(), selfHands(deps), (entry) => void deps.store.emit(deps.identity, "ledger.recorded", entry));
}

function selfHands(deps: LoopTaskDeps) {
  return {
    reap: async (sandbox: string, quest: string) => {
      if (!deps.sandbox) throw new Error("this node is not a sandbox host");
      return deps.sandbox.destroy(sandbox, { quest });
    },
    retry: (loop: string) => {
      if (!deps.runLoop) throw new Error("loops can't be run from here");
      deps.runLoop(loop);
    },
    calibrate: async (why: "joined" | "changed") => {
      if (!deps.compute) throw new Error("no compute here");
      await deps.compute.calibrate(why, "his own upkeep");
    },
    adaptCompute: () => {
      if (!deps.compute) throw new Error("no compute here");
      return deps.compute.adapt();
    },
  };
}

export function loopExecutor(deps: LoopTaskDeps) {
  return async (loop: RunnableLoop, ctx: RunContext): Promise<RunResult> => {
    const task = loop.task;
    switch (task.kind) {
      case "heartbeat": {
        const result = await beat(deps, task.checklist, ctx.signal, task.selfAction !== false);
        // His skills' tidy-up goes with the heartbeat (skills.ts): the long-unused are marked stale (never with
        // self-action off), near-duplicates are suggested to you. It merges, retires and deletes nothing.
        const tidied = quietly(deps, "skills (tidy-up)", () => deps.skills?.tidy(task.selfAction !== false) ?? null);
        return tidied?.stale ? { ...result, summary: `${result.summary} Marked ${tidied.stale} skill${tidied.stale === 1 ? "" : "s"} stale.`.slice(0, 2000) } : result;
      }
      case "tell":
        // What woke it is told by the runner (Woken by …); the notice is raised when the run is recorded (daemon).
        return { status: "ok", summary: task.text ?? (ctx.woken.length ? "" : "It's time.") };
      case "bilag": {
        // The mail that woke it, by its mailbox and id (wakes.ts names a mail's event mail:<mailbox>:<id>).
        const mails = ctx.woken.flatMap((event) => {
          const m = /^mail:(gmail|outlook):(.+)$/.exec(event.id);
          return m ? [{ mailbox: m[1] as Mailbox, id: m[2]! }] : [];
        });
        if (!mails.length) return { status: "ok", summary: "Nothing to copy: it copies the bilag in the mail that wakes it (to copy older mail's: galahad bilag copy)." };
        if (!deps.local) return { status: "failed", summary: "This node keeps no record of bilag copied, so it copies none." };
        const report = await copyBilag({ transfer: (connector, step) => deps.connectors.transfer(connector, step), local: deps.local, tz: loop.tz }, mails, task.folder);
        // A mail it couldn't copy goes back to be tried again (loops.ts giveBack): what was copied never is twice.
        const left = new Set(report.left.map((mail) => `mail:${mail}`));
        const giveBack = ctx.woken.filter((event) => left.has(event.id)).map((event) => event.id);
        return { status: report.failed.length ? "attention" : "ok", summary: bilagSummary(report), ...(giveBack.length ? { giveBack } : {}) };
      }
      case "call": {
        const outcome = await deps.connectors.call(
          { connector: task.connector, tool: task.tool, args: task.args ?? {} },
          { kind: "agent", by: `loop:${loop.name}`, quest: `loop.${loop.name}` },
        );
        if (outcome.status === "asked") {
          return { status: "attention", summary: `${task.connector}.${task.tool} needs your approval: action ${outcome.action} is in your inbox.` };
        }
        const took = `${outcome.result.durationMs} ms`;
        return { status: outcome.result.ok ? "ok" : "attention", summary: `${task.connector}.${task.tool} → ${excerpt(outcome.result, 240)} (${took})` };
      }
      case "quest": {
        // The loop works as an arm: least privilege, its own ephemeral sandboxes, untrusted memories.
        const label = `loop.${loop.name}`;
        const { token } = deps.arms.mint(label, ["mind:read", "mind:write", "sandbox", "chat"]);
        try {
          const client = new LocalClient(`http://127.0.0.1:${deps.port}`, token);
          // Your gates go with it as you gave them; on his own, the planner proposes none of its own.
          // What woke it goes with its goal as data from outside, within the goal's own limit (wakes.ts).
          const goal = `${task.goal}${wokenData(ctx.woken, QUEST_GOAL_CHARS - task.goal.length)}`;
          const { outcome, learned, usage } = await runNodeQuest(client, { goal, network: task.network, maxSteps: task.maxSteps, ...(task.gates?.length ? { gates: task.gates } : {}) }, { signal: ctx.signal });
          const gated = outcome.gates?.some((g) => g.exitCode !== 0) ?? false;
          const review = outcome.status !== "done" && outcome.review ? ` ${gated ? "Never reviewed:" : "Reviewer:"} ${outcome.review.trim()}` : "";
          return {
            status: outcome.status === "done" ? "ok" : "attention",
            // The skills it used, and one it learned, by title (skills.ts): only what the node said is in the mind.
            // What its model calls came to goes first, so it survives the summary's cut: tokens as the providers reported them.
            summary: `${outcome.status} after ${commandsRun(outcome)} commands${usage.length ? ` (${spendLabel(usage)})` : ""}: ${outcome.summary.trim()}${review}${learnedLines(learned ?? null).map((line) => ` ${line}.`).join("")}`,
          };
        } finally {
          deps.arms.revoke(label);
        }
      }
    }
  };
}
