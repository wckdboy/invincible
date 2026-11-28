import { SEAT_HARNESS, seatServes, servedBy } from "@invincible/core/seat-agents";
import type { SeatKind, SeatSignInCard, SeatState, SeatUse, SeatView } from "@invincible/core/seats";
import { tokensLabel } from "@invincible/core/spend";
import { windowName } from "@invincible/core/team-record";

/*
 * Seats, in words (pure: no DOM): an account you hold with a vendor, that serves the agents you chose (core's seats.ts).
 * What each kind is called, where a seat stands, whom it serves (and what a share means, said wherever you choose one),
 * its meter (each window, and its use lately), what a sign-in's card asks of you, and when to sign one in again. The views and `inv` say these. (The iPhone and
 * Android apps show no seats yet: when they do, they port these words, held to the vectors.)
 */

/** What each kind of seat is, and how it is signed in. */
export const SEAT_KIND_WORDS: Readonly<Record<SeatKind, { name: string; how: string }>> = {
  "claude-subscription": { name: "Claude plan", how: "Pro, Max or Ultra, signed in with Claude Code" },
  "chatgpt-codex": { name: "ChatGPT plan", how: "signed in with Codex" },
  "chatgpt-siwc": { name: "ChatGPT plan", how: "Sign in with ChatGPT" },
  "mistral-vibe": { name: "Mistral plan", how: "its key from Mistral's console" },
  "google-antigravity": { name: "Gemini plan", how: "Google AI Pro or Ultra, signed in with Antigravity" },
  plan: { name: "Coding plan", how: "its key, in the vault" },
  api: { name: "API key", how: "in the vault" },
};

/** A seat of a kind this version doesn't know (core's UnknownSeat), a later release's: shown, and used for nothing here. */
export const UNKNOWN_KIND_WORDS = { name: "A kind this version doesn't know", how: "update this node to see how it stands" } as const;

/** The kinds added in one tap, each signed in at once. */
export const QUICK_ADDS: readonly { kind: SeatKind; button: string; name: string }[] = [
  { kind: "claude-subscription", button: "Add a Claude plan", name: "Claude" },
  { kind: "chatgpt-codex", button: "Add a ChatGPT plan", name: "ChatGPT" },
  { kind: "google-antigravity", button: "Add a Gemini plan", name: "Gemini" },
];

/** The kinds a vendor's tool signs in in a seat's VM, with a card (the rest are keys, or the node's own sign-in). */
const SIGNED_IN_HERE: readonly SeatKind[] = ["claude-subscription", "chatgpt-codex", "google-antigravity"];

/** A one-tap seat's name: its vendor's, numbered after those you have ("Claude 2"), and never one you have already. */
export function quickLabel(kind: SeatKind, seats: readonly Pick<SeatView, "label">[]): string {
  const name = QUICK_ADDS.find((quick) => quick.kind === kind)?.name ?? SEAT_KIND_WORDS[kind].name;
  const taken = new Set(seats.map((seat) => seat.label));
  for (let n = 1; ; n++) if (!taken.has(`${name} ${n}`)) return `${name} ${n}`;
}

/** A sign-in that ends within this many days is said to need signing in again. */
export const RENEW_DAYS = 7;
const DAY = 86_400_000;

/** A time as the seats page says it: HH:MM in UTC, with the day when it isn't today's; one no date can be, "later". */
function when(at: number, now: number): string | null {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return null;
  const clock = `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")} UTC`;
  return new Date(now).toISOString().slice(0, 10) === date.toISOString().slice(0, 10) ? clock : `${date.getUTCDate()} ${date.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })}, ${clock}`;
}

/** A plan's tier as a word ("max" → "Max"). */
const tier = (plan: string): string => plan.charAt(0).toUpperCase() + plan.slice(1);

