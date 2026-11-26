import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { b64u, decodeHlc, encodeHlc, type GEvent, HlcClock, type Json, newNodeIdentity, type NodeIdentity, signEvent } from "../../packages/core/src/index.ts";
import { enrollDevice, foundFleet, MindStore } from "../../packages/mind/src/index.ts";

/*
 * A log as months of work would leave it, for timing what the mind does with it
 * (bench/suites/mind.ts, and scripts/bench-mind.ts for the long sizes): its own
 * temp home with a three-node fleet (a founder, a sandbox host that writes most
 * of the log, and one more node) and a log shaped like a real one: mostly ledger
 * entries (every sandbox exec is one), loop runs, memories and notices. Every
 * event is really signed and chained; they're written straight into the log and
 * the views rebuilt, as if they had arrived over months. Nothing touches
 * ~/.galahad.
 */

export interface BenchLog {
  dir: string;
  path: string;
  a: NodeIdentity;
  b: NodeIdentity;
  c: NodeIdentity;
  /** Ids of a few of b's older events, to punch holes with. */
  oldB: string[];
}

/** A log of `n` signed, chained events from three nodes, written in bulk, views rebuilt. */
export function buildLog(n: number): BenchLog {
  const dir = mkdtempSync(join(tmpdir(), "galahad-bench-"));
  const path = join(dir, "mind.db");
  const a = newNodeIdentity();
  const b = newNodeIdentity();
  const c = newNodeIdentity();
  // The fleet was founded long enough ago for one event a second up to an hour ago.
  const founded = Date.now() - (n + 7_200) * 1_000;
  const store = new MindStore(path, new HlcClock(() => founded));
  foundFleet(store, a, { fleetName: "bench", nodeName: "founder" });
  enrollDevice(store, a, { device: b.id, name: "sandbox-host", kind: "node", box: b64u(b.boxPublic) });
  enrollDevice(store, a, { device: c.id, name: "third", kind: "node", box: b64u(c.boxPublic) });
  const loops: [NodeIdentity, string][] = [[b, "heartbeat"], [c, "poll"], [a, "backup"]];
  for (const [node, name] of loops) {
    store.emit(a, "loop.set", { name, schedule: "every 30m", on: node.id, enabled: true, task: { kind: "heartbeat" } });
  }
  const fleet = store.fleet!;
  const heads = new Map<string, string | null>([a, b, c].map((node) => [node.id, store.head(node.id)]));
  const slots = new Map<string, number>();
  // Strictly increasing timestamps after the fleet was set up, ending about an hour ago.
  const startMs = founded + 1_000;
  const insert = store.db.query("INSERT INTO events (id, hlc, device, kind, raw) VALUES (?, ?, ?, ?, ?)");
  const oldB: string[] = [];
  let seed = 7;
  const random = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
  let batch: GEvent[] = [];
  const flush = () => {
    store.db.transaction(() => {
      for (const event of batch) insert.run(event.id, event.hlc, event.device, event.kind, JSON.stringify(event));
    })();
    batch = [];
  };
  for (let i = 0; i < n; i++) {
    // The last few are the sandbox host's, so an event from `c` can arrive "late" (out of order).
    const r = random();
    const node = i >= n - 5 ? b : r < 0.7 ? b : r < 0.85 ? a : c;
    const loop = loops.find(([owner]) => owner === node)![1];
    const k = random();
    const hlc = encodeHlc({ ms: startMs + i * 1_000, counter: 0 });
    let kind: string;
    let body: unknown;
    if (k < 0.85) {
      kind = "ledger.recorded";
      body = { class: "create", resource: "sandbox.exec", target: `sb${(i % 997).toString(16)}`, verdict: "allow", quest: `q${i % 50}`, detail: `python3 -c "print(${i})"` };
    } else if (k < 0.93) {
      const slot = (slots.get(loop) ?? 1_700_000_000_000) + 1_800_000;
      slots.set(loop, slot);
      kind = "loop.ran";
      body = { loop, run: `s${slot.toString(36)}`, slot, status: "ok", started: slot, finished: slot + 1_000, summary: "All quiet." };
    } else if (k < 0.97) {
      kind = "memory.added";
      body = { text: `observation ${i}: the build took ${Math.round(random() * 100)} seconds`, tags: ["bench"] };
    } else {
      kind = "notice.raised";
      body = { key: `bench:${i % 20}`, severity: "info", title: "Bench notice", body: `number ${i}`, source: "heartbeat", at: startMs + i * 1_000 };
    }
    const event = signEvent({ v: 2, fleet, hlc, device: node.id, prev: heads.get(node.id) ?? null, kind, body: body as never }, node);
    heads.set(node.id, event.id);
    if (node === b && oldB.length < 4 && i > n / 10) oldB.push(event.id);
    batch.push(event);
    if (batch.length >= 5_000) flush();
  }
  flush();
  store.rebuild();
  const rejected = store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM v_rejected").get()!.n;
  if (rejected) throw new Error(`the generated log should be valid, but ${rejected} events were rejected`);
  store.close();
  return { dir, path, a, b, c, oldB };
}

/** An event from `c`, dated after its own head but before the log's newest event: it arrived late. */
export function lateEvent(store: MindStore, c: NodeIdentity, kind: "ledger.recorded" | "memory.added"): GEvent {
  const head = store.event(store.head(c.id)!)!;
  const { ms, counter } = decodeHlc(head.hlc);
  const body: Json = kind === "ledger.recorded" ? { class: "read", resource: "bench", target: "late", verdict: "allow" } : { text: "a late thought" };
  return signEvent({ v: 2, fleet: store.fleet!, hlc: encodeHlc({ ms, counter: counter + 1 }), device: c.id, prev: head.id, kind, body }, c);
}
