import { artifactTitle, compactNumber, isBlockKind, readArtifact, readChart, readChoices, readStats, readSteps } from "@galahad/core/blocks";

/*
 * His answer, as a chat app shows it: in its own markup (Telegram's HTML, Slack's mrkdwn: bold, italic, code, links,
 * nothing else), the choices of a choices block as buttons, a plan's steps as marked lines, figures as lines, a chart
 * or a page as a line that says it's in the app. Fences are read as the apps read them (a block on one line too).
 * Anything else stays the text it is, escaped.
 */

/** A message Telegram takes is at most 4,096 characters; this leaves room for its markup. */
export const TELEGRAM_CHUNK = 3500;
/** Slack draws at most 3,000 characters of a message's section (where its buttons go under); this leaves room. */
export const SLACK_CHUNK = 2900;

export interface ChatAnswer {
  /** Its markup, in pieces each short enough to send. */
  chunks: string[];
  /** The answer's choices (its last choices block), offered as buttons under its last piece. */
  choices: string[];
}
export type TelegramAnswer = ChatAnswer;

/** How one chat app writes what the apps draw. */
interface Dialect {
  chunk: number;
  escape: (text: string) => string;
  /** Bold, italic, inline code and http(s) links, on text already split from code; the rest escaped. */
  inline: (text: string) => string;
  bold: (markup: string) => string;
  italic: (markup: string) => string;
  /** A code block, from its text (escaped here). */
  pre: (text: string) => string;
  /** A code block around text already escaped (a long one's pieces). */
  wrapPre: (escaped: string) => string;
  /** A code block's text, escaped as `pre` left it; null for any other block. */
  preBody: (block: string) => string | null;
  quote: (markup: string) => string;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*(?:([\w+#.-]+)(?:\s+([^`\s](?:[^`]*[^`\s])?))?\s*)?$/;
const STEP_MARK: Record<string, string> = { done: "✓", doing: "→", todo: "○", failed: "✗", skipped: "–" };

export const escapeHtml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Telegram's HTML: bold, italic, inline code and http(s) links, on text already split from code; the rest escaped. */
export function inlineHtml(text: string): string {
  const out: string[] = [];
  // Inline code first: what's inside it is never read as markup.
  const parts = text.split(/(`[^`\n]+`)/);
  for (const part of parts) {
    if (/^`[^`\n]+`$/.test(part)) {
      out.push(`<code>${escapeHtml(part.slice(1, -1))}</code>`);
      continue;
    }
    let html = escapeHtml(part);
    html = html.replace(/\[([^\]\n]{1,300})\]\((https?:\/\/[^\s)]{1,2000})\)/g, (_m, label: string, url: string) => `<a href="${url.replace(/"/g, "&quot;")}">${label}</a>`);
    html = html.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>").replace(/__([^_\n]+)__/g, "<b>$1</b>");
    html = html.replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=[\s).,!?:;]|$)/g, "$1<i>$2</i>").replace(/(^|[\s(])_([^_\s][^_\n]*?)_(?=[\s).,!?:;]|$)/g, "$1<i>$2</i>");
    html = html.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
    out.push(html);
  }
  return out.join("");
}

/** Slack's escaping: its three characters, and nothing else (a stray control character goes). */
export const escapeSlack = (text: string): string => text.replace(/[\u0000-\u0008\u000b-\u001f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Slack's mrkdwn: *bold*, _italic_, ~struck~, `code` and <url|links>, on text already split from code; the rest escaped. */
export function inlineSlack(text: string): string {
  const out: string[] = [];
  for (const part of text.split(/(`[^`\n]+`)/)) {
    if (/^`[^`\n]+`$/.test(part)) {
      out.push(`\`${escapeSlack(part.slice(1, -1))}\``);
      continue;
    }
    let mrkdwn = escapeSlack(part);
    // (A label's | would end it early.)
    mrkdwn = mrkdwn.replace(/\[([^\]\n]{1,300})\]\((https?:\/\/[^\s)|]{1,2000})\)/g, (_m, label: string, url: string) => `<${url}|${label.replace(/\|/g, "¦")}>`);
    // Bold is held apart while italics are read, so its stars aren't read again as italics.
    mrkdwn = mrkdwn.replace(/\*\*([^*\n]+)\*\*/g, "\u0001$1\u0001").replace(/__([^_\n]+)__/g, "\u0001$1\u0001");
    mrkdwn = mrkdwn.replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=[\s).,!?:;]|$)/g, "$1_$2_");
    mrkdwn = mrkdwn.replace(/~~([^~\n]+)~~/g, "~$1~").replace(/\u0001/g, "*");
    out.push(mrkdwn);
  }
  return out.join("");
}

const TELEGRAM: Dialect = {
  chunk: TELEGRAM_CHUNK,
  escape: escapeHtml,
  inline: inlineHtml,
  bold: (markup) => `<b>${markup}</b>`,
  italic: (markup) => `<i>${markup}</i>`,
  pre: (text) => `<pre>${escapeHtml(text)}</pre>`,
  wrapPre: (escaped) => `<pre>${escaped}</pre>`,
  preBody: (block) => /^<pre>([\s\S]*)<\/pre>$/.exec(block)?.[1] ?? null,
  quote: (markup) => `▎${markup}`,
};

