import { type NodeIdentity, randomId, SEAT_LIMITS, type SeatFacts, seatRuns, type SeatSignInCard, signInUrlOk } from "@invincible/core";
import { AGENTS, seatSignInBridge } from "@invincible/agents";
import type { LedgerStore, Vault } from "@invincible/ledger";
import type { SandboxHost, SandboxStream } from "@invincible/sandbox";
import { recordSeatStatus, SeatError, seatEmailName, seatSalt } from "./seats.ts";

/*
 * Signing a seat in (I15 step 4; core's seats.ts), on this node, which holds its home: the vendor's own tool signs in, in
 * a VM made for the seat from the pinned image (agents' seat-sign-in.ts is what runs there), and the owner signs in on
 * the vendor's own page. What the tool asks of the owner comes back as a card (startSeatSignIn): its page, and Codex's
 * code to enter there, or a field for the code Claude Code's page shows, which goes to that sign-in's own process once
 * (answer) and nowhere else. Neither the card nor the code is kept or logged: the log says only that a sign-in began and
 * how it ended. Once the tool says it is signed in, the seat's status is asked of it in the same VM, and a sign-in to
 * another account than the seat's, or to another seat's, is refused and signed out again by the tool's own command.
 */

type Host = Pick<SandboxHost, "createSeatVm" | "exec" | "destroy" | "stream">;

interface Attempt {
  id: string;
  seat: SeatFacts;
  vm: string;
  run: string;
  stream: SandboxStream;
  card: SeatSignInCard;
  answered: boolean;
  /** Why it is being ended, once something ends it (cancelled, expired): the outcome the log is told. */
  ending: "cancelled" | "expired" | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** Settled once it has ended and its VM is gone. */
  ended: Promise<void>;
}

export interface SeatSignInDeps {
  store: LedgerStore;
  vault: Vault;
  node: NodeIdentity;
  /** This node's sandbox host (none: it can't make a seat's VM). */
  host: () => Host | null;
  now?: () => number;
  /** How long a tool has to show its card before its sign-in is given up (ms). */
  cardWaitMs?: number;
  /** How long a sign-in waits for you before it lapses (ms; SEAT_LIMITS.attemptMinutes unless a test says otherwise). */
  attemptMs?: number;
}

/** How the tool's own sign-out is asked, for a seat signed in to an account that isn't its own. */
const SIGN_OUT: Record<string, string[]> = { "claude-subscription": ["claude", "auth", "logout"], "chatgpt-codex": ["codex", "logout"] };

export class SeatSignIns {
  private readonly open = new Map<string, Attempt>();
  private readonly now: () => number;
  private readonly attemptMs: number;

  constructor(private readonly deps: SeatSignInDeps) {
    this.now = deps.now ?? Date.now;
    this.attemptMs = deps.attemptMs ?? SEAT_LIMITS.attemptMinutes * 60_000;
  }

  /** The card of a seat's sign-in under way (nil: none). */
  card(seat: string): SeatSignInCard | null {
    const open = this.open.get(seat);
    return open && !open.ending ? open.card : null;
  }

