import type { Route } from "./nav.ts";

/*
 * What a place reads first, asked for as your finger lands on a link to it (or the pointer presses), a tap's length
 * before the tap: the place then shows its own content at once, or that much sooner. Only reads: GETs, and POSTs that
 * change nothing (api.ts READING_POSTS). The answer is kept as any other (api.peek), and a place that asks while it is
 * on its way shares it. A place missing here, or a read it no longer makes, only means no head start.
 */
export type Read = string | { post: string; body: unknown };

export const PLACE_READS: Partial<Record<Route, readonly Read[]>> = {
  chat: ["/api/conversations"],
  loops: ["/api/loops", "/api/self-action"],
  overview: ["/api/ledger", "/api/turns", "/api/quests", { post: "/api/doctor", body: { quick: true } }],
  activity: ["/api/ledger"],
  artifacts: ["/api/artifacts"],
  projects: ["/api/projects", "/api/conversations"],
  skills: ["/api/skills"],
  archive: ["/api/archive"],
  findings: ["/api/investigations"],
  trials: ["/api/trials"],
  vault: ["/api/providers", "/api/secrets", "/api/secret-requests"],
  models: ["/api/providers"],
  connectors: ["/api/connectors"],
};

/** What to ask for ahead of a tap on a link to `hash`, among the places this device may see: a place's first reads, or a room's conversation. */
export function readsFor(hash: string, visible: readonly Route[]): Read[] {
  const route = /^#\/([a-z]+)/.exec(hash)?.[1];
  const place = visible.find((r) => r === (route === "roundtable" ? "team" : route));
  if (!place) return [];
  const room = place === "team" ? /[?&]room=([A-Za-z0-9_.:-]{1,80})(?:&|$)/.exec(hash)?.[1] : undefined;
  return room ? [{ post: "/api/team/room", body: { id: room } }] : [...(PLACE_READS[place] ?? [])];
}
