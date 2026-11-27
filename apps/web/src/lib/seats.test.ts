import { describe, expect, test } from "bun:test";
import { cardWords, quickAgent, quickLabel, RENEW_DAYS, SEAT_KIND_WORDS, seatStateWords, servesChoiceWords, servesWords, signInAction } from "./seats.ts";

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

  test("a time no date can be (a reset its VM said lies past every date) is said as later, never thrown", () => {
    expect(seatStateWords({ is: "resting", until: Number.MAX_SAFE_INTEGER, window: "five_hour" }, null, NOW)).toEqual({ word: "Spent: back later", tone: "quiet" });
    expect(seatStateWords({ is: "ready", renewBy: Number.MAX_SAFE_INTEGER }, "max", NOW).word).toBe("Signed in · Max");
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

describe("whom a seat serves, in words", () => {
  const ADA = { id: "ada", name: "Ada", createdAt: 1_000 };
  const BO = { id: "bo", name: "Bo", createdAt: 2_000 };
  const CY = { id: "cy", name: "Cy", createdAt: 3_000 };
  const serving = (...agents: { id: string; createdAt: number }[]) => ({ serves: agents.map((agent) => ({ id: agent.id, made: agent.createdAt })) });

  test("one agent; a share, its trust domain said every time; or none: none chosen yet, or none now", () => {
    expect(servesWords(serving(), [ADA, BO])).toEqual({ word: "Serves no agent yet", shared: false });
    expect(servesWords(serving(ADA), [ADA, BO])).toEqual({ word: "Serves Ada", shared: false });
    expect(servesWords(serving(ADA, BO), [ADA, BO])).toEqual({ word: "Shared by Ada and Bo: one trust domain", shared: true });
    expect(servesWords(serving(ADA, BO, CY), [CY, BO, ADA]).word).toBe("Shared by Ada, Bo and Cy: one trust domain");
    // Ada removed: she isn't on the roster, and a later agent given her handle was made later. Neither is served.
    expect(servesWords(serving(ADA), [BO])).toEqual({ word: "Serves no agent now", shared: false });
    expect(servesWords(serving(ADA), [{ ...ADA, createdAt: 9_000 }])).toEqual({ word: "Serves no agent now", shared: false });
    expect(servesWords(serving(ADA, BO), [BO]).word).toBe("Serves Bo");
    // Without its node's roster (a seat whose home is on another node): as you chose them there, by handle.
    expect(servesWords(serving(ADA), null)).toEqual({ word: "Serves ada", shared: false });
    expect(servesWords(serving(ADA, BO), null)).toEqual({ word: "Shared by ada and bo: one trust domain", shared: true });
    expect(servesWords(serving(), null).word).toBe("Serves no agent yet");
  });

  test("what a choice means, said where you make it: a share is one trust domain, and so is a move; the same agents, fewer, or none says nothing new", () => {
    expect(servesChoiceWords("Claude 1", ["Ada"], ["Ada", "Bo"])).toBe("Ada and Bo will share Claude 1's home, and what any of their runs leave there (its tool's settings, hooks and notes) the next one runs with: they are one trust domain.");
    expect(servesChoiceWords("Claude 1", [], ["Ada", "Bo", "Cy"])).toContain("Ada, Bo and Cy will share Claude 1's home");
    expect(servesChoiceWords("Claude 1", ["Ada"], ["Bo"])).toBe("Bo will run with what Ada's runs left in Claude 1's home (its tool's settings, hooks and notes): Ada and Bo are one trust domain.");
    expect(servesChoiceWords("Claude 1", ["Ada", "Cy"], ["Bo"])).toBe("Bo will run with what the runs of Ada and Cy left in Claude 1's home (its tool's settings, hooks and notes): Ada, Cy and Bo are one trust domain.");
    expect(servesChoiceWords("Claude 1", [], ["Ada"])).toBeNull();
    expect(servesChoiceWords("Claude 1", ["Ada"], ["Ada"])).toBeNull();
    expect(servesChoiceWords("Claude 1", ["Ada", "Bo"], ["Ada"])).toBeNull();
    expect(servesChoiceWords("Claude 1", ["Ada"], [])).toBeNull();
  });

  test("a one-tap seat serves the first of your agents on its tool that no seat of its kind serves yet, else the first on it, else none", () => {
    const agents = [{ ...BO, harness: "codex" }, { ...CY, harness: "claude" }, { ...ADA, harness: "claude" }];
    expect(quickAgent("claude-subscription", [], agents)?.id).toBe("ada");
    expect(quickAgent("claude-subscription", [{ kind: "claude-subscription", ...serving(ADA) }], agents)?.id).toBe("cy");
    expect(quickAgent("claude-subscription", [{ kind: "claude-subscription", ...serving(ADA, CY) }], agents)?.id).toBe("ada");
    expect(quickAgent("claude-subscription", [{ kind: "chatgpt-codex", ...serving(ADA) }], agents)?.id).toBe("ada");
    expect(quickAgent("chatgpt-codex", [], agents)?.id).toBe("bo");
    expect(quickAgent("chatgpt-codex", [], agents.filter((agent) => agent.harness !== "codex"))).toBeNull();
  });
});
