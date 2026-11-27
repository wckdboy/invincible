import { HOMED_KINDS, type NodeIdentity, seatKindBehind, OWN_SIGN_IN_TALLY, type Prov, randomId, type SeatAddInput, type SeatFacts, seatRuns, SEAT_USE_DAYS, type SeatUse, type SeatView, seatView, type TeamTask } from "@invincible/core";
import type { AgentDriver } from "@invincible/agents";
import type { LedgerStore, Vault } from "@invincible/ledger";
import { keyUsable, providerRecords } from "@invincible/models";
import type { SandboxHost } from "@invincible/sandbox";

/*
 * Seats on this node (core's seats.ts): what the seats routes do with the mind. A seat is added, set and removed on your
 * word alone, and this node holds its home: the vendor's tool keeps its sign-in there, and how the seat stands is said
 * in the log by this node alone. The email a subscription seat's sign-in starts with is sealed in the vault under its
 * own name, never in the log, and goes with the seat. The agents a seat serves are this node's own, each named as the
 * agent this node's team made (its handle and createdAt): only they run on its home.
 */

/** More accounts than anyone holds: a list that long is a mistake, not a fleet. */
export const MAX_SEATS = 32;

/** The vault's name for a seat's email. */
export const seatEmailName = (id: string): string => `seat-email:${id}`;

export class SeatError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** This node's agents, by handle, each as its team made it: null for one it hasn't (or one you removed). */
export type SeatRoster = (id: string) => { id: string; createdAt: number } | null;

/** Each agent named, as this node's team made it: one it hasn't is said, and nothing is chosen. */
function asMade(roster: SeatRoster, agents: readonly string[]): { id: string; made: number }[] {
  return agents.map((id) => {
    const agent = roster(id);
    if (!agent) throw new SeatError(`there is no agent ${id} on this node`, 404);
    return { id: agent.id, made: agent.createdAt };
  });
}

/** Your word, from a terminal or a device of yours (as a rule's is). */
export const yourWord = (via: string | null): Prov => ({ trust: "owner", ...(via ? { via } : {}) });

export function seatViews(store: LedgerStore, now = Date.now()): SeatView[] {
  return store.seats().map((seat) => seatView(seat, now));
}

function seatOf(store: LedgerStore, id: string, now: number): SeatView {
  const found = seatViews(store, now).find((seat) => seat.id === id);
  if (!found) throw new SeatError("no such seat", 404);
  return found;
}

/**
 * Add a seat whose home is on this node. A plan or api seat is its provider's key, which must be there to use. One added
 * for an agent serves it, as this node's team made it; one added without serves none until you choose.
 */
export function addSeat(store: LedgerStore, vault: Vault, node: NodeIdentity, input: SeatAddInput, via: string | null, roster: SeatRoster, now = Date.now()): SeatView {
  // A kind another node of the fleet can't read yet would hold back that node's sync of all this one writes after it:
  // never added until each says it reads it (core's seatKindBehind), and nothing written meanwhile.
  const others = store.devices().filter((device) => device.kind === "node" && device.id !== node.id);
  const behind = seatKindBehind(input.kind, others.map((device) => ({ id: device.id, name: device.name, caps: device.profile?.caps ?? null })));
  if (behind) throw new SeatError(behind, 409);
  if (store.seats().length >= MAX_SEATS) throw new SeatError(`you may keep at most ${MAX_SEATS} seats: remove one first`, 400);
  const serves = input.agent ? asMade(roster, [input.agent]) : [];
  if (input.provider) {
    const provider = providerRecords(store).find((p) => p.id === input.provider);
    if (!provider) throw new SeatError(`there is no provider ${input.provider}: add it first`, 404);
    if (!keyUsable(vault, provider)) throw new SeatError(`${input.provider} has no key of yours to use: add its key first`, 400);
  }
  const id = `st_${randomId(16)}`;
  // (Sealed before the seat is said: a seat is never in the log with an email that isn't in the vault.)
  if (input.email) vault.set(seatEmailName(id), input.email, { label: `The email seat ${input.label} signs in with` });
  try {
    store.emit(node, "seat.added", { id, kind: input.kind, label: input.label, node: node.id, ...(input.provider ? { provider: input.provider } : {}), runs: input.runs ?? 1 }, yourWord(via));
    if (serves.length) store.emit(node, "seat.serves", { id, agents: serves }, yourWord(via));
  } catch (error) {
    if (input.email) vault.delete(seatEmailName(id));
    throw error;
  }
  return seatOf(store, id, now);
}

/**
 * Remove a seat, its email with it, and its home on this node with the sign-in its tool kept there (never while a VM has
 * it: its run ends first). Its home goes first, so a seat is never gone from the log with a sign-in left behind.
 */
export async function removeSeat(store: LedgerStore, vault: Vault, node: NodeIdentity, id: string, via: string | null, host: Pick<SandboxHost, "removeSeatHome"> | null): Promise<void> {
  const seat = store.seats().find((s) => s.id === id);
  if (!seat) throw new SeatError("no such seat", 404);
  if (HOMED_KINDS.includes(seat.kind) && seat.node === node.id && host) {
    try {
      await host.removeSeatHome(id);
    } catch (error) {
      const status = (error as { status?: number }).status;
      throw new SeatError((error as Error).message, status === 409 ? 409 : 503);
    }
  }
  store.emit(node, "seat.removed", { id }, yourWord(via));
  if (vault.has(seatEmailName(id))) vault.delete(seatEmailName(id));
}

/** How many runs at once a seat takes, at most: it never takes more than has been shown safe (core's seatRuns). */
export function setSeatPolicy(store: LedgerStore, node: NodeIdentity, id: string, runs: number, via: string | null, now = Date.now()): SeatView {
  seatOf(store, id, now);
  store.emit(node, "seat.policy", { id, runs }, yourWord(via));
  return seatOf(store, id, now);
}

