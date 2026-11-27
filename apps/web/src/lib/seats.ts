import type { SeatKind, SeatSignInCard, SeatState, SeatView } from "@invincible/core/seats";

/*
 * Seats, in words (pure: no DOM): an account you hold with a vendor, that any agent may use (core's seats.ts). What each
 * kind is called, where a seat stands, what a sign-in's card asks of you, and when to sign one in again. The views draw
 * these; the iPhone and Android apps port them, held to the vectors.
 */

/** What each kind of seat is, and how it is signed in. */
export const SEAT_KIND_WORDS: Readonly<Record<SeatKind, { name: string; how: string }>> = {
  "claude-subscription": { name: "Claude plan", how: "Pro, Max or Ultra, signed in with Claude Code" },
  "chatgpt-codex": { name: "ChatGPT plan", how: "signed in with Codex" },
  "chatgpt-siwc": { name: "ChatGPT plan", how: "Sign in with ChatGPT" },
  "mistral-vibe": { name: "Mistral plan", how: "its key from Mistral's console" },
  plan: { name: "Coding plan", how: "its key, in the vault" },
  api: { name: "API key", how: "in the vault" },
};

/** The two kinds added in one tap, each signed in at once. */
export const QUICK_ADDS: readonly { kind: SeatKind; button: string; name: string }[] = [
  { kind: "claude-subscription", button: "Add a Claude plan", name: "Claude" },
  { kind: "chatgpt-codex", button: "Add a ChatGPT plan", name: "ChatGPT" },
];

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
  if (seat.kind !== "claude-subscription" && seat.kind !== "chatgpt-codex") return null;
  if (seat.state.is === "signing-in") return null;
  if (seat.state.is === "ready") return seat.state.renewBy !== null && seat.state.renewBy - now <= RENEW_DAYS * DAY ? "Sign in again" : null;
  return seat.state.is === "resting" ? null : "Sign in";
}

/** What a sign-in's card asks of you, in order: its vendor's page, and the code to enter there or to paste back here. */
export function cardWords(card: Pick<SeatSignInCard, "kind" | "code" | "firstTime">): { title: string; open: string; steps: string[]; first: string | null } {
  if (card.kind === "device-code") {
    return {
      title: "Sign in on ChatGPT's page",
      open: "Open ChatGPT's page",
      steps: ["Open the page and sign in to the account this seat is for.", `Enter this code there: ${card.code ?? ""}`, "This finishes by itself once you have."],
      first: card.firstTime ? "First, turn on device code sign-in in ChatGPT's settings (Security): this is its first ChatGPT seat." : null,
    };
  }
  return {
    title: "Sign in on Claude's page",
    open: "Open Claude's page",
    steps: ["Open the page and sign in to the account this seat is for.", "Paste the code it shows you here."],
    first: null,
  };
}
