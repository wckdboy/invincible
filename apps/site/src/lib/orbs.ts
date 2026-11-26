/*
 * The agents the site shows, each by its job (the owner's word: agents are named by what they do), and their orbs as
 * files: /orbs/<job>-<size>-<light|ink>-<hash>.svg, written by src/pages/orbs/[file].ts and named by their content, so a
 * browser keeps each for good. A page shows the one for its theme (Orb.astro), and downloads only that one.
 */
import { createHash } from "node:crypto";
import { agentOrbSvg } from "./field-svg.ts";

/** The jobs the site shows, in its order: the agents your agent gives work to, and the reviewer that checks it. */
export const AGENTS = ["coder", "researcher", "reviewer", "operator"] as const;
export type Job = (typeof AGENTS)[number];

/** The sizes the page draws them at, in CSS pixels. */
export const ORB_SIZES = [72] as const;
export type OrbSize = (typeof ORB_SIZES)[number];

export interface OrbFiles {
  size: number;
  /** For a dark page (the field as light) and for a light one (as ink): each file's address, and its SVG. */
  dark: { href: string; svg: string };
  light: { href: string; svg: string };
}

const made = new Map<string, OrbFiles>();

/** An agent's orb at a size, as its two files. */
export function agentOrb(job: Job, size: OrbSize): OrbFiles {
  const key = `${job}-${size}`;
  let files = made.get(key);
  if (!files) {
    const svg = agentOrbSvg(job, size);
    const file = (variant: "light" | "ink", text: string) => ({ href: `/orbs/${key}-${variant}-${createHash("sha256").update(text).digest("hex").slice(0, 10)}.svg`, svg: text });
    files = { size, dark: file("light", svg.dark), light: file("ink", svg.light) };
    made.set(key, files);
  }
  return files;
}

/** Every orb file the site serves. */
export function orbFiles(): { href: string; svg: string }[] {
  return AGENTS.flatMap((job) => ORB_SIZES.flatMap((size) => {
    const files = agentOrb(job, size);
    return [files.dark, files.light];
  }));
}
