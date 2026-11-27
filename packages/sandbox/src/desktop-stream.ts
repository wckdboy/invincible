/*
 * The stream of an agent's desktop you watch (C1 step 9), from its VM to the node: `desktop stream` in a held exec of
 * its own, its frames on stdout (core's desktop-frames.ts), sent on to each of your devices that watches. Nothing
 * listens in the VM, and the encoder runs only while someone watches:
 * - one exec a VM however many watch, started with the first;
 * - each that joins after asks it for a keyframe, and is sent from one on;
 * - a device that falls DESKTOP_SLOW_BYTES behind is let go: what it hasn't read is screens gone by, and it starts again
 *   from a keyframe when it comes back;
 * - while the screen is still, a beat to each device that has been sent nothing for LIVE_BEAT_MS, so that whatever
 *   carries the stream knows it is alive;
 * - the last one gone, the encoder's stdin is closed, which ends it, and it is killed if it lingers;
 * - your input asks it for 25 frames a second for 2 s (`fast`).
 */

import { DESKTOP_FRAME_KIND, type DesktopFrame, DesktopFrames, desktopBeat, LIVE_BEAT_MS } from "@invincible/core";

/** The encoder's exec: its stdout a byte at a time as it comes, and what it is told on its stdin. */
export interface FramesProcess {
  chunks: AsyncIterable<Uint8Array>;
  write(text: string): void;
  /** Its stdin closed: the encoder ends. */
  close(): void;
  kill(): void;
  exited: Promise<number>;
}
export type SpawnFrames = (args: string[]) => FramesProcess;

