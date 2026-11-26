import { h } from "./dom.ts";

/*
 * The mark, inline: Galahad's helm as the owner drew it (src/knights/galahad-helm.webp; the brand is ../brand.ts). It
 * stands on no tile: the drawing has its own ink line, so it reads the same in a light theme as in a dark one.
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
    h("img", { src: "/knights/galahad-helm.webp", alt: "", draggable: "false", decoding: "async" }),
  );
}
