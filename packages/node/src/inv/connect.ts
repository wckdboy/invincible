import { existsSync, readFileSync } from "node:fs";
import { loadEnv } from "../env.ts";
import { Home } from "../home.ts";
import { adminClient, type FetchLike, type NodeClient, notTheNode, provenWhoami, signedClient } from "./client.ts";
import { type CliEnv, CliHome, type Pairing } from "./config.ts";
import { CliError, EXIT } from "./exit.ts";

/*
 * Which node inv talks to (docs/CLI.md, "Which one"): the one it is paired with; else, on a node's own machine, that
 * node, through its home and its admin token over loopback, as `invincible` does. `--node local` takes the local one
 * even when paired. Nothing is made here: a home with no admin token is a node that never ran.
 */

export interface Connection {
  client: NodeClient;
  how: "paired" | "local";
  pairing: Pairing | null;
}

export interface ConnectOptions {
  env: CliEnv & { INVINCIBLE_HOME?: string | undefined; INVINCIBLE_PORT?: string | undefined };
  /** `--home`: the local node's home. */
  home?: string | undefined;
  /** `--node local`. */
  local?: boolean;
  fetch?: FetchLike;
}

export async function connect(opts: ConnectOptions): Promise<Connection> {
  const cli = CliHome.resolve(opts.env);
  const pairing = opts.local ? null : cli.pairing();
  if (pairing) {
    const key = await cli.key(pairing);
    const label = pairing.nodeName ?? new URL(pairing.node).host;
    const fetching = opts.fetch ? { fetch: opts.fetch } : {};
    // A pairing made before this device named its node: which node it is, proven, kept from now on (the slice 8 note's
    // item 11). A node from before, which proves nothing, is spoken to as before.
    let pinned = pairing;
    if (pairing.nodeId === undefined) {
      const { proven } = await provenWhoami(pairing.node, key.id, key.sign, undefined, { label, ...fetching });
      const not = notTheNode(label, proven);
      if (not) throw not;
      if (proven.kind === "pin") {
        pinned = { ...pairing, nodeId: proven.node };
        cli.savePairing(pinned);
      }
    }
    return { client: signedClient(pairing.node, key.id, key.sign, { label, ...fetching, ...(pinned.nodeId ? { node: pinned.nodeId } : {}) }), how: "paired", pairing: pinned };
  }
  const home = Home.resolve(opts.home ?? opts.env.INVINCIBLE_HOME);
  if (!home.exists()) {
    throw new CliError(
      opts.local ? `no node at ${home.dir} (--home names another)` : "no node to talk to: pair with one (inv pair <invite>, from invincible invite --client on the node), or run inv on a node's own machine",
      EXIT.unreachable,
    );
  }
  if (!existsSync(home.adminTokenPath)) throw new CliError(`the node at ${home.dir} has never run here (no admin token): start it with invincible serve`, EXIT.unreachable);
  const config = home.readConfig();
  const port = (opts.env.INVINCIBLE_PORT ? loadEnv({ INVINCIBLE_PORT: opts.env.INVINCIBLE_PORT }).INVINCIBLE_PORT : undefined) ?? config.port;
  const token = readFileSync(home.adminTokenPath, "utf8").trim();
  return { client: adminClient(`http://127.0.0.1:${port}`, token, { label: config.name, ...(opts.fetch ? { fetch: opts.fetch } : {}) }), how: "local", pairing: null };
}
