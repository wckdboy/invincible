/*
 * Markdown-lite → a tiny AST. Pure (no DOM): the renderer in ui/markdown.ts
 * turns it into elements with createElement + textContent only, so model
 * output can never become HTML. Raw HTML in the source stays literal text.
 *
 * Supported: paragraphs (single newlines are line breaks), # headings,
 * fenced code (an unclosed fence while streaming is still code), bullet and
 * numbered lists (nested by indentation), > quotes, --- rules, GFM tables,
 * `code`, **bold**, *italic*, ~~strike~~, [links](https://…) and bare URLs.
 * Only http(s) links ever become links; anything else stays text.
 */

import { isBlockKind } from "@galahad/core/blocks";

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "del"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "br" };

export type Align = "left" | "center" | "right" | null;

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "h"; level: number; c: Inline[] }
  | { t: "code"; lang: string; v: string; open: boolean }
  | { t: "list"; ordered: boolean; start: number; items: Block[][] }
  | { t: "quote"; c: Block[] }
  | { t: "hr" }
  | { t: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] };

const MAX_DEPTH = 6;
/**
 * A fence: its run, its language, and whatever else its line says (never a backtick: that's inline code). No two
 * parts can match the same spaces, so a line is read in linear time, whatever a model writes on it.
 */
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*(?:([\w+#.-]+)(?:\s+([^`\s](?:[^`]*[^`\s])?))?\s*)?$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

export function parseMarkdown(source: string, depth = 0): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  const startsBlock = (line: string, next: string | undefined): boolean =>
    FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || BULLET.test(line) || ORDERED.test(line) || isTableStart(line, next);

  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = line.match(FENCE);
    if (fence) {
      const marker = fence[1]!;
      const body: string[] = [];
      i++;
      let open = true;
      while (i < lines.length) {
        const l = lines[i]!;
        if (l.trim().startsWith(marker[0]!.repeat(marker.length)) && /^\s*[`~]+\s*$/.test(l)) {
          open = false;
          i++;
          break;
        }
        body.push(l);
        i++;
      }
      // An answer block written on one line (```choices ["a","b"]) has its JSON on the fence line and nothing inside.
      const lang = fence[2] ?? "", v = body.join("\n"), said = fence[3] ?? "";
      blocks.push({ t: "code", lang, v: !v.trim() && said && isBlockKind(lang.toLowerCase()) ? said : v, open });
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      blocks.push({ t: "h", level: heading[1]!.length, c: parseInline(heading[2] ?? "") });
      i++;
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ t: "hr" });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && lines[i]!.trim() && QUOTE.test(lines[i]!)) body.push(lines[i++]!.match(QUOTE)![1]!);
      blocks.push(depth < MAX_DEPTH ? { t: "quote", c: parseMarkdown(body.join("\n"), depth + 1) } : { t: "p", c: [{ t: "text", v: body.join("\n") }] });
      continue;
    }

    if (isTableStart(line, lines[i + 1])) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]!).map(alignment);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) {
        const cells = splitRow(lines[i++]!);
        rows.push(head.map((_, col) => parseInline(cells[col] ?? "")));
      }
      blocks.push({ t: "table", align: head.map((_, col) => align[col] ?? null), head: head.map((cell) => parseInline(cell)), rows });
      continue;
    }

    const listMatch = line.match(BULLET) ?? line.match(ORDERED);
    if (listMatch) {
      const ordered = !BULLET.test(line);
      const baseIndent = listMatch[1]!.length;
      const items: string[][] = [];
      let start = ordered ? Number(listMatch[2]) : 1;
      while (i < lines.length) {
        const l = lines[i]!;
        const m = ordered ? l.match(ORDERED) : l.match(BULLET);
        if (m && m[1]!.length <= baseIndent + 1) {
          items.push([m[3]!]);
          i++;
          continue;
        }
        if (!l.trim()) {
          // A blank line ends the list unless the next line continues it (indented or another item).
          const next = lines[i + 1];
          if (next !== undefined && (indentOf(next) > baseIndent || (ordered ? ORDERED : BULLET).test(next))) {
            items.at(-1)?.push("");
            i++;
            continue;
          }
          break;
        }
        if (indentOf(l) > baseIndent && items.length) {
          items.at(-1)!.push(l.slice(Math.min(indentOf(l), baseIndent + 2)));
          i++;
          continue;
        }
        if (items.length && !startsBlock(l, lines[i + 1])) {
          items.at(-1)!.push(l.trim()); // lazy continuation
          i++;
          continue;
        }
        break;
      }
      if (ordered && !Number.isFinite(start)) start = 1;
      blocks.push({
        t: "list",
        ordered,
        start,
        items: items.map((item) => (depth < MAX_DEPTH ? parseMarkdown(item.join("\n"), depth + 1) : [{ t: "p", c: [{ t: "text", v: item.join("\n") }] }])),
      });
      continue;
    }

    // Paragraph: until a blank line or the start of another block.
    const body: string[] = [line.trim()];
    i++;
    while (i < lines.length && lines[i]!.trim() && !startsBlock(lines[i]!, lines[i + 1])) body.push(lines[i++]!.trim());
    blocks.push({ t: "p", c: parseInline(body.join("\n")) });
  }
  return blocks;
}

