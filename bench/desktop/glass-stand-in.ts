/*
 * Stand-ins for glass-node.ts --stand-in: Docker, deskd's two sessions and the VM's encoder, so the harness can be tried
 * end to end on a machine with no VM. The encoder replays a recording in the stream's own format at its own pace (from
 * its first keyframe again when a watcher asks for one), each frame stamped with the time it is sent. Nothing it shows
 * is live: the glass clock it carries is the recording's, and a click changes nothing on it.
 */

import { DesktopFrames } from "../../packages/core/src/index.ts";
import type { DockerRunner, FramesProcess, SessionProcess } from "../../packages/sandbox/src/index.ts";
import { fakeDocker } from "../../packages/node/test/fake-docker.ts";

export const docker = (): DockerRunner => fakeDocker().runner;

let hold: { since: number; last: number } | null = null;

/** deskd's sessions: the agent's and yours told apart by how they were started, your hold kept as deskd keeps it. */
export function spawnSession(args: string[]): SessionProcess {
  const yours = args.includes("--owner-session");
  let take: ((line: string) => void) | null = null;
  let ended!: (code: number) => void;
  const exited = new Promise<number>((resolve) => (ended = resolve));
  const now = () => (hold ? { since: hold.since / 1000, idle: 120, most: 900, ends_in: Math.max(0, Math.min(hold.last + 120_000, hold.since + 900_000) - Date.now()) / 1000 } : null);
  return {
    write: (text) => {
      for (const line of text.trim().split("\n")) {
        const q = JSON.parse(line) as { id: number; name?: string; argv?: string[] };
        const answer: Record<string, unknown> = { id: q.id, ok: true };
        if (yours && q.name === "take") hold = { since: Date.now(), last: Date.now() };
        else if (yours && q.name === "release") {
          answer.released = hold !== null;
          hold = null;
        } else if (q.argv) {
          if (yours && !["status", "help"].includes(q.argv[0]!)) {
            if (!hold) answer.took = true;
            hold = { since: hold?.since ?? Date.now(), last: Date.now() };
          }
          Object.assign(answer, { code: 0, stdout: "", stderr: "" });
        } else if (q.name === "screenshot") Object.assign(answer, { ok: false, error: "the stand-in has no picture: watch it live" });
        if (yours) answer.hold = now();
        queueMicrotask(() => take?.(JSON.stringify(answer)));
      }
    },
    onLine: (fn) => void (take = fn),
    kill: () => ended(-15),
    exited,
  };
}

/** The encoder: `recording` (the stream's own format) replayed at its own pace while it is watched. */
export function spawnFrames(recording: Uint8Array): (args: string[]) => FramesProcess {
  const frames = new DesktopFrames().push(new Uint8Array(recording));
  if (!frames.length) throw new Error("--frames: give it a recording of the glass page (the stream's own format)");
  return () => {
    let next = 0;
    let ended = false;
    const queue: Uint8Array[] = [];
    let wake: (() => void) | null = null;
    let exit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => (exit = resolve));
    let tick: ReturnType<typeof setTimeout>;
    const send = (): void => {
      if (ended) return;
      const frame = frames[next]!;
      const out = frame.bytes.slice();
      new DataView(out.buffer).setBigUint64(5, BigInt(Date.now()));
      queue.push(out);
      wake?.();
      const after = frames[next + 1];
      next = after ? next + 1 : 0;
      tick = setTimeout(send, after ? Math.max(10, after.time - frame.time) : 100);
    };
    tick = setTimeout(send, 0);
    const end = (code: number): void => {
      ended = true;
      clearTimeout(tick);
      wake?.();
      exit(code);
    };
    async function* chunks(): AsyncIterable<Uint8Array> {
      for (;;) {
        if (queue.length) yield queue.shift()!;
        else if (ended) return;
        else await new Promise<void>((resolve) => (wake = resolve));
      }
    }
    return { chunks: chunks(), write: (text) => void (text.includes("key") && (next = 0)), close: () => end(0), kill: () => end(137), exited };
  };
}
