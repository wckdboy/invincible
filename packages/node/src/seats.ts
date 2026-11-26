import { type NodeIdentity, type Prov, randomId, type SeatAddInput, type SeatView, seatView } from "@invincible/core";
import type { LedgerStore, Vault } from "@invincible/ledger";
import { keyUsable, providerRecords } from "@invincible/models";

/*
 * Seats on this node (core's seats.ts): what the seats routes do with the mind. A seat is added, set and removed on your
 * word alone, and this node holds its home: the vendor's tool keeps its sign-in there, and how the seat stands is said
 * in the log by this node alone. The email a subscription seat's sign-in starts with is sealed in the vault under its
 * own name, never in the log, and goes with the seat.
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

/** Add a seat whose home is on this node. A plan or api seat is its provider's key, which must be there to use. */
export function addSeat(store: LedgerStore, vault: Vault, node: NodeIdentity, input: SeatAddInput, via: string | null, now = Date.now()): SeatView {
  if (store.seats().length >= MAX_SEATS) throw new SeatError(`you may keep at most ${MAX_SEATS} seats: remove one first`, 400);
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
  } catch (error) {
    if (input.email) vault.delete(seatEmailName(id));
    throw error;
  }
  return seatOf(store, id, now);
}

/** Remove a seat, and its email with it. */
export function removeSeat(store: LedgerStore, vault: Vault, node: NodeIdentity, id: string, via: string | null): void {
  if (!store.seats().some((seat) => seat.id === id)) throw new SeatError("no such seat", 404);
  store.emit(node, "seat.removed", { id }, yourWord(via));
  if (vault.has(seatEmailName(id))) vault.delete(seatEmailName(id));
}

/** How many runs at once a seat takes, at most: it never takes more than has been shown safe (core's seatRuns). */
export function setSeatPolicy(store: LedgerStore, node: NodeIdentity, id: string, runs: number, via: string | null, now = Date.now()): SeatView {
  seatOf(store, id, now);
  store.emit(node, "seat.policy", { id, runs }, yourWord(via));
  return seatOf(store, id, now);
}
