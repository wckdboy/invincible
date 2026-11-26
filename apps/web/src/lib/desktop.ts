/*
 * A knight's desktop, watched and taken over from the app (POST /api/team/desktop): whether its VM has one, where
 * a tap on the picture lands on the knight's own screen, what counts as an address for its browser, the picture
 * the node sends as an image's source, and the node's refusal that a VM has no desktop. Pure (no DOM).
 */

/** One thing done on a knight's desktop, as the node takes it (core's DesktopAction, without its schema). */
export type DesktopDo =
  | { do: "click"; x: number; y: number }
  | { do: "scroll"; direction: "up" | "down"; times?: number }
  | { do: "type"; text: string }
  | { do: "key"; keys: string[] }
  | { do: "open"; address: string };

/** What comes back from every look and everything done: the screen as it then is, and its size in its own pixels. */
export interface DesktopView {
  shot: { mediaType: string; data: string };
  width: number;
  height: number;
}

/** The keys offered beside the picture, by the names X gives them. */
export const DESKTOP_KEYS = [
  { label: "Return", key: "Return" },
  { label: "Tab", key: "Tab" },
  { label: "Escape", key: "Escape" },
  { label: "Backspace", key: "BackSpace" },
] as const;

/** A VM made from the desktop image has a display, a window manager and a browser. */
export const hasDesktop = (workspace: { image: string } | null | undefined): boolean => Boolean(workspace?.image.includes("desktop"));

/**
 * A tap on the picture as a place on the knight's screen, in the screen's own pixels: the picture may be drawn at
 * any size, anywhere on the page. Null for a tap beside it (or on a picture not drawn yet).
 */
export function screenPoint(tap: { x: number; y: number }, shown: { left: number; top: number; width: number; height: number }, screen: { width: number; height: number }): { x: number; y: number } | null {
  if (!(shown.width > 0 && shown.height > 0)) return null;
  const across = (tap.x - shown.left) / shown.width;
  const down = (tap.y - shown.top) / shown.height;
  if (!(across >= 0 && across <= 1 && down >= 0 && down <= 1)) return null;
  return { x: Math.min(screen.width - 1, Math.floor(across * screen.width)), y: Math.min(screen.height - 1, Math.floor(down * screen.height)) };
}

/** An address as the desktop's browser takes it: http, https, file or about as written, a bare host with https. Null: not one. */
export function desktopAddress(text: string): string | null {
  const typed = text.trim();
  if (!typed || /\s/.test(typed)) return null;
  // (A colon before a digit is a port, not a scheme: localhost:3000.)
  const address = /^(https?:\/\/|file:\/\/|about:)/.test(typed) ? typed : /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(typed) ? null : `https://${typed}`;
  return address && address.length <= 2000 ? address : null;
}

/** The picture as an image's source: a JPEG or a PNG in base64 of a screen with a size, and nothing else (null). */
export function shotSource(view: DesktopView): string | null {
  const { mediaType, data } = view.shot;
  if (mediaType !== "image/jpeg" && mediaType !== "image/png") return null;
  if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  if (!(view.width > 0 && view.height > 0)) return null;
  return `data:${mediaType};base64,${data}`;
}

/** The node's refusal that this VM has no desktop (it says how to get one), told apart from every other. */
export const saysNoDesktop = (error: unknown): boolean => {
  const refusal = error as { status?: unknown; message?: unknown } | null;
  return refusal?.status === 424 && typeof refusal.message === "string" && refusal.message.includes("no desktop");
};
