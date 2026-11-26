import { FABRIC_RUN_TOOLS, type FabricSettingView, type FleetView, type HandedView, HandoffGrantInput, type HandoffGrantView, HandTaskInput, plainLine } from "@invincible/core";
// The apps' own words for a verdict (the CLI reads them as the apps do).
import { type ProofFacts, verdictOf } from "../../../apps/web/src/lib/steps.ts";
import type { Api } from "./loop-cli.ts";

/*
 * `invincible hand` and `invincible handed`: a task handed to another node's agents over Q-AMP (fabric/handoff.ts), and
 * what came of it, its proof checked here. Thin: the node hands it on, follows it and checks its proof; this shapes what
 * you type and prints what came back, in the apps' own words. The exit code is the verdict, as inv's is: 0 means proven.
 */

type Flags = Record<string, string | boolean | (string | boolean)[] | undefined>;

const tty = process.stdout.isTTY;
const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s);

export const HAND_USAGE = `usage: invincible hand <node> "<goal>" [--gate "<command>"]… [--agent <id>] [--tools ${FABRIC_RUN_TOOLS.join(",")}] [--budget <usd>] [--title "…"] [--follow]
       invincible handed [<id> [--follow] | stop <id> | revoke <id>]`;

/**
 * `invincible status`'s lines for the fleet: each device, its state and the path to it, and why a peer is over HTTP.
 * Names, capabilities and reasons are other devices' words (the ledger's, or a peer's error): each is printed plain.
 */
export function fleetStatusLines(fleet: FleetView): string[] {
  const peers = new Map(fleet.peers.map((p) => [p.device, p]));
  const lines = [`${bold(`Fleet ${plainLine(fleet.name)}`)}  ${dim(fleet.fleet.slice(0, 12))}  events=${fleet.events}  digest=${fleet.digest.slice(0, 10)}`];
  for (const d of fleet.devices) {
    const caps = d.caps as Record<string, any> | null;
    const peer = peers.get(d.id);
    // (Its path: Q-AMP through the sidecars, or HTTP with signed requests where Q-AMP can't be had: the API calls it "https".)
    const path = peer?.path === "qamp" ? " q-amp" : peer?.path === "https" ? " http" : "";
    const state = d.revokedAt ? "revoked" : d.id === fleet.self ? "this node" : d.kind === "client" ? "client" : peer?.online ? `online ${peer.rttMs}ms${path}` : "offline";
    const summary = caps
      ? plainLine(`${caps.os}/${caps.arch} ${caps.cores}c ${caps.memoryGb}GB${caps.gpu?.length ? ` gpu:${caps.gpu[0].name}` : ""}${caps.docker ? " docker" : ""}${caps.vm?.kvm ? " kvm" : ""}${caps.localModels?.some((r: any) => r.models.length) ? " local-ai" : ""}`)
      : "";
    lines.push(`  ${plainLine(d.name).padEnd(18)} ${d.kind.padEnd(6)} ${state.padEnd(20)} ${dim(summary)}`);
    if (peer?.online && peer.path === "https" && peer.fallback) lines.push(`  ${" ".repeat(18)} ${dim(`over HTTP: ${plainLine(peer.fallback)}`)}`);
  }
  return lines;
}

/** A handed task's verdict, in the apps' words, from what the node that ran it signed (null: not ended yet). */
export function handedVerdict(view: HandedView): { word: string; proven: boolean } | null {
  if (view.phase !== "ended") return null;
  if (view.proof.state === "refused") return { word: `Not proven: its proof didn't check (${plainLine(view.proof.why)})`, proven: false };
  if (view.proof.state === "none") return { word: view.status === "stopped" ? "Stopped" : `Failed${view.error ? `: ${plainLine(view.error)}` : ""}`, proven: false };
  const facts: ProofFacts | null = view.proof.proof
    ? { gates: view.proof.proof.after.map((exit, i) => ({ exit, before: view.proof.state === "checked" ? (view.proof.proof!.before[i] ?? null) : null })), review: view.proof.proof.review, sameModel: view.proof.proof.sameModel }
    : null;
  const status = view.status === "done" || view.status === "failed" || view.status === "stopped" ? view.status : "failed";
  const verdict = verdictOf({ status, verified: view.proof.verified, record: view.proof.ended ? ({ ended: view.proof.ended } as never) : undefined, error: view.error }, facts);
  return verdict ? { word: plainLine(verdict.word), proven: verdict.verdict === "proven" } : null;
}

