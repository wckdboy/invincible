import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cborDecode, cborEncode } from "@invincible/core";
import { type Invocation, SidecarClient, SidecarError } from "../src/fabric/socket.ts";

/*
 * The node's side of Q-AMP's sidecar socket (Q-AMP docs/SIDECAR.md), against a stand-in sidecar that says exactly what a
 * test needs: frames cut anywhere, one too long to be one, another API, and both ways of flow control. The real
 * sidecar is in fabric.e2e.test.ts.
 */

type Msg = Record<string, unknown> & { t: string };

const frame = (m: Msg): Uint8Array => {
  const body = cborEncode(m);
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length);
  out.set(body, 4);
  return out;
};

interface Fake {
  path: string;
  /** What the host sent, in order. */
  got: Msg[];
  send(m: Msg): void;
  raw(bytes: Uint8Array): void;
  /** Resolves once the host has sent a message that matches. */
  next(match: (m: Msg) => boolean): Promise<Msg>;
  stop(): void;
}

const fakes: Fake[] = [];
afterEach(() => {
  for (const f of fakes.splice(0)) f.stop();
});

function fake(opts: { hello?: Msg | null; onMessage?: (m: Msg, f: Fake) => void } = {}): Fake {
  const path = join(tmpdir(), `q5s-${randomBytes(4).toString("hex")}.sock`);
  const got: Msg[] = [];
  const waiting: { match: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = [];
  let peer: Bun.Socket<undefined> | null = null;
  let inbox = new Uint8Array(0);
  // What the socket didn't take yet: written on its drain, in order (Bun writes what fits, and says how much).
  const queued: Uint8Array[] = [];
  const flush = () => {
    while (peer && queued.length) {
      const head = queued[0]!;
      const wrote = peer.write(head);
      if (wrote >= head.length) queued.shift();
      else {
        if (wrote > 0) queued[0] = head.subarray(wrote);
        return;
      }
    }
  };
  const write = (bytes: Uint8Array) => {
    queued.push(bytes);
    flush();
  };
  const self: Fake = {
    path,
    got,
    send: (m) => write(frame(m)),
    raw: (bytes) => write(bytes),
    next: (match) => {
      const seen = got.find(match);
      return seen ? Promise.resolve(seen) : new Promise((resolve) => waiting.push({ match, resolve }));
    },
    stop: () => {
      server.stop(true);
      rmSync(path, { force: true });
    },
  };
  const server = Bun.listen<undefined>({
    unix: path,
    socket: {
      drain: () => flush(),
      open(socket) {
        peer = socket;
        if (opts.hello !== null) write(frame(opts.hello ?? { t: "hello", api: 1, did: "did:key:z6Mk-stand-in", key_type: "ed25519", version: "0.2.0" }));
      },
      data(_socket, chunk) {
        const next = new Uint8Array(inbox.length + chunk.length);
        next.set(inbox);
        next.set(chunk, inbox.length);
        inbox = next;
        while (inbox.length >= 4) {
          const len = new DataView(inbox.buffer, inbox.byteOffset).getUint32(0);
          if (inbox.length < 4 + len) return;
          const m = cborDecode(inbox.subarray(4, 4 + len)) as Msg;
          inbox = inbox.slice(4 + len);
          got.push(m);
          for (const w of waiting.filter((w) => w.match(m))) {
            waiting.splice(waiting.indexOf(w), 1);
            w.resolve(m);
          }
          opts.onMessage?.(m, self);
        }
      },
    },
  });
  fakes.push(self);
  return self;
}

describe("the sidecar's socket, as the node speaks it", () => {
  test("a hello of an API this node doesn't speak is refused, by its number", async () => {
    const f = fake({ hello: { t: "hello", api: 2, did: "x", key_type: "ed25519", version: "9" } });
    await expect(SidecarClient.connect(f.path)).rejects.toThrow(/speaks API 2, this node 1/);
  });

  test("a message cut across writes, and two in one write, are each read whole", async () => {
    const f = fake({ hello: null });
    const connecting = SidecarClient.connect(f.path);
    await Bun.sleep(30);
    const hello = frame({ t: "hello", api: 1, did: "did:key:z6Mkexample", key_type: "ed25519", version: "0.2.0", address: "qamp://x" });
    f.raw(hello.subarray(0, 3));
    await Bun.sleep(10);
    f.raw(hello.subarray(3, 9));
    await Bun.sleep(10);
    f.raw(hello.subarray(9));
    const client = await connecting;
    expect(client.hello).toEqual({ did: "did:key:z6Mkexample", keyType: "ed25519", address: "qamp://x", version: "0.2.0" });
    const pings = [client.ping(), client.ping()];
    const [a, b] = await Promise.all([f.next((m) => m.t === "ping" && m.id === 1), f.next((m) => m.t === "ping" && m.id === 2)]);
    const both = new Uint8Array([...frame({ t: "pong", id: a.id as number }), ...frame({ t: "pong", id: b.id as number })]);
    f.raw(both);
    await Promise.all(pings);
    client.close();
  });

  test("a length past the socket's limit is a broken socket: nothing is buffered, and what was under way ends", async () => {
    const f = fake();
    const client = await SidecarClient.connect(f.path);
    const ping = client.ping();
    const head = new Uint8Array(4);
    new DataView(head.buffer).setUint32(0, 66 * 1024 * 1024);
    f.raw(head);
    await expect(ping).rejects.toThrow(/past/);
    expect(client.open).toBe(false);
  });

  test("a call's chunks come in order and its result ends it; a peer's error is its code", async () => {
    const f = fake({
      onMessage: (m, f) => {
        if (m.t !== "call") return;
        if (m.tool === "ok/tool") {
          f.send({ t: "chunk", id: m.id as number, text: "one" });
          f.send({ t: "chunk", id: m.id as number, value: { progress: 1 } });
          f.send({ t: "result", id: m.id as number, result: { done: true } });
        } else f.send({ t: "error", id: m.id as number, kind: "remote", code: 8, message: "the tool failed", retryable: false });
      },
    });
    const client = await SidecarClient.connect(f.path);
    const call = client.call("qamp://did:key:z6Mkexample@127.0.0.1:1", "ok/tool", { a: 1 }, { deadlineMs: 500 });
    const chunks: unknown[] = [];
    for await (const chunk of call.chunks) chunks.push(chunk);
    expect(chunks).toEqual([{ text: "one" }, { value: { progress: 1 } }]);
    expect(await call.result).toEqual({ done: true });
    expect(f.got.find((m) => m.t === "call")).toMatchObject({ tool: "ok/tool", args: { a: 1 }, deadline_ms: 500 });
    const failing = client.call("qamp://did:key:z6Mkexample@127.0.0.1:1", "bad/tool", null);
    const error = (await failing.result.catch((e) => e)) as SidecarError;
    expect([error.kind, error.code, error.message]).toEqual(["remote", 8, "the tool failed"]);
    client.close();
  });

  test("the sidecar's pause holds a call's input until it resumes, and the input's end follows it in order", async () => {
    const f = fake();
    const client = await SidecarClient.connect(f.path);
    const call = client.call("qamp://p", "in/tool", null, { input: true });
    const id = call.id;
    call.send({ text: "first" });
    await f.next((m) => m.t === "input" && m.text === "first");
    f.send({ t: "pause", id });
    await Bun.sleep(20);
    call.send({ text: "second" });
    call.end();
    await Bun.sleep(40);
    expect(f.got.filter((m) => m.t === "input" || m.t === "input_end").map((m) => m.text ?? m.t)).toEqual(["first"]);
    f.send({ t: "resume", id });
    await f.next((m) => m.t === "input_end");
    expect(f.got.filter((m) => m.t === "input" || m.t === "input_end").map((m) => m.text ?? m.t)).toEqual(["first", "second", "input_end"]);
    // A cancel is never held.
    f.send({ t: "pause", id });
    await Bun.sleep(20);
    call.cancel();
    await f.next((m) => m.t === "cancel");
    client.close();
  });

  test("a served task's output waits while the sidecar holds it, and its complete comes after it", async () => {
    let inv!: Invocation;
    const f = fake();
    const client = await SidecarClient.connect(f.path);
    const serving = client.serve([{ name: "my/tool" }], [], (i) => (inv = i));
    const serve = await f.next((m) => m.t === "serve");
    f.send({ t: "ok", id: serve.id as number });
    await serving;
    f.send({ t: "invoke", task: 7, tool: "my/tool", args: { x: 1 }, caller: "did:key:z6Mkcaller", authorization: { kind: "public" }, chain: [], input: false });
    await Bun.sleep(30);
    expect([inv.task, inv.tool, inv.args, inv.caller]).toEqual([7, "my/tool", { x: 1 }, "did:key:z6Mkcaller"]);
    inv.emit({ text: "a" });
    await f.next((m) => m.t === "emit" && m.text === "a");
    f.send({ t: "pause", task: 7 });
    await Bun.sleep(20);
    inv.emit({ text: "b" });
    inv.complete({ fine: true });
    await Bun.sleep(40);
    expect(f.got.filter((m) => m.task === 7).map((m) => m.text ?? m.t)).toEqual(["a"]);
    f.send({ t: "resume", task: 7 });
    await f.next((m) => m.t === "complete");
    expect(f.got.filter((m) => m.task === 7).map((m) => m.text ?? m.t)).toEqual(["a", "b", "complete"]);
    client.close();
  });

  test("a task the caller left is told: its signal aborts, and what it sends after is dropped", async () => {
    let inv!: Invocation;
    const f = fake();
    const client = await SidecarClient.connect(f.path);
    const serving = client.serve([{ name: "slow/tool" }], ["slow/tool"], (i) => (inv = i));
    f.send({ t: "ok", id: (await f.next((m) => m.t === "serve")).id as number });
    await serving;
    f.send({ t: "invoke", task: 9, tool: "slow/tool", args: null, caller: "did:key:z6Mkcaller", authorization: { kind: "public" }, chain: [], input: true });
    await Bun.sleep(30);
    f.send({ t: "input", task: 9, text: "in" });
    f.send({ t: "cancelled", task: 9, reason: "cancelled" });
    await Bun.sleep(30);
    expect(inv.signal.aborted).toBe(true);
    const inputs: unknown[] = [];
    for await (const chunk of inv.inputs) inputs.push(chunk);
    expect(inputs).toEqual([{ text: "in" }]);
    inv.complete("too late");
    await Bun.sleep(30);
    expect(f.got.some((m) => m.t === "complete")).toBe(false);
    client.close();
  });

  test("this node holds back a call whose unread chunks pass its budget, and lets it go on once they are read", async () => {
    const f = fake();
    const client = await SidecarClient.connect(f.path);
    const call = client.call("qamp://p", "big/tool", null);
    const big = "x".repeat(256 * 1024);
    for (let i = 0; i < 6; i++) f.send({ t: "chunk", id: call.id, text: big });
    const paused = await f.next((m) => m.t === "pause");
    expect(paused).toEqual({ t: "pause", id: call.id });
    let read = 0;
    for await (const chunk of call.chunks) {
      read += "text" in chunk ? chunk.text.length : 0;
      if (read >= 6 * big.length) break;
    }
    expect(await f.next((m) => m.t === "resume")).toEqual({ t: "resume", id: call.id });
    client.close();
  });

  test("structured chunks count at their size: past the budget, the host asks the sidecar to hold them too (L2)", async () => {
    const f = fake();
    const client = await SidecarClient.connect(f.path);
    const call = client.call("qamp://p", "big/tool", null);
    const big = "x".repeat(256 * 1024);
    // The same bytes as the text chunks above, sent as structured values: before the fix each counted 64 bytes.
    for (let i = 0; i < 6; i++) f.send({ t: "chunk", id: call.id, value: { line: big } });
    expect(await f.next((m) => m.t === "pause")).toEqual({ t: "pause", id: call.id });
    call.cancel();
    client.close();
  });

  test("a call that takes no chunks holds none: what its peer streams to it is dropped as it comes (L2)", async () => {
    const f = fake();
    const client = await SidecarClient.connect(f.path);
    const call = client.call("qamp://p", "invincible/link/sync", null, { discard: true });
    const big = "x".repeat(256 * 1024);
    for (let i = 0; i < 16; i++) f.send({ t: "chunk", id: call.id, value: { line: big } });
    f.send({ t: "result", id: call.id, result: { events: [], more: false } });
    expect(await call.result).toEqual({ events: [], more: false });
    const read: unknown[] = [];
    for await (const chunk of call.chunks) read.push(chunk);
    expect(read).toEqual([]);
    expect(f.got.some((m) => m.t === "pause")).toBe(false);
    client.close();
  });

  test("a peer that sends past what a call may hold, whatever it was asked, has that call cancelled (L2)", async () => {
    // A stand-in that ignores the pause it is asked for.
    const f = fake();
    const client = await SidecarClient.connect(f.path);
    const call = client.call("qamp://p", "big/tool", null);
    const big = "x".repeat(1024 * 1024);
    for (let i = 0; i < 40; i++) f.send({ t: "chunk", id: call.id, value: { line: big } });
    const error = await call.result.catch((e) => e as SidecarError);
    expect(error).toBeInstanceOf(SidecarError);
    expect((error as SidecarError).message).toContain("sent past what this node holds for a call");
    expect(await f.next((m) => m.t === "cancel")).toEqual({ t: "cancel", id: call.id });
    client.close();
  });

  test("a socket that closes ends its calls as unavailable and aborts its tasks", async () => {
    let inv!: Invocation;
    const f = fake();
    const client = await SidecarClient.connect(f.path);
    const serving = client.serve([{ name: "t/x" }], [], (i) => (inv = i));
    f.send({ t: "ok", id: (await f.next((m) => m.t === "serve")).id as number });
    await serving;
    f.send({ t: "invoke", task: 3, tool: "t/x", args: null, caller: "did:key:z6Mkcaller", authorization: { kind: "public" }, chain: [], input: false });
    await Bun.sleep(30);
    const call = client.call("qamp://p", "y/z", null);
    let closedWith: Error | null = null;
    client.onClose((why) => (closedWith = why));
    f.stop();
    fakes.length = 0;
    const error = (await call.result.catch((e) => e)) as SidecarError;
    expect(error.kind).toBe("unavailable");
    expect(inv.signal.aborted).toBe(true);
    expect(closedWith).toBeInstanceOf(SidecarError);
  });
});