/** Where a seat stands, in a word or two, and how it reads: at work, waiting on you, resting, or out. */
export function seatStateWords(state: SeatState, plan: string | null, now: number): { word: string; tone: "ok" | "work" | "warn" | "quiet" } {
  switch (state.is) {
    case "ready":
      if (state.renewBy !== null && state.renewBy - now <= RENEW_DAYS * DAY) return { word: `Sign in again before ${when(state.renewBy, now) ?? "it ends"}`, tone: "warn" };
      return { word: plan ? `Signed in · ${tier(plan)}` : "Signed in", tone: "ok" };
    case "signing-in":
      return { word: "Signing in", tone: "work" };
    case "resting":
      {
        const back = when(state.until, now);
        return { word: back ? `Spent: back at ${back}` : "Spent: back later", tone: "quiet" };
      }
    case "signed-out":
      return {
        never: { word: "Not signed in", tone: "warn" as const },
        "signed-out": { word: "Signed out", tone: "warn" as const },
        cancelled: { word: "Sign-in cancelled", tone: "quiet" as const },
        expired: { word: "Sign-in lapsed", tone: "quiet" as const },
        failed: { word: "Sign-in failed", tone: "warn" as const },
        "wrong-account": { word: "Signed in to another account: refused", tone: "warn" as const },
      }[state.why];
  }
}

/** What a seat's button offers: to sign it in, again when it needs to be, and nothing while it is signing in or a key's. */
export function signInAction(seat: Pick<SeatView, "kind" | "state">, now: number): string | null {
  if (!SIGNED_IN_HERE.includes(seat.kind)) return null;
  if (seat.state.is === "signing-in") return null;
  if (seat.state.is === "ready") return seat.state.renewBy !== null && seat.state.renewBy - now <= RENEW_DAYS * DAY ? "Sign in again" : null;
  return seat.state.is === "resting" ? null : "Sign in";
}

/**
 * What a sign-in's card asks of you, in order: its vendor's page, and the code to enter there or to paste back here, of
 * a seat of this kind. `first`: what to know before you begin (the first ChatGPT seat's device codes; an Antigravity
 * seat's risk to your Google account, which Google's terms put on it: core's SEAT_TERMS).
 */
export function cardWords(card: Pick<SeatSignInCard, "kind" | "code" | "firstTime">, kind: SeatKind): { title: string; open: string; steps: string[]; first: string | null } {
  if (card.kind === "device-code") {
    return {
      title: "Sign in on ChatGPT's page",
      open: "Open ChatGPT's page",
      steps: ["Open the page and sign in to the account this seat is for.", `Enter this code there: ${card.code ?? ""}`, "This finishes by itself once you have."],
      first: card.firstTime ? "First, turn on device code sign-in in ChatGPT's settings (Security): this is its first ChatGPT seat." : null,
    };
  }
  if (kind === "google-antigravity") {
    return {
      title: "Sign in on Google's page",
      open: "Open Google's page",
      // (Google's page sends you on to antigravity.google, which shows the code.)
      steps: ["Open the page and sign in to the account this seat is for.", "Paste the code its last page shows you here."],
      first: "Google's Antigravity terms call reaching it through another tool, as Invincible does, a breach that may get your Antigravity and Gemini CLI accounts suspended: you chose this on 27 November 2026, accepting that risk to your Google account.",
    };
  }
  return {
    title: "Sign in on Claude's page",
    open: "Open Claude's page",
    steps: ["Open the page and sign in to the account this seat is for.", "Paste the code it shows you here."],
    first: null,
  };
}

