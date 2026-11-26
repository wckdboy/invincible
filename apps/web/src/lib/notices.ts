/*
 * The node's notices as the Inbox says them: where one came from, in words. The iPhone and Mac apps say the same
 * (Core/Notices.swift), held to it by the parity vectors (apps/apple/scripts/vectors.ts). Pure, unit-tested.
 */

const KINDS = new Map([
  ["rule", "Your rule"],
  ["loop", "The loop"],
]);
const NAMED = new Map([
  ["heartbeat", "The heartbeat"],
  ["ci", "CI"],
  ["compute", "His compute"],
]);

/** Where a notice came from, as you'd say it: "rule:pushes" is "Your rule pushes"; one this app doesn't know, as it is. */
export function noticeFrom(source: string): string {
  const at = source.indexOf(":");
  const kind = at > 0 && at < source.length - 1 ? KINDS.get(source.slice(0, at)) : undefined;
  return kind ? `${kind} ${source.slice(at + 1)}` : (NAMED.get(source) ?? source);
}