function indentOf(line: string): number {
  return line.match(/^\s*/)![0].replace(/\t/g, "    ").length;
}

function isTableStart(line: string, next: string | undefined): boolean {
  return line.includes("|") && next !== undefined && TABLE_SEP.test(next) && next.includes("-");
}

function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  let inCode = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i]!;
    if (ch === "\\" && row[i + 1] === "|") {
      current += "|";
      i++;
    } else if (ch === "`") {
      inCode = !inCode;
      current += ch;
    } else if (ch === "|" && !inCode) {
      cells.push(current.trim());
      current = "";
    } else current += ch;
  }
  cells.push(current.trim());
  return cells;
}

function alignment(cell: string): Align {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  return left && right ? "center" : right ? "right" : left ? "left" : null;
}

const URL_RE = /^https?:\/\/[^\s<>"'`]+/i;

/** Only absolute http(s) URLs are ever linked. */
export function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function parseInline(source: string, depth = 0, inLink = false): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ t: "text", v: text });
    text = "";
  };
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    const rest = source.slice(i);

    if (ch === "\n") {
      flush();
      out.push({ t: "br" });
      i++;
      continue;
    }

    if (ch === "\\" && i + 1 < source.length && /[\\`*_~[\]()#>|-]/.test(source[i + 1]!)) {
      text += source[i + 1];
      i += 2;
      continue;
    }

    if (ch === "`") {
      const run = rest.match(/^`+/)![0];
      const end = source.indexOf(run, i + run.length);
      if (end > 0) {
        flush();
        let code = source.slice(i + run.length, end);
        if (/^ .* $/.test(code)) code = code.slice(1, -1);
        out.push({ t: "code", v: code });
        i = end + run.length;
        continue;
      }
      text += run;
      i += run.length;
      continue;
    }

    if (depth < MAX_DEPTH && (ch === "*" || ch === "_" || ch === "~")) {
      const strong = delimited(source, i, "**") ?? delimited(source, i, "__", true);
      if (strong) {
        flush();
        out.push({ t: "strong", c: parseInline(strong.inner, depth + 1, inLink) });
        i = strong.end;
        continue;
      }
      const del = delimited(source, i, "~~");
      if (del) {
        flush();
        out.push({ t: "del", c: parseInline(del.inner, depth + 1, inLink) });
        i = del.end;
        continue;
      }
      const em = delimited(source, i, "*") ?? delimited(source, i, "_", true);
      if (em) {
        flush();
        out.push({ t: "em", c: parseInline(em.inner, depth + 1, inLink) });
        i = em.end;
        continue;
      }
    }

    if (ch === "[" && !inLink) {
      const link = rest.match(/^\[([^\]\n]{1,500})\]\(\s*([^()\s]{1,2000})\s*\)/);
      if (link) {
        const href = safeHref(link[2]!);
        flush();
        if (href && depth < MAX_DEPTH) out.push({ t: "link", href, c: parseInline(link[1]!, depth + 1, true) });
        else out.push({ t: "text", v: link[0] });
        i += link[0].length;
        continue;
      }
    }

    if (!inLink && (ch === "h" || ch === "H") && (i === 0 || /[\s(<]/.test(source[i - 1]!))) {
      const url = rest.match(URL_RE);
      if (url) {
        const raw = url[0].replace(/[.,;:!?)\]]+$/, "");
        const href = safeHref(raw);
        if (href) {
          flush();
          out.push({ t: "link", href, c: [{ t: "text", v: raw }] });
          i += raw.length;
          continue;
        }
      }
    }

    text += ch;
    i++;
  }
  flush();
  return out;
}

/*
 * Emphasis needs a closing delimiter nearby, on the same paragraph, with no space just
 * inside it. The search is bounded (a few candidate closers within a short distance) so
 * parsing stays linear: chat re-parses the whole answer on every frame while it streams.
 */
const MAX_CLOSERS = 8;
const MAX_SPAN = 2000;

function delimited(source: string, i: number, marker: string, wordBoundary = false): { inner: string; end: number } | null {
  if (!source.startsWith(marker, i)) return null;
  if (marker.length === 1 && source[i + 1] === marker) return null; // ** handled by the strong rule
  if (wordBoundary && i > 0 && /[A-Za-z0-9]/.test(source[i - 1]!)) return null;
  const open = i + marker.length;
  if (open >= source.length || /\s/.test(source[open]!)) return null;
  let search = open;
  for (let attempt = 0; attempt < MAX_CLOSERS; attempt++) {
    const close = source.indexOf(marker, search);
    if (close < 0 || close - open > MAX_SPAN) return null;
    const after = source[close + marker.length];
    const validClose =
      close > open &&
      !/\s/.test(source[close - 1]!) &&
      !(marker.length === 1 && after === marker) &&
      !(wordBoundary && after !== undefined && /[A-Za-z0-9]/.test(after));
    if (validClose) {
      const inner = source.slice(open, close);
      if (!inner.includes("\n\n")) return { inner, end: close + marker.length };
    }
    search = close + marker.length;
  }
  return null;
}

/** Plain text of inlines, for copy and aria labels. */
export function inlineText(inlines: Inline[]): string {
  return inlines.map((n) => (n.t === "text" || n.t === "code" ? n.v : n.t === "br" ? "\n" : inlineText(n.c))).join("");
}
