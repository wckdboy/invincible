import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FORWARD_PY, type RegistryProxy, registryProxy } from "../src/index.ts";

/*
 * A fill's one way out (registry-proxy.ts; the twelfth fabric re-review's R12-2): the node's proxy, on a unix socket,
 * opens a tunnel to the registry for `CONNECT registry.npmjs.org:443` alone. Here its far end is a stand-in of this
 * test's on the loopback, which counts what reaches it: nothing but a tunnel the proxy opened. And the filler's forwarder
 * (FORWARD_PY), as the filler runs it, takes what reaches its port to the proxy's socket.
 */

const undo: (() => void)[] = [];
afterEach(() => {
  for (const step of undo.splice(0).reverse()) step();
});

/** A stand-in for the registry, on the loopback: it echoes, and counts what reached it. */
async function farEnd(): Promise<{ port: number; reached: () => number }> {
  let reached = 0;
  const server: Server = createServer((socket) => {
    reached++;
    socket.on("data", (data) => socket.write(data));
    socket.on("error", () => socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  undo.push(() => server.close());
  return { port: (server.address() as { port: number }).port, reached: () => reached };
}

async function proxied(): Promise<{ socket: string; proxy: RegistryProxy; far: Awaited<ReturnType<typeof farEnd>>; asked: string[] }> {
  const far = await farEnd();
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "registry-proxy-")));
  undo.push(() => rmSync(dir, { recursive: true, force: true }));
  const socket = join(dir, "registry.sock");
  const asked: string[] = [];
  const proxy = await registryProxy(socket, {
    connect: (host, port) => {
      asked.push(`${host}:${port}`);
      return connect({ host: "127.0.0.1", port: far.port });
    },
  });
  undo.push(() => proxy.close());
  return { socket, proxy, far, asked };
}

/** What a client of `path` (a unix socket, or a TCP port on the loopback) reads back for `request`, then for `then` once the tunnel is open. */
function ask(to: string | number, request: string, then?: string): Promise<string> {
  return new Promise((resolve) => {
    const client: Socket = typeof to === "string" ? connect(to) : connect({ host: "127.0.0.1", port: to });
    let got = "";
    let sent = false;
    const timer = setTimeout(() => client.destroy(), 5_000);
    client.on("connect", () => client.write(request));
    client.on("data", (data) => {
      got += data.toString("latin1");
      if (then !== undefined && !sent && got.includes("\r\n\r\n") && got.startsWith("HTTP/1.1 200")) {
        sent = true;
        client.write(then);
      }
      if (then !== undefined && sent && got.endsWith(then)) client.end();
    });
    client.on("close", () => {
      clearTimeout(timer);
      resolve(got);
    });
    client.on("error", () => client.destroy());
  });
}

describe("the node's proxy for a fill", () => {
  test("opens a tunnel to the registry for a CONNECT to it, and passes what is sent both ways", async () => {
    const { socket, proxy, far, asked } = await proxied();
    const got = await ask(socket, "CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n", "a TLS hello, as bun would send it");
    expect(got).toBe("HTTP/1.1 200 Connection Established\r\n\r\na TLS hello, as bun would send it");
    expect(asked).toEqual(["registry.npmjs.org:443"]);
    expect(far.reached()).toBe(1);
    expect(proxy.close()).toEqual({ tunnels: 1, refused: 0, first: [] });
  });

  test("refuses everything else, and opens nothing: another host or port, a plain request, a request too long to read", async () => {
    const { socket, proxy, far, asked } = await proxied();
    const refused = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
    const requests = [
      "CONNECT 192.0.2.7:47124 HTTP/1.1\r\nHost: 192.0.2.7:47124\r\n\r\n",
      "CONNECT registry.npmjs.org:80 HTTP/1.1\r\n\r\n",
      "CONNECT registry.npmjs.org.example.test:443 HTTP/1.1\r\n\r\n",
      "CONNECT REGISTRY.NPMJS.ORG:443 HTTP/1.1\r\n\r\n",
      "CONNECT registry.npmjs.org:443 HTTP/1.1 \r\n\r\n",
      "GET http://192.0.2.7:47124/evil.tgz HTTP/1.1\r\nHost: 192.0.2.7:47124\r\n\r\n",
      "GET https://registry.npmjs.org/is-odd HTTP/1.1\r\n\r\n",
      `CONNECT registry.npmjs.org:443 HTTP/1.1\r\nX-Long: ${"a".repeat(9000)}`,
    ];
    for (const request of requests) expect([request.slice(0, 60), await ask(socket, request)]).toEqual([request.slice(0, 60), refused]);
    expect(asked).toEqual([]);
    expect(far.reached()).toBe(0);
    const counts = proxy.close();
    expect(counts.tunnels).toBe(0);
    expect(counts.refused).toBe(requests.length);
    expect(counts.first[0]).toBe("CONNECT 192.0.2.7:47124 HTTP/1.1");
    expect(counts.first).toHaveLength(5);
  });

  test("ends every tunnel still open as it closes", async () => {
    const { socket, proxy } = await proxied();
    const client = connect(socket);
    const closed = new Promise<void>((resolve) => client.on("close", () => resolve()));
    client.on("error", () => client.destroy());
    await new Promise<void>((resolve) => {
      client.on("data", () => resolve());
      client.write("CONNECT registry.npmjs.org:443 HTTP/1.1\r\n\r\n");
    });
    expect(proxy.close().tunnels).toBe(1);
    await closed;
  });
});

describe("the filler's forwarder (FORWARD_PY)", () => {
  test("takes what reaches its port on the loopback to the node's proxy, which decides", async () => {
    const { socket, proxy, far } = await proxied();
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "registry-forward-")));
    undo.push(() => rmSync(dir, { recursive: true, force: true }));
    // (A free port of the loopback's, as the filler's own container has all of them.)
    const free = createServer();
    await new Promise<void>((resolve) => free.listen(0, "127.0.0.1", () => resolve()));
    const port = (free.address() as { port: number }).port;
    await new Promise<void>((resolve) => free.close(() => resolve()));
    const ready = join(dir, "forwarding");
    const forwarder = spawn("python3", ["-I", "-c", FORWARD_PY, socket, String(port), ready], { stdio: "ignore" });
    undo.push(() => forwarder.kill("SIGKILL"));
    for (let i = 0; i < 200 && !existsSync(ready); i++) await Bun.sleep(25);
    expect(existsSync(ready)).toBe(true);
    expect(await ask(port, "CONNECT registry.npmjs.org:443 HTTP/1.1\r\n\r\n", "through")).toBe("HTTP/1.1 200 Connection Established\r\n\r\nthrough");
    expect(await ask(port, "CONNECT 192.0.2.7:443 HTTP/1.1\r\n\r\n")).toStartWith("HTTP/1.1 403 Forbidden");
    expect(far.reached()).toBe(1);
    expect(proxy.close()).toMatchObject({ tunnels: 1, refused: 1 });
  });
});
