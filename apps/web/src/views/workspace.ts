import type { TeamChangesView, TeamFilesView, TeamFileView } from "@galahad/core";
import { type Ctx, errorMessage } from "../context.ts";
import { bytesLabel } from "../lib/artifacts.ts";
import { languageOf } from "../lib/highlight.ts";
import { button, callout, empty, segmented, skeletonRows } from "../ui/controls.ts";
import { openSheet } from "../ui/dialog.ts";
import { h, replace } from "../ui/dom.ts";
import { icon } from "../ui/icons.ts";
import { codeBlock, renderMarkdown } from "../ui/markdown.ts";

/*
 * A knight's workspace, read (POST /api/team/files, /file and /changes; the Apple apps' Workspace, the terminal's
 * `galahad roundtable files|read|changes`): its folders and files, a file as its code in colour (Markdown drawn, a
 * picture shown), and what its latest task changed, each file's part of the diff. In a sheet that moves within itself,
 * with Back; nothing here writes.
 */

type Page = { kind: "folder"; path: string } | { kind: "file"; path: string } | { kind: "changes" } | { kind: "diff"; title: string; text: string };

const nameOf = (path: string) => path.split("/").filter(Boolean).at(-1) ?? "/work";

/** Each `diff --git a/… b/…` part of a diff, by the path it is about (the Apple apps' DiffParts). */
function diffParts(diff: string): Map<string, string> {
  const parts = new Map<string, string>();
  let path: string | null = null;
  let lines: string[] = [];
  const close = () => { if (path !== null && lines.length) parts.set(path, lines.join("\n")); };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      close();
      const b = line.indexOf(" b/");
      path = b >= 0 ? line.slice(b + 3) : line.slice("diff --git ".length);
      lines = [line];
    } else if (path !== null) lines.push(line);
  }
  close();
  return parts;
}