const SLACK: Dialect = {
  chunk: SLACK_CHUNK,
  escape: escapeSlack,
  inline: inlineSlack,
  bold: (markup) => `*${markup}*`,
  italic: (markup) => `_${markup}_`,
  // (Three backticks in the code itself would end it: they go as two and a lookalike.)
  pre: (text) => `\`\`\`${escapeSlack(text).replace(/```/g, "``ˋ")}\`\`\``,
  wrapPre: (escaped) => `\`\`\`${escaped}\`\`\``,
  preBody: (block) => /^```([\s\S]*)```$/.exec(block)?.[1] ?? null,
  quote: (markup) => `>${markup}`,
};

/** A block the apps draw, said in words (and its choices kept for buttons). */
function blockText(d: Dialect, kind: string, body: string, choices: string[][]): string {
  switch (kind) {
    case "choices": {
      const read = readChoices(body);
      if (!read.ok) return d.pre(body);
      choices.push(read.value);
      return "";
    }
    case "steps": {
      const read = readSteps(body);
      if (!read.ok) return d.pre(body);
      return read.value.map((step) => `${STEP_MARK[step.state] ?? "·"} ${d.escape(step.text)}`).join("\n");
    }
    case "stats": {
      const read = readStats(body);
      if (!read.ok) return d.pre(body);
      return read.value
        .map((stat) => {
          const value = typeof stat.value === "number" ? compactNumber(stat.value) : stat.value;
          const delta = stat.delta === null ? "" : ` (${stat.delta > 0 ? "+" : ""}${compactNumber(stat.delta)}${stat.note ? ` ${stat.note}` : ""})`;
          return `${d.bold(d.escape(stat.label))}: ${d.escape(`${value}${stat.unit ? ` ${stat.unit}` : ""}${delta}`)}`;
        })
        .join("\n");
    }
    case "chart": {
      const read = readChart(body);
      const title = read.ok && read.value.title ? `: ${read.value.title}` : "";
      return d.italic(`A chart${d.escape(title)}, drawn in the app.`);
    }
    case "artifact": {
      const read = readArtifact(body);
      const title = read.ok ? artifactTitle(read.value) : null;
      return d.italic(`A page${title ? `, ${d.escape(title)}` : ""}: open this chat in the app to see it.`);
    }
  }
  return d.pre(body);
}

/** His answer in a chat app's own markup. */
function chatAnswer(d: Dialect, markdown: string): ChatAnswer {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  const choices: string[][] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (!paragraph.length) return;
    blocks.push(paragraph.map((line) => lineMarkup(d, line)).join("\n"));
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const marker = fence[1]!;
      const body: string[] = [];
      for (i++; i < lines.length; i++) {
        const l = lines[i]!;
        if (l.trim().startsWith(marker[0]!.repeat(marker.length)) && /^\s*[`~]+\s*$/.test(l)) break;
        body.push(l);
      }
      const lang = (fence[2] ?? "").toLowerCase();
      const text = body.join("\n");
      const said = fence[3] ?? "";
      if (isBlockKind(lang)) {
        const shown = blockText(d, lang, !text.trim() && said ? said : text, choices);
        if (shown) blocks.push(shown);
      } else blocks.push(d.pre(text));
      continue;
    }
    if (!line.trim()) flush();
    else paragraph.push(line);
  }
  flush();
  return { chunks: chunked(d, blocks.filter((b) => b.trim())), choices: choices.at(-1) ?? [] };
}

/** His answer as Telegram takes it. */
export const telegramAnswer = (markdown: string): ChatAnswer => chatAnswer(TELEGRAM, markdown);
/** His answer as Slack takes it. */
export const slackAnswer = (markdown: string): ChatAnswer => chatAnswer(SLACK, markdown);

/** One line of a paragraph: a heading in bold, a list item with its bullet, a quote kept as one. */
function lineMarkup(d: Dialect, line: string): string {
  const heading = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
  if (heading) return d.bold(d.inline(heading[1]!));
  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (bullet) return `${bullet[1]!.replace(/ {2}/g, "  ")}• ${d.inline(bullet[2]!)}`;
  const quote = /^ {0,3}>\s?(.*)$/.exec(line);
  if (quote) return d.quote(d.inline(quote[1]!));
  return d.inline(line);
}

/** Pieces each short enough to send, split between blocks (a long block alone is cut, code kept as code). */
function chunked(d: Dialect, blocks: string[]): string[] {
  const out: string[] = [];
  let current = "";
  const push = (piece: string) => {
    if (current && current.length + 2 + piece.length > d.chunk) {
      out.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${piece}` : piece;
  };
  for (const block of blocks) {
    if (block.length <= d.chunk) {
      push(block);
      continue;
    }
    // Too long for one message: a code block is cut into code blocks, anything else at line ends.
    const pre = d.preBody(block);
    const body = pre ?? block;
    const room = d.chunk - (pre !== null ? block.length - pre.length : 0);
    let rest = body;
    while (rest.length) {
      let cut = rest.length <= room ? rest.length : rest.lastIndexOf("\n", room);
      if (cut <= 0) cut = room;
      // Never cut an entity (&amp;) in two.
      const amp = rest.lastIndexOf("&", cut);
      if (amp > cut - 8 && rest.indexOf(";", amp) >= cut) cut = amp;
      push(pre !== null ? d.wrapPre(rest.slice(0, cut)) : rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^\n/, "");
    }
  }
  if (current) out.push(current);
  return out.length ? out : [""];
}