/** Names said as a list: "Ada", "Ada and Bo", "Ada, Bo and Cy". */
export function listWords(names: readonly string[]): string {
  if (names.length < 2) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** An agent as a seat's words name it: its name, or its handle when it has none. */
type Named = { id: string; name?: string; createdAt: number };
const nameOf = (agent: Named): string => agent.name || agent.id;

/**
 * Whom a seat serves, in words. With its node's roster (`roster`: that node's agents, as its team lists them), the
 * agents it names that are on it as themselves (core's servedBy: one you removed, or a later one given its handle, is
 * not served, so a seat that served only such serves "no agent now"); without it (a seat whose home is on another
 * node), as you chose them there, by handle. A share says its trust domain every time.
 */
export function servesWords(seat: Pick<SeatView, "serves">, roster: readonly Named[] | null): { word: string; shared: boolean } {
  const names = roster ? servedBy(seat, roster).map(nameOf) : [...new Set(seat.serves.map((one) => one.id))];
  if (names.length > 1) return { word: `Shared by ${listWords(names)}: one trust domain`, shared: true };
  if (names.length === 1) return { word: `Serves ${names[0]}`, shared: false };
  return { word: seat.serves.length ? "Serves no agent now" : "Serves no agent yet", shared: false };
}

/**
 * What choosing these agents for a seat means, said where you choose them (`before`: the agents it serves now; `after`:
 * those you are choosing). More than one share its home, and what one's runs leave there the next runs with: they are
 * one trust domain. One in place of others runs with what their runs left, so it is one trust domain with them too.
 * Null: nothing new (the same agents, fewer of those it serves, or none).
 */
export function servesChoiceWords(label: string, before: readonly string[], after: readonly string[]): string | null {
  if (after.length > 1) return `${listWords(after)} will share ${label}'s home, and what any of their runs leave there (its tool's settings, hooks and notes) the next one runs with: they are one trust domain.`;
  const [only] = after;
  if (!only || !before.length || before.includes(only)) return null;
  const whose = before.length === 1 ? `${before[0]}'s runs` : `the runs of ${listWords(before)}`;
  return `${only} will run with what ${whose} left in ${label}'s home (its tool's settings, hooks and notes): ${listWords([...before, only])} are one trust domain.`;
}

/**
 * The agent a one-tap seat serves: the first of your agents (by handle) whose tool its plan runs that no seat of its
 * kind serves yet, else the first on that tool; or none, and it serves none until you choose.
 */
export function quickAgent<A extends { id: string; createdAt: number; harness: string }>(kind: SeatKind, seats: readonly Pick<SeatView, "kind" | "serves">[], roster: readonly A[]): A | null {
  const on = roster.filter((agent) => agent.harness === SEAT_HARNESS[kind]).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const free = on.find((agent) => !seats.some((seat) => seat.kind === kind && seatServes(seat, { id: agent.id, made: agent.createdAt })));
  return free ?? on[0] ?? null;
}

/**
 * One of a seat's windows on its meter: how much of it is used and when it resets ("Five hours: 42% used, resets 14:00
 * UTC"); one its tool refused, spent; one its tool warned of, nearly spent; one it said no share of, in use.
 */
export function seatWindowWords(window: SeatView["windows"][number], now: number): string {
  const name = windowName(window.window);
  const used = window.status === "rejected" ? "spent" : window.usedPercent === null ? "in use" : `${Math.round(window.usedPercent)}% used${window.status === "warning" ? ", nearly spent" : ""}`;
  const back = window.resetsAt === null ? null : (when(window.resetsAt, now) ?? "later");
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}: ${used}${back ? `, resets ${back}` : ""}`;
}

/**
 * A seat's meter in words, the PWA's and inv's: each window still open (one past its reset is fresh again), the soonest
 * to reset first (one that said no reset last, then by name), then its use lately.
 */
export function seatMeterWords(seat: Pick<SeatView, "windows">, use: SeatUse | undefined, now: number): string[] {
  const later = (at: number | null) => at ?? Number.MAX_SAFE_INTEGER;
  const open = seat.windows
    .filter((window) => window.resetsAt === null || window.resetsAt > now)
    .sort((a, b) => later(a.resetsAt) - later(b.resetsAt) || a.window.localeCompare(b.window))
    .map((window) => seatWindowWords(window, now));
  const lately = seatUseWords(use);
  return lately ? [...open, lately] : open;
}

/** A seat's use lately, in words: its tasks this week and their tokens, and its runs now. Nothing yet: null. */
export function seatUseWords(use: SeatUse | undefined): string | null {
  if (!use || (!use.tasks && !use.running)) return null;
  return [use.tasks ? `${use.tasks} task${use.tasks === 1 ? "" : "s"} this week` : "", use.tasks ? `${tokensLabel(use.tokens)} tokens` : "", use.running ? `${use.running} running now` : ""].filter(Boolean).join(" · ");
}

/**
 * Where a seat's vendor shows its use itself, where it asks that it be read there: a ChatGPT plan's, in ChatGPT's own
 * settings (OpenAI's word, read 26 November 2026, help.openai.com article 20001542, which names the place and no address).
 */
export const USE_ELSEWHERE: Readonly<Partial<Record<SeatKind, { words: string; url: string }>>> = {
  "chatgpt-codex": { words: "Its use as ChatGPT counts it: Settings → Usage", url: "https://chatgpt.com/" },
  "chatgpt-siwc": { words: "Its use as ChatGPT counts it: Settings → Usage", url: "https://chatgpt.com/" },
};
