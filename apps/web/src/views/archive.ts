import type { ArchiveEntryView, ArchiveFileView, ArchiveHit, ArchiveSearchView, ArchiveStatusView } from "@galahad/core";
import { findSecrets } from "@galahad/core/secret-scan";
import { ApiError, isUnavailable } from "../api.ts";
import { type Ctx, errorMessage, type View } from "../context.ts";
import { type ArchiveFilter, bytesShort, deleteName, embeddedShare, embedderLine, emptyFilter, filtering, filterSummary, KIND_INFO, kindInfo, searchBody, SPANS, type Span, TRUST_LABEL, type Trust } from "../lib/archive.ts";
import { fileKind, imageDataUrl, previewText, sha256Hex, shortSha, shownAs } from "../lib/artifacts.ts";
import { absoluteTime, relativeTime } from "../lib/time.ts";
import { badge, busy, button, callout, chipInput, dot, empty, errorState, field, formActions, meter, pageBody, pageHead, section, skeletonRows } from "../ui/controls.ts";
import { openSheet, type Sheet } from "../ui/dialog.ts";
import { debounce, h, keepPlace, replace } from "../ui/dom.ts";
import { icon, type IconName } from "../ui/icons.ts";
import { selector, type SelectorGroup } from "../ui/selector.ts";
import { signal } from "../ui/signal.ts";
import { toast } from "../ui/toast.ts";
import { trustBadge } from "./memory.ts";

/*
 * The Archive: everything Galahad made, was taught or thought of, kept for good on the
 * node you talk to, and searched by words and meaning together. One smart selector for
 * kind, time and trust; the search; each entry's summary, facts, lessons, files (checked
 * against their SHA-256 in the browser) and links; the index's state; and New idea.
 */

const PAGE = 20;
const PREVIEW_MAX = 20 * 2 ** 20;
const archiveChanged = signal(0);

const kindIcon = (kind: string): IconName => kindInfo(kind).icon as IconName;

