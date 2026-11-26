import type { ConnectorView } from "@galahad/core";
import type { IconName } from "../ui/icons.ts";

/*
 * Where a connector's key stands, in words (pure: no DOM): what views/connectors.ts badges each card with, and what
 * the Apple app's Connectors say too (held to this by its vectors).
 */

type Tone = "ok" | "warn" | "danger" | "accent" | "neutral";

export const KEY_STATE: Record<string, { label: string; tone: Tone; icon: IconName; explain: string }> = {
  "none-needed": { label: "no key needed", tone: "neutral", icon: "check", explain: "It works without a key." },
  ready: { label: "key sealed", tone: "ok", icon: "check", explain: "Its key is sealed in the vault and only ever sent to this origin." },
  missing: { label: "needs a key", tone: "warn", icon: "key", explain: "It can't do anything until its key is in the vault." },
  "optional-missing": { label: "public only", tone: "neutral", icon: "key", explain: "Public reads work without a key, at a lower rate limit. Add one to reach your own data." },
  "signed-out": { label: "not signed in", tone: "warn", icon: "key", explain: "Its app is sealed: sign in as yourself to use it." },
  "wrong-origin": {
    label: "key pinned elsewhere",
    tone: "danger",
    icon: "alert",
    explain: "The vault holds a key under this name, but it's pinned to another origin, so it's never sent here. Replace it with one entered for this connector.",
  },
};

/** A connector that signs in as you (mail): its key state is its app and its sign-in, said as those. */
export const OAUTH_STATE: Record<string, { label: string; tone: Tone; icon: IconName }> = {
  missing: { label: "needs your app", tone: "warn", icon: "key" },
  "signed-out": { label: "not signed in", tone: "warn", icon: "key" },
  ready: { label: "signed in", tone: "ok", icon: "check" },
  "wrong-origin": { label: "pinned elsewhere", tone: "danger", icon: "alert" },
};

/** A hosted MCP server you sign in to (Linear, Notion): no app of yours, so until you sign in it is just not signed in. */
export const MCP_SIGN_IN_STATE: Record<string, { label: string; tone: Tone; icon: IconName }> = { ...OAUTH_STATE, missing: { label: "not signed in", tone: "warn", icon: "key" } };

/** Where a connector stands, with its icon: a sign-in's words for one that signs in as you, a key's for any other. */
export const connectorStateOf = (c: Pick<ConnectorView, "key" | "oauth">): { label: string; tone: Tone; icon: IconName } | undefined =>
  (c.oauth ? (c.oauth.provider === "mcp" ? MCP_SIGN_IN_STATE : OAUTH_STATE)[c.key] : undefined) ?? KEY_STATE[c.key];

/** A connector's badge: a sign-in's words for one that signs in as you, a key's for any other. */
export const connectorState = (c: Pick<ConnectorView, "key" | "oauth">): { label: string; tone: Tone } | null => {
  const state = connectorStateOf(c);
  return state ? { label: state.label, tone: state.tone } : null;
};
