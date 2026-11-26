import { h } from "./dom.ts";
import { appMark } from "./orb.ts";

/*
 * The mark, inline (the welcome, pairing, an empty chat): the app's own mark (ui/orb.ts appMark), the icon's field on
 * nothing, drawn for the page's theme, so no dark tile sits on a light page.
 */

export interface EmblemOptions {
  size?: number;
  class?: string;
  /** Accessible name. Omit when the emblem sits beside the app's name (decorative). */
  label?: string;
}

export function emblem(options: EmblemOptions = {}): HTMLElement {
  const size = Number.isFinite(options.size) ? Math.round(Math.max(16, Math.min(256, options.size!))) : 24;
  return h(
    "span",
    {
      class: options.class ? `emblem ${options.class}` : "emblem",
      ...(options.label ? { role: "img", "aria-label": options.label } : { "aria-hidden": "true" }),
    },
    appMark(size),
  );
}
