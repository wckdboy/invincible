import { FABRIC_RUN_TOOLS, type HandedView, HandTaskInput } from "@invincible/core";
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
       invincible handed [<id> [--follow] | stop <id>]`;

/** A handed task's verdict, in the apps' words, from what the node that ran it signed (null: not ended yet). */
export function handedVerdict(view: HandedView): { word: string; proven: boolean } | null {
  if (view.phase !== "ended") return null;
  if (view.proof.state === "refused") return { word: `Not proven: its proof didn't check (${view.proof.why})`, proven: false };
  if (view.proof.state === "none") return { word: view.status === "stopped" ? "Stopped" : `Failed${view.error ? `: ${view.error}` : ""}`, proven: false };
  const facts: ProofFacts | null = view.proof.proof
    ? { gates: view.proof.proof.after.map((exit, i) => ({ exit, before: view.proof.state === "checked" ? (view.proof.proof!.before[i] ?? null) : null })), review: view.proof.proof.review, sameModel: view.proof.proof.sameModel }
    : null;
  const status = view.status === "done" || view.status === "failed" || view.status === "stopped" ? view.status : "failed";
  const verdict = verdictOf({ status, verified: view.proof.verified, record: view.proof.ended ? ({ ended: view.proof.ended } as never) : undefined, error: view.error }, facts);
  return verdict ? { word: verdict.word, proven: verdict.verdict === "proven" } : null;
}

function summary(view: HandedView): string {
  const verdict = handedVerdict(view);
  const where = `${view.node.name}${view.agent ? ` · ${view.agent.name}` : ""}`;
  return `${bold(view.id)}  ${view.title.slice(0, 80)}\n  ${dim(`${where} · ${verdict ? verdict.word : view.phase === "handing" ? "handing it over" : `${view.status} there`}${view.task ? ` · its task there ${view.task}` : ""}`)}`;
}

async function follow(api: Api, id: string, from = 0): Promise<HandedView> {
  let after = from;
  for (;;) {
    const view = await api.call<HandedView>("handedTask", { id, after });
    for (const line of view.trail) console.log(`  ${dim(new Date(line.at).toLocaleTimeString())}  ${line.text.split("\n")[0]!.slice(0, 200)}`);
    after += view.trail.length;
    if (view.phase === "ended") return view;
    await Bun.sleep(300);
  }
}

/** Ends with the verdict: printed, and as the exit code (0: proven). */
function verdictExit(view: HandedView): void {
  const verdict = handedVerdict(view);
  console.log(`\n${bold(verdict?.word ?? view.status)}${view.proof.state === "checked" ? dim(` · its proof checked: signed by ${view.node.name}'s own key, for this hand-off`) : ""}`);
  if (!verdict?.proven) process.exitCode = 1;
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
    console.log(`Handed to ${view.node.name} over Q-AMP: ${bold(view.id)}${view.tools.length ? ` · its run may use ${view.tools.join(", ")} here` : ""}`);
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
  if (first === "stop") {
    if (!second) throw new Error("usage: invincible handed stop <id>");
    const view = await api.call<HandedView>("stopHanded", { id: second });
    console.log(`Asked ${view.node.name} to stop ${view.id}: it stops the work there and says how it ended.`);
    return verdictExit(await follow(api, view.id, 10_000_000));
  }
  const view = flags.follow ? await follow(api, first) : await api.call<HandedView>("handedTask", { id: first });
  if (!flags.follow) {
    console.log(summary(view));
    for (const line of view.trail.slice(-20)) console.log(`  ${dim(new Date(line.at).toLocaleTimeString())}  ${line.text.split("\n")[0]!.slice(0, 200)}`);
  }
  if (view.phase === "ended") verdictExit(view);
}