  /** Begin a seat's sign-in, or answer the card of the one under way. */
  async start(seatId: string): Promise<SeatSignInCard> {
    const seat = this.deps.store.seats().find((s) => s.id === seatId);
    if (!seat) throw new SeatError("no such seat", 404);
    if (seat.kind === "mistral-vibe") throw new SeatError("A Mistral plan signs in with a key: add it as a key seat, with the key Mistral's console gives (Code › Vibe CLI)", 400);
    if (seat.kind === "chatgpt-siwc") throw new SeatError("Sign in with ChatGPT signs in on the node itself, not in a VM: it isn't here yet", 400);
    const bridge = seatSignInBridge(seat.kind);
    if (!bridge) throw new SeatError("A key seat has no sign-in: its key is in the vault", 400);
    if (seat.node !== this.deps.node.id) throw new SeatError("This seat's home is on another node: sign it in from there", 409);
    const open = this.open.get(seatId);
    if (open && !open.ending) return open.card;
    if (open) await open.ended;
    const host = this.deps.host();
    if (!host) throw new SeatError("This node can't make a seat's VM: that needs a Linux host with Docker", 424);
    const id = `sa_${randomId(16)}`;
    const run = `seat.${seat.id}`;
    let vm: string;
    try {
      vm = (await host.createSeatVm({ seat: { id: seat.id, kind: seat.kind, runs: seatRuns(seat) }, network: "online", cpus: 1, memoryGb: 1, ttlMinutes: SEAT_LIMITS.attemptMinutes + 10, run })).id;
    } catch (error) {
      const status = (error as { status?: number }).status;
      throw new SeatError(status === 409 ? "This seat is in use by a run: sign it in once that ends" : `Its VM couldn't be made: ${(error as Error).message}`, status === 409 ? 409 : 503);
    }
    const gone = () => host.destroy(vm, { run }).then(() => undefined, () => undefined);
    let stream: SandboxStream;
    try {
      stream = await host.stream(vm, ["python3", "-I", "-c", bridge], SEAT_LIMITS.attemptMinutes * 60 + 60);
    } catch (error) {
      await gone();
      throw new SeatError(`Its sign-in couldn't start: ${(error as Error).message}`, 503);
    }
    // Its start: the account Claude Code starts on, from the vault (never an argument, which a process list shows).
    const email = seat.kind === "claude-subscription" && this.deps.vault.has(seatEmailName(seat.id)) ? this.deps.vault.reveal(seatEmailName(seat.id)) : null;
    stream.write(`${JSON.stringify(email ? { email } : {})}\n`);
    const lines = stream.lines[Symbol.asyncIterator]();
    const shown = await this.firstCard(lines, stream);
    if (!shown.ok) {
      stream.kill();
      await gone();
      throw new SeatError(shown.why, 502);
    }
    if (!signInUrlOk(seat.kind, shown.url)) {
      stream.kill();
      await gone();
      throw new SeatError("Its sign-in showed an address that isn't its vendor's own, so nothing of it is shown", 502);
    }
    const until = this.now() + this.attemptMs;
    const firstTime = seat.kind === "chatgpt-codex" && !this.deps.store.seats().some((other) => other.kind === "chatgpt-codex" && other.account);
    const card: SeatSignInCard = {
      attempt: id,
      seat: seat.id,
      kind: seat.kind === "chatgpt-codex" ? "device-code" : "paste-code",
      url: shown.url,
      ...(shown.code ? { code: shown.code } : {}),
      until,
      ...(firstTime ? { firstTime: true } : {}),
    };
    this.deps.store.emit(this.deps.node, "seat.signin", { id: seat.id, attempt: id, phase: "started" });
    let settle!: () => void;
    const attempt: Attempt = { id, seat, vm, run, stream, card, answered: false, ending: null, timer: null, ended: new Promise<void>((resolve) => (settle = resolve)) };
    attempt.timer = setTimeout(() => void this.end(attempt, "expired"), this.attemptMs);
    this.open.set(seat.id, attempt);
    void this.follow(attempt, lines, host).finally(() => {
      if (attempt.timer) clearTimeout(attempt.timer);
      if (this.open.get(seat.id) === attempt) this.open.delete(seat.id);
      settle();
    });
    return card;
  }

  /** The code its vendor's page showed you, to that sign-in's own process: once, and only a sign-in that asks for one. */
  answer(seatId: string, attemptId: string, code: string): void {
    const attempt = this.open.get(seatId);
    if (!attempt || attempt.id !== attemptId || attempt.ending) throw new SeatError("That sign-in has ended, or another began: start it again", 404);
    if (attempt.card.kind !== "paste-code") throw new SeatError("This sign-in takes no code here: its page finishes it", 400);
    if (attempt.answered) throw new SeatError("Its code was given already: a code reaches its sign-in once", 409);
    attempt.answered = true;
    attempt.stream.write(`${JSON.stringify({ code })}\n`);
  }

