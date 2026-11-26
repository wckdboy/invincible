import { type BrainContext, chat, isEmbeddingModel, resolveProvider } from "@galahad/brain";
import { freeSlots, type NodeCapacity, SELF_ACTION_QUEST } from "@galahad/core";
import type { SandboxHost } from "@galahad/sandbox";
import type { Capabilities } from "../capabilities.ts";
import type { Governor } from "./governor.ts";

/*
 * The two measurements a calibration takes of this node beyond the benchmark: how long
 * a sandbox takes to be ready, and how fast a local model writes. Both go through the
 * node's own doors (the governed sandbox host, the roster's local runtimes on
 * loopback), so they respect the ceiling like any other work, and neither installs or
 * downloads anything: a runtime that isn't there isn't measured.
 */

/** The calibration's own sandbox: as small as a sandbox gets, gone as soon as it has started. */
const PROBE = { cpus: 1, memoryGb: 1, ttlMinutes: 5, persistent: false, quest: SELF_ACTION_QUEST } as const;

/**
 * How long a sandbox takes from asked-for to running its first command, for each kind this host has (a Mac's are
 * all VMs), cut off as far as this host cuts one off (no network; on a Mac, which has none such, the gateway's
 * alone). Only when a slot is free now (a calibration never queues behind real work, nor in front of it).
 */
export async function sandboxStart(host: SandboxHost, governor: Governor, capacity: () => NodeCapacity): Promise<{ kind: "container" | "vm"; startMs: number }[]> {
  const out: { kind: "container" | "vm"; startMs: number }[] = [];
  for (const kind of host.kinds) {
    if (freeSlots(capacity(), governor.use(), governor.hostNow()) < 1 || governor.usage().queued > 0) break;
    const started = performance.now();
    const sandbox = await host.create({ ...PROBE, network: host.strictest, isolation: kind });
    try {
      const ran = await host.exec(sandbox.id, ["true"], 30);
      if (ran.exitCode === 0) out.push({ kind, startMs: Math.round(performance.now() - started) });
    } finally {
      // His own, ephemeral, made for this: the oath lets him remove it.
      await host.destroy(sandbox.id, { quest: SELF_ACTION_QUEST }).catch(() => {});
    }
  }
  return out;
}

const PROMPT = "Count from 1 to 60, one number per line, and nothing else.";
/** One model is asked for at most this long, and at most this much. */
const MODEL_MS = 12_000;
const MODEL_CHARS = 600;

/**
 * Tokens a second (about four characters each) from the first chat model each local runtime serves on this
 * node. A runtime that isn't running, or serves only an embedding model, isn't measured. Nor is one whose
 * provider no longer points at this machine (someone repointed "ollama" at a service elsewhere): measuring
 * himself never calls out, and never spends a provider's quota.
 */
export async function modelSpeed(ctx: BrainContext, caps: Capabilities | null, enter: Governor["enterModel"]): Promise<{ runtime: string; model: string; tps: number }[]> {
  const out: { runtime: string; model: string; tps: number }[] = [];
  for (const runtime of caps?.localModels ?? []) {
    const model = runtime.models.find((m) => !isEmbeddingModel(m));
    if (!model) continue;
    if (resolveProvider(ctx.store, ctx.vault, runtime.runtime)?.local !== true) continue;
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), MODEL_MS);
    const leave = await enter({ wait: true }, stop.signal).catch(() => null);
    if (!leave) {
      clearTimeout(timer);
      continue;
    }
    let first = 0;
    let chars = 0;
    try {
      for await (const event of chat(ctx, { model: `${runtime.runtime}/${model}`, messages: [{ role: "user", content: PROMPT }], signal: stop.signal })) {
        if (event.type !== "text") continue;
        first ||= performance.now();
        chars += event.text.length;
        if (chars >= MODEL_CHARS) break;
      }
    } catch {
      /* cut off at its time limit: what it wrote until then counts */
    } finally {
      stop.abort();
      clearTimeout(timer);
      leave();
    }
    const seconds = first ? (performance.now() - first) / 1000 : 0;
    if (chars >= 40 && seconds > 0.2) out.push({ runtime: runtime.runtime, model, tps: chars / 4 / seconds });
  }
  return out;
}
