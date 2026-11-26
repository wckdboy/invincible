import { type Item, KINDS, type Kind, type Plan } from "./plan.ts";

/*
 * What the import says, kind by kind: what comes (or came), what is here already, what can't come and why, and what
 * stays behind. Names and counts only: a secret is said by its name, a memory by how many, a chat by its id and title.
 */

const LABELS: Record<Kind, string> = {
  secrets: "secrets",
  providers: "providers",
  roster: "roster",
  thinking: "thinking",
  prices: "prices",
  "about-you": "about you",
  memory: "memory",
  projects: "projects",
  connectors: "connectors",
  agents: "agents",
  chats: "chats",
};

/** Kinds said by how many alone: their names are ids that tell you nothing. */
const COUNTED = new Set<Kind>(["about-you", "memory"]);

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const named = (items: readonly Item[]) => items.map((i) => (i.note ? `${i.name} (${i.note})` : i.name)).join(", ");

function line(kind: Kind, items: readonly Item[], dryRun: boolean): string[] {
  const pad = LABELS[kind].padEnd(12);
  const of = (state: Item["state"]) => items.filter((i) => i.state === state);
  const coming = [...of("bring"), ...of("brought")];
  const out: string[] = [];
  const parts: string[] = [];
  if (coming.length) {
    const verb = dryRun ? "to bring" : "brought";
    if (kind === "about-you") {
      const kept = coming.filter((i) => i.whose === "kept").length;
      const proposed = coming.length - kept;
      parts.push(`${coming.length} ${verb}: ${kept} kept${proposed ? `, ${proposed} proposed (${proposed === 1 ? "it waits" : "they wait"} for you to keep ${proposed === 1 ? "it" : "them"})` : ""}`);
    } else if (kind === "memory") parts.push(`${plural(coming.length, "note")} ${verb}`);
    else if (kind === "secrets") parts.push(`${coming.length} ${verb}, sealed anew in this node's vault and never shown: ${named(coming)}`);
    else if (kind === "roster") parts.push(`${plural(coming.length, "role")} ${verb}: ${named(coming)}`);
    else parts.push(`${coming.length} ${verb}: ${named(coming)}`);
  }
  if (of("here").length) parts.push(`${of("here").length} here already`);
  if (of("differs").length) parts.push(`${of("differs").length} here already and different, kept as they are here${COUNTED.has(kind) ? "" : `: ${named(of("differs"))}`}`);
  if (of("left").length) parts.push(`${of("left").length} left behind on your word (--skip)${COUNTED.has(kind) ? "" : `: ${named(of("left"))}`}`);
  if (of("removed").length) parts.push(`${of("removed").length} removed here, not brought back${COUNTED.has(kind) ? "" : `: ${named(of("removed"))}`}`);
  if (parts.length) out.push(`  ${pad} ${parts.join("; ")}`);
  for (const item of of("skip")) out.push(`  ${out.length ? " ".repeat(12) : pad} skipped ${item.name}: ${item.note}`);
  return out;
}

export interface Said {
  lines: string[];
  /** Something couldn't come. */
  skipped: number;
}

export function report(plan: Plan, opts: { dryRun: boolean; from: string; into: string; node: string }): Said {
  const lines = [`From Galahad's home at ${opts.from} (its node ${opts.node}) into this node's home at ${opts.into}.`];
  if (opts.dryRun) lines.push("A dry run: nothing is written, here or there.");
  lines.push("");
  for (const kind of KINDS) {
    const items = plan.items.filter((i) => i.kind === kind);
    if (!items.length) {
      if (kind === "chats" && plan.chats?.length) {
        lines.push(`  ${LABELS.chats.padEnd(12)} none asked for; ${plural(plan.chats.length, "chat")} there (--chats all, or --chats <id>,<id>):`);
        for (const chat of plan.chats) lines.push(`  ${" ".repeat(12)}   ${chat.id}  ${chat.title} · ${plural(chat.count, "message")}${chat.bank ? " · it read the bank, so it stays behind" : ""}`);
      }
      continue;
    }
    lines.push(...line(kind, items, opts.dryRun));
  }
  if (plan.behind.length) {
    lines.push("", "Stays behind:");
    for (const what of plan.behind) lines.push(`  ${what}`);
  }
  const skipped = plan.items.filter((i) => i.state === "skip").length;
  const coming = plan.items.filter((i) => i.state === "bring" || i.state === "brought").length;
  lines.push("");
  if (!coming) lines.push(`Nothing to bring: everything that can come is here already${skipped ? `, and ${skipped} can't (above)` : ""}.`);
  else if (opts.dryRun) lines.push(`${plural(coming, "thing")} would come${skipped ? `, ${skipped} can't (above)` : ""}. Run it without --dry-run, with this node stopped, to bring ${coming === 1 ? "it" : "them"}.`);
  else lines.push(`Brought ${plural(coming, "thing")}${skipped ? `; ${skipped} couldn't come (above)` : ""}. Run it again at any time: what is here stays as it is.`);
  return { lines, skipped };
}
