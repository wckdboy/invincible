import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import {
  didKeyOfEd25519,
  FABRIC,
  FABRIC_RUN_TOOLS,
  type FabricRunTool,
  goalDigest,
  HANDED_AT_ONCE,
  HANDOFF_DAY_MS,
  HandArgs,
  HandChunk,
  type HandedView,
  HandInputChunk,
  LINK_PATHS,
  handoffUnder,
  type HandTaskInput,
  type NodeIdentity,
  proofRefusal,
  type ProofStatement,
  qdtChainText,
  qdtChainTokens,
  randomId,
  readHandoffTerms,
  readQdt,
  RUN_GRANT_COMMAND,
  RUN_GRANT_TTL,
  runGrantPolicy,
  saidDigest,
  signingPublicKey,
  signProof,
  signQdt,
  type TeamTask,
  TeamTaskProof,
} from "@invincible/core";
import type { Device, LedgerStore } from "@invincible/ledger";
import type { Fabric, FabricTools } from "./service.ts";
import { type Call, type Invocation, SidecarError, type ToolSpec } from "./socket.ts";

/*
 * Agents working together across nodes (docs/ARCHITECTURE.md §3, PLAN Phase 2): a task handed from one node to another
 * node's agents, over one Q-AMP call between the two nodes' transport keys.
 *
 *  - The node that hands it on (the giver) opens the call with the task; the node that runs it (the runner) gives it to
 *    its own agents, as you would there, and streams back its trail as it goes. The giver streams in the run's chain and
 *    each renewal of it, and a stop when you stop it; a stop on either side ends the work on the other.
 *  - The runner makes the run a key of its own, in memory alone and destroyed when the run ends. Where the task was given
 *    some of the giver's tools, the giver grants them to that key: a chain from its transport key, held to this task by
 *    its policy, for a few minutes at a time, renewed while the task lives and revoked when it ends. The run calls them
 *    through its own node, which passes the grant on to its own transport key under the run's key (a link the run's key
 *    signs), so the chain the giver checks names the run's key, and ends at the node it handed the task to.
 *  - The proof survives the hop: the runner signs what the work came to (each gate's exit before and after, the
 *    reviewer's verdict, how it ended) with its device key, for this hand-off and its nonce, and the giver checks that
 *    signature before it says anything is proven. A node that didn't run the work can't make it look proven.
 */

/**
 * How a hand-off is given to the agents here, always as the node that handed it over (`by`, `node:<id>`): within your
 * grant for the pair (its agents, and the budget it leaves for the day), or as a proposal that waits for your approval
 * here, and why.
 */
export type HandHow = { by: string; budgetUsd: number; agents?: readonly string[] } | { by: string; propose: string };

/** Who handed a task over, as its task here records it. */
export const handedBy = (node: string): string => `node:${node}`;

/** What the runner's agents need: the team service's own operations (the server binds them). */
export interface HandTeam {
  /** Gives the task to an agent here as `how` says (the one named, or the one best suited): its task and who took it. */
  give(args: HandArgs, signal: AbortSignal, how: HandHow): Promise<{ task: TeamTask; agent: { id: string; name: string } }>;
  task(id: string): TeamTask | null;
  trail(id: string, after: number): { entries: { n: number; at: number; text: string }[]; more: boolean };
  /** Stops it: as you would (no `why`), or in these words, by no word of yours. */
  stop(id: string, why?: string): void;
  /** The task an agent's VM is running now, by the VM's id (the sandbox its gateway token names). */
  runningIn(sandbox: string): string | null;
  /** What one node has handed here: how many are open now, and what those under your grant since `since` were given. */
  handed(by: string, since: number): { atOnce: number; given: number };
  /** The tasks other nodes handed here that haven't ended: who handed each (`node:<id>`), and whether it was taken under
   * your grant (not proposed to you and approved). */
  handedOpen(): { id: string; by: string; granted: boolean }[];
  /**
   * As the node comes back: ends, in each agent's VM, what tasks other nodes handed over left running there once they
   * have ended, those this start ended among them (a crash, or the node's own stop, cut their own end off). It goes on
   * after attachTeam returns, and says what it can't end.
   */
  sweep?(): void;
}

/** A tool of the primary's, run on this node for a run another node runs for it (the server binds it, as that run's principal). */
export type RunTool = (tool: FabricRunTool, input: Record<string, unknown>, run: { handoff: string; tools: readonly FabricRunTool[] }, signal: AbortSignal) => Promise<unknown>;

export interface HandoffsDeps {
  db: Database;
  store: LedgerStore;
  identity: NodeIdentity;
  fabric: Fabric;
  log(message: string): void;
  now?(): number;
  /** How long a run's grant lasts before it is renewed at half of it, in seconds (tests: a few; RUN_GRANT_TTL). */
  grantTtlSecs?: number;
  /** How long a stop waits for the runner's answer before the call itself is cancelled (tests: less; STOP_WAIT_MS). */
  stopWaitMs?: number;
  /** The longest a hand-off's call lasts (its deadline), and so its run's grant (tests: less; HAND_CALL_MS). */
  handCallMs?: number;
}

const ENDED = new Set(["done", "failed", "stopped", "interrupted"]);
/** The most trail lines a hand-off keeps here (its runner keeps all of them). */
const TRAIL_KEEP = 2_000;
/** How long a stop waits for the runner to say the work stopped, before the call itself is cancelled. */
const STOP_WAIT_MS = 15_000;
/**
 * The longest a hand-off's call lasts, waiting for your approval there included: its deadline, past which the runner
 * stops the work, and the longest its run's grant is renewed. A task the agents there give no clock of their own.
 */
