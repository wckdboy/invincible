/*
 * The agents the site shows, each by its job (the owner's word: agents are named by what they do), and their marks as
 * files: /orbs/<job>-<size>-<light|ink>-<hash>.svg, written by src/pages/orbs/[file].ts and named by their content, so a
 * browser keeps each for good. A page shows the one for its theme (Orb.astro), and downloads only that one. Each agent's
 * mark is the one a node gives it as it joins, in the order they are listed (core's assignMark): no two share a colour.
 */
import { createHash } from "node:crypto";
import { type AgentMark, assignMark } from "../../../../packages/core/src/agent-mark.ts";
import { agentMarkSvg } from "./mark-svg.ts";

/** The jobs the site shows, in its order: the agents your agent gives work to, and the reviewer that checks it. */
export const AGENTS = ["coder", "researcher", "reviewer", "operator"] as const;
export type Job = (typeof AGENTS)[number];

/** Each job's mark, given in the order the jobs are listed, as a node gives agents theirs. */
export const MARKS: Readonly<Record<Job, AgentMark>> = (() => {
  const given: AgentMark[] = [];
  for (const job of AGENTS) given.push(assignMark(job, given));
  return Object.fromEntries(AGENTS.map((job, n) => [job, given[n]!])) as Record<Job, AgentMark>;
})();

/** The sizes the page draws them at, in CSS pixels. */
export const ORB_SIZES = [72] as const;
export type OrbSize = (typeof ORB_SIZES)[number];

export interface OrbFiles {
  size: number;
  /** For a dark page and for a light one (its colour's forms): each file's address, and its SVG. */
  dark: { href: string; svg: string };
  light: { href: string; svg: string };
}

const made = new Map<string, OrbFiles>();

/** An agent's orb at a size, as its two files. */
export function agentOrb(job: Job, size: OrbSize): OrbFiles {
  const key = `${job}-${size}`;
  let files = made.get(key);
  if (!files) {
    const svg = agentMarkSvg(job, MARKS[job], size);
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
