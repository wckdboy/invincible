import { createHash } from "node:crypto";

/**
 * Someone else's words (a reviewer's, what a task's run printed), fenced as data under a mark they couldn't have known
 * to write: the digest of those words themselves, as a run's reviewer is shown the work's (agents' run.ts fenceWork).
 * Words that wrote a mark of their own would have another digest. The same words always have the same mark.
 */
export function fenced(label: string, words: string): string {
  const mark = createHash("sha256").update(words).digest("hex").slice(0, 12);
  return `<<<${label} ${mark}>>>\n${words}\n<<<end of ${label} ${mark}>>>`;
}