export const HAND_CALL_MS = 24 * 3_600_000;
/** A length of time as a hand-off's words say it. */
const span = (ms: number): string => (ms % 3_600_000 === 0 ? `${ms / 3_600_000} h` : ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.ceil(ms / 1000)} s`);
/** How long a run's link (the run's key to its node's) lasts at most; it is signed again as the grant renews. */
const LINK_TTL = RUN_GRANT_TTL;
/** A link is signed again this long before it would end (or its grant's token would). */
const LINK_EARLY_SECS = 30;

interface Row {
  id: string;
  node: string;
  node_name: string;
  task: string | null;
  agent: string | null;
  title: string;
  goal: string;
  gates: string;
  tools: string;
  nonce: string;
  run: string | null;
  grant_id: string | null;
  tokens: string;
  phase: "handing" | "following" | "ended";
  status: string;
  proof: string | null;
  output: string;
  error: string | null;
  created_at: number;
  first_output_at: number | null;
  stop_asked_at: number | null;
  ended_at: number | null;
  waits: string | null;
}

/** A run this node runs for another: its hand-off, the key it holds in memory alone, and the giver's chain for it. */
interface Running {
  handoff: string;
  giver: string;
  giverKey: string;
  task: string;
  seed: Uint8Array;
  did: string;
  tools: FabricRunTool[];
  /** Taken under your grant (else you approved its proposal), and whether the giver has been told it was taken. */
  granted: boolean;
  accepted: boolean;
  /** The giver's grant, as its encoded tokens (root first), and the link this node's run key signed onto it. */
  chain: Uint8Array[] | null;
  link: { encoded: Uint8Array; exp: number } | null;
  inv: Invocation;
}

export class Handoffs implements FabricTools {
  private readonly now: () => number;
  private team: HandTeam | null = null;
  private runTool: RunTool | null = null;
  /** Here, as the giver: the calls of the hand-offs under way, and their grants' renewals. */
  private readonly calls = new Map<string, { call: Call; renew: ReturnType<typeof setInterval> | null }>();
  /** Here, as the runner: the runs under way, by hand-off and by task. */
  private readonly runs = new Map<string, Running>();
  /** Here, as the runner: each giving node's hand-offs waiting to be given, one at a time, and the last of them. */
  private readonly giving = new Map<string, { waiting: number; last: Promise<unknown> }>();
  /** Stops waiting for the runner's answer, cleared when the node stops. */
  private readonly stopTimers = new Set<ReturnType<typeof setTimeout>>();
  /** The node is stopping: nothing more is written or followed (its database closes after this). */
  private closed = false;
  /** Followers waiting for the agents here to change something (poke), each at most a while. */
  private readonly wakers = new Set<() => void>();
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: HandoffsDeps) {
    this.now = deps.now ?? Date.now;
    deps.db.exec(`CREATE TABLE IF NOT EXISTS fabric_handed (
      id TEXT PRIMARY KEY, node TEXT NOT NULL, node_name TEXT NOT NULL, task TEXT, agent TEXT, title TEXT NOT NULL, goal TEXT NOT NULL,
      gates TEXT NOT NULL, tools TEXT NOT NULL, nonce TEXT NOT NULL, run TEXT, grant_id TEXT, tokens TEXT NOT NULL DEFAULT '[]',
      phase TEXT NOT NULL, status TEXT NOT NULL, proof TEXT, output TEXT NOT NULL DEFAULT '', error TEXT,
      created_at INTEGER NOT NULL, first_output_at INTEGER, stop_asked_at INTEGER, ended_at INTEGER)`);
    deps.db.exec("CREATE TABLE IF NOT EXISTS fabric_handed_trail (handoff TEXT NOT NULL, n INTEGER NOT NULL, at INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY (handoff, n))");
    // (Why it waited there for your approval: a column a table from before grants lacks.)
    if (!deps.db.query<{ name: string }, []>("PRAGMA table_info(fabric_handed)").all().some((c) => c.name === "waits")) deps.db.exec("ALTER TABLE fabric_handed ADD COLUMN waits TEXT");
    // Your grant for a pair revoked: what that node handed here under it stops now (what you approved yourself goes on).
    // So does what was taken under a grant that ended with the node that recorded it, revoked.
    this.unsubscribe =
      typeof deps.store.onApplied === "function"
        ? deps.store.onApplied((events) => {
            for (const event of events) {
              if (event.kind !== "handoff.revoked") continue;
              const pair = event.body as { from?: unknown; to?: unknown };
              if (pair.to !== deps.identity.id || typeof pair.from !== "string" || deps.store.handoffGrant(pair.from, deps.identity.id)) continue;
              for (const run of [...this.runs.values()].filter((r) => r.giver === pair.from && r.granted)) this.team?.stop(run.task, "Your grant for the node that handed it over was revoked.");
              // And what it handed under that grant that the agents hold and no call follows.
              for (const t of this.team?.handedOpen() ?? []) if (t.granted && t.by === handedBy(pair.from)) this.team?.stop(t.id, "Your grant for the node that handed it over was revoked.");
            }
            if (!events.some((e) => e.kind === "device.revoked")) return;
            for (const run of [...this.runs.values()].filter((r) => r.granted && !deps.store.handoffGrant(r.giver, deps.identity.id)))
              this.team?.stop(run.task, "The grant it was taken under ended: the node that recorded it was revoked.");
            for (const t of this.team?.handedOpen() ?? [])
              if (t.granted && !deps.store.handoffGrant(t.by.slice("node:".length), deps.identity.id)) this.team?.stop(t.id, "The grant it was taken under ended: the node that recorded it was revoked.");
          })
        : () => {};
    // A hand-off a node that stopped was following has lost its call: the runner stopped the work when it did.
    for (const row of this.rows().filter((r) => r.phase !== "ended")) this.end(row.id, { status: "interrupted", error: "this node stopped while it followed the task: the node that ran it stopped the work when the call ended" });
  }

  /**
   * The runner's side, once the server has its agents. What other nodes handed here before this node last stopped has
   * lost its call (its giver ended it then): nobody follows it any more, so it ends now rather than run unseen.
   */
  attachTeam(team: HandTeam): void {
    this.team = team;
    for (const { id } of team.handedOpen()) team.stop(id, "The node that handed it over no longer follows it: its call ended when this node stopped.");
    // What they left running in their VMs ends too: nothing ran their end after a crash (the third re-review's R3-5).
    team.sweep?.();
  }

  /** The giver's side: how a run elsewhere calls this node's tools. */
  attachTools(run: RunTool): void {
    this.runTool = run;
  }

  // ---- what the fabric serves for it ----

  specs(): { tools: ToolSpec[]; public: string[] } {
    const tools: ToolSpec[] = [
      { name: FABRIC.hand, description: "A task handed over by an active full node of this fleet, run by this node's agents, its trail streamed back and its proof signed" },
      ...FABRIC_RUN_TOOLS.map((tool) => ({ name: `${FABRIC.agent}/${tool}`, description: `The primary's ${tool}, for a run another node runs for this one, under that run's own chain`, annotations: { read_only: true } })),
    ];
    // The hand-off is public at Q-AMP's door, and this node's decides; a run's tools are never: its chain is checked first.
    return { tools, public: [FABRIC.hand] };
  }

  owns(tool: string): boolean {
    return tool === FABRIC.hand || tool.startsWith(`${FABRIC.agent}/`);
  }

  invoked(inv: Invocation, caller: Device | null): void {
    // Its work runs in the background: an error in it fails this one invocation, and is said, never the node.
    const failed = (doing: string) => (error: unknown) => {
      const said = String((error as Error)?.message ?? error).slice(0, 300);
      this.deps.log(`fabric: ${inv.tool} failed here: ${said}`);
      try {
        inv.fail(10, `this node failed while it ${doing}: ${said}`);
      } catch {
        // Its invocation had ended already.
      }
    };
    if (inv.tool === FABRIC.hand) this.runHanded(inv, caller).catch(failed("ran the task"));
    else this.agentTool(inv, caller).catch(failed("answered"));
  }

  /** A node revoked here: what it ran for this node stops being followed, its runs' grants end, and what it gave here stops. */
  revoked(device: string): void {
    // (Ending each cancels its call.)
    for (const row of this.rows().filter((r) => r.node === device && r.phase !== "ended")) this.end(row.id, { status: "interrupted", error: "the node it ran on was revoked" });
    for (const run of [...this.runs.values()].filter((r) => r.giver === device)) {
      this.team?.stop(run.task, "The node that handed it over was revoked.");
      run.inv.fail(3, "the node that handed this task over was revoked");
    }
    // And what it handed that the agents hold and no call follows (one you took up again by its id).
    for (const t of this.team?.handedOpen() ?? []) if (t.by === handedBy(device)) this.team?.stop(t.id, "The node that handed it over was revoked.");
  }

  // ---- the giver ----

  private rows(): Row[] {
    if (this.closed) return [];
    return this.deps.db.query<Row, []>("SELECT * FROM fabric_handed ORDER BY created_at DESC LIMIT 200").all();
  }

  private row(id: string): Row | null {
    if (this.closed) return null;
    return this.deps.db.query<Row, [string]>("SELECT * FROM fabric_handed WHERE id = ?").get(id);
  }

  private set(id: string, fields: Partial<Omit<Row, "id">>): void {
    const keys = Object.keys(fields);
    if (!keys.length || this.closed) return;
    this.deps.db.query(`UPDATE fabric_handed SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...(keys.map((k) => (fields as Record<string, unknown>)[k] ?? null) as never[]), id);
  }

  /** Hands a task to another node's agents, over Q-AMP: refused at once when it can't be had (there is no HTTPS form). */
  async hand(input: HandTaskInput, node: Device): Promise<HandedView> {
    const why = this.deps.fabric.unusable(node);
    if (why) throw Object.assign(new Error(`a task is handed to another node over Q-AMP alone, and ${why}`), { status: 424 });
    const endpoint = this.deps.fabric.peerEndpoint(node)!;
    const client = this.deps.fabric.sidecar.client!;
    const id = `h_${randomId(16)}`;
    const nonce = randomId(16);
    const title = input.title ?? input.goal.slice(0, 200);
    const gates = input.gates ?? [];
    const tools = input.tools ?? [];
    this.deps.db
      .query("INSERT INTO fabric_handed (id, node, node_name, title, goal, gates, tools, nonce, phase, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'handing', 'handing', ?)")
      .run(id, node.id, node.name, title, input.goal, JSON.stringify(gates), JSON.stringify(tools), nonce, this.now());
    const args: HandArgs = { handoff: id, nonce, goal: input.goal, title, gates, tools, ...(input.budgetUsd !== undefined ? { budgetUsd: input.budgetUsd } : {}), ...(input.agent ? { agent: input.agent } : {}) };
    // Signed by this node's device key, as its HTTPS request would be: its transport key alone hands nothing over.
    const call = client.call(endpoint.address, FABRIC.hand, await this.deps.fabric.seal(LINK_PATHS.hand, args), { input: true, deadlineMs: this.deps.handCallMs ?? HAND_CALL_MS });
    this.calls.set(id, { call, renew: null });
    void this.follow(id, node, call).catch((error: Error) => this.deps.log(`fabric: ${id} wasn't followed to its end: ${error.message}`));
    return this.view(this.row(id)!);
  }

  private async follow(id: string, node: Device, call: Call): Promise<void> {
    let n = 0;
    try {
      for await (const chunk of call.chunks) {
        const parsed = "value" in chunk ? HandChunk.safeParse(chunk.value) : null;
        if (!parsed?.success) continue;
        const said = parsed.data;
        if (said.kind === "accepted") {
          // Taken once: a runner that says it again is heard once (its first run key stands, and the one grant to it).
          if (this.row(id)?.run) continue;
          this.set(id, { phase: "following", task: said.task, agent: JSON.stringify(said.agent), run: said.run, status: "queued" });
          await this.grant(id, call);
        } else if (said.kind === "proposed") {
          // Beyond your grant there: it waits for your approval on that node, and is taken (accepted) once you give it.
          this.set(id, { phase: "following", task: said.task, agent: JSON.stringify(said.agent), status: "proposed", waits: said.why });
        } else if (said.kind === "state") {
          this.set(id, { status: said.status });
          // Its run is over there: its grant ends now, whatever the call does (it goes on for the proof alone).
          if (ENDED.has(said.status)) this.release(id);
        } else {
          n++;
          if (this.closed) return;
          this.deps.db.query("INSERT OR REPLACE INTO fabric_handed_trail (handoff, n, at, text) VALUES (?, ?, ?, ?)").run(id, n, said.at, said.text);
          if (n > TRAIL_KEEP) this.deps.db.query("DELETE FROM fabric_handed_trail WHERE handoff = ? AND n <= ?").run(id, n - TRAIL_KEEP);
          if (n === 1) this.set(id, { first_output_at: this.now() });
        }
      }
      const result = (await call.result) as { task?: { status?: unknown; output?: unknown; error?: unknown }; proof?: unknown } | null;
      const row = this.row(id)!;
      const status = typeof result?.task?.status === "string" && ENDED.has(result.task.status) ? result.task.status : "failed";
      // Checked before anything is said of it: signed by the node it was handed to, for this hand-off, over its goal and gates.
      const refusal = proofRefusal(result?.proof, {
        by: node.id,
        for: this.deps.identity.id,
        handoff: id,
        nonce: row.nonce,
        goal: row.goal,
        gates: JSON.parse(row.gates) as string[],
        // The task and run it was taken as here, and what it said beside the proof, as it came.
        task: row.task,
        run: row.run,
        said: { output: result?.task?.output, error: result?.task?.error === undefined ? undefined : result.task.error },
        active: (device) => this.deps.store.activeDevice(device)?.kind === "node",
      });
      const statement = refusal ? null : (result!.proof as { statement: ProofStatement }).statement;
      const proof = refusal ? { state: "refused", why: refusal } : { state: "checked", verified: statement!.verified, proof: statement!.proof, ended: statement!.ended, attestation: result!.proof };
      this.end(id, {
        ended: true,
        status: statement?.status ?? status,
        proof: JSON.stringify(proof),
        output: typeof result?.task?.output === "string" ? result.task.output.slice(0, 20_000) : "",
        error: typeof result?.task?.error === "string" ? result.task.error.slice(0, 2_000) : refusal ? `its proof didn't check: ${refusal}` : null,
      });
      if (refusal) this.deps.log(`fabric: ${id}'s proof from ${node.name} was refused: ${refusal}`);
    } catch (error) {
      const e = error as SidecarError;
      const stopped = this.row(id)?.stop_asked_at != null || e.kind === "cancelled";
      // (Ending it here cancels its call: the work there stops, as it would for any end its result didn't bring.)
      this.end(id, { status: stopped ? "stopped" : "interrupted", error: stopped ? null : `the link to ${node.name} failed: ${String(e.message ?? e).slice(0, 300)}` });
    }
  }

  /** Its run is over there: its grant is renewed no more and revoked now, while the call goes on for the proof. */
  private release(id: string): void {
    const held = this.calls.get(id);
    if (held?.renew) clearInterval(held.renew);
    if (held) held.renew = null;
    const row = this.row(id);
    const client = this.deps.fabric.sidecar.client;
    if (!row?.grant_id) return;
    this.set(id, { grant_id: null, tokens: "[]" });
    if (client) void client.revoke({ grant: row.grant_id }).catch((error: Error) => this.deps.log(`fabric: ${id}'s grant wasn't revoked: ${error.message}`));
  }

  /** The run's grant: minted once the runner says the run's key, sent in on the call, renewed at half its life. */
  private async grant(id: string, call: Call): Promise<void> {
    const row = this.row(id)!;
    const tools = JSON.parse(row.tools) as FabricRunTool[];
    const client = this.deps.fabric.sidecar.client;
    if (!tools.length || !row.run || !client) return;
    const ttl = this.deps.grantTtlSecs ?? RUN_GRANT_TTL;
    const minted = await client.mint({ aud: row.run, cmds: [RUN_GRANT_COMMAND], sub: this.deps.fabric.sidecar.did ?? undefined, pol: runGrantPolicy(id), ttlSecs: ttl, renewable: true });
    const chain = minted.tokens[0]!.chain;
    this.set(id, { grant_id: minted.grant, tokens: JSON.stringify(minted.tokens.map((t) => t.tokenId)) });
    call.send({ value: { kind: "chain", chain } });
    const held = this.calls.get(id);
    if (!held) return;
    held.renew = setInterval(() => {
      void (async () => {
        const live = this.row(id);
        const sidecar = this.deps.fabric.sidecar.client;
        // Never past its call's deadline: the grant ends with the longest the hand-off may last.
        if (live && this.now() - live.created_at >= (this.deps.handCallMs ?? HAND_CALL_MS)) return this.release(id);
        if (!live || live.phase === "ended" || !live.grant_id || !sidecar) return;
        try {
          const renewed = await sidecar.renew(live.grant_id, ttl);
          const ids = [...(JSON.parse(live.tokens) as string[]), ...renewed.tokens.map((t) => t.tokenId)].slice(-8);
          this.set(id, { tokens: JSON.stringify(ids) });
          call.send({ value: { kind: "chain", chain: renewed.tokens[0]!.chain } });
        } catch (error) {
          this.deps.log(`fabric: ${id}'s grant wasn't renewed: ${(error as Error).message}`);
        }
      })();
    }, (ttl * 1000) / 2);
    held.renew.unref?.();
  }

  /**
   * It ended here: its grant ends with it (revoked, so its next call is refused), and nothing more is followed. Any end
   * its call's own result didn't bring (`ended`) cancels the call, so the work there stops too.
   */
  private end(id: string, fields: Partial<Omit<Row, "id">> & { ended?: boolean }): void {
    const { ended, ...rest } = fields;
    const row = this.row(id);
    if (!row || row.phase === "ended") return;
    this.set(id, { ...rest, phase: "ended", ended_at: this.now() });
    const held = this.calls.get(id);
    this.calls.delete(id);
    if (!ended) held?.call.cancel();
    if (held?.renew) clearInterval(held.renew);
    const client = this.deps.fabric.sidecar.client;
    if (row.grant_id && client) void client.revoke({ grant: row.grant_id }).catch((error: Error) => this.deps.log(`fabric: ${id}'s grant wasn't revoked: ${error.message}`));
    this.set(id, { tokens: "[]" });
  }

  /**
   * Cuts a run's key off, its task going on without this node's tools: its grant revoked at this node's sidecar, so the
   * run's very next call is refused (and this node's door refuses it too: no token of the hand-off's is current).
   */
  async revokeRun(id: string): Promise<string[]> {
    const row = this.row(id);
    if (!row) throw Object.assign(new Error("no such task handed on"), { status: 404 });
    const held = this.calls.get(id);
    if (held?.renew) clearInterval(held.renew);
    if (held) held.renew = null;
    this.set(id, { tokens: "[]" });
    const client = this.deps.fabric.sidecar.client;
    return row.grant_id && client ? client.revoke({ grant: row.grant_id }) : [];
  }

  /** Stops a task handed on: the runner stops the work and says how it ended; past a while, the call itself is cancelled. */
  stop(id: string): HandedView {
    const row = this.row(id);
    if (!row) throw Object.assign(new Error("no such task handed on"), { status: 404 });
    const held = this.calls.get(id);
    if (row.phase !== "ended" && held) {
      this.set(id, { stop_asked_at: this.now() });
      held.call.send({ value: { kind: "stop" } });
      const timer = setTimeout(() => {
        this.stopTimers.delete(timer);
        if (this.row(id)?.phase !== "ended") held.call.cancel();
      }, this.deps.stopWaitMs ?? STOP_WAIT_MS);
      timer.unref?.();
      this.stopTimers.add(timer);
    }
    return this.view(this.row(id)!);
  }

  /** The agents here changed something (a trail's line, a task's state): whoever follows a run here looks now. */
  poke(): void {
    for (const wake of [...this.wakers]) wake();
  }

  /** Until the agents here change something, or `ms` at most. */
  private nap(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.wakers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      this.wakers.add(wake);
    });
  }

  /**
   * As the node stops, before its database closes: nothing more is written or followed here, and no timer of a hand-off
   * outlives the node (the calls end with its sidecar, and each runner stops its work when its call ends).
   */
  close(): void {
    this.closed = true;
    this.unsubscribe();
    this.poke();
    for (const timer of this.stopTimers) clearTimeout(timer);
    this.stopTimers.clear();
    for (const held of this.calls.values()) if (held.renew) clearInterval(held.renew);
    this.calls.clear();
  }

  list(): HandedView[] {
    return this.rows().map((row) => this.view(row, -1));
  }

  get(id: string, after = 0): HandedView {
    const row = this.row(id);
    if (!row) throw Object.assign(new Error("no such task handed on"), { status: 404 });
    return this.view(row, after);
  }

  /** How long the stop of a hand-off took, from asking to its end (ms), and its first output (bench/fabric). */
  timings(id: string): { firstOutputMs: number | null; stopMs: number | null } {
    const row = this.row(id);
    if (!row) return { firstOutputMs: null, stopMs: null };
    return { firstOutputMs: row.first_output_at ? row.first_output_at - row.created_at : null, stopMs: row.stop_asked_at && row.ended_at ? row.ended_at - row.stop_asked_at : null };
  }

  private view(row: Row, after = 0): HandedView {
    if (this.closed) after = -1;
    const proof = row.proof ? (JSON.parse(row.proof) as { state: string; why?: string; verified?: boolean; proof?: unknown; ended?: string | null }) : null;
    const trail = after < 0 ? [] : this.deps.db.query<{ at: number; text: string }, [string, number]>("SELECT at, text FROM fabric_handed_trail WHERE handoff = ? AND n > ? ORDER BY n").all(row.id, after);
    const facts = proof?.state === "checked" ? TeamTaskProof.nullable().safeParse(proof.proof ?? null) : null;
    return {
      id: row.id,
      node: { id: row.node, name: row.node_name },
      task: row.task,
      agent: row.agent ? (JSON.parse(row.agent) as { id: string; name: string }) : null,
      title: row.title,
      goal: row.goal,
      gates: JSON.parse(row.gates) as string[],
      tools: JSON.parse(row.tools) as FabricRunTool[],
      phase: row.phase,
      status: row.status,
      waits: row.waits ?? null,
      path: "qamp",
      proof: proof?.state === "checked" ? { state: "checked", verified: proof.verified === true, proof: facts?.success ? facts.data : null, ended: proof.ended ?? null } : proof?.state === "refused" ? { state: "refused", why: proof.why ?? "" } : { state: "none" },
      output: row.output,
      error: row.error,
      createdAt: row.created_at,
      firstOutputAt: row.first_output_at,
      endedAt: row.ended_at,
      trail,
    };
  }

  // ---- the giver's door for a run elsewhere ----

  private async agentTool(inv: Invocation, caller: Device | null): Promise<void> {
    const tool = inv.tool.slice(FABRIC.agent.length + 1) as FabricRunTool;
    if (!(FABRIC_RUN_TOOLS as readonly string[]).includes(tool)) return inv.fail(1, `no tool ${inv.tool}`);
    const args = inv.args as { task?: unknown; input?: unknown } | null;
    const row = typeof args?.task === "string" ? this.row(args.task) : null;
    // What the sidecar checked (signatures, revocation, expiry, linkage, policy, binding to the caller's key) is checked
    // again here for what only this node knows: this hand-off's grant, its run's key, and the node it was handed to.
    const refuse = (why: string) => inv.fail(3, why);
    if (!row || row.phase === "ended") return refuse("that task has ended here, and its grant with it");
    if (!caller || caller.id !== row.node) return refuse("only the node this task was handed to calls for its run");
    if (inv.authorization.kind !== "delegated" || inv.chain.length !== 2) return refuse("a run calls with its own chain: this node's grant to its key, and its key's link to its node");
    const [root, link] = inv.chain as [(typeof inv.chain)[0], (typeof inv.chain)[0]];
    if (root.iss !== this.deps.fabric.sidecar.did || !(JSON.parse(row.tokens) as string[]).includes(root.id)) return refuse("that grant isn't this task's");
    if (root.aud !== row.run || link.iss !== row.run || link.aud !== inv.caller) return refuse("that chain isn't this task's run's");
    if (!(JSON.parse(row.tools) as string[]).includes(tool)) return refuse(`${tool} isn't one of the tools this task was given`);
    if (!this.runTool) return inv.fail(1, "this node serves no tools to runs elsewhere");
    try {
      const input = args?.input && typeof args.input === "object" && !Array.isArray(args.input) ? (args.input as Record<string, unknown>) : {};
      inv.complete(await this.runTool(tool, input, { handoff: row.id, tools: JSON.parse(row.tools) as FabricRunTool[] }, inv.signal));
    } catch (error) {
      if (!inv.signal.aborted) inv.fail(8, String((error as Error).message ?? error).slice(0, 500));
    }
  }

  // ---- the runner ----

  private async runHanded(inv: Invocation, caller: Device | null): Promise<void> {
    // Its life here, from its call's arrival: that call's deadline, or the longest a hand-off may last, whichever comes
    // first. Its giver's deadline alone bounded it, so a giver that set none kept the work going while it stayed.
    const began = this.now();
    const longest = this.deps.handCallMs ?? HAND_CALL_MS;
    const lifeMs = Math.min(inv.deadlineMs ?? Infinity, longest);
    const lifeEnded =
      inv.deadlineMs !== null && inv.deadlineMs <= longest
        ? `Its call's deadline passed (${span(inv.deadlineMs)} from when it was handed over): it ends here with its call.`
        : `It reached the longest a hand-off may last here (${span(longest)}): it ends rather than run on, whatever its giver's call allows.`;
    if (!caller || caller.role !== "full") return inv.fail(3, "a task is handed over by an active full node of this fleet alone");
    const parsed = HandArgs.safeParse(inv.args);
    if (!parsed.success) return inv.fail(2, `that isn't a task handed over: ${parsed.error.issues.map((i) => i.message).join("; ").slice(0, 300)}`);
    const args = parsed.data;
    if (!this.team) return inv.fail(1, "this node has no agents to give it to");
    const self = this.deps.identity.id;
    const by = handedBy(caller.id);
    const team = this.team;
    const busy = () => inv.fail(6, `${caller.name} has ${HANDED_AT_ONCE} tasks handed here at once already, waiting for you, queued or running: let some end first`, true);
    // One at a time for each giving node: what it has open and what your grant has given it today are read, it is given
    // to an agent, and its task is written, before that node's next hand-off is looked at. (The give awaits, and every
    // call of a burst would otherwise read "nothing open, nothing given".) Those waiting their turn count as open from
    // the moment they arrive, so a burst past the limit is refused at once rather than kept waiting.
    const line = this.giving.get(by) ?? { waiting: 0, last: Promise.resolve() };
    if (team.handed(by, this.now() - HANDOFF_DAY_MS).atOnce + line.waiting >= HANDED_AT_ONCE) return busy();
    line.waiting++;
    this.giving.set(by, line);
    const turn = line.last.then(async () => {
      if (inv.signal.aborted) throw new Error("its call ended before its turn came");
      const counts = team.handed(by, this.now() - HANDOFF_DAY_MS);
      if (counts.atOnce >= HANDED_AT_ONCE) return null;
      // Your grant for this pair, as the ledger holds it now: within it, taken at once; beyond it, written down for you.
      const terms = readHandoffTerms(this.deps.store.handoffGrant(caller.id, self)?.terms ?? null);
      const under = handoffUnder(terms, { agent: args.agent ?? null, tools: args.tools, ...(args.budgetUsd !== undefined ? { budgetUsd: args.budgetUsd } : {}) }, counts.given);
      const how: HandHow = "budgetUsd" in under ? { by, budgetUsd: under.budgetUsd, ...(terms?.agents ? { agents: terms.agents } : {}) } : { by, propose: under.beyond };
      return { how, given: await team.give(args, inv.signal, how) };
    });
    line.last = turn.catch(() => {});
    let taken: { how: HandHow; given: { task: TeamTask; agent: { id: string; name: string } } } | null;
    try {
      taken = await turn;
    } catch (error) {
      return inv.fail(8, `it couldn't be given to an agent here: ${String((error as Error).message ?? error).slice(0, 400)}`);
    } finally {
      // (Its task is written by now, or it was never given: the agents' own count holds it from here, or nothing does.)
      if (--line.waiting === 0 && this.giving.get(by) === line) this.giving.delete(by);
    }
    if (!taken) return busy();
    const { how, given } = taken;
    // The run's own key: made here for this run alone, held in memory, destroyed when it ends.
    const seed = new Uint8Array(randomBytes(32));
    const did = didKeyOfEd25519(signingPublicKey(seed));
    // A revocation that landed while it was being given (the node, or your grant it was taken under): it ends now.
    const still = this.deps.store.activeDevice(caller.id);
    const lost = !still || still.role !== "full" ? "the node that handed it over was revoked" : "budgetUsd" in how && !this.deps.store.handoffGrant(caller.id, self) ? "your grant for it was revoked as it was given" : null;
    if (lost) {
      this.team.stop(given.task.id, `It ended at once: ${lost}.`);
      seed.fill(0);
      return inv.fail(3, lost);
    }
    const run: Running = { handoff: args.handoff, giver: caller.id, giverKey: inv.caller, task: given.task.id, seed, did, tools: args.tools, granted: "budgetUsd" in how, accepted: false, chain: null, link: null, inv };
    this.runs.set(args.handoff, run);
    const accept = () => {
      if (run.accepted) return;
      run.accepted = true;
      inv.emit({ value: { kind: "accepted", task: given.task.id, agent: given.agent, run: did } });
    };
    if ("propose" in how) {
      this.deps.log(`fabric: ${caller.name} handed over “${args.title.slice(0, 80)}” beyond your grant (${how.propose}): it waits for your approval as ${given.task.id}`);
      inv.emit({ value: { kind: "proposed", task: given.task.id, agent: given.agent, why: how.propose.slice(0, 500) } });
    } else {
      this.deps.log(`fabric: ${caller.name} handed over “${args.title.slice(0, 80)}” under your grant: ${given.agent.name} took it as ${given.task.id}`);
      accept();
    }
    // In: the giver's chain for the run (and each renewal), or a stop.
    void (async () => {
      for await (const chunk of inv.inputs) {
        const said = "value" in chunk ? HandInputChunk.safeParse(chunk.value) : null;
        if (!said?.success) continue;
        if (said.data.kind === "stop") this.team?.stop(run.task);
        else
          try {
            run.chain = qdtChainTokens(said.data.chain);
            run.link = null;
          } catch {
            // Not a chain: the run's calls are refused as without one.
          }
      }
    })().catch(() => {
      // Its input ended with its call: what the run does then is the call's end, below.
    });
    // A call that ended (the giver cancelled, went away, or its link did): the work stops here too, also when it ended
    // as its task was being given.
    const unfollowed = () => this.team?.stop(run.task, "The node that handed it over stopped following it: its call ended.");
    if (inv.signal.aborted) unfollowed();
    else inv.signal.addEventListener("abort", unfollowed, { once: true });
    let after = 0;
    let status = "";
    // Its life ran out and its stop didn't take: why, as its giver is told it (it is answered as failed).
    let unstopped: string | null = null;
    try {
      for (;;) {
        // (The node is stopping: nothing more is followed here.)
        if (this.closed) break;
        const task = this.team.task(run.task);
        if (!task) break;
        if (!ENDED.has(task.status) && this.now() - began >= lifeMs) {
          this.team.stop(run.task, lifeEnded);
          if (ENDED.has(this.team.task(run.task)?.status ?? "stopped")) continue;
          // The stop didn't take (the node is stopping, or the stop couldn't be written): the hand-off ends here all the
          // same, answered as failed, rather than go round again at once for ever, which froze the node (the third
          // re-review's R3-2).
          unstopped = `${lifeEnded} It couldn't be stopped here (the node is stopping, or its stop couldn't be written), so it ends as failed.`;
          break;
        }
        // Approved by you: taken now (a proposal you declined ends stopped, never taken).
        if (!run.accepted && (task.status === "queued" || task.status === "running" || task.record !== undefined)) accept();
        const page = this.team.trail(run.task, after);
        for (const entry of page.entries) {
          inv.emit({ value: { kind: "trail", at: entry.at, text: entry.text.slice(0, 4000) } });
          after = entry.n;
        }
        if (task.status !== status) {
          status = task.status;
          inv.emit({ value: { kind: "state", status } });
        }
        if ((ENDED.has(task.status) && !page.more) || inv.signal.aborted) break;
        // Woken by the agents' own change (each line of its trail is one); a while at most, whatever happens.
        if (!page.more) await this.nap(250);
      }
      if (inv.signal.aborted) return;
      // Paused while its call followed it (its agent, its room or the task, or the agent turned off): it ends now, as
      // it would at a restart, since nobody follows it after this call, and a resume would run it unseen. Its proof
      // says it stopped.
      if (!unstopped && this.team.task(run.task)?.status === "interrupted") this.team.stop(run.task, "This work was paused, and it was handed over by another node: its call ended with the pause, and nobody follows it now, so it ends here rather than be resumed unseen.");
      const task = this.team.task(run.task)!;
      const output = task.output.slice(0, 20_000);
      const endedAs = (unstopped ? "failed" : ENDED.has(task.status) ? task.status : "interrupted") as ProofStatement["status"];
      const verified = !unstopped && task.status === "done" && task.verified;
      const error = unstopped ?? task.error;
      const statement: ProofStatement = {
        v: 1,
        by: this.deps.identity.id,
        for: caller.id,
        handoff: args.handoff,
        nonce: args.nonce,
        task: task.id,
        run: did,
        goal: goalDigest(args.goal),
        gates: args.gates,
        status: endedAs,
        verified,
        ended: task.record?.ended ?? null,
        proof: task.record?.proof ?? null,
        startedAt: task.record?.startedAt ?? null,
        endedAt: task.record?.endedAt ?? null,
        // What it says beside the proof, signed with it: its output and its error, exactly as sent.
        said: saidDigest(output, error),
      };
      inv.complete({ task: { id: task.id, status: unstopped ? endedAs : task.status, verified: unstopped ? false : task.verified, output, error }, proof: signProof(this.deps.identity, statement) });
    } catch (error) {
      // Nobody can follow it now: the work stops here too, and the call fails (invoked says why).
      this.team?.stop(run.task, "This node failed while it followed the task, so it was stopped.");
      throw error;
    } finally {
      this.runs.delete(args.handoff);
      seed.fill(0);
    }
  }

  /**
   * A run here calling one of its giver's tools, from its VM through this node's gateway: carried to the giver over
   * Q-AMP with the giver's grant and the run key's own link onto this node's transport key. Null: no such run.
   */
  async callGiver(sandbox: string, tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<{ status: number; body: unknown }> {
    const task = this.team?.runningIn(sandbox) ?? null;
    const run = task ? [...this.runs.values()].find((r) => r.task === task) : undefined;
    if (!run) return { status: 404, body: { error: "this VM runs no task handed over by another node" } };
    if (!(run.tools as string[]).includes(tool)) return { status: 403, body: { error: `${tool} isn't one of the tools this task was given (${run.tools.join(", ") || "none"})` } };
    // The grant follows the run's key by a round trip: a call made the moment the run begins waits for it a little.
    for (let waited = 0; !run.chain?.length && waited < 3_000 && !signal.aborted; waited += 50) await Bun.sleep(50);
    if (!run.chain?.length) return { status: 503, body: { error: "the node that gave this task hasn't granted its tools yet" } };
    const giver = this.deps.store.activeDevice(run.giver);
    const endpoint = giver ? this.deps.fabric.peerEndpoint(giver) : null;
    const client = this.deps.fabric.sidecar.client;
    const self = this.deps.fabric.sidecar.did;
    if (!giver || !endpoint || !client || !self) return { status: 503, body: { error: "the node that gave this task can't be reached over Q-AMP now" } };
    const root = readQdt(run.chain[0]!).payload;
    const nowSecs = Math.floor(this.now() / 1000);
    // Signed again when it would end soon (a renewal of the giver's grant has cleared it already: chain, above).
    if (!run.link || run.link.exp - nowSecs < LINK_EARLY_SECS) {
      // The run's key passes the grant on to its own node's transport key: no more than it was given, never past it.
      const exp = Math.min(root.exp, nowSecs + LINK_TTL);
      const link = signQdt(run.seed, { aud: self, sub: root.sub, cmd: `/tool/${FABRIC.agent}/${tool}`, exp, pol: runGrantPolicy(run.handoff) });
      run.link = { encoded: link.encoded, exp };
    }
    const call = client.call(endpoint.address, `${FABRIC.agent}/${tool}`, { task: run.handoff, input }, { proofs: [...run.chain, run.link.encoded], deadlineMs: 60_000, signal });
    try {
      return { status: 200, body: await call.result };
    } catch (error) {
      const e = error as SidecarError;
      if (e.kind === "remote" && e.code === 3) return { status: 403, body: { error: `refused: ${e.message}` } };
      return { status: 502, body: { error: String(e.message ?? e).slice(0, 300) } };
    }
  }

  /**
   * What a run here is told of the tools its task was given by the node that handed it over (its planner whole, its
   * engineer in brief): which, and how its commands call them through this node's gateway. Null: none were given.
   */
  toolsNote(task: string): { text: string; brief: string } | null {
    const run = [...this.runs.values()].find((r) => r.task === task);
    if (!run?.tools.length) return null;
    const giver = this.deps.store.device(run.giver)?.name ?? "the node that gave it";
    const how = `curl -s -X POST "\${INVINCIBLE_GATEWAY%/gw}/fabric/tool/<tool>" -H "Authorization: Bearer $INVINCIBLE_TOKEN" -H "content-type: application/json" -d '<the tool's input as JSON, {} for none>'`;
    return {
      text: `This task was handed to you by ${giver}, another node of the owner's fleet. Your commands may call these tools of its (read-only): ${run.tools.join(", ")}. Each call is ${how}; the answer is the tool's result there, as JSON. Each one is checked on ${giver} against a grant to this run alone, which ends with the task.`,
      brief: `Tools of ${giver}, which gave this task: ${run.tools.join(", ")}, by ${how}.`,
    };
  }

  /** The runs under way here, for the doctor and tests: their hand-offs, tasks and keys. */
  running(): { handoff: string; task: string; run: string; chained: boolean }[] {
    return [...this.runs.values()].map((r) => ({ handoff: r.handoff, task: r.task, run: r.did, chained: !!r.chain }));
  }

  /** The chain a run holds now (tests), as text. */
  chainOf(handoff: string): string | null {
    const run = this.runs.get(handoff);
    return run?.chain ? qdtChainText(run.chain) : null;
  }
}


