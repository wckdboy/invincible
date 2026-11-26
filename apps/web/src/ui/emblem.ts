import { h } from "./dom.ts";

/*
 * The mark, inline: the app icon (the field in gold, on its own tile), until the new identity's mark (Phase 1).
 */

export interface EmblemOptions {
  size?: number;
  class?: string;
  /** Accessible name. Omit when the emblem sits beside the word "Galahad" (decorative). */
  label?: string;
}

export function emblem(options: EmblemOptions = {}): HTMLElement {
  const size = Number.isFinite(options.size) ? Math.round(Math.max(12, Math.min(256, options.size!))) : 24;
  return h(
    "span",
    {
      class: options.class ? `emblem ${options.class}` : "emblem",
      style: `--em-size:${size}px`,
      ...(options.label ? { role: "img", "aria-label": options.label } : { "aria-hidden": "true" }),
    },
    h("img", { src: "/icon-192.png", alt: "", draggable: "false", decoding: "async" }),
  );
}
