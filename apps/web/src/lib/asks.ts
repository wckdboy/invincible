import type { ActionView, ConnectorView } from "@invincible/core";

/*
 * An approval in plain words, as its ask says it in a chat (I10's phone-gaps, the lead's word of 28 November 2026): "Post
 * to Forge: “Sync survives a dropped connection…”", never "Outward · forge.post POST /posts". The call itself (its
 * connector and tool, its target, every argument) is behind More, in its card. Every app says it so (the vectors' asks).
 */

/** What sends takes "to" ("Post to Forge"); anything else is done "on" its service ("Merge on GitHub"). */
const SENDS = new Set(["post", "send", "publish", "upload", "push", "write", "comment", "reply", "message", "email", "share"]);

/** Where an ask's words are, the first of these an argument has in words. */
const WORDS = ["text", "title", "subject", "message", "body", "content", "name", "summary"];

/** As many characters of its words as a line shows, its last an ellipsis where it was cut. */
const SHOWN = 60;

const capital = (words: string): string => (words ? words.charAt(0).toUpperCase() + words.slice(1) : words);

/** The first line of its words, cut on a character (never inside one) at SHOWN; null where it has none. */
function firstWords(args: Readonly<Record<string, unknown>>): string | null {
  for (const key of WORDS) {
    const value = args[key];
    if (typeof value !== "string") continue;
    const line = value.trim().split("\n")[0]!.trim();
    if (!line) continue;
    const characters = Array.from(line);
    return characters.length > SHOWN ? `${characters.slice(0, SHOWN - 1).join("").trimEnd()}…` : line;
  }
  return null;
}

/**
 * The connectors' own names by their ids, from the node's list (GET /api/connectors), as an ask names its service: each
 * as written, its spaces at either end aside; a blank one is none (its id with a capital, then).
 */
export function connectorLabels(connectors: readonly Pick<ConnectorView, "id" | "label">[]): Map<string, string> {
  return new Map(connectors.map((c): [string, string] => [c.id, c.label.trim()]).filter(([, label]) => label));
}

/**
 * An approval as its ask says it: what it would do (its tool's name in words, a capital first), to or on which service
 * ([label]: the connector's own name where the app knows it, else its id with a capital), and the first words it would
 * send, in quotes.
 */
export function askPlain(ask: Pick<ActionView, "connector" | "tool" | "args">, label?: string | null): string {
  const service = label?.trim() || capital(ask.connector);
  const tool = ask.tool.replace(/[._-]+/g, " ").trim();
  const verb = tool.split(" ")[0]!.toLowerCase();
  const head = `${capital(tool)} ${SENDS.has(verb) ? "to" : "on"} ${service}`;
  const words = firstWords(ask.args ?? {});
  return words ? `${head}: “${words}”` : head;
}
