import type { ArtifactView, SandboxView } from "@galahad/core";
import { ApiError, isUnavailable } from "../api.ts";
import { type Ctx, errorMessage, type View } from "../context.ts";
import {
  type ArtifactFile,
  archiveName,
  baseName,
  bytesLabel,
  canDownloadAll,
  fileKind,
  type FileKind,
  groupFiles,
  imageDataUrl,
  previewText,
  removeName,
  sha256Hex,
  shortSha,
  shownAs,
  tarArchive,
} from "../lib/artifacts.ts";
import { plural } from "../lib/text.ts";
import { absoluteTime, relativeTime } from "../lib/time.ts";
import { badge, busy, button, callout, empty, errorState, field, formActions, pageHead, skeletonRows, spinner } from "../ui/controls.ts";
import { confirmAction, openSheet } from "../ui/dialog.ts";
import { h, keepPlace, replace } from "../ui/dom.ts";
import { icon, type IconName } from "../ui/icons.ts";
import { renderMarkdown } from "../ui/markdown.ts";
import { signal } from "../ui/signal.ts";
import { toast } from "../ui/toast.ts";

/*
 * Artifacts: a sandbox's work products, kept after the sandbox is gone. Every
 * quest keeps its /work/out; you can keep any folder of a running sandbox. The
 * mind records each file's path, size and SHA-256; the node that holds the files
 * serves them. Here they're listed, previewed and saved, and every file fetched
 * is checked against its recorded SHA-256. Nothing is ever rendered as HTML:
 * HTML and SVG show as source, and only raster images go in an <img>.
 */

/** Bumped when work is kept or removed. */
export const artifactsChanged = signal(0);

/** Previews fetch the whole file: past this, it's saved instead. */
const PREVIEW_MAX = 20 * 2 ** 20;

export async function loadArtifacts(ctx: Ctx, abort?: AbortSignal): Promise<ArtifactView[]> {
  const { artifacts } = await ctx.api.get<{ artifacts: ArtifactView[] }>("/api/artifacts", abort);
  return [...artifacts].sort((a, b) => b.savedAt - a.savedAt);
}

/** One file's bytes, and whether they match the SHA-256 recorded when it was kept. */
async function fetchFile(ctx: Ctx, a: ArtifactView, f: ArtifactFile, abort?: AbortSignal): Promise<{ data: Uint8Array; type: string; matches: boolean }> {
  const { data, type } = await ctx.api.bytes("/api/artifacts/file", { id: a.id, path: f.path }, abort);
  return { data, type, matches: (await sha256Hex(data)) === f.sha256.toLowerCase() };
}

