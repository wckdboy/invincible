import type { NotifyPayload } from "@galahad/core/notify-payload";

/*
 * The number on the app's icon, where the system shows one (an iPhone or a Mac, from iOS and macOS's
 * Home Screen and Dock; Android as its launcher does): what waits for you. An open page knows it exactly
 * (the Inbox's count) and sets it, and tells the service worker. While the app is closed, each push about
 * something new that needs you adds one, until a page is opened and sets it exactly again; the same thing
 * told again (by its tag) adds nothing.
 */

/** What the worker keeps between pushes: the count a page last set, and the pushes since that each add one. */
export interface BadgeState {
  base: number;
  tags: string[];
}

export const NO_BADGE: BadgeState = { base: 0, tags: [] };
/** No count the badge shows is larger; a list of tags no longer. */
const MOST = 999;
const TAGS_KEPT = 50;

/** The pushes that mean something now waits for you; "finished", the day's limit and a test don't. */
const WAITS: ReadonlySet<NotifyPayload["kind"]> = new Set(["needs-you", "approval", "question", "summary"]);

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= MOST;

/** The state as the worker stored it, read strictly: anything else is no badge. */
export function readBadgeState(raw: unknown): BadgeState {
  if (!raw || typeof raw !== "object") return NO_BADGE;
  const { base, tags } = raw as { base?: unknown; tags?: unknown };
  if (!isCount(base) || !Array.isArray(tags) || !tags.every((tag) => typeof tag === "string" && tag.length <= 64)) return NO_BADGE;
  return { base, tags: tags.slice(-TAGS_KEPT) };
}

/** A page's message setting the count ({ type: "galahad:badge", count }), or null if it isn't one. */
export function readBadgeMessage(data: unknown): number | null {
  const d = (data && typeof data === "object" ? data : {}) as { type?: unknown; count?: unknown };
  return d.type === "galahad:badge" && isCount(d.count) ? d.count : null;
}

export const badgeMessage = (count: number) => ({ type: "galahad:badge", count: Math.min(MOST, Math.max(0, Math.floor(count))) });

/** After a push is shown: one more, if it's about something new that waits for you. */
export function afterPush(state: BadgeState, payload: Pick<NotifyPayload, "kind" | "tag">): BadgeState {
  if (!WAITS.has(payload.kind) || state.tags.includes(payload.tag)) return state;
  return { base: state.base, tags: [...state.tags, payload.tag].slice(-TAGS_KEPT) };
}

export const badgeCount = (state: BadgeState): number => Math.min(MOST, state.base + state.tags.length);

/** The system's badge calls, where the browser has them (a page's navigator, or the worker's). */
export interface Badging {
  setAppBadge?(count?: number): Promise<void>;
  clearAppBadge?(): Promise<void>;
}

/** Shows the count on the icon, or clears it at none. Never throws: a browser without badges, or one that refuses, shows nothing. */
export async function showBadge(on: Badging, count: number): Promise<void> {
  try {
    if (count > 0) await on.setAppBadge?.(count);
    else await on.clearAppBadge?.();
  } catch {
    /* no permission to badge (iOS asks for notifications first), or no badges at all */
  }
}
