import { describe, expect, test } from "bun:test";
import { DESKTOP_FRAME_HEADER, DESKTOP_FRAME_KIND, DesktopFrames } from "@invincible/core";
import { DesktopStream, type FramesProcess, StreamEnded } from "../src/desktop-stream.ts";

/*
 * The stream of an agent's desktop you watch, from its VM to the node (C1 step 9): one `desktop stream` exec in the VM
 * however many of your devices watch, its frames sent on to each from a keyframe, a device that can't keep up let go,
 * beats while the screen is still, and the exec ended when the last goes. The encoder is stood in for here.
 */

/** A frame as the encoder writes one, its payload a byte that says which. */
function frame(kind: number, n: number): Uint8Array {
  const out = new Uint8Array(DESKTOP_FRAME_HEADER + 1);
  const view = new DataView(out.buffer);
  view.setUint32(0, 10);
  out[4] = kind;
  view.setBigUint64(5, BigInt(1_764_216_000_000 + n));
  out[DESKTOP_FRAME_HEADER] = n;
  return out;
}
const KEY = (n: number) => frame(DESKTOP_FRAME_KIND.key, n);
const DELTA = (n: number) => frame(DESKTOP_FRAME_KIND.delta, n);

/** The encoder's stand-in: what it was told, the frames a test gives it, its end. */
function encoder() {
  const made: { said: string[]; closed: boolean; killed: boolean; push(bytes: Uint8Array): void; end(code: number): void }[] = [];
  const start = (): FramesProcess => {
    const queue: Uint8Array[] = [];
    let wake: (() => void) | null = null;
    let done = false;
    let exit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => (exit = resolve));
    const one = {
      said: [] as string[],
      closed: false,
      killed: false,
      push: (bytes: Uint8Array) => { queue.push(bytes); wake?.(); },
      end: (code: number) => { done = true; wake?.(); exit(code); },
    };
    made.push(one);
    async function* chunks(): AsyncIterable<Uint8Array> {
      for (;;) {
        if (queue.length) yield queue.shift()!;
        else if (done) return;
        else await new Promise<void>((resolve) => (wake = resolve));
      }
    }
    return { chunks: chunks(), write: (text) => void one.said.push(text), close: () => void (one.closed = true), kill: () => { one.killed = true; one.end(137); }, exited };
  };
  return { start, made };
}