function summary(view: HandedView): string {
  const verdict = handedVerdict(view);
  // Every field another node said is plain text here: no escape of theirs reaches your terminal.
  const where = `${plainLine(view.node.name)}${view.agent ? ` · ${plainLine(view.agent.name)}` : ""}`;
  const state = verdict ? verdict.word : view.phase === "handing" ? "handing it over" : view.status === "proposed" ? `waits for your approval there${view.waits ? ` (${plainLine(view.waits)})` : ""}` : `${plainLine(view.status)} there`;
  return `${bold(view.id)}  ${plainLine(view.title).slice(0, 80)}\n  ${dim(`${where} · ${state}${view.task ? ` · its task there ${plainLine(view.task)}` : ""}`)}`;
}

/** A line of a trail another node's agent wrote, as plain text, its first line alone. */
function trailLine(line: { at: number; text: string }): string {
  return `  ${dim(new Date(line.at).toLocaleTimeString())}  ${plainLine(line.text.split("\n")[0]!).slice(0, 200)}`;
}

async function follow(api: Api, id: string, from = 0): Promise<HandedView> {
  let after = from;
  for (;;) {
    const view = await api.call<HandedView>("handedTask", { id, after });
    for (const line of view.trail) console.log(trailLine(line));
    after += view.trail.length;
    if (view.phase === "ended") return view;
    await Bun.sleep(300);
  }
}

