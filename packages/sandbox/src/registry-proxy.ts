import { connect as tcp, createServer, type Socket } from "node:net";

/*
 * A fill's one way out (install-cache.ts; the twelfth fabric re-review's R12-2): the node's proxy, on a unix socket of the
 * fill's own that is mounted into its filler, which has no network of its own. It opens a tunnel to the default registry,
 * registry.npmjs.org:443, for each `CONNECT registry.npmjs.org:443` it is asked, and refuses anything else: another
 * host or port, a plain request, or one it can't read. What passes through it is TLS between bun and the registry, which
 * bun checks itself. So nothing a tree names reaches anything but the registry: not the host, the bridge's containers,
 * the tailnet, the LAN or a metadata address.
 */

/** The one place a fill reaches. */
export const REGISTRY = { host: "registry.npmjs.org", port: 443 } as const;
/** What bun asks of its proxy for the registry, and nothing else passes. */
const ASKED = /^CONNECT registry\.npmjs\.org:443 HTTP\/1\.[01]$/;
/** The most of a request read before it is refused, and the most tunnels open at once. */
const MOST_HEAD = 8192;
const MOST_OPEN = 256;
/** How long a tunnel may say nothing before it is closed. */
const IDLE_MS = 120_000;

export interface ProxyCounts {
  /** The tunnels it opened to the registry. */
  tunnels: number;
  /** How many it refused, and the first of them, as they were asked. */
  refused: number;
  first: string[];
}

export interface RegistryProxy {
  /** Its socket closed and every tunnel ended: what it did. */
  close(): ProxyCounts;
}

/** A proxy on the unix socket `path`; `connect` opens the tunnel's far end (the registry's, but in a test). */
export async function registryProxy(path: string, opts: { connect?: (host: string, port: number) => Socket; idleMs?: number } = {}): Promise<RegistryProxy> {
  const counts: ProxyCounts = { tunnels: 0, refused: 0, first: [] };
  const open = new Set<Socket>();
  const kept = (socket: Socket) => {
    open.add(socket);
    socket.once("close", () => open.delete(socket));
    socket.setTimeout(opts.idleMs ?? IDLE_MS, () => socket.destroy());
    return socket;
  };
  const refuse = (client: Socket, asked: string) => {
    counts.refused++;
    if (counts.first.length < 5) counts.first.push(asked.slice(0, 200));
    client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  };
  const server = createServer((client) => {
    kept(client).on("error", () => client.destroy());
    if (open.size > MOST_OPEN) return refuse(client, "a tunnel past the most open at once");
    let head = Buffer.alloc(0);
    const read = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) {
        if (head.length > MOST_HEAD) {
          client.pause();
          client.off("data", read);
          refuse(client, "a request too long to read");
        }
        return;
      }
      client.pause();
      client.off("data", read);
      const line = head.subarray(0, head.indexOf("\r\n")).toString("latin1");
      if (!ASKED.test(line)) return refuse(client, line);
      const far = kept((opts.connect ?? ((host, port) => tcp({ host, port })))(REGISTRY.host, REGISTRY.port));
      far.on("error", () => {
        far.destroy();
        client.destroy();
      });
      far.once("close", () => client.destroy());
      client.once("close", () => far.destroy());
      far.once("connect", () => {
        counts.tunnels++;
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const rest = head.subarray(end + 4);
        if (rest.length) far.write(rest);
        client.pipe(far);
        far.pipe(client);
      });
    };
    client.on("data", read);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
  return {
    close() {
      server.close();
      for (const socket of open) socket.destroy();
      return counts;
    },
  };
}