  /** End a seat's sign-in under way: its tool is told to cancel, and its VM goes. */
  async cancel(seatId: string, attemptId: string): Promise<void> {
    const attempt = this.open.get(seatId);
    if (!attempt || attempt.id !== attemptId) throw new SeatError("That sign-in has ended, or another began", 404);
    await this.end(attempt, "cancelled");
  }

  /** Every sign-in under way ended (the node stopping): each said to have ended so, and each VM gone. */
  async close(): Promise<void> {
    await Promise.all([...this.open.values()].map((attempt) => this.end(attempt, "cancelled")));
  }

  private async end(attempt: Attempt, why: "cancelled" | "expired"): Promise<void> {
    if (!attempt.ending) {
      attempt.ending = why;
      attempt.stream.write(`${JSON.stringify({ cancel: true })}\n`);
      // (Its tool is given a moment to cancel what it began; then it is ended, whatever it is doing.)
      const hard = setTimeout(() => attempt.stream.kill(), 10_000);
      void attempt.ended.finally(() => clearTimeout(hard));
    }
    await attempt.ended;
  }

  /** What the tool showed first: its card, or why it couldn't show one (within cardWaitMs). */
  private async firstCard(lines: AsyncIterator<string>, stream: SandboxStream): Promise<{ ok: true; url: string; code?: string } | { ok: false; why: string }> {
    const deadline = setTimeout(() => stream.kill(), this.deps.cardWaitMs ?? 60_000);
    try {
      for (;;) {
        const next = await lines.next();
        if (next.done) return { ok: false, why: "Its sign-in ended before it showed what it asks of you" };
        const said = parse(next.value);
        if (said?.type === "card" && typeof said.url === "string") return { ok: true, url: said.url, ...(typeof said.code === "string" ? { code: said.code } : {}) };
        if (said?.type === "done") return { ok: false, why: `Its sign-in couldn't start${typeof said.why === "string" && said.why ? `: ${clip(said.why)}` : ""}` };
      }
    } finally {
      clearTimeout(deadline);
    }
  }

  /** The rest of it: how it ends, what the seat's tool then says of it, and its VM gone. */
  private async follow(attempt: Attempt, lines: AsyncIterator<string>, host: Host): Promise<void> {
    let ok = false;
    try {
      for (;;) {
        const next = await lines.next();
        if (next.done) break;
        const said = parse(next.value);
        if (said?.type === "done") {
          ok = said.ok === true;
          break;
        }
      }
      if (ok && !attempt.ending) {
        const seat = this.deps.store.seats().find((s) => s.id === attempt.seat.id) ?? attempt.seat;
        const driver = seat.kind === "claude-subscription" ? AGENTS.claude! : AGENTS.codex!;
        const asked = await host.exec(attempt.vm, ["bash", "-lc", driver.signIn!.seatCheck(seatSalt(this.deps.vault))], 60);
        const stands = recordSeatStatus(this.deps.store, this.deps.node, seat, driver.signIn!.read(asked.stdout), attempt.id);
        // Another account than the seat's: refused, and signed out again by the tool's own command, so its home holds none.
        if (stands === "wrong-account") await host.exec(attempt.vm, SIGN_OUT[seat.kind]!, 60).catch(() => undefined);
        return;
      }
      const outcome = attempt.ending ?? "failed";
      this.deps.store.emit(this.deps.node, "seat.signin", { id: attempt.seat.id, attempt: attempt.id, phase: "ended", outcome });
    } catch {
      try {
        this.deps.store.emit(this.deps.node, "seat.signin", { id: attempt.seat.id, attempt: attempt.id, phase: "ended", outcome: attempt.ending ?? "failed" });
      } catch {
        // (The seat was removed meanwhile: there is nothing to say of it.)
      }
    } finally {
      attempt.stream.kill();
      await host.destroy(attempt.vm, { run: attempt.run }).catch(() => undefined);
    }
  }
}

const parse = (line: string): Record<string, unknown> | null => {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** What a tool said of why it couldn't sign in, short and on one line. */
const clip = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, 200);
