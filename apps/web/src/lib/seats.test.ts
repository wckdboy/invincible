import { describe, expect, test } from "bun:test";
import { cardWords, quickLabel, RENEW_DAYS, SEAT_KIND_WORDS, seatStateWords, signInAction } from "./seats.ts";

/*
 * Seats, in words (lib/seats.ts): what each kind is, the one-tap names, where a seat stands, what its button offers and
 * what a sign-in's card asks of you.
 */

const NOW = Date.UTC(2026, 10, 26, 12, 0);
const DAY = 86_400_000;

describe("seats in words", () => {
  test("each kind, and the one-tap names: numbered after those you have, never one you have", () => {
    expect(SEAT_KIND_WORDS["claude-subscription"]).toEqual({ name: "Claude plan", how: "Pro, Max or Ultra, signed in with Claude Code" });
    expect(quickLabel("claude-subscription", [])).toBe("Claude 1");
    expect(quickLabel("claude-subscription", [{ label: "Claude 1" }, { label: "Claude 3" }])).toBe("Claude 2");
    expect(quickLabel("chatgpt-codex", [{ label: "Claude 1" }])).toBe("ChatGPT 1");
  });

  test("where a seat stands: signed in with its tier, to sign in again within a week of its end, resting until its reset, and why it's out", () => {
    expect(seatStateWords({ is: "ready", renewBy: NOW + 30 * DAY }, "max", NOW)).toEqual({ word: "Signed in · Max", tone: "ok" });
    expect(seatStateWords({ is: "ready", renewBy: null }, null, NOW)).toEqual({ word: "Signed in", tone: "ok" });
    expect(seatStateWords({ is: "ready", renewBy: NOW + 3 * DAY + 3_600_000 }, "max", NOW)).toEqual({ word: "Sign in again before 29 Nov, 13:00 UTC", tone: "warn" });
    expect(seatStateWords({ is: "resting", until: NOW + 2 * 3_600_000, window: "five_hour" }, "max", NOW)).toEqual({ word: "Spent: back at 14:00 UTC", tone: "quiet" });
    expect(seatStateWords({ is: "signing-in", attempt: "sa_x", since: NOW, until: NOW + 600_000 }, null, NOW)).toEqual({ word: "Signing in", tone: "work" });
    expect(seatStateWords({ is: "signed-out", why: "never" }, null, NOW).word).toBe("Not signed in");
    expect(seatStateWords({ is: "signed-out", why: "wrong-account" }, null, NOW).word).toBe("Signed in to another account: refused");
    expect(seatStateWords({ is: "signed-out", why: "expired" }, null, NOW)).toEqual({ word: "Sign-in lapsed", tone: "quiet" });
  });

  test("its button: Sign in when it's out, Sign in again within a week of its end, nothing while signing in, resting or a key's", () => {
    expect(signInAction({ kind: "claude-subscription", state: { is: "signed-out", why: "never" } }, NOW)).toBe("Sign in");
    expect(signInAction({ kind: "chatgpt-codex", state: { is: "ready", renewBy: NOW + (RENEW_DAYS - 1) * DAY } }, NOW)).toBe("Sign in again");
    expect(signInAction({ kind: "chatgpt-codex", state: { is: "ready", renewBy: NOW + 30 * DAY } }, NOW)).toBeNull();
    expect(signInAction({ kind: "claude-subscription", state: { is: "signing-in", attempt: "sa_x", since: NOW, until: NOW } }, NOW)).toBeNull();
    expect(signInAction({ kind: "api", state: { is: "ready", renewBy: null } }, NOW)).toBeNull();
    expect(signInAction({ kind: "mistral-vibe", state: { is: "signed-out", why: "never" } }, NOW)).toBeNull();
  });

  test("a card: Codex's code to enter on its page (the first ChatGPT seat's says to turn device codes on); Claude's code to paste back", () => {
    expect(cardWords({ kind: "device-code", code: "FAKE-1234", firstTime: true })).toEqual({
      title: "Sign in on ChatGPT's page",
      open: "Open ChatGPT's page",
      steps: ["Open the page and sign in to the account this seat is for.", "Enter this code there: FAKE-1234", "This finishes by itself once you have."],
      first: "First, turn on device code sign-in in ChatGPT's settings (Security): this is its first ChatGPT seat.",
    });
    expect(cardWords({ kind: "device-code", code: "FAKE-1234" }).first).toBeNull();
    expect(cardWords({ kind: "paste-code" })).toEqual({ title: "Sign in on Claude's page", open: "Open Claude's page", steps: ["Open the page and sign in to the account this seat is for.", "Paste the code it shows you here."], first: null });
  });
});
