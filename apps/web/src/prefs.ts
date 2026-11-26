/*
 * UI preferences, the only thing this app keeps in localStorage: theme, motion,
 * sidebar state, the last chat role, what Enter does while the primary is working,
 * which kept chat you had open (its id only), how the agents are laid out on
 * this device (a board or a list, an agent's side panel shown), which of the
 * work's sections are open, whether a task's details card is shown, when it last showed you what happened while you were away (a
 * time), and when you put away the card that says it can't reach this device (a
 * time). Never secrets, never a word of a chat, never anything else from the
 * server. boot.ts reads the same keys before paint.
 */

export type ThemePref = "system" | "light" | "dark";
export type MotionPref = "system" | "reduce" | "full";

const KEYS = {
  theme: "invincible:theme",
  motion: "invincible:motion",
  sidebar: "invincible:sidebar",
  role: "invincible:chat-role",
  enter: "invincible:chat-enter",
  chat: "invincible:open-chat",
  agents: "invincible:agents-view",
  work: "invincible:work-open",
  details: "invincible:task-details",
  panel: "invincible:agent-panel",
  away: "invincible:away-seen",
  reach: "invincible:reach-put-away",
} as const;

type PrefKey = keyof typeof KEYS;

function read(key: PrefKey): string | null {
  try {
    return localStorage.getItem(KEYS[key]);
  } catch {
    return null;
  }
}

function write(key: PrefKey, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(KEYS[key]);
    else localStorage.setItem(KEYS[key], value);
  } catch {
    /* storage unavailable: preferences just don't persist */
  }
}

const root = () => document.documentElement;

// The app opens on Chat, so the page you were last on is no longer kept; nor the roster's folded sections, which went with
// the roster sidebar (26 November 2026): what an earlier version wrote goes.
try {
  localStorage.removeItem("invincible:last-route");
  localStorage.removeItem("invincible:roster-folded");
} catch {
  /* storage unavailable: there is nothing to remove */
}

export function themePref(): ThemePref {
  const value = read("theme");
  return value === "light" || value === "dark" ? value : "system";
}

export function resolvedTheme(): "light" | "dark" {
  const pref = themePref();
  if (pref !== "system") return pref;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function setTheme(pref: ThemePref): void {
  write("theme", pref === "system" ? null : pref);
  if (pref === "system") delete root().dataset.theme;
  else root().dataset.theme = pref;
  syncThemeColor();
}

/** Keeps the browser chrome (status bar, title bar) in step with the canvas: exactly --bg. */
export function syncThemeColor(): void {
  const color = resolvedTheme() === "dark" ? "#08080a" : "#fafafa";
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) meta.content = color;
}

export function motionPref(): MotionPref {
  const value = read("motion");
  return value === "reduce" || value === "full" ? value : "system";
}

export function setMotion(pref: MotionPref): void {
  write("motion", pref === "system" ? null : pref);
  if (pref === "system") delete root().dataset.motion;
  else root().dataset.motion = pref;
}

export function sidebarCollapsed(): boolean {
  return read("sidebar") === "collapsed";
}

export function setSidebarCollapsed(collapsed: boolean): void {
  write("sidebar", collapsed ? "collapsed" : null);
  if (collapsed) root().dataset.sidebar = "collapsed";
  else delete root().dataset.sidebar;
}

export const lastRole = (): string | null => read("role");
export const rememberRole = (role: string): void => write("role", role);

/** What Enter does while it's working, on this device: steer (the default: it's told now) or queue (sent when it's done). */
export type ChatEnterPref = "steer" | "queue";
export const chatEnter = (): ChatEnterPref => (read("enter") === "queue" ? "queue" : "steer");
export const setChatEnter = (pref: ChatEnterPref): void => write("enter", pref === "steer" ? null : pref);

/**
 * The kept chat you had open (its id, never a word of it), so the app comes back to it, and to the turn it's
 * working on in it, after a reload: where you were, like the last page.
 */
export const openChatId = (): string | null => {
  const id = read("chat");
  return id && /^cv_[A-Za-z0-9_-]{22}$/.test(id) ? id : null;
};
export const rememberOpenChat = (id: string | null): void => write("chat", id);

/** Since when "while you were away" tells this device what happened: when it last did, else the last day. */
export const awaySince = (now = Date.now()): number => {
  const at = Number(read("away"));
  return Number.isFinite(at) && at > 0 && at <= now ? at : now - 24 * 3600_000;
};
export const markAwaySeen = (at = Date.now()): void => write("away", String(at));

/** When you put away the card that says it can't reach this device (Not now), or null (lib/push.ts reachDismissed). */
export const reachPutAway = (): number | null => {
  const at = Number(read("reach"));
  return Number.isFinite(at) && at > 0 ? at : null;
};
export const putReachAway = (at = Date.now()): void => write("reach", String(at));

/** How the agents' own page shows the agents on this device: as a board of cards (the default) or as a list. */
export type AgentsView = "board" | "list";
export const agentsView = (): AgentsView => (read("agents") === "list" ? "list" : "board");
export const setAgentsView = (view: AgentsView): void => write("agents", view === "board" ? null : view);

/** The work's sections opened on this device (the sidebar's, and Home's settled ones): what is at work and what is
 * settled are folded until you open them. */
export type WorkFold = "working" | "done";
export const workOpen = (): Set<WorkFold> => new Set((read("work") ?? "").split(",").filter((part): part is WorkFold => part === "working" || part === "done"));
export function setWorkOpen(section: WorkFold, opened: boolean): void {
  const now = workOpen();
  if (opened) now.add(section);
  else now.delete(section);
  write("work", now.size ? [...now].sort().join(",") : null);
}

/** Whether an agent's page shows its side panel beside the timeline on a wide screen (it does unless you hid it). */
export const agentPanelShown = (): boolean => read("panel") !== "hidden";
export const setAgentPanelShown = (shown: boolean): void => write("panel", shown ? null : "hidden");

/** Whether a task's details card shows beside its thread on a wide screen: as you last left it, else where there is room
 * for it (1200 px and wider). */
export const taskDetailsShown = (wide: boolean): boolean => {
  const said = read("details");
  return said === "shown" ? true : said === "hidden" ? false : wide;
};
export const setTaskDetailsShown = (shown: boolean): void => write("details", shown ? "shown" : "hidden");
