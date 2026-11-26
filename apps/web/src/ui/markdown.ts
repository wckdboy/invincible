import { highlight } from "../lib/highlight.ts";
import { type Block, type Inline, parseMarkdown } from "../lib/markdown.ts";
import { matchRanges } from "../lib/text.ts";
import { type BlockOptions, drawBlock } from "./blocks.ts";
import { copyText } from "./controls.ts";
import { h } from "./dom.ts";
import { icon } from "./icons.ts";

/*
 * AST → DOM with createElement and textContent only. There is no path from
 * model output to innerHTML. Links are http(s) only, open in a new tab with
 * no referrer or opener, and show their host when the text says otherwise.
 * A fenced block a model may show as more than code (a chart, figures, choices,
 * steps, a page) is drawn by ui/blocks.ts; a page is the one thing parsed as
 * HTML, and only inside a frame sealed off from the app.
 */

/**
 * True only when the link's text is itself a URL on the very host it points to. Anything
 * else ("click here", or a look-alike URL that points somewhere different) shows the real host.
 */
function textNamesHost(children: Inline[], host: string): boolean {
  if (children.length !== 1 || children[0]!.t !== "text") return false;
  try {
    const url = new URL(children[0]!.v.trim());
    return (url.protocol === "https:" || url.protocol === "http:") && url.host === host;
  } catch {
    return false;
  }
}

function inlines(nodes: Inline[]): Node[] {
  return nodes.map((node): Node => {
    switch (node.t) {
      case "text":
        return document.createTextNode(node.v);
      case "br":
        return h("br");
      case "code":
        return h("code", {}, node.v);
      case "strong":
        return h("strong", {}, ...inlines(node.c));
      case "em":
        return h("em", {}, ...inlines(node.c));
      case "del":
        return h("del", {}, ...inlines(node.c));
      case "link": {
        const host = new URL(node.href).host;
        const fragment = document.createDocumentFragment();
        fragment.append(
          h("a", { href: node.href, target: "_blank", rel: "noopener noreferrer nofollow", title: node.href }, ...inlines(node.c)),
          textNamesHost(node.c, host) ? "" : h("span", { class: "host" }, `(${host})`),
        );
        return fragment;
      }
    }
  });
}

export function codeBlock(block: { lang: string; v: string }): HTMLElement {
  const copy = h("button", { class: "btn ghost sm", type: "button", "aria-label": "Copy code" }, icon("copy", { size: 13 }), h("span", {}, "Copy"));
  copy.addEventListener("click", () => void copyText(block.v, "Code copied"));
  return h(
    "div",
    { class: "codeblock" },
    h("div", { class: "cb-head" }, h("span", { class: "mono" }, block.lang || "text"), copy),
    // Coloured by what each part is (lib/highlight.ts): still only text nodes, in spans of a class.
    h("pre", { tabindex: 0 }, h("code", {}, ...highlight(block.v, block.lang).map((piece) => (piece.tone ? h("span", { class: `tok-${piece.tone}` }, piece.text) : piece.text)))),
  );
}

function blocks(list: Block[], options: BlockOptions): Node[] {
  return list.map((block): Node => {
    switch (block.t) {
      case "p":
        return h("p", {}, ...inlines(block.c));
      case "h": {
        // Chat headings stay modest: # → h3 … ###### → h6.
        const level = Math.min(6, block.level + 2) as 3 | 4 | 5 | 6;
        return h(`h${level}`, {}, ...inlines(block.c));
      }
      case "code":
        return drawBlock(block, options, codeBlock) ?? codeBlock(block);
      case "list": {
        const items = block.items.map((item) => h("li", {}, ...blocks(item, options)));
        return block.ordered ? h("ol", { start: block.start !== 1 ? block.start : null }, ...items) : h("ul", {}, ...items);
      }
      case "quote":
        return h("blockquote", {}, ...blocks(block.c, options));
      case "hr":
        return h("hr");
      case "table":
        return h(
          "div",
          { class: "table-wrap" },
          h(
            "table",
            {},
            h("thead", {}, h("tr", {}, ...block.head.map((cell, i) => h("th", { style: block.align[i] ? `text-align:${block.align[i]}` : null }, ...inlines(cell))))),
            h("tbody", {}, ...block.rows.map((row) => h("tr", {}, ...row.map((cell, i) => h("td", { style: block.align[i] ? `text-align:${block.align[i]}` : null }, ...inlines(cell)))))),
          ),
        );
    }
  });
}

export function renderMarkdown(source: string, options: BlockOptions = {}): DocumentFragment {
  const fragment = document.createDocumentFragment();
  fragment.append(...blocks(parseMarkdown(source), options));
  return fragment;
}

/** Plain text with search terms wrapped in <mark>, built from text nodes. */
export function highlighted(text: string, query: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  let at = 0;
  for (const [start, end] of matchRanges(text, query)) {
    if (start > at) fragment.append(text.slice(at, start));
    fragment.append(h("mark", { class: "hl" }, text.slice(start, end)));
    at = end;
  }
  if (at < text.length) fragment.append(text.slice(at));
  return fragment;
}
