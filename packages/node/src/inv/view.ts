import { type ActionView, costOf, type FleetView, moneyPrices, type ProjectView, type RunView, runInHand, type TeamSnapshot, type TurnView, type UnreadChat, type UsageView } from "@invincible/core";
import { primaryNow } from "../../../../apps/web/src/lib/now.ts";
import { type Ask, agentOfCaller } from "../../../../apps/web/src/lib/roster.ts";
import { type Attended, atAGlance, attended, inboxBeyond, type WorkRow } from "../../../../apps/web/src/lib/work.ts";
import type { NodeClient } from "./client.ts";

/*
 * What the board shows, as the apps show it: the rows are the web app's own (apps/web/src/lib/work.ts, its attended()),
 * your agent's line is its own (now.ts, work.ts' atAGlance), so every word is the apps' word. Read from the routes every
 * client reads, each under its own scope: a piece this device may not read is left out, never guessed at.
 */

/** What `GET /api/whoami` answers (`primaryName`: what you named your agent, where a node sends it). */
export interface Whoami {
  device: string;
  kind: string;
  scopes: string[];
  node: string;
  nodeName: string;
  fleet: string | null;
  fleetName: string | null;
  primaryName?: string | null;
}

/** What your agent is called until you name it. */
export const UNNAMED = "Invincible";

/** Your agent's name, as the apps take it (Primary.swift, Primary.kt): the node's word for it, else "Invincible". */
export function primaryName(whoami: Pick<Whoami, "primaryName"> | null): string {
  const name = whoami?.primaryName?.trim();
  return name ? [...name].slice(0, 40).join("") : UNNAMED;
}

export interface BoardData {
  whoami: Whoami | null;
  snapshot: TeamSnapshot;
  actions: ActionView[];
  projects: ProjectView[];
  fleet: FleetView | null;
  usage: UsageView | null;
  turns: TurnView[];
  unread: UnreadChat[];
  runs: RunView[];
  now: number;
}

/** A piece the board can do without: null (or nothing) when this device may not read it, or the node lacks it. */
const optional = <T>(read: Promise<T>): Promise<T | null> =>
  read.catch((error: { exit?: number }) => {
    if (error?.exit === 31) throw error;
    return null;
  });

export async function readBoard(client: NodeClient, now = Date.now): Promise<BoardData> {
  const [snapshot, whoami, actions, projects, fleet, usage, turns, runs] = await Promise.all([
    client.call<TeamSnapshot>("team"),
    optional(client.call<Whoami>("whoami")),
    optional(client.call<{ actions: ActionView[] }>("actions")),
    optional(client.call<{ projects: ProjectView[] }>("projects")),
    optional(client.call<FleetView>("fleet")),
    optional(client.call<UsageView>("usage", { days: 1 })),
    optional(client.call<{ turns: TurnView[]; unread?: UnreadChat[] }>("turns")),
    optional(client.call<{ runs: RunView[] }>("runs")),
  ]);
  return {
    whoami,
    snapshot,
    actions: actions?.actions ?? [],
    projects: projects?.projects ?? [],
    fleet,
    usage,
    turns: turns?.turns ?? [],
    unread: turns?.unread ?? [],
    runs: runs?.runs ?? [],
    now: now(),
  };
}

/** What waits for your answer, as the rows read it (lib/roster.ts' Ask). */
export const waiting = (actions: readonly ActionView[]): ActionView[] => actions.filter((action) => action.state === "waiting");
export const asksOf = (actions: readonly ActionView[]): Ask[] => waiting(actions).map((action) => ({ by: action.by, connector: action.connector, tool: action.tool }));

/** The agent an approval's asker is (an agent's task asking as it runs), or null (your agent itself, a loop, you). */
export const askingAgent = (action: Pick<ActionView, "by">): string | null => agentOfCaller(action.by);

export function workOf(data: Pick<BoardData, "snapshot" | "projects" | "actions" | "now">): Attended {
  return attended({ snapshot: data.snapshot, projects: data.projects, asks: asksOf(data.actions), now: data.now });
}

export interface NodeLine {
  name: string;
  online: boolean;
  self: boolean;
}

/** The fleet's nodes: each by its name, whether it answers now, and which one inv is talking to. */
export function nodesOf(fleet: FleetView | null): NodeLine[] {
  if (!fleet) return [];
  const peers = new Map(fleet.peers.map((peer) => [peer.device, peer]));
  return fleet.devices
    .filter((device) => device.kind === "node" && !device.revokedAt)
    .map((device) => ({ name: device.name, online: device.id === fleet.self || peers.get(device.id)?.online === true, self: device.id === fleet.self }));
}

/** What this node's model calls cost today (its UTC day, as it counts them), at your prices; a plan's calls cost nothing. */
export function todayCost(usage: UsageView | null, now: number): { usd: number; complete: boolean } | null {
  if (!usage) return null;
  const today = new Date(now).toISOString().slice(0, 10);
  const cost = costOf(usage.rows.filter((row) => row.day === today), moneyPrices(usage.prices, usage.plans ?? []));
  return { usd: cost.usd, complete: cost.complete && !cost.unpriced.length };
}

export interface BoardView {
  primary: { name: string; line: string; needs: boolean };
  work: Attended;
  /** Approvals that wait for you beyond the rows that stand for them (your agent's own, a loop's): `inv asks` has them. */
  beyond: number;
  nodes: NodeLine[];
  cost: { usd: number; complete: boolean } | null;
}

export function boardView(data: BoardData): BoardView {
  const work = workOf(data);
  const open = waiting(data.actions);
  const beyond = inboxBeyond(open.length, open, work.needs);
  const needs = work.needs.length + beyond;
  const now = primaryNow({ turns: data.turns.map((turn) => ({ title: turn.title })), runs: data.runs.filter((run) => runInHand(run.state)).map((run) => ({ goal: run.goal })), needs, unread: data.unread });
  const glance = atAGlance(work, needs, now.text);
  return { primary: { name: primaryName(data.whoami), line: glance.text, needs: glance.needs || needs > 0 }, work, beyond, nodes: nodesOf(data.fleet), cost: todayCost(data.usage, data.now) };
}

export type Section = "needs" | "active" | "working" | "done";

/** A row as `--json` prints it (docs/CLI.md, "The objects --json prints"). */
export function rowJson(row: WorkRow, section: Section) {
  return {
    id: row.id,
    title: row.title,
    section,
    state: row.state,
    word: row.word,
    agent: row.agent.id,
    project: row.project.key === "other" ? null : row.project.name,
    detail: row.detail,
    age: row.age,
    at: row.at,
  };
}
export type RowJson = ReturnType<typeof rowJson>;

export const SECTIONS: readonly Section[] = ["needs", "active", "working", "done"];