/** Ends with the verdict: printed, and as the exit code (0: proven). */
function verdictExit(view: HandedView): void {
  const verdict = handedVerdict(view);
  console.log(`\n${bold(verdict?.word ?? plainLine(view.status))}${view.proof.state === "checked" ? dim(` · its proof checked: signed by ${plainLine(view.node.name)}'s own key, for this hand-off`) : ""}`);
  if (!verdict?.proven) process.exitCode = 1;
}

export const FABRIC_USAGE = `usage: invincible fabric on|off|status|rotate
       invincible fabric grant <from> <to> --budget <usd a day> [--agents <id>,…] [--tools ${FABRIC_RUN_TOOLS.join(",")}]
       invincible fabric grants | invincible fabric revoke <from> <to>`;

function grantLine(g: HandoffGrantView): string {
  const t = g.terms;
  const terms = t ? `${t.agents ? `agents ${t.agents.join(", ")}` : "any agent"} · ${t.tools.length ? `tools ${t.tools.join(", ")}` : "no tools"} · $${t.budgetUsdPerDay} a day` : "terms this version doesn't read (a newer node's)";
  return `${bold(`${plainLine(g.from.name)} → ${plainLine(g.to.name)}`)}  ${dim(terms)}`;
}

/** `invincible fabric grant|grants|revoke`: your grants for hand-offs, one per pair of nodes, given once. */
async function grantCommand(api: Api, sub: "grant" | "grants" | "revoke", rest: string[], flags: Flags): Promise<void> {
  if (sub === "grants") {
    const { grants } = await api.call<{ grants: HandoffGrantView[] }>("handoffGrants");
    if (!grants.length) console.log("No grant for hand-offs: a task handed from one node to another waits there for your approval.");
    for (const g of grants) console.log(grantLine(g));
    return;
  }
  const [from, to] = rest;
  if (!from || !to) throw new Error(FABRIC_USAGE);
  if (sub === "revoke") {
    await api.call("revokeHandoffs", { from, to });
    console.log(`Revoked: what ${plainLine(from)} handed ${plainLine(to)} under it stops there, and its next hand-off waits for your approval.`);
    return;
  }
  const list = (flag: unknown) => (typeof flag === "string" ? flag.split(",").map((x) => x.trim()).filter(Boolean) : undefined);
  const budget = typeof flags.budget === "string" ? Number(flags.budget) : undefined;
  const agents = list(flags.agents);
  const checked = HandoffGrantInput.safeParse({ from, to, ...(agents ? { agents } : {}), tools: list(flags.tools) ?? [], budgetUsdPerDay: budget });
  if (!checked.success) throw new Error(checked.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "));
  const { grant } = await api.call<{ grant: HandoffGrantView }>("grantHandoffs", checked.data);
  console.log(`Granted: ${grantLine(grant)}`);
  console.log(dim(`A task ${plainLine(grant.from.name)} hands ${plainLine(grant.to.name)} within it is taken at once; anything else waits there for your approval.`));
}

/** Where the setting is kept: the node's config (home.ts), written here only when the node isn't running. */
export interface FabricConfig {
  readConfig(): { fabric?: boolean };
  writeConfig(change: { fabric: boolean }): void;
}

function fabricLine(view: FabricSettingView): string {
  const sidecar = view.state === "up" ? `its sidecar is up as ${view.did?.slice(0, 22)}…${view.address ? ` on ${view.address.split("@")[1]}` : " (dials out only)"}` : `its sidecar is ${view.state}${view.why ? `: ${view.why}` : ""}`;
  return `fabric: ${view.on ? "on" : "off"} · ${sidecar}`;
}

/**
 * `invincible fabric on|off|status`: the node's own switch for its fabric, off by default (home.ts NodeConfig.fabric). A
 * running node applies it at once (on: its sidecar starts; off: it stops, and its profile names no endpoint); one that
 * isn't running keeps it in its config for its next start.
 */
export async function fabricCommand(api: Api, sub: string | undefined, config: FabricConfig, rest: string[] = [], flags: Flags = {}): Promise<void> {
  if (sub === "grant" || sub === "grants" || sub === "revoke") return grantCommand(api, sub, rest, flags);
  if (sub === "rotate") {
    const view = await api.call<FabricSettingView>("rotateTransportKey", {});
    console.log(`A new transport key: ${view.did ?? "?"}. Its peers refuse the old one from now on.`);
    console.log(fabricLine(view));
    return;
  }
  if (sub !== undefined && sub !== "on" && sub !== "off" && sub !== "status") throw new Error(FABRIC_USAGE);
  const on = sub === "on" ? true : sub === "off" ? false : undefined;
  let view: FabricSettingView;
  try {
    view = await api.call<FabricSettingView>("fabricSetting", on === undefined ? {} : { on });
  } catch (error) {
    if (!/^no daemon on/.test((error as Error).message)) throw error;
    if (on !== undefined) config.writeConfig({ fabric: on });
    console.log(`fabric: ${(on ?? config.readConfig().fabric === true) ? "on" : "off"} · the node isn't running${on === undefined ? "" : ": it applies this when it next starts"}`);
    return;
  }
  console.log(fabricLine(view));
  if (on === true && view.state !== "up") console.log(dim("It goes on trying by itself; invincible doctor says why, and docs/FABRIC.md what to check."));
  if (on === false) console.log(dim("Every link to another node goes over HTTP with signed requests, as before the fabric."));
}

export async function handCommand(api: Api, command: "hand" | "handed", rest: string[], flags: Flags): Promise<void> {
  if (command === "hand") {
    const [node, ...goal] = rest;
    if (!node || !goal.length) throw new Error(HAND_USAGE);
    const gates = (Array.isArray(flags.gate) ? flags.gate : flags.gate !== undefined ? [flags.gate] : []).filter((g): g is string => typeof g === "string");
    const agents = (Array.isArray(flags.agent) ? flags.agent : flags.agent !== undefined ? [flags.agent] : []).filter((a): a is string => typeof a === "string");
    if (agents.length > 1) throw new Error("--agent names one agent of that node's");
    const tools = typeof flags.tools === "string" ? flags.tools.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
    const budget = typeof flags.budget === "string" ? Number(flags.budget) : undefined;
    const checked = HandTaskInput.safeParse({ node, goal: goal.join(" "), ...(gates.length ? { gates } : {}), ...(agents[0] ? { agent: agents[0] } : {}), ...(tools ? { tools } : {}), ...(budget !== undefined ? { budgetUsd: budget } : {}), ...(typeof flags.title === "string" ? { title: flags.title } : {}) });
    if (!checked.success) throw new Error(checked.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "));
    const view = await api.call<HandedView>("handTask", checked.data);
    console.log(`Handed to ${plainLine(view.node.name)} over Q-AMP: ${bold(view.id)}${view.tools.length ? ` · its run may use ${view.tools.join(", ")} here` : ""}`);
    if (!flags.follow) {
      console.log(dim(`invincible handed ${view.id} --follow follows it; invincible handed stop ${view.id} stops it there.`));
      return;
    }
    return verdictExit(await follow(api, view.id));
  }
  const [first, second] = rest;
  if (!first) {
    const { handed } = await api.call<{ handed: HandedView[] }>("handedTasks");
    if (!handed.length) console.log(`No task handed to another node yet. ${HAND_USAGE.split("\n")[0]!.replace("usage: ", "")}`);
    for (const view of handed) console.log(summary(view));
    return;
  }
  if (first === "revoke") {
    if (!second) throw new Error("usage: invincible handed revoke <id>");
    const view = await api.call<HandedView>("revokeHandedRun", { id: second });
    console.log(`Cut ${view.id}'s run on ${plainLine(view.node.name)} off from this node's tools: its next call is refused, and the task goes on there without them.`);
    return;
  }
  if (first === "stop") {
    if (!second) throw new Error("usage: invincible handed stop <id>");
    const view = await api.call<HandedView>("stopHanded", { id: second });
    console.log(`Asked ${plainLine(view.node.name)} to stop ${view.id}: it stops the work there and says how it ended.`);
    return verdictExit(await follow(api, view.id, 10_000_000));
  }
  const view = flags.follow ? await follow(api, first) : await api.call<HandedView>("handedTask", { id: first });
  if (!flags.follow) {
    console.log(summary(view));
    for (const line of view.trail.slice(-20)) console.log(trailLine(line));
  }
  if (view.phase === "ended") verdictExit(view);
}
