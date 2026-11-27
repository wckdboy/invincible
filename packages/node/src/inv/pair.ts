import { hostname } from "node:os";
import { decodeInvite, DeviceName, type Invite } from "@invincible/core";
import { type FetchLike as LinkFetch, requestPairing, waitForApproval } from "@invincible/link";
import { type FetchLike, notTheNode, provenWhoami } from "./client.ts";
import { type CliEnv, CliHome, keystoreFor, type Pairing } from "./config.ts";
import { CliError, EXIT, usageError } from "./exit.ts";
import type { Whoami } from "./view.ts";

/*
 * inv pair (docs/CLI.md, "Reaching a node"): this machine becomes a client of a node, as a phone or a browser does.
 * Its P-256 key is made and kept first (the login keychain on a Mac, a 0600 file elsewhere), then the invite is proven
 * without sending its secret (core's pairing math), and the code both sides derive is shown. The owner compares it with
 * the node's and approves there. Only an approval the invite's secret authenticates is taken; a refusal forgets the key.
 */

export interface PairIo {
  /** A line for the person pairing (to stderr when the answer is JSON). */
  say(line: string): void;
}

export interface PairOptions {
  env: CliEnv;
  invite?: string | undefined;
  name?: string | undefined;
  forget?: boolean;
  fetch?: FetchLike;
  /** How long to wait for the approval (default: as long as the invite lives, 10 minutes). */
  timeoutMs?: number;
  intervalMs?: number;
}

export interface PairResult {
  node: string | null;
  nodeName: string | null;
  fleet: string | null;
  device: string | null;
  name: string | null;
  paired: boolean;
}

const asResult = (pairing: Pairing | null): PairResult => ({
  node: pairing?.node ?? null,
  nodeName: pairing?.nodeName ?? null,
  fleet: pairing?.fleet ?? null,
  device: pairing?.device ?? null,
  name: pairing?.name ?? null,
  paired: pairing !== null,
});

export async function pairCommand(opts: PairOptions, io: PairIo): Promise<PairResult> {
  const cli = CliHome.resolve(opts.env);
  const kept = cli.pairing();
  if (opts.forget) {
    await cli.forget(kept?.keystore ?? null);
    if (kept) io.say(`Forgotten here: the pairing with ${kept.nodeName ?? kept.node}, and this device's key. The node still lists it until you revoke it there: invincible revoke ${kept.device.slice(0, 12)}`);
    else io.say("Nothing to forget: inv isn't paired here.");
    return asResult(null);
  }
  if (!opts.invite) {
    if (kept) io.say(`Paired with ${kept.nodeName ?? "a node"} at ${kept.node}, as ${kept.name} (${kept.device.slice(0, 12)}…), since ${new Date(kept.pairedAt).toLocaleDateString()}. Its key is in ${kept.keystore === "keychain" ? "the login keychain" : cli.keyPath}.`);
    else io.say("Not paired. On the node: invincible invite --client, then here: inv pair <invite>.");
    return asResult(kept);
  }
  if (kept) throw new CliError(`already paired with ${kept.nodeName ?? kept.node}: inv pair --forget first`);

  let invite: Invite;
  try {
    invite = decodeInvite(opts.invite);
  } catch {
    throw usageError("that isn't an invite: invincible invite --client on the node makes one (gi1.…, or a link with #pair=…)");
  }
  if (invite.k !== "client") throw usageError("that invite is for a node: on the new machine, invincible join <invite>. For inv: invincible invite --client");
  const name = (opts.name ?? `${hostname().split(".")[0] || "this machine"} (inv)`).slice(0, 64);
  if (!DeviceName.safeParse(name).success) throw usageError("a device's name is plain words: no control characters");

  const keystore = keystoreFor(opts.env);
  const key = await cli.newKey(keystore);
  const fetchLike = opts.fetch as LinkFetch | undefined;
  try {
    const join = await requestPairing(opts.invite, { device: key.id, name, kind: "client" }, fetchLike ? { fetch: fetchLike } : {}).catch((error: Error) => {
      if (/fetch failed|Unable to connect|ECONNREFUSED|timed out|The operation was aborted/i.test(error.message)) throw new CliError(`the node isn't answering at ${invite.e} (${error.message})`, EXIT.unreachable);
      throw new CliError(error.message.replace(/^pairing refused: \d+ /, "the node refused the pairing: "), EXIT.refused);
    });
    io.say(`Code: ${join.sas}`);
    io.say("Compare it with the code the node shows for this device. If they are the same, approve it there:");
    io.say(`  invincible approve ${invite.i} ${key.id}`);
    io.say("  (or in the waiting invincible invite, or in Needs you on another device). Waiting…");
    await waitForApproval(join, { timeoutMs: opts.timeoutMs ?? 10 * 60_000, ...(opts.intervalMs ? { intervalMs: opts.intervalMs } : {}), ...(fetchLike ? { fetch: fetchLike } : {}) }).catch((error: Error) => {
      if (/rejected/.test(error.message)) throw new CliError("the pairing was refused on the node", EXIT.refused);
      if (/timed out/.test(error.message)) throw new CliError("no approval came while the invite lived: make a new one (invincible invite --client) and pair again", EXIT.refused);
      if (/could not be authenticated/.test(error.message)) throw new CliError(`the approval didn't prove itself with the invite's secret, so it was not taken: ${error.message}`, EXIT.refused);
      if (/fetch failed|Unable to connect|ECONNREFUSED/i.test(error.message)) throw new CliError(`the node stopped answering at ${invite.e} (${error.message})`, EXIT.unreachable);
      throw new CliError(error.message, EXIT.refused);
    });
    // Approved: what the node says this device is, asked as this device, signed; and which node it is, proven, which
    // this device pins and names in what it signs from then on (the slice 8 note's item 11).
    const { whoami: me, proven } = await provenWhoami<Whoami>(invite.e, key.id, key.sign, undefined, { ...(opts.fetch ? { fetch: opts.fetch } : {}) });
    const not = notTheNode(invite.e, proven);
    if (not) throw not;
    if (me.device !== key.id || me.kind !== "client") throw new CliError("the node answered as if this device were another: not paired", EXIT.refused);
    const pairing: Pairing = { v: 1, node: invite.e, nodeName: me.nodeName ?? null, fleet: invite.f, device: key.id, name, keystore, pairedAt: Date.now(), ...(proven.kind === "pin" ? { nodeId: proven.node } : {}) };
    cli.savePairing(pairing);
    io.say(`Paired with ${me.nodeName}${me.fleetName ? ` in ${me.fleetName}` : ""}. It may: ${me.scopes.join(", ")}. inv shows the board.`);
    return asResult(pairing);
  } catch (error) {
    await cli.forget(keystore);
    throw error;
  }
}