/** What a watcher reads next: each frame's kind and its payload's byte (a beat's: null). */
async function next(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<[number, number | null] | "done"> {
  const { done, value } = await reader.read();
  if (done) return "done";
  const [f] = new DesktopFrames().push(value);
  return [f!.kind, f!.payload.length ? f!.payload[0]! : null];
}

const until = async (ready: () => boolean) => {
  for (let i = 0; i < 500 && !ready(); i++) await Bun.sleep(2);
  if (!ready()) throw new Error("never got there");
};

describe("the desktop stream you watch", () => {
  test("one exec however many watch: the first starts it, and each that joins after asks for a keyframe and is sent from one on", async () => {
    const e = encoder();
    const hub = new DesktopStream(e.start);
    const first = hub.watch();
    await until(() => e.made.length === 1);
    e.made[0]!.push(DELTA(1)); // (before any keyframe: no one is sent it)
    e.made[0]!.push(KEY(2));
    const a = (await first).getReader();
    expect(await next(a)).toEqual([1, 2]);
    e.made[0]!.push(DELTA(3));
    expect(await next(a)).toEqual([2, 3]);
    const second = hub.watch();
    expect(e.made[0]!.said).toEqual(["key\n"]);
    e.made[0]!.push(DELTA(4));
    e.made[0]!.push(KEY(5));
    const b = (await second).getReader();
    expect(await next(a)).toEqual([2, 4]);
    expect(await next(a)).toEqual([1, 5]);
    expect(await next(b)).toEqual([1, 5]);
    expect(e.made).toHaveLength(1);
    expect(hub.watching).toBe(2);
  });

  test("when the last one goes, the encoder's stdin is closed, and it is killed if it lingers; one that comes after starts it again", async () => {
    const e = encoder();
    const hub = new DesktopStream(e.start, { lingerMs: 30 });
    const first = hub.watch();
    await until(() => e.made.length === 1);
    e.made[0]!.push(KEY(1));
    const a = await first;
    const b = hub.watch();
    e.made[0]!.push(KEY(2));
    await (await b).cancel();
    expect(e.made[0]!.closed).toBe(false);
    await a.cancel();
    expect(e.made[0]!.closed).toBe(true);
    await until(() => e.made[0]!.killed);
    const again = hub.watch();
    await until(() => e.made.length === 2);
    e.made[1]!.push(KEY(3));
    expect(await next((await again).getReader())).toEqual([1, 3]);
  });

  test("a device that falls behind is let go, as what it hasn't read is screens gone by; the others are sent on as before", async () => {
    const e = encoder();
    const hub = new DesktopStream(e.start, { slowBytes: 100 });
    const slow = hub.watch();
    await until(() => e.made.length === 1);
    e.made[0]!.push(KEY(1));
    const s = (await slow).getReader();
    const fast = hub.watch();
    e.made[0]!.push(KEY(2));
    const f = (await fast).getReader();
    expect(await next(f)).toEqual([1, 2]);
    // The slow one reads nothing; the fast one reads each frame as it comes.
    for (let n = 3; n < 40; n++) {
      e.made[0]!.push(DELTA(n));
      expect(await next(f)).toEqual([2, n]);
    }
    expect(hub.watching).toBe(1);
    await expect(s.read()).rejects.toThrow(/fell behind/);
  });

  test("while the screen is still, each watcher is sent a beat when it has been sent nothing for a beat's time", async () => {
    const e = encoder();
    const hub = new DesktopStream(e.start, { beatMs: 40 });
    const first = hub.watch();
    await until(() => e.made.length === 1);
    e.made[0]!.push(KEY(1));
    const a = (await first).getReader();
    expect(await next(a)).toEqual([1, 1]);
    const t0 = performance.now();
    expect(await next(a)).toEqual([DESKTOP_FRAME_KIND.beat, null]);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(35);
    await a.cancel();
  });

  test("an encoder that ends before it shows anything is an error that says how it ended, never an empty stream", async () => {
    const e = encoder();
    const hub = new DesktopStream(e.start);
    const first = hub.watch();
    await until(() => e.made.length === 1);
    e.made[0]!.end(2);
    const ended = await first.catch((error: unknown) => error);
    expect(ended).toBeInstanceOf(StreamEnded);
    expect((ended as StreamEnded).code).toBe(2);
    expect(hub.watching).toBe(0);
  });

  test("one that shows nothing in time is an error too, and one whose watcher leaves before is gone with it", async () => {
    const e = encoder();
    const hub = new DesktopStream(e.start, { firstMs: 30, lingerMs: 10 });
    await expect(hub.watch()).rejects.toThrow(/showed nothing within/);
    expect(e.made[0]!.closed).toBe(true);
    const away = new AbortController();
    const leaving = hub.watch(away.signal);
    away.abort();
    await expect(leaving).rejects.toThrow(/went away/);
    expect(hub.watching).toBe(0);
  });

  test("its end ends each watcher's stream; what isn't frames is its end; and your input asks it for fast frames", async () => {
    const e = encoder();
    const hub = new DesktopStream(e.start);
    hub.fast(); // (no one watches: nothing to tell)
    const first = hub.watch();
    await until(() => e.made.length === 1);
    e.made[0]!.push(KEY(1));
    const a = (await first).getReader();
    expect(await next(a)).toEqual([1, 1]);
    hub.fast();
    expect(e.made[0]!.said).toEqual(["fast\n"]);
    e.made[0]!.end(0);
    expect(await next(a)).toBe("done");
    // Text where frames should be: it is killed, and its watchers' streams end.
    const second = hub.watch();
    await until(() => e.made.length === 2);
    e.made[1]!.push(KEY(2));
    const b = (await second).getReader();
    expect(await next(b)).toEqual([1, 2]);
    e.made[1]!.push(new TextEncoder().encode("desktop: something went wrong\n"));
    await until(() => e.made[1]!.killed);
    expect(await next(b)).toBe("done");
    // Ended with the VM: each stream ends, and the encoder with them.
    const third = hub.watch();
    await until(() => e.made.length === 3);
    e.made[2]!.push(KEY(3));
    const c = (await third).getReader();
    expect(await next(c)).toEqual([1, 3]);
    hub.close();
    expect(await next(c)).toBe("done");
    expect(e.made[2]!.closed).toBe(true);
  });
});