/**
 * The agents a seat serves, on your word: this node's own, each as its team made it, for a seat whose home is here (only
 * this node's agents run on it). More than one is a share, only when you say so (`shared`): they are one trust domain.
 */
export function setSeatServes(store: LedgerStore, node: NodeIdentity, id: string, agents: readonly string[], shared: boolean, roster: SeatRoster, via: string | null, now = Date.now()): SeatView {
  const seat = seatOf(store, id, now);
  if (!HOMED_KINDS.includes(seat.kind)) throw new SeatError(`${seat.label} has no home of its own: a key reaches the agents you grant it`, 400);
  if (seat.node !== node.id) throw new SeatError(`${seat.label}'s home is on another node: choose the agents it serves there`, 409);
  if (agents.length > 1 && !shared) throw new SeatError("a seat serves one agent: to share it, say so. The agents sharing a seat are one trust domain", 400);
  store.emit(node, "seat.serves", { id, agents: asMade(roster, agents) }, yourWord(via));
  return seatOf(store, id, now);
}

/**
 * Each of these seats' use lately (core's SeatUse), from this node's tasks as they recorded it: those that ended in the
 * last SEAT_USE_DAYS on the seat (their record's plan names it), with the tokens their coding tools spent there on its
 * own sign-in; and its runs now (`running`). Only a seat whose home is on this node has its agents' tasks here.
 */
export function seatUse(seats: readonly Pick<SeatFacts, "id">[], tasks: readonly Pick<TeamTask, "record">[], running: (seat: string) => number, now: number): Record<string, SeatUse> {
  const since = now - SEAT_USE_DAYS * 86_400_000;
  const use: Record<string, SeatUse> = {};
  for (const seat of seats) use[seat.id] = { since, tasks: 0, tokens: 0, running: running(seat.id) };
  for (const { record } of tasks) {
    const on = record?.plan?.seat;
    if (!record || !on || !use[on] || record.endedAt < since) continue;
    use[on].tasks += 1;
    for (const line of record.spent) if (line.model.startsWith(`${OWN_SIGN_IN_TALLY}/`)) use[on].tokens += line.input + line.output;
  }
  return use;
}

/** The vault's name for the fleet's salt for seats' fingerprints: one salt, so one account is one fingerprint whatever its seat. */
export const SEATS_SALT = "seats-salt";

/** The salt seats' fingerprints are made with, made the first time it's needed and sealed in the vault. */
export function seatSalt(vault: Vault): string {
  if (vault.has(SEATS_SALT)) return vault.reveal(SEATS_SALT);
  const salt = randomId(24);
  vault.set(SEATS_SALT, salt, { label: "The salt seats' account fingerprints are made with" });
  return salt;
}

/** What a seat's tool said of its sign-in, as its driver read it: whether, how, its tier, its account's fingerprint, when it ends. */
export type SeatStatus = ReturnType<NonNullable<AgentDriver["signIn"]>["read"]>;

/**
 * A seat's status, asked of its own tool in a VM made for it from the pinned image, its home mounted (and made, the
 * first time), the VM gone once it has answered. Refused like any seat's VM while its home is in use: it waits.
 */
export async function askSeat(host: Pick<SandboxHost, "createSeatVm" | "exec" | "destroy">, seat: SeatFacts, driver: AgentDriver, salt: string): Promise<SeatStatus> {
  if (!driver.signIn) throw new SeatError(`${driver.title} has no sign-in to ask about`, 400);
  const run = `seat.${seat.id}`;
  const vm = await host.createSeatVm({ seat: { id: seat.id, kind: seat.kind, runs: seatRuns(seat) }, network: "online", cpus: 1, memoryGb: 1, ttlMinutes: 15, run });
  try {
    const asked = await host.exec(vm.id, ["bash", "-lc", driver.signIn.seatCheck(salt)], 60);
    return driver.signIn.read(asked.stdout);
  } finally {
    await host.destroy(vm.id, { run });
  }
}

/**
 * What the log is told of what a seat's tool said, by the node that holds its home: only a change (a sign-in, a sign-out,
 * a new tier or end), and never a sign-in to an account other than its own or another seat's. `attempt`: a sign-in's.
 * Answers how its sign-in stands now.
 */
export function recordSeatStatus(store: LedgerStore, node: NodeIdentity, seat: SeatFacts, told: SeatStatus, attempt?: string): "ready" | "signed-out" | "wrong-account" {
  const said = (body: Record<string, unknown>) => store.emit(node, "seat.signin", { id: seat.id, ...(attempt ? { attempt } : {}), phase: "ended", ...body } as never);
  const before = seat.signIn?.phase === "ended" ? seat.signIn : null;
  if (!told.signedIn) {
    if (attempt || before?.outcome === "ready") said({ outcome: "signed-out" });
    return "signed-out";
  }
  const theirs = told.fingerprint ? store.seats().find((other) => other.id !== seat.id && other.account === told.fingerprint) : undefined;
  if ((seat.account && told.fingerprint !== seat.account) || theirs) {
    said({ outcome: "wrong-account" });
    return "wrong-account";
  }
  const same = before?.outcome === "ready" && before.method === (told.method ?? null) && before.plan === (told.plan ?? null) && before.renewBy === (told.renewBy ?? null) && (!told.fingerprint || seat.account === told.fingerprint);
  if (!same || attempt) {
    said({ outcome: "ready", ...(told.method ? { method: told.method } : {}), ...(told.plan ? { plan: told.plan } : {}), ...(told.fingerprint ? { fingerprint: told.fingerprint } : {}), ...(told.renewBy ? { renewBy: told.renewBy } : {}) });
  }
  return "ready";
}