/** The most a VM's tool input may be, and how many calls one VM may make to its giver's tools in a minute. */
const TOOL_INPUT_MAX = 1 << 20;
const VM_CALLS_PER_MINUTE = 60;
/** Each VM's calls in the last minute, by its VM: its gateway token is never spent by them, so they are counted here. */
const vmCalls = new Map<string, number[]>();

/** Whether one more call of this VM's fits its minute (and it is counted when it does). */
function spendCall(sandbox: string, now: number): boolean {
  const recent = (vmCalls.get(sandbox) ?? []).filter((at) => now - at < 60_000);
  const fits = recent.length < VM_CALLS_PER_MINUTE;
  if (fits) recent.push(now);
  vmCalls.set(sandbox, recent);
  // (VMs whose minute is over are forgotten, so the count holds as many VMs as are calling.)
  if (vmCalls.size > 1024) for (const [vm, calls] of vmCalls) if (!calls.some((at) => now - at < 60_000)) vmCalls.delete(vm);
  return fits;
}

/** A request's body as text, read as it comes up to `max` bytes: past them (said or found), null, and the rest unread. */
async function boundedBody(req: Request, max: number): Promise<string | null> {
  const said = req.headers.get("content-length");
  if (said && /^\d{1,16}$/.test(said) && Number(said) > max) {
    await req.body?.cancel().catch(() => {});
    return null;
  }
  if (!req.body) return "";
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

/**
 * The VM's way to the tools its task was given by the node that handed it over: POST /fabric/tool/<name> on its node's
 * gateway, with the VM's own gateway token (whose label names its VM) and the tool's input as JSON (1 MiB at most, read
 * as it comes; at most VM_CALLS_PER_MINUTE calls a minute from one VM). Its node carries it over Q-AMP under the run's
 * own chain (Handoffs.callGiver), which the VM never sees, as it never sees a key.
 */
export async function handleFabricTool(req: Request, ctx: { tokens: { liveLabel(token: string): string | null }; handoffs: Pick<Handoffs, "callGiver"> | null; now?: () => number }): Promise<Response> {
  const answer = (status: number, body: unknown) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
  if (req.method !== "POST") return answer(405, { error: "POST" });
  const label = ctx.tokens.liveLabel(req.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? "");
  if (!label?.startsWith("sandbox:")) return answer(401, { error: "this VM's gateway token, as its model access uses it" });
  const tool = new URL(req.url).pathname.slice("/fabric/tool/".length);
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(tool)) return answer(404, { error: "no such tool" });
  const sandbox = label.slice("sandbox:".length);
  if (!spendCall(sandbox, (ctx.now ?? Date.now)())) return answer(429, { error: `at most ${VM_CALLS_PER_MINUTE} calls a minute from one VM to the tools its task was given` });
  const text = await boundedBody(req, TOOL_INPUT_MAX);
  if (text === null) return answer(413, { error: "a tool's input is at most 1 MiB" });
  let input: unknown = {};
  try {
    input = text.trim() ? JSON.parse(text) : {};
  } catch {
    return answer(400, { error: "the tool's input is JSON" });
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return answer(400, { error: "the tool's input is a JSON object" });
  if (!ctx.handoffs) return answer(404, { error: "this node has no fabric" });
  const done = await ctx.handoffs.callGiver(sandbox, tool, input as Record<string, unknown>, req.signal);
  return answer(done.status, done.body);
}