/** The engine's binary run with `args`, its stdout read as it comes (Bun's own process). */
export const spawnFrames = (bin: string): SpawnFrames => (args) => {
  const proc = Bun.spawn([bin, ...args], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  return {
    chunks: proc.stdout as unknown as AsyncIterable<Uint8Array>,
    write: (text) => {
      try {
        proc.stdin.write(text);
        void proc.stdin.flush();
      } catch {
        // (It has ended: what it's told goes nowhere.)
      }
    },
    close: () => {
      try {
        void proc.stdin.end();
      } catch {
        // (Ended already.)
      }
    },
    kill: () => proc.kill(),
    exited: proc.exited,
  };
};

/** The stream ended before it showed anything: `code` is its exec's (2 from a `desktop` older than its stream, or an encoder that couldn't start). */
export class StreamEnded extends Error {
  constructor(readonly code: number) {
    super(`the desktop's stream ended before it showed anything (exit ${code})`);
  }
}

/** A device this far behind (unread) is let go. A second of the stream moving is about 125 KB. */
export const DESKTOP_SLOW_BYTES = 1024 * 1024;

/** What a device is sent before it is let go reads at its pace: this much is queued before its lag is counted. */
const QUEUED = 64 * 1024;

interface Watcher {
  controller: ReadableStreamDefaultController<Uint8Array>;
  /** Sent a keyframe yet: nothing before one. */
  keyed: boolean;
  sentAt: number;
  /** Its stream not given yet: it is, on its first keyframe. */
  waiting: { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null;
}

export class DesktopStream {
  private proc: FramesProcess | null = null;
  private readonly watchers = new Set<Watcher>();
  private beat: ReturnType<typeof setInterval> | null = null;
  private readonly beatMs: number;
  private readonly slowBytes: number;
  private readonly firstMs: number;
  private readonly lingerMs: number;

  constructor(
    private readonly start: () => FramesProcess,
    opts: { beatMs?: number; slowBytes?: number; firstMs?: number; lingerMs?: number } = {},
  ) {
    this.beatMs = opts.beatMs ?? LIVE_BEAT_MS;
    this.slowBytes = opts.slowBytes ?? DESKTOP_SLOW_BYTES;
    // (The desktop may have to start first: `desktop stream` starts it, a few seconds.)
    this.firstMs = opts.firstMs ?? 30_000;
    this.lingerMs = opts.lingerMs ?? 2_000;
  }

  /** How many watch now. */
  get watching(): number {
    return this.watchers.size;
  }

  /**
   * A device watches: its stream of frames, given once its first keyframe is in it, from that keyframe on. Its going
   * away (the stream cancelled, or `signal`) is its leaving. An encoder that ends before it shows anything is an error
   * (StreamEnded), and so is one that shows nothing in time; never an empty stream.
   */
  watch(signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    // (One gone before it began starts nothing.)
    if (signal?.aborted) return Promise.reject(new Error("whoever asked to watch went away"));
    return new Promise((resolve, reject) => {
      let w!: Watcher;
      const stream = new ReadableStream<Uint8Array>(
        {
          start: (controller) => {
            w = { controller, keyed: false, sentAt: performance.now(), waiting: null };
          },
          cancel: () => this.leave(w),
        },
        new ByteLengthQueuingStrategy({ highWaterMark: QUEUED }),
      );
      const timer = setTimeout(() => this.fail(w, new Error(`the desktop showed nothing within ${this.firstMs / 1000} s`)), this.firstMs);
      w.waiting = { resolve: () => resolve(stream), reject, timer };
      this.watchers.add(w);
      signal?.addEventListener("abort", () => (w.waiting ? this.fail(w, new Error("whoever asked to watch went away")) : this.leave(w)), { once: true });
      try {
        if (this.proc) this.proc.write("key\n");
        else this.begin();
      } catch (error) {
        // (An encoder that can't be started is said at once.)
        this.fail(w, error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.beating();
    });
  }

  /** Your input: 25 frames a second for 2 s, as you see what you did. */
  fast(): void {
    this.proc?.write("fast\n");
  }

  /** Ended with the VM (stopped, removed, made again): each watcher's stream ends, and the encoder with them. */
  close(): void {
    for (const w of [...this.watchers]) {
      if (w.waiting) this.fail(w, new StreamEnded(-1));
      else this.leave(w);
    }
    this.idle();
  }

  private begin(): void {
    const proc = this.start();
    this.proc = proc;
    const frames = new DesktopFrames();
    void (async () => {
      try {
        for await (const chunk of proc.chunks) {
          if (this.proc !== proc) return;
          for (const frame of frames.push(chunk)) this.send(frame);
        }
      } catch {
        // What isn't frames, or its pipe broken: the stream's end.
        proc.kill();
      }
    })();
    void proc.exited.then((code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      for (const w of [...this.watchers]) {
        if (w.waiting) this.fail(w, new StreamEnded(code));
        else this.leave(w);
      }
    });
  }

  private send(frame: DesktopFrame): void {
    for (const w of [...this.watchers]) {
      if (!w.keyed) {
        if (frame.kind !== DESKTOP_FRAME_KIND.key) continue;
        w.keyed = true;
      }
      if (!this.put(w, frame.bytes) || !w.waiting) continue;
      clearTimeout(w.waiting.timer);
      const shown = w.waiting.resolve;
      w.waiting = null;
      shown();
    }
  }

  /** Bytes to one device, or it is let go when it has fallen behind. Whether they went. */
  private put(w: Watcher, bytes: Uint8Array): boolean {
    if (QUEUED - (w.controller.desiredSize ?? 0) > this.slowBytes) {
      // (Its unread screens are dropped with it: it starts again from a keyframe when it comes back.)
      this.watchers.delete(w);
      try {
        w.controller.error(new Error("this device fell behind the desktop's stream: watch again"));
      } catch {
        // (Already ended.)
      }
      this.idle();
      return false;
    }
    try {
      w.controller.enqueue(bytes);
      w.sentAt = performance.now();
      return true;
    } catch {
      this.leave(w);
      return false;
    }
  }

  /** A device that was watching leaves: its stream ends. */
  private leave(w: Watcher): void {
    if (!this.watchers.delete(w)) return;
    try {
      w.controller.close();
    } catch {
      // (Cancelled already.)
    }
    this.idle();
  }

  /** A device whose stream was never given: what became of it, said to whoever asked. */
  private fail(w: Watcher, error: Error): void {
    const waiting = w.waiting;
    w.waiting = null;
    if (waiting) clearTimeout(waiting.timer);
    this.watchers.delete(w);
    this.idle();
    waiting?.reject(error);
  }

  /** No one watches: the encoder is ended (its stdin closed, then killed if it lingers). */
  private idle(): void {
    if (this.watchers.size) return;
    if (this.beat) clearInterval(this.beat);
    this.beat = null;
    const proc = this.proc;
    this.proc = null;
    if (!proc) return;
    proc.close();
    const linger = setTimeout(() => proc.kill(), this.lingerMs);
    void proc.exited.finally(() => clearTimeout(linger));
  }

  /** While anyone watches: a beat to each sent nothing for a beat's time (never before its first keyframe: its answer isn't given yet). */
  private beating(): void {
    if (this.beat) return;
    this.beat = setInterval(() => {
      const now = performance.now();
      for (const w of [...this.watchers]) if (!w.waiting && now - w.sentAt >= this.beatMs) this.put(w, desktopBeat(Date.now()));
    }, this.beatMs / 2);
  }
}
