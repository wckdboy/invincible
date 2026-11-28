import { describe, expect, test } from "bun:test";
import { cardWords, QUICK_ADDS, quickAgent, quickLabel, RENEW_DAYS, SEAT_KIND_WORDS, seatMeterWords, seatStateWords, seatUseWords, seatWindowWords, servesChoiceWords, servesWords, signInAction, USE_ELSEWHERE } from "./seats.ts";
import { SEAT_TERMS } from "@invincible/core/seat-agents";

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

  test("a Gemini plan: Antigravity's, added in one tap like the others, signed in on Google's page with a code pasted back", () => {
    expect(SEAT_KIND_WORDS["google-antigravity"]).toEqual({ name: "Gemini plan", how: "Google AI Pro or Ultra, signed in with Antigravity" });
    expect(QUICK_ADDS.map((quick) => quick.button)).toEqual(["Add a Claude plan", "Add a ChatGPT plan", "Add a Gemini plan"]);
    expect(quickLabel("google-antigravity", [{ label: "Gemini 1" }])).toBe("Gemini 2");
    expect(signInAction({ kind: "google-antigravity", state: { is: "signed-out", why: "never" } }, NOW)).toBe("Sign in");
    // Its card says, before anything, the risk Google's terms put on your account, which you chose to take.
    const card = cardWords({ kind: "paste-code" }, "google-antigravity");
    expect(card).toEqual({
      title: "Sign in on Google's page",
      open: "Open Google's page",
      steps: ["Open the page and sign in to the account this seat is for.", "Paste the code its last page shows you here."],
      first: "Your agent can direct this plan. It works only on your own repositories. A key to your Google Cloud is in its VM, readable by what it runs. Google's Antigravity terms call reaching it through another tool, as Invincible does, a breach that may get your Antigravity and Gemini CLI accounts suspended: you chose this on 27 November 2026, accepting that risk to your Google account. The same terms let Google use what the seat sends (your code, your words and what its tools print) to improve its products and models, and let its staff read it; Antigravity's own settings have an opt-out.",
    });
    // What it rests on: Google's own words, where Google says them, and what that lets its agents do.
    expect(SEAT_TERMS["google-antigravity"]).toEqual({
      says: 'Google: "Using third party software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of this Agreement." "Such actions may be grounds for suspension or termination of your Antigravity and/or Gemini CLI accounts." The owner chose this on 27 November 2026, accepting the risk to their Google account (as T3 Code drives agy). And: "We use Interactions to evaluate, develop, and improve Google and Alphabet research, products, services and machine learning technologies." "Google employees and contractors may access, view, review and use Interactions." "Please don’t submit confidential information or any data you wouldn’t want a reviewer to see."',
      terms: "https://antigravity.google/terms",
      allows: { native: false, tools: "unattended" },
    });
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
    expect(cardWords({ kind: "device-code", code: "FAKE-1234", firstTime: true }, "chatgpt-codex")).toEqual({
      title: "Sign in on ChatGPT's page",
      open: "Open ChatGPT's page",
      steps: ["Open the page and sign in to the account this seat is for.", "Enter this code there: FAKE-1234", "This finishes by itself once you have."],
      first: "First, turn on device code sign-in in ChatGPT's settings (Security): this is its first ChatGPT seat.",
    });
    expect(cardWords({ kind: "device-code", code: "FAKE-1234" }, "chatgpt-codex").first).toBeNull();
    expect(cardWords({ kind: "paste-code" }, "claude-subscription")).toEqual({ title: "Sign in on Claude's page", open: "Open Claude's page", steps: ["Open the page and sign in to the account this seat is for.", "Paste the code it shows you here."], first: null });
  });
});

describe("a seat's meter, in words", () => {
  const window = (over: object = {}) => ({ window: "five_hour", status: "allowed" as const, usedPercent: 42, resetsAt: NOW + 2 * 3_600_000, at: NOW, ...over });
  test("each window: how much is used and when it resets; one its tool refused is spent; one that said no share, in use", () => {
    expect(seatWindowWords(window(), NOW)).toBe("Five hours: 42% used, resets 14:00 UTC");
    expect(seatWindowWords(window({ window: "seven_day", usedPercent: 12, resetsAt: NOW + 3 * DAY }), NOW)).toBe("Week: 12% used, resets 29 Nov, 12:00 UTC");
    expect(seatWindowWords(window({ status: "rejected", usedPercent: 100 }), NOW)).toBe("Five hours: spent, resets 14:00 UTC");
    expect(seatWindowWords(window({ usedPercent: null, resetsAt: null }), NOW)).toBe("Five hours: in use");
    expect(seatWindowWords(window({ status: "warning", usedPercent: 91 }), NOW)).toBe("Five hours: 91% used, nearly spent, resets 14:00 UTC");
  });

  test("its use lately: its tasks this week and their tokens, and its runs now; nothing yet, nothing said", () => {
    expect(seatUseWords({ since: NOW - 7 * DAY, tasks: 3, tokens: 1_204_000, running: 1 })).toBe("3 tasks this week · 1.20M tokens · 1 running now");
    expect(seatUseWords({ since: NOW - 7 * DAY, tasks: 1, tokens: 4_000, running: 0 })).toBe("1 task this week · 4,000 tokens");
    expect(seatUseWords({ since: NOW - 7 * DAY, tasks: 0, tokens: 0, running: 0 })).toBeNull();
    expect(seatUseWords(undefined)).toBeNull();
  });

  test("its meter: each window still open, the soonest to reset first (one past its reset is fresh again, and left out), then its use lately", () => {
    const windows = [window({ window: "seven_day", usedPercent: 12, resetsAt: NOW + 3 * DAY }), window({ window: "seven_day_opus", usedPercent: 80, resetsAt: NOW - 1 }), window()];
    expect(seatMeterWords({ windows }, { since: NOW - 7 * DAY, tasks: 2, tokens: 9_000, running: 0 }, NOW)).toEqual(["Five hours: 42% used, resets 14:00 UTC", "Week: 12% used, resets 29 Nov, 12:00 UTC", "2 tasks this week · 9,000 tokens"]);
    expect(seatMeterWords({ windows: [] }, undefined, NOW)).toEqual([]);
  });

  test("a ChatGPT plan's use is read where OpenAI asks, in ChatGPT's own settings; a Claude plan's, here", () => {
    expect(USE_ELSEWHERE["chatgpt-codex"]).toEqual({ words: "Its use as ChatGPT counts it: Settings → Usage", url: "https://chatgpt.com/" });
    expect(USE_ELSEWHERE["chatgpt-siwc"]).toEqual(USE_ELSEWHERE["chatgpt-codex"]);
    expect(USE_ELSEWHERE["claude-subscription"]).toBeUndefined();
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