/** `task`: what that task changed, rather than the knight's latest (a task's own page opens it so). */
export function openWorkspace(ctx: Ctx, knight: { id: string; name: string }, start: "files" | "changes" = "files", task?: string): void {
  const sheet = openSheet({ title: `${knight.name}'s workspace`, description: task ? "Read only: its files, and what this task changed." : "Read only: its files, and what its latest task changed.", size: "wide", body: h("div") });
  const stack: Page[] = [start === "files" ? { kind: "folder", path: "/work" } : { kind: "changes" }];
  const shown = segmented<"files" | "changes">(
    [
      { value: "files", label: "Files" },
      { value: "changes", label: "Changes" },
    ],
    start,
    (value) => {
      stack.splice(0, stack.length, value === "files" ? { kind: "folder", path: "/work" } : { kind: "changes" });
      void draw();
    },
    { label: "Show", small: true },
  );
  const head = h("div", { class: "row between" });
  const page = h("div", { class: "stack" });
  replace(sheet.body, h("div", { class: "stack loose" }, head, page));
  const open = (next: Page) => {
    stack.push(next);
    void draw();
  };
  let drawn = 0;

  async function draw(): Promise<void> {
    const mine = ++drawn;
    const top = stack.at(-1)!;
    const back = stack.length > 1 ? button("Back", { size: "sm", variant: "ghost", icon: "chevron-left", onClick: () => { stack.pop(); void draw(); } }) : null;
    const title = top.kind === "folder" ? (top.path === "/work" ? "/work" : top.path) : top.kind === "file" ? top.path : top.kind === "diff" ? top.title : "Its latest task";
    replace(head, h("div", { class: "row tight grow" }, back, h("strong", { class: "mono ellipsis" }, title)), stack.length === 1 ? shown.el : null);
    replace(page, skeletonRows(4));
    try {
      const body = await pageOf(top);
      if (mine === drawn && !sheet.scope.disposed) replace(page, body);
    } catch (error) {
      if (mine === drawn && !sheet.scope.disposed) replace(page, callout("warn", errorMessage(error), { title: "It couldn't be read" }));
    }
  }

  async function pageOf(top: Page): Promise<HTMLElement> {
    switch (top.kind) {
      case "folder": {
        const view = await ctx.api.post<TeamFilesView>("/api/team/files", { id: knight.id, path: top.path });
        if (!view.entries.length) return empty({ icon: "folder", title: "Nothing here yet", body: `${top.path} is empty.`, compact: true });
        return h(
          "div",
          { class: "card flat" },
          h(
            "div",
            { class: "rows" },
            ...view.entries.map((entry) => {
              const full = top.path === "/work" ? `/work/${entry.name}` : `${top.path}/${entry.name}`;
              const row = h(
                "button",
                { class: "item center workspace-entry", type: "button", disabled: entry.kind === "other" },
                icon(entry.kind === "dir" ? "folder" : "file", { size: 16 }),
                h("span", { class: "grow ellipsis" }, entry.name),
                entry.kind === "file" ? h("span", { class: "tiny subtle tnum" }, bytesLabel(entry.size)) : null,
                icon("chevron-right", { size: 14, class: "subtle" }),
              );
              row.addEventListener("click", () => open(entry.kind === "dir" ? { kind: "folder", path: full } : { kind: "file", path: full }));
              return row;
            }),
            view.more ? h("p", { class: "tiny subtle" }, `Only its first ${view.entries.length} entries are listed.`) : null,
          ),
        );
      }
      case "file": {
        const file = await ctx.api.post<TeamFileView>("/api/team/file", { id: knight.id, path: top.path });
        const notes = [file.cut ? `Only its beginning is here: it is ${bytesLabel(file.size)}.` : null, file.redacted ? "Something that looked like a key was redacted." : null].filter(Boolean).join(" ");
        const said = notes ? h("p", { class: "tiny subtle" }, notes) : null;
        if (file.kind === "text") {
          const text = file.text ?? "";
          const markdown = /\.(md|markdown)$/i.test(top.path);
          return h("div", { class: "stack" }, said, markdown ? h("div", { class: "md" }, renderMarkdown(text)) : codeBlock({ lang: languageOf(top.path), v: text }));
        }
        if (file.kind === "image" && file.data && file.type) return h("div", { class: "stack" }, h("img", { class: "attached-large", src: `data:${file.type};base64,${file.data}`, alt: nameOf(top.path) }));
        return empty({ icon: "file", title: file.kind === "large" ? "Too big to show here" : "Not text", body: `${bytesLabel(file.size)}${file.kind === "large" ? ": a picture past what is shown here." : " that isn't text or a picture."}`, compact: true });
      }
      case "changes": {
        const changes = await ctx.api.post<TeamChangesView>("/api/team/changes", { id: knight.id, ...(task ? { task } : {}) });
        const parts = diffParts(changes.diff);
        const from = changes.base ? `from ${changes.base.slice(0, 8)}` : "since its last commit";
        const rows = [
          ...changes.files.map((file) => {
            const part = parts.get(file.path);
            const row = h(
              "button",
              { class: "item center workspace-entry", type: "button", disabled: !part },
              h("span", { class: "mono tiny subtle workspace-status" }, file.status),
              h("span", { class: "grow ellipsis mono small" }, file.path),
              file.added === null ? h("span", { class: "tiny subtle" }, "binary") : h("span", { class: "tiny tnum" }, h("span", { class: "tok-added-text" }, `+${file.added}`), " ", h("span", { class: "tok-removed-text" }, `−${file.removed}`)),
              icon("chevron-right", { size: 14, class: "subtle" }),
            );
            if (part) row.addEventListener("click", () => open({ kind: "diff", title: file.path, text: part }));
            return row;
          }),
          ...changes.untracked.map((file) => h("div", { class: "item center workspace-entry" }, h("span", { class: "mono tiny subtle workspace-status" }, "?"), h("span", { class: "grow ellipsis mono small" }, file))),
        ];
        const whole = changes.diff ? button("The whole diff", { size: "sm", icon: "file", onClick: () => open({ kind: "diff", title: "The whole diff", text: changes.diff }) }) : null;
        return h(
          "div",
          { class: "stack" },
          h("p", { class: "small muted" }, `${changes.task ? (task ? "This task" : "Its latest task") : "Its repository"}, ${from}.`, changes.cut ? " The diff is cut: only its beginning is here." : "", changes.redacted ? " Something that looked like a key was redacted." : ""),
          rows.length ? h("div", { class: "card flat" }, h("div", { class: "rows" }, ...rows)) : empty({ icon: "check", title: "Nothing changed yet", compact: true }),
          whole ? h("div", { class: "row" }, whole) : null,
        );
      }
      case "diff":
        return codeBlock({ lang: "diff", v: top.text });
    }
  }

  void draw();
}