/** Save bytes as a file. Always as octet-stream, so even an HTML file can only ever be saved, never opened here. */
function saveBytes(name: string, data: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([data as Uint8Array<ArrayBuffer>], { type: "application/octet-stream" }));
  const link = h("a", { href: url, download: name, hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

const KIND_ICON: Record<FileKind, IconName> = { markdown: "scroll", source: "code", text: "file", image: "eye", download: "download" };
const where = (a: ArtifactView) => `Its files are on ${a.nodeName}. This node keeps only the record: open Galahad on ${a.nodeName} to preview or save them.`;

/** One artifact: its files grouped by folder, previews, verified downloads, and (for you) Remove. */
export function openArtifact(ctx: Ctx, a: ArtifactView): void {
  let elsewhere = !a.here;
  const note = h("div");
  const preview = h("div", { class: "stack tight", "aria-live": "polite" });
  const list = h("div", { class: "stack" });
  const admin = ctx.can("fleet:admin");

  const mismatch = (f: ArtifactFile, save?: () => void) =>
    callout(
      "danger",
      h(
        "span",
        {},
        h("span", { class: "mono" }, f.path),
        " doesn't match the SHA-256 recorded when it was kept. It may have been changed or damaged on ",
        a.nodeName,
        ". Use it with care.",
      ),
      { title: "This file isn't what was kept", actions: save ? button("Save it anyway", { size: "sm", variant: "danger", icon: "download", onClick: save }) : null },
    );

  /** A 421 means the files are elsewhere after all: say so once, and stop offering previews. */
  const failed = (error: unknown, title: string) => {
    if (error instanceof ApiError && error.status === 421) {
      elsewhere = true;
      replace(note, callout("info", where(a), { title: "Not on this node" }));
      renderList();
      replace(preview);
      return;
    }
    replace(preview, callout("danger", errorMessage(error), { title }));
  };

  async function show(f: ArtifactFile, trigger: HTMLButtonElement): Promise<void> {
    await busy(trigger, async () => {
      replace(preview, h("p", { class: "small muted row" }, spinner("sm"), `Fetching ${baseName(f.path)}…`));
      try {
        const got = await fetchFile(ctx, a, f, sheet.scope.signal);
        if (sheet.scope.disposed) return;
        const kind = shownAs(fileKind(f.path), got.type);
        const head = h(
          "div",
          { class: "row wrap between" },
          h("span", { class: "mono strong small wrap-anywhere" }, f.path),
          got.matches ? badge("SHA-256 matches", "ok", "shield-check") : badge("SHA-256 differs", "danger", "alert"),
        );
        const save = button(`Save ${baseName(f.path)}`, { size: "sm", icon: "download", onClick: () => saveBytes(baseName(f.path), got.data) });
        let body: HTMLElement;
        if (kind === "image") {
          const url = imageDataUrl(got.data, got.type);
          body = url ? h("img", { class: "preview-img", src: url, alt: f.path }) : callout("quiet", "This one can only be saved.");
        } else if (kind === "download") {
          body = callout("quiet", "The node sends this one only as a file to save, so it isn't shown here.");
        } else {
          const { text, clipped } = previewText(got.data);
          body = h(
            "div",
            { class: "stack tight" },
            kind === "markdown"
              ? h("div", { class: "md card flat pad" }, renderMarkdown(text))
              : h("pre", { class: "result" }, text),
            kind === "source" ? h("p", { class: "tiny subtle" }, "Shown as source: HTML and SVG never run here.") : null,
            clipped ? h("p", { class: "tiny subtle" }, "Only the first 512 KB is shown. Save it to see the rest.") : null,
          );
        }
        replace(preview, head, got.matches ? null : mismatch(f), body, h("div", { class: "row end" }, save));
        preview.scrollIntoView({ block: "nearest" });
      } catch (error) {
        if (!sheet.scope.disposed) failed(error, `Couldn't fetch ${baseName(f.path)}`);
      }
    });
  }

  async function download(f: ArtifactFile, trigger: HTMLButtonElement): Promise<void> {
    await busy(trigger, async () => {
      try {
        const got = await fetchFile(ctx, a, f, sheet.scope.signal);
        if (sheet.scope.disposed) return;
        if (got.matches) {
          saveBytes(baseName(f.path), got.data);
          replace(preview, callout("ok", h("span", {}, "Saved ", h("span", { class: "mono" }, baseName(f.path)), ". Its SHA-256 matches what was kept.")));
        } else replace(preview, mismatch(f, () => saveBytes(baseName(f.path), got.data)));
      } catch (error) {
        if (!sheet.scope.disposed) failed(error, `Couldn't save ${baseName(f.path)}`);
      }
    });
  }

  async function downloadAll(trigger: HTMLButtonElement): Promise<void> {
    await busy(trigger, async () => {
      const entries: { path: string; bytes: Uint8Array }[] = [];
      const differs: string[] = [];
      const progress = h("p", { class: "small muted tnum" });
      replace(preview, progress);
      try {
        for (const [i, f] of a.files.entries()) {
          progress.textContent = `Fetching and checking ${i + 1} of ${a.files.length}…`;
          const got = await fetchFile(ctx, a, f, sheet.scope.signal);
          if (got.matches) entries.push({ path: f.path, bytes: got.data });
          else differs.push(f.path);
        }
      } catch (error) {
        if (!sheet.scope.disposed) failed(error, "Couldn't fetch every file");
        return;
      }
      if (sheet.scope.disposed) return;
      const { tar, skipped } = tarArchive(entries);
      saveBytes(archiveName(a.label), tar);
      replace(
        preview,
        callout("ok", `Saved ${archiveName(a.label)}: ${plural(entries.length - skipped.length, "file")}, each checked against its SHA-256.`),
        differs.length
          ? callout("danger", h("span", {}, "Left out because they don't match what was kept: ", h("span", { class: "mono" }, differs.join(", ")), "."), { title: "Some files aren't what was kept" })
          : null,
        skipped.length ? callout("warn", h("span", {}, "Paths too long for a tar file, left out: ", h("span", { class: "mono" }, skipped.join(", ")), ". Save them one by one.")) : null,
      );
    });
  }

  async function remove(): Promise<void> {
    const ok = await confirmAction({
      title: `Remove "${a.label}"?`,
      body: [
        h(
          "p",
          {},
          `${a.count === 1 ? `Its one file (${bytesLabel(a.bytes)}) is` : `Its ${a.count} files (${bytesLabel(a.bytes)}) are`} deleted from ${a.nodeName} for good, and the record goes from every device.`,
        ),
        h("p", {}, "Save anything you still need first."),
      ],
      confirmLabel: "Remove for good",
      typeToConfirm: removeName(a),
    });
    if (!ok) return;
    try {
      await ctx.api.post("/api/artifacts/remove", { id: a.id });
      sheet.close();
      artifactsChanged.update((n) => n + 1);
      toast("Removed", { tone: "ok", description: `${a.label}: its files are gone from ${a.nodeName}.` });
    } catch (error) {
      replace(note, callout("danger", errorMessage(error), { title: "Not removed" }));
    }
  }

  function fileRow(f: ArtifactFile): HTMLElement {
    const kind = fileKind(f.path);
    const previewable = kind !== "download" && f.size <= PREVIEW_MAX;
    return h(
      "div",
      { class: "item center" },
      h("span", { class: "avatar", title: kind }, icon(KIND_ICON[kind], { size: 14 })),
      h(
        "div",
        { class: "grow" },
        h("div", { class: "mono small strong wrap-anywhere" }, baseName(f.path)),
        h("div", { class: "meta" }, h("span", { class: "tnum" }, bytesLabel(f.size)), h("span", { class: "mono", title: `SHA-256 ${f.sha256}` }, shortSha(f.sha256))),
      ),
      h(
        "div",
        { class: "item-actions" },
        previewable ? button("Preview", { size: "sm", variant: "ghost", icon: "eye", disabled: elsewhere, label: `Preview ${f.path}`, onClick: (e) => void show(f, e.currentTarget as HTMLButtonElement) }) : null,
        button("Save", { size: "sm", variant: "ghost", icon: "download", iconOnly: true, disabled: elsewhere, label: `Save ${f.path}`, onClick: (e) => void download(f, e.currentTarget as HTMLButtonElement) }),
      ),
    );
  }

  function renderList(): void {
    // One list; a folder is a quiet header row above its files.
    const folder = (dir: string) =>
      h("div", { class: "item dir-row" }, icon("layers", { size: 12 }), `${dir}/`);
    replace(
      list,
      h("div", { class: "card flat" }, h("div", { class: "rows" }, ...groupFiles(a.files).flatMap((g) => [g.dir ? folder(g.dir) : null, ...g.files.map(fileRow)]))),
      a.count > a.files.length ? h("p", { class: "tiny subtle" }, `Showing ${a.files.length} of ${a.count} files. ${a.nodeName} keeps them all.`) : null,
    );
  }

  if (elsewhere) replace(note, callout("info", where(a), { title: "Not on this node" }));
  renderList();
  const all = canDownloadAll(a) ? button("Download all", { size: "sm", icon: "download", disabled: elsewhere, onClick: (e) => void downloadAll(e.currentTarget as HTMLButtonElement) }) : null;
  const sheet = openSheet({
    title: a.label,
    description: `${a.quest ? `From quest ${a.quest}` : "Kept by hand"} · ${relativeTime(a.savedAt)} · on ${a.nodeName}`,
    size: "wide",
    body: h(
      "div",
      { class: "stack loose" },
      h(
        "dl",
        { class: "kv" },
        h("dt", {}, "Files"),
        h("dd", { class: "tnum" }, `${plural(a.count, "file")} · ${bytesLabel(a.bytes)}`),
        h("dt", {}, "Kept"),
        h("dd", {}, absoluteTime(a.savedAt)),
        h("dt", {}, "On"),
        h("dd", {}, a.nodeName, a.here ? h("span", { class: "subtle" }, " (this node)") : null),
        a.sandbox ? h("dt", {}, "Sandbox") : null,
        a.sandbox ? h("dd", { class: "mono" }, a.sandbox) : null,
        h("dt", {}, "Id"),
        h("dd", { class: "mono" }, a.id),
      ),
      note,
      h(
        "div",
        { class: "row wrap" },
        h("span", { class: "small muted grow" }, "Every file is checked against its recorded SHA-256 when it's fetched."),
        all,
        admin ? button("Remove…", { size: "sm", variant: "danger", icon: "trash", onClick: () => void remove() }) : null,
      ),
      list,
      preview,
    ),
  });
}

/** Keep a running sandbox's work (a folder under /work, by default /work/out) after it's gone. */
export function openKeepWork(ctx: Ctx, sandbox: SandboxView, on: string | null): void {
  const folder = h("input", { class: "input mono", type: "text", value: "/work/out", autocomplete: "off", autocorrect: "off", spellcheck: "false", autocapitalize: "off", maxlength: 256 });
  const label = h("input", { class: "input", type: "text", autocomplete: "off", maxlength: 200, placeholder: sandbox.quest || sandbox.name });
  const status = h("div");
  const keep = button("Keep it", { variant: "primary", type: "submit", icon: "archive" });
  const body = h(
    "form",
    {
      class: "stack loose",
      autocomplete: "off",
      onsubmit: (event: Event) => {
        event.preventDefault();
        replace(status);
        const path = folder.value.trim();
        if (!/^\/work(\/[A-Za-z0-9._ -]+)*\/?$/.test(path) || path.split("/").some((part) => part === "." || part === "..")) {
          replace(status, callout("warn", "Choose a folder under /work, such as /work/out (letters, digits, . _ - and spaces)."));
          folder.focus();
          return;
        }
        void busy(keep, async () => {
          replace(status, h("p", { class: "small muted row" }, spinner("sm"), "Copying its files out… a large folder takes a while."));
          try {
            const { artifact } = await ctx.api.post<{ artifact: ArtifactView | null }>("/api/artifacts/save", {
              sandbox: sandbox.id,
              ...(path !== "/work/out" ? { path } : {}),
              ...(label.value.trim() ? { label: label.value.trim() } : {}),
              ...(on ? { on } : {}),
            });
            if (sheet.scope.disposed) return;
            if (!artifact) {
              replace(status, callout("info", h("span", {}, "Nothing to keep: ", h("span", { class: "mono" }, path), " is empty or missing.")));
              return;
            }
            sheet.close();
            artifactsChanged.update((n) => n + 1);
            toast(`Kept: ${artifact.label}`, {
              tone: "ok",
              description: `${plural(artifact.count, "file")}, ${bytesLabel(artifact.bytes)}, on ${artifact.nodeName}. It stays after the sandbox is gone.`,
              action: { label: "Open", run: () => ctx.navigate("artifacts", { intent: artifact.id }) },
            });
          } catch (error) {
            if (!sheet.scope.disposed) replace(status, callout("danger", errorMessage(error), { title: "Nothing was kept" }));
          }
        });
      },
    },
    field("Folder", folder, { hint: "A folder under /work. Quests write their results to /work/out." }),
    field("Label (optional)", label, { hint: "How it shows up under Artifacts." }),
    callout("quiet", `Galahad copies the files out and keeps them on ${sandbox.node} after the sandbox is gone, up to 512 MB and 5,000 files, each with its SHA-256.`),
    status,
    formActions(button("Cancel", { onClick: () => sheet.close() }), keep),
  );
  const sheet = openSheet({ title: `Keep ${sandbox.name}'s work`, description: "Its results, kept after the sandbox is gone.", body, size: "small", initialFocus: () => folder });
}

export const artifactsView: View = (root, ctx, { scope, opts }) => {
  const box = h("div", { class: "card" }, skeletonRows(4, { avatar: true }));
  let opened = false;

  function row(a: ArtifactView): HTMLElement {
    return h(
      "button",
      { class: "item item-button", type: "button", "data-key": a.id, "aria-label": `${a.label}, ${plural(a.count, "file")}`, onclick: () => openArtifact(ctx, a) },
      h("span", { class: "avatar" }, icon("archive", { size: 14 })),
      h(
        "div",
        { class: "grow" },
        h("div", { class: "row wrap" }, h("span", { class: "strong small" }, a.label), a.here ? null : badge(`on ${a.nodeName}`, "neutral")),
        h(
          "div",
          { class: "meta" },
          a.quest ? h("span", {}, "quest ", h("span", { class: "mono" }, a.quest)) : h("span", {}, "kept by hand"),
          h("span", { title: absoluteTime(a.savedAt) }, relativeTime(a.savedAt)),
          h("span", { class: "tnum" }, `${plural(a.count, "file")} · ${bytesLabel(a.bytes)}`),
          a.here ? h("span", {}, `on ${a.nodeName}`) : null,
        ),
      ),
      icon("chevron-right", { size: 16, class: "subtle" }),
    );
  }

  async function refresh(): Promise<void> {
    try {
      const list = await loadArtifacts(ctx, scope.signal);
      if (scope.disposed) return;
      keepPlace(box, () =>
        replace(
          box,
          list.length
            ? h("div", { class: "rows" }, ...list.map(row))
            : empty({
                icon: "archive",
                title: "Nothing kept yet",
                body: "Every quest keeps what it writes to /work/out. You can also keep a running sandbox's work from Sandboxes.",
                actions: ctx.can("sandbox") ? button("Open Sandboxes", { icon: "sandbox", onClick: () => ctx.navigate("sandboxes") }) : null,
              }),
        ),
      );
      if (!opened && opts.intent) {
        opened = true;
        const wanted = list.find((a) => a.id === opts.intent);
        if (wanted) openArtifact(ctx, wanted);
      }
    } catch (error) {
      if (scope.disposed) return;
      replace(
        box,
        isUnavailable(error)
          ? empty({ icon: "archive", title: "Artifacts aren't available on this node yet", body: "They arrive with an update: a sandbox's results, kept after it's gone.", compact: true })
          : errorState("Couldn't load artifacts", error, () => void refresh()),
      );
    }
  }

  replace(
    root,
    h(
      "div",
      { class: "page narrow" },
      pageHead("Artifacts", "What sandboxes leave behind: reports, plots, data and models, kept after the sandbox is gone. Each file carries its SHA-256, and only you remove them."),
      box,
    ),
  );
  scope.add(artifactsChanged.subscribe(() => void refresh()));
  scope.interval(() => void refresh(), 30_000);
  void refresh();
};