/** Save bytes as a file, as octet-stream: an archived HTML file can only ever be saved, never opened here. */
function saveBytes(name: string, data: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([data as Uint8Array<ArrayBuffer>], { type: "application/octet-stream" }));
  const link = h("a", { href: url, download: name, hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** A new idea, kept for good. Secret-shaped text is stopped here, before it's sent. */
export function openNewIdea(ctx: Ctx): void {
  if (!ctx.can("mind:write")) {
    toast("This device can't add to the archive", { tone: "warn" });
    return;
  }
  const title = h("input", { class: "input", id: "idea-title", maxlength: 200, placeholder: "The idea in a few words", autocomplete: "off" });
  const text = h("textarea", { class: "textarea", id: "idea-text", rows: 5, maxlength: 20000, placeholder: "What it is, why, and how it might be tried" });
  const tags = chipInput({ id: "idea-tags", placeholder: "Add tags, then Enter", validate: (t) => (findSecrets(t).length ? "That tag looks like a secret." : null) });
  const status = h("div");
  const save = button("Keep it", { variant: "primary", type: "submit", icon: "check" });
  const form = h(
    "form",
    {
      class: "stack loose",
      onsubmit: (event: Event) => {
        event.preventDefault();
        const t = title.value.trim();
        const body = text.value.trim() || t;
        if (!t) return title.focus();
        const finding = findSecrets(`${t}\n${body}`)[0];
        if (finding) {
          replace(status, callout("warn", `That looks like a ${finding.kind}. The archive may be searched by agents and embedded, so it wasn't sent. Keys belong in the vault.`, { title: "Secrets belong in the vault", icon: "shield" }));
          return;
        }
        const tagList = tags.values();
        void busy(save, async () => {
          try {
            const noted = await ctx.api.post<{ id: string; created: boolean; node: string }>("/api/archive/ideas", { title: t, text: body, ...(tagList.length ? { tags: tagList } : {}) });
            sheet.close();
            archiveChanged.update((n) => n + 1);
            toast(noted.created ? "Kept for good" : "Already in the archive", { tone: "ok", description: `In the archive on ${noted.node}.` });
          } catch (error) {
            replace(status, callout(error instanceof ApiError && error.status === 422 ? "warn" : "danger", errorMessage(error)));
          }
        });
      },
    },
    field("Idea", title),
    field("Details", text, { hint: "Plain text. Galahad finds it again by its words and its meaning." }),
    h("div", { class: "field" }, h("label", { for: "idea-tags" }, "Tags (optional)"), tags.el),
    status,
    formActions(button("Cancel", { onClick: () => sheet.close() }), save),
  );
  const sheet = openSheet({ title: "New idea", description: "Kept for good, in the archive.", body: form, initialFocus: () => title });
}

function list(title: string, items: string[]): HTMLElement | null {
  if (!items.length) return null;
  return h("div", { class: "stack tight" }, h("h3", { class: "small strong" }, title), h("ul", { class: "plain-list small" }, ...items.map((i) => h("li", {}, i))));
}

/** Delete for good, with a reason; you type its name. A tombstone keeps it from coming back. */
function openDelete(ctx: Ctx, entry: ArchiveEntryView, done: () => void): void {
  const name = deleteName(entry);
  const reason = h("textarea", { class: "textarea", id: "archive-reason", rows: 2, maxlength: 500, placeholder: "Why it should go" });
  const confirm = h("input", { class: "input", id: "archive-confirm", autocomplete: "off", autocorrect: "off", spellcheck: "false", placeholder: name });
  const status = h("div");
  const go = button("Delete for good", { variant: "danger-solid", type: "submit", icon: "trash" });
  const form = h(
    "form",
    {
      class: "stack loose",
      onsubmit: (event: Event) => {
        event.preventDefault();
        if (reason.value.trim().length < 3) return reason.focus();
        if (confirm.value.trim() !== name) return confirm.focus();
        void busy(go, async () => {
          try {
            await ctx.api.post("/api/archive/delete", { id: entry.id, reason: reason.value.trim() });
            sheet.close();
            archiveChanged.update((n) => n + 1);
            toast("Deleted from the archive", { description: "Its words and files are gone; a tombstone keeps it from being archived again." });
            done();
          } catch (error) {
            replace(status, callout("danger", errorMessage(error)));
          }
        });
      },
    },
    callout("danger", `"${entry.title}" and its ${entry.files.length} file(s) (unless another entry holds them) go for good, with any lessons drawn from it. This can't be undone.`, { title: "Delete from the archive" }),
    field("Reason", reason, { hint: "Kept in the tombstone." }),
    field(`Type ${name} to confirm`, confirm),
    status,
    formActions(button("Cancel", { onClick: () => sheet.close() }), go),
  );
  const sheet = openSheet({ title: "Delete for good?", body: form, role: "alertdialog", initialFocus: () => reason });
}

/** One entry: what it is, what Galahad understood of it, its files and links. */
export function openEntry(ctx: Ctx, id: string): void {
  const body = h("div", { class: "stack loose" }, skeletonRows(4));
  const sheet: Sheet = openSheet({ title: "Archive entry", description: id, size: "wide", body });

  void (async () => {
    let entry: ArchiveEntryView;
    try {
      ({ entry } = await ctx.api.post<{ entry: ArchiveEntryView }>("/api/archive/entry", { id }, sheet.scope.signal));
    } catch (error) {
      if (!sheet.scope.disposed) replace(body, errorState("Couldn't open that entry", error));
      return;
    }
    if (sheet.scope.disposed) return;
    const heading = sheet.el.querySelector("h2");
    if (heading) heading.textContent = entry.title;
    const u = entry.understanding;
    const preview = h("div", { class: "stack tight", "aria-live": "polite" });

    async function show(f: ArchiveFileView, trigger: HTMLButtonElement, save: boolean): Promise<void> {
      await busy(trigger, async () => {
        try {
          const { data, type } = await ctx.api.bytes("/api/archive/file", { id: entry.id, path: f.path }, sheet.scope.signal);
          const matches = (await sha256Hex(data)) === f.sha256;
          if (save) {
            if (!matches) toast("That file doesn't match its SHA-256", { tone: "error" });
            saveBytes(f.path.split("/").at(-1)!, data);
            return;
          }
          const kind = shownAs(fileKind(f.path), type);
          const head = h("div", { class: "row wrap between" }, h("span", { class: "mono strong small wrap-anywhere" }, f.path), matches ? badge("SHA-256 matches", "ok", "shield-check") : badge("SHA-256 differs", "danger", "alert"));
          let shown: HTMLElement;
          if (kind === "image") {
            const url = imageDataUrl(data, type);
            shown = url ? h("img", { class: "preview-img", src: url, alt: f.path }) : callout("quiet", "This one can only be saved.");
          } else if (kind === "download") shown = callout("quiet", "The node sends this one only as a file to save, so it isn't shown here.");
          else {
            const { text, clipped } = previewText(data);
            shown = h("div", { class: "stack tight" }, h("pre", { class: "result" }, text), clipped ? h("p", { class: "tiny subtle" }, "Only the beginning is shown: save the file for all of it.") : null);
          }
          replace(preview, head, matches ? null : callout("danger", "It doesn't match the SHA-256 recorded when it was archived. It may have been changed or damaged on the node."), shown);
        } catch (error) {
          replace(preview, callout("danger", errorMessage(error), { title: "Couldn't fetch it" }));
        }
      });
    }

    const files = entry.files.length
      ? h(
          "div",
          { class: "card flat" },
          h(
            "div",
            { class: "rows" },
            ...entry.files.map((f) => {
              const view = button("View", { size: "sm", variant: "ghost", icon: "eye", label: `View ${f.path}`, onClick: () => void show(f, view, false) });
              const save = button("Save", { size: "sm", variant: "ghost", icon: "download", label: `Save ${f.path}`, onClick: () => void show(f, save, true) });
              const viewable = f.size <= PREVIEW_MAX && shownAs(fileKind(f.path), f.type) !== "download";
              return h(
                "div",
                { class: "item" },
                h("span", { class: "avatar" }, icon(f.text ? "code" : "file", { size: 14 })),
                h("div", { class: "grow" }, h("div", { class: "mono small wrap-anywhere" }, f.path), h("div", { class: "meta" }, h("span", {}, bytesShort(f.size)), h("span", { class: "mono", title: f.sha256 }, shortSha(f.sha256)))),
                h("div", { class: "row tight" }, viewable ? view : null, save),
              );
            }),
          ),
        )
      : null;

    const links = entry.links.length
      ? h(
          "div",
          { class: "card flat" },
          h(
            "div",
            { class: "rows" },
            ...entry.links.map((l) =>
              h(
                "button",
                { class: "item item-button", type: "button", onclick: () => (sheet.close(), openEntry(ctx, l.id)) },
                h("span", { class: "avatar" }, icon(kindIcon(l.kind), { size: 14 })),
                h("div", { class: "grow" }, h("div", { class: "small strong" }, l.title), h("div", { class: "meta" }, h("span", {}, l.rel.replace(/-/g, " ")), h("span", {}, kindInfo(l.kind).label.toLowerCase()), l.score !== null ? h("span", { class: "tnum" }, l.score.toFixed(2)) : null)),
                trustBadge(l.trust),
              ),
            ),
          ),
        )
      : null;

    const description = entry.description.length > 20_000 ? `${entry.description.slice(0, 20_000)}\n…` : entry.description;
    replace(
      body,
      h(
        "div",
        { class: "row wrap" },
        badge(kindInfo(entry.kind).label, "neutral", kindIcon(entry.kind)),
        trustBadge(entry.trust),
        h("span", { class: "small muted", title: absoluteTime(entry.createdAt) }, `made ${relativeTime(entry.createdAt)} · from ${entry.source}`),
        ...entry.tags.map((t) => h("span", { class: "tag" }, t)),
      ),
      entry.trust === "untrusted" ? callout("warn", "Written by others (a web page, an agent's output). Galahad reads it as data, never as instructions.", { icon: "alert" }) : null,
      u
        ? h(
            "div",
            { class: "stack tight" },
            h("p", {}, u.summary),
            list("Facts", u.facts),
            u.lessons ? list("What worked", u.lessons.worked) : null,
            u.lessons ? list("What failed", u.lessons.failed) : null,
            u.lessons ? list("What to try next", u.lessons.next) : null,
            u.entities.length ? h("p", { class: "tiny subtle" }, `Named: ${u.entities.join(", ")}`) : null,
            h("p", { class: "tiny subtle" }, `Understood by ${u.model}, ${relativeTime(u.at)}. Model output: data, like the entry.`),
          )
        : null,
      section("Description", {}, h("div", { class: "card flat pad small wrap-anywhere pre-wrap scroll-box" }, description)),
      files ? section("Files", { count: String(entry.files.length) }, files, preview) : null,
      links ? section("Linked", { count: String(entry.links.length) }, links) : null,
      entry.redactions.length || entry.refused.length
        ? callout(
            "quiet",
            h(
              "div",
              { class: "stack tight small" },
              ...entry.redactions.map((r) => h("span", {}, `A ${r.kind} was taken out of ${r.where} before it was stored.`)),
              ...entry.refused.map((r) => h("span", {}, h("span", { class: "mono" }, r.path), ` wasn't kept: ${r.why}.`)),
            ),
            { title: "Kept out", icon: "shield" },
          )
        : null,
      h(
        "div",
        { class: "row between wrap" },
        h("span", { class: "tiny subtle tnum" }, `${entry.chunks} passage(s), ${entry.embedded} embedded · archived ${relativeTime(entry.archivedAt)}`),
        ctx.can("fleet:admin") ? button("Delete…", { variant: "danger", size: "sm", icon: "trash", onClick: () => openDelete(ctx, entry, () => sheet.close()) }) : null,
      ),
    );
  })();
}

function statusCard(ctx: Ctx, s: ArchiveStatusView, refresh: () => void): HTMLElement {
  const emb = embedderLine(s);
  const share = embeddedShare(s);
  const i = s.integrity;
  const u = s.understanding;
  const kinds = Object.entries(s.byKind).map(([k, n]) => `${n} ${n === 1 ? kindInfo(k).label.toLowerCase() : kindInfo(k).plural.toLowerCase()}`);
  const budget = ctx.can("brain:write")
    ? button("Change", {
        size: "sm",
        variant: "ghost",
        onClick: () => {
          const input = h("input", { class: "input", type: "number", min: 0, max: 10000, step: 1, value: String(u.perDay), id: "archive-budget" });
          const save = button("Save", { variant: "primary", type: "submit" });
          const form = h(
            "form",
            {
              class: "stack loose",
              onsubmit: (event: Event) => {
                event.preventDefault();
                const n = Math.max(0, Math.floor(Number(input.value)));
                void busy(save, async () => {
                  await ctx.api.post("/api/archive/budget", { summariesPerDay: n });
                  sheet.close();
                  refresh();
                });
              },
            },
            field("Summaries a day", input, { hint: "The swift role writes each entry's summary, facts, tags and lessons. A budget you set lets its models in order do it; a cloud model among them gets the entries' text. 0 stops it." }),
            formActions(button("Cancel", { onClick: () => sheet.close() }), save),
          );
          const sheet = openSheet({ title: "Summary budget", body: form, size: "small", initialFocus: () => input });
        },
      })
    : null;
  const admin = ctx.can("fleet:admin");
  const verify = admin
    ? button("Check the files now", {
        size: "sm",
        variant: "ghost",
        icon: "shield-check",
        onClick: () =>
          void busy(verify!, async () => {
            try {
              const r = await ctx.api.post<{ checked: number; problems: string[] }>("/api/archive/verify", {});
              toast(r.problems.length ? `${r.problems.length} problem(s) found` : `All ${r.checked} file(s) match their SHA-256`, { tone: r.problems.length ? "error" : "ok" });
              refresh();
            } catch (error) {
              toast(errorMessage(error), { tone: "error" });
            }
          }),
      })
    : null;
  const reindex = admin
    ? button("Embed again", {
        size: "sm",
        variant: "ghost",
        icon: "refresh",
        onClick: () =>
          void busy(reindex!, async () => {
            const r = await ctx.api.post<{ backlog: number }>("/api/archive/reindex", { embeddings: true });
            toast(`Embedding ${r.backlog} passage(s) again in the background`);
            refresh();
          }),
      })
    : null;
  return h(
    "div",
    { class: "card" },
    h("div", { class: "card-head" }, icon("library", { size: 16 }), h("h3", { class: "grow" }, `On ${s.node}`), s.paused ? badge("waiting: the node is busy", "neutral", "pause") : null),
    h(
      "div",
      { class: "card-body" },
      h(
        "dl",
        { class: "kv" },
        h("dt", {}, "Entries"),
        h("dd", { class: "tnum" }, String(s.entries), kinds.length ? h("span", { class: "subtle" }, ` · ${kinds.join(", ")}`) : null, s.deleted ? h("span", { class: "subtle" }, ` · ${s.deleted} deleted`) : null),
        h("dt", {}, "Passages"),
        h("dd", { class: "stack tight" }, h("span", { class: "tnum" }, `${s.embedded} of ${s.embedded + s.backlog} embedded${s.backlog ? ` · ${s.backlog} waiting` : ""}`), s.embedder.model ? meter(share, undefined, "Passages embedded") : null),
        h("dt", {}, "Embedder"),
        h("dd", { class: "stack snug" }, h("span", { class: "row tight" }, dot(emb.tone === "ok" ? "ok" : emb.tone === "warn" ? "warn" : null), h("span", { class: "mono small wrap-anywhere" }, emb.text)), emb.hint ? h("div", { class: "tiny subtle" }, emb.hint) : null),
        h("dt", {}, "Summaries"),
        h("dd", {}, h("span", { class: "tnum" }, `${u.usedToday} of ${u.perDay} today`), u.backlog ? h("span", { class: "subtle tnum" }, ` · ${u.backlog} waiting`) : null, u.localOnly ? h("div", { class: "tiny subtle" }, "A local model only, until you set a budget: nothing leaves.") : null, u.lastError ? h("div", { class: "tiny subtle" }, u.lastError) : null, budget),
        h("dt", {}, "Files checked"),
        h(
          "dd",
          {},
          i.lastAt === null ? h("span", { class: "subtle" }, "Not yet (daily)") : h("span", { class: "row tight" }, dot(i.ok ? "ok" : "danger"), `${i.ok ? "All match" : `${i.problems.length} problem(s)`} · ${relativeTime(i.lastAt)}`),
          ...i.problems.slice(0, 3).map((p) => h("div", { class: "tiny mono wrap-anywhere" }, p)),
        ),
        h("dt", {}, "Disk"),
        h("dd", { class: "tnum" }, `${bytesShort(s.disk.blobBytes)} in ${s.disk.blobs} file(s) · index ${bytesShort(s.disk.indexBytes)}`, h("div", { class: "tiny subtle mono wrap-anywhere" }, `${s.disk.backend}: ${s.disk.root}`)),
      ),
    ),
    h(
      "div",
      { class: "card-foot" },
      h(
        "div",
        { class: "stack tight grow" },
        h("span", { class: "tiny subtle" }, "Sources"),
        ...s.sources.map((src) =>
          h(
            "div",
            { class: "row between small" },
            h("span", {}, src.name),
            h("span", { class: "tiny subtle tnum text-end" }, src.waiting ? "not hooked up yet" : src.lastError ? `failing: ${src.lastError}` : src.lastRun ? `${src.pulled} · ${relativeTime(src.lastRun)}` : "not yet"),
          ),
        ),
        verify || reindex ? h("div", { class: "row wrap" }, verify, reindex) : null,
      ),
    ),
  );
}

export const archiveView: View = (root, ctx, { scope, opts }) => {
  const filter: ArchiveFilter = emptyFilter();
  let status: ArchiveStatusView | null = null;
  let limit = PAGE;
  let seq = 0;
  let last: ArchiveSearchView | null = null;
  const results = h("div", { class: "card", id: "archive-results", "aria-busy": "true" }, skeletonRows(6, { avatar: true }));
  const statusBox = h("div", { class: "card" }, skeletonRows(6));
  const countLabel = h("span", { class: "count-label tnum", role: "status" });
  const search = h("input", { class: "input", type: "search", id: "archive-q", placeholder: "Search the archive by words or meaning", "aria-label": "Search the archive", "aria-controls": "archive-results", autocomplete: "off", autocorrect: "off", spellcheck: "false", value: opts.query ?? "" });

  const picker = selector({
    label: "Filter the archive",
    scope,
    search: false,
    current: () => ({ text: filterSummary(filter), icon: "filter", active: filtering(filter) }),
    groups: () => {
      const by = status?.byKind ?? {};
      const kinds = [...new Set([...Object.keys(KIND_INFO), ...Object.keys(by)])];
      const groups: SelectorGroup[] = [
        { id: "kind", label: "Kind", mode: "many", options: kinds.map((k) => ({ value: k, label: kindInfo(k).plural, icon: kindIcon(k), meta: `${by[k] ?? 0}`, selected: filter.kinds.has(k) })) },
        { id: "span", label: "When it was made", options: SPANS.map((s) => ({ value: s.value, label: s.label, selected: filter.span === s.value })) },
        {
          id: "trust",
          label: "Whose words",
          mode: "many",
          options: (["owner", "agent", "untrusted"] as const).map((t) => ({ value: t, label: TRUST_LABEL[t], meta: t === "owner" ? "yours" : t === "agent" ? "Galahad's own" : "web pages, agents' output", tone: t === "untrusted" ? ("warn" as const) : t === "owner" ? ("accent" as const) : ("agent" as const), selected: filter.trust.has(t) })),
        },
      ];
      if (filtering(filter)) groups.push({ id: "clear", mode: "action", options: [{ value: "clear", label: "Show everything", icon: "x" }] });
      return groups;
    },
    onSelect: (group, option) => {
      if (group === "kind") filter.kinds.has(option.value) ? filter.kinds.delete(option.value) : filter.kinds.add(option.value);
      else if (group === "trust") filter.trust.has(option.value as Trust) ? filter.trust.delete(option.value as Trust) : filter.trust.add(option.value as Trust);
      else if (group === "span") filter.span = option.value as Span;
      else Object.assign(filter, emptyFilter());
      picker.refresh();
      limit = PAGE;
      void run();
    },
  });

  function hitRow(hit: ArchiveHit): HTMLElement {
    const found = hit.matched.length ? `${hit.matched.join(" + ")}${hit.similarity !== null ? ` ${hit.similarity.toFixed(2)}` : ""}` : null;
    return h(
      "button",
      { class: "item item-button", type: "button", "data-key": hit.id, "aria-label": `${hit.title}, ${kindInfo(hit.kind).label}`, onclick: () => openEntry(ctx, hit.id) },
      h("span", { class: "avatar" }, icon(kindIcon(hit.kind), { size: 14 })),
      h(
        "div",
        { class: "item-text" },
        h("div", { class: "row wrap" }, h("span", { class: "strong small" }, hit.title), trustBadge(hit.trust)),
        h("div", { class: "small muted wrap-anywhere" }, hit.summary ?? hit.snippet),
        h(
          "div",
          { class: "meta tnum" },
          h("span", {}, kindInfo(hit.kind).label.toLowerCase()),
          h("span", { title: absoluteTime(hit.createdAt) }, relativeTime(hit.createdAt)),
          hit.from !== "description" ? h("span", { class: "mono" }, hit.from) : null,
          found ? h("span", { title: "How it was found: by its words (BM25), its meaning (vectors), or both, fused" }, found) : null,
        ),
      ),
      icon("chevron-right", { size: 16, class: "subtle" }),
    );
  }

  function render(view: ArchiveSearchView): void {
    const q = search.value.trim();
    results.setAttribute("aria-busy", "false");
    countLabel.textContent = view.hits.length ? `${view.hits.length}${view.hits.length >= limit ? "+" : ""} · ${view.mode === "hybrid" ? "words and meaning" : view.mode === "text" ? "words only" : "newest first"}` : "";
    if (!view.hits.length) {
      replace(
        results,
        q || filtering(filter)
          ? empty({ icon: "search", title: "Nothing matches", body: filtering(filter) ? "Try another kind, a longer time or fewer words." : "Try other words: with an embedder, the archive also finds what means the same.", compact: true })
          : empty({
              icon: "library",
              title: "Nothing archived yet",
              body: "Kept work, models, what Galahad was taught, ideas, chats and lessons arrive here by themselves, and stay.",
              actions: ctx.can("mind:write") ? button("New idea", { icon: "lightbulb", onClick: () => openNewIdea(ctx) }) : null,
            }),
      );
      return;
    }
    keepPlace(results, () =>
      replace(
        results,
        h("div", { class: "rows" }, ...view.hits.map(hitRow)),
        view.hits.length >= limit && limit < 50
          ? h(
              "div",
              { class: "card-foot centered" },
              button("Show more", {
                variant: "ghost",
                icon: "chevron-down",
                onClick: () => {
                  limit = Math.min(50, limit + PAGE);
                  void run();
                },
              }),
            )
          : null,
      ),
    );
  }

  async function run(): Promise<void> {
    const mine = ++seq;
    try {
      const view = await ctx.api.post<ArchiveSearchView>("/api/archive/search", searchBody(search.value, filter, limit), scope.signal);
      if (scope.disposed || mine !== seq) return;
      last = view;
      render(view);
    } catch (error) {
      if (scope.disposed || mine !== seq) return;
      replace(results, isUnavailable(error) ? empty({ icon: "library", title: "The archive isn't on this node yet", body: "It arrives with an update.", compact: true }) : errorState("Couldn't search the archive", error, () => void run()));
    }
  }

  async function loadStatus(): Promise<void> {
    try {
      status = await ctx.api.get<ArchiveStatusView>("/api/archive", scope.signal);
      if (scope.disposed) return;
      keepPlace(statusBox, () => replace(statusBox, statusCard(ctx, status!, () => void loadStatus())));
      statusBox.className = "";
      picker.refresh();
    } catch (error) {
      if (scope.disposed) return;
      if (!status) replace(statusBox, isUnavailable(error) ? empty({ icon: "library", title: "No archive here yet", compact: true }) : errorState("Couldn't read the archive's state", error, () => void loadStatus()));
    }
  }

  const runSoon = debounce(() => {
    limit = PAGE;
    void run();
  }, 220);
  search.addEventListener("input", runSoon);
  scope.add(() => runSoon.cancel());
  scope.add(archiveChanged.subscribe(() => (void run(), void loadStatus())));

  const bar = h("div", { class: "filter-bar", role: "search" }, h("div", { class: "input-wrap" }, icon("search", { size: 16 }), search), picker.el);
  replace(
    root,
    h(
      "div",
      { class: "page" },
      pageHead(
        "Archive",
        "Everything Galahad made, was taught or thought of, kept for good on this node and searched by words and meaning together. He searches it before new work; you see what he used with each answer.",
        ctx.can("mind:write") ? button("New idea", { variant: "primary", icon: "lightbulb", onClick: () => openNewIdea(ctx) }) : null,
      ),
      // Shown whole once the entries and the index's state have answered: on a phone the state is under the entries,
      // and moved as they came in.
      pageBody(h("div", { class: "two-col" }, h("div", { class: "stack" }, bar, section("Entries", {}, results)), h("div", { class: "stack loose" }, statusBox))),
    ),
  );
  root.querySelector(".section-head h2")?.after(countLabel);

  scope.interval(() => void loadStatus(), 15_000);
  // The newest list follows what arrives; a search stays as it is until you change it.
  scope.interval(() => {
    if (!search.value.trim() && last?.mode === "recent") void run();
  }, 30_000);
  void loadStatus();
  void run();
  if (opts.intent === "new-idea") openNewIdea(ctx);
  else if (opts.intent?.startsWith("arc_")) openEntry(ctx, opts.intent);
};
