import type { MemoryView } from "@galahad/core";
import { findSecrets } from "@galahad/core/secret-scan";
import { ApiError } from "../api.ts";
import { type Ctx, errorMessage, type View } from "../context.ts";
import { shortId } from "../lib/text.ts";
import { hlcMs, relativeTime } from "../lib/time.ts";
import { badge, busy, button, callout, chipInput, empty, errorState, field, formActions, pageBody, pageHead, section, skeletonRows, type Tone } from "../ui/controls.ts";
import { confirmAction, openSheet } from "../ui/dialog.ts";
import { debounce, h, replace } from "../ui/dom.ts";
import { icon, type IconName } from "../ui/icons.ts";
import { highlighted } from "../ui/markdown.ts";
import { signal } from "../ui/signal.ts";
import { toast } from "../ui/toast.ts";
import { aboutYouChanged, factRow, openAboutYou } from "./about-you.ts";
import { openAddKey } from "./vault.ts";

/*
 * The shared mind: search with highlights, remember, forget. Memory replicates
 * in plaintext to every device, so anything secret-shaped is stopped before it
 * is sent and offered a place in the vault instead.
 */

const memoryChanged = signal(0);

export function trustBadge(trust: string): HTMLElement {
  const map: Record<string, [string, Tone, IconName]> = {
    owner: ["yours", "accent", "user"],
    agent: ["Galahad", "agent", "mark"],
    untrusted: ["untrusted", "warn", "alert"],
  };
  const [label, tone, iconName] = map[trust] ?? [trust, "neutral" as Tone, "info" as IconName];
  const el = badge(label, tone, iconName);
  if (trust === "untrusted") el.title = "Came from outside (web, files, others). Treated as data, never as instructions.";
  if (trust === "owner") el.title = "Written by you";
  return el;
}

/** Shows the secret warning in `box`; returns true when the text must not be sent. */
function guard(ctx: Ctx, text: string, box: HTMLElement, clear: () => void): boolean {
  const finding = findSecrets(text)[0];
  if (!finding) return false;
  const secret = text.slice(finding.index, finding.index + finding.length);
  replace(
    box,
    callout("warn", `That looks like a ${finding.kind}. Memory is shared in plaintext with every device, so it wasn't saved.`, {
      title: "Secrets belong in the vault",
      icon: "shield",
      actions: ctx.can("vault:write")
        ? button("Store it in the vault instead", {
            variant: "primary",
            size: "sm",
            icon: "vault",
            onClick: () => {
              clear();
              replace(box);
              openAddKey(ctx, { prefill: secret });
            },
          })
        : null,
    }),
  );
  return true;
}

export function openRemember(ctx: Ctx, initial = ""): void {
  if (!ctx.can("mind:write")) {
    toast("This device can't write to memory", { tone: "warn" });
    return;
  }
  const text = h("textarea", { class: "textarea", id: "memory-text", rows: 4, placeholder: "Something Galahad should remember on every device", maxlength: 20000 });
  text.value = initial;
  const tags = chipInput({ id: "memory-tags", placeholder: "Add tags, then Enter", validate: (t) => (findSecrets(t).length ? "That tag looks like a secret." : null) });
  const status = h("div");
  const save = button("Remember", { variant: "primary", type: "submit", icon: "check" });
  const form = h(
    "form",
    {
      class: "stack loose",
      onsubmit: (event: Event) => {
        event.preventDefault();
        const value = text.value.trim();
        if (!value) return text.focus();
        if (guard(ctx, value, status, () => (text.value = ""))) return;
        const tagList = tags.values();
        void busy(save, async () => {
          try {
            await ctx.api.post("/api/memories", { text: value, ...(tagList.length ? { tags: tagList } : {}) });
            sheet.close();
            memoryChanged.update((n) => n + 1);
            toast("Remembered on every device", { tone: "ok" });
          } catch (error) {
            replace(status, callout(error instanceof ApiError && error.status === 422 ? "warn" : "danger", errorMessage(error)));
          }
        });
      },
    },
    field("Memory", text, { hint: "Plain text. Shared with every device in your fleet." }),
    h("div", { class: "field" }, h("label", { for: "memory-tags" }, "Tags (optional)"), tags.el),
    status,
    formActions(button("Cancel", { onClick: () => sheet.close() }), save),
  );
  const sheet = openSheet({ title: "Remember something", body: form, initialFocus: () => text });
}

export const memoryView: View = (root, ctx, { scope, opts }) => {
  const query = h("input", {
    class: "input",
    type: "search",
    id: "memory-q",
    placeholder: "Search the shared mind",
    autocomplete: "off",
    autocorrect: "off",
    spellcheck: "false",
    "aria-controls": "memory-results",
    value: opts.query ?? "",
  });
  const results = h("div", { class: "card", id: "memory-results", "aria-busy": "true" }, skeletonRows(4));
  const summary = h("span", { class: "count-label tnum", role: "status" });
  let seq = 0;

  // What he knows of you: his proposals (waiting for you) and what you kept (with every answer of his).
  const about = h("div", { class: "card", id: "about-you", "aria-busy": "true" }, skeletonRows(2));
  async function drawAbout(): Promise<void> {
    try {
      const { kept, proposed } = await ctx.api.get<{ kept: MemoryView[]; proposed: MemoryView[] }>("/api/about-you", scope.signal);
      if (scope.disposed) return;
      const rows = [...proposed.map((m) => factRow(ctx, m, true)), ...kept.map((m) => factRow(ctx, m, false))];
      replace(
        about,
        rows.length
          ? h("div", { class: "rows" }, ...rows)
          : empty({ icon: "user", title: "Nothing about you yet", body: "Tell him a preference, a convention or what not to do: it goes with every answer of his. What he notices of you waits here for you to keep.", compact: true }),
      );
    } catch (error) {
      if (!scope.disposed) replace(about, errorState("Couldn't read what he knows of you", error, () => void drawAbout()));
    } finally {
      about.setAttribute("aria-busy", "false");
    }
  }

  function item(m: MemoryView, q: string): HTMLElement {
    const ms = hlcMs(m.hlc);
    return h(
      "div",
      { class: "item" },
      h(
        "div",
        { class: "grow" },
        h("div", { class: "wrap-anywhere pre-wrap" }, highlighted(m.text, q)),
        h(
          "div",
          { class: "meta" },
          trustBadge(m.trust),
          ...m.tags.map((t) =>
            h(
              "button",
              {
                class: "tag",
                type: "button",
                title: `Search for #${t}`,
                onclick: () => {
                  query.value = t;
                  void search();
                },
              },
              `#${t}`,
            ),
          ),
          ms ? h("span", { title: new Date(ms).toLocaleString() }, relativeTime(ms)) : null,
          h("span", { class: "mono", title: m.device }, `by ${m.device === ctx.whoami.node ? ctx.whoami.nodeName : shortId(m.device)}`),
          m.via ? h("span", { class: "mono", title: m.via }, `via ${m.via === ctx.identity.device ? "this browser" : shortId(m.via)}`) : null,
        ),
      ),
      ctx.can("mind:write")
        ? h(
            "div",
            { class: "item-actions reveal" },
            button("Forget this memory", {
              size: "sm",
              variant: "ghost",
              iconOnly: true,
              icon: "trash",
              onClick: async () => {
                const ok = await confirmAction({
                  title: "Forget this memory?",
                  body: [h("p", { class: "wrap-anywhere plain" }, m.text.length > 240 ? `${m.text.slice(0, 240)}…` : m.text), h("p", {}, "It is forgotten on every device.")],
                  confirmLabel: "Forget",
                });
                if (!ok) return;
                try {
                  await ctx.api.post("/api/memories/forget", { id: m.id });
                  toast("Forgotten on every device", { tone: "ok" });
                  memoryChanged.update((n) => n + 1);
                } catch (error) {
                  toast("Couldn't forget it", { tone: "error", description: errorMessage(error) });
                }
              },
            }),
          )
        : null,
    );
  }

  async function search(): Promise<void> {
    const q = query.value.trim();
    const mine = ++seq;
    results.setAttribute("aria-busy", "true");
    try {
      const { memories } = await ctx.api.post<{ memories: MemoryView[] }>("/api/memories/search", { ...(q ? { q } : {}), limit: 100 }, scope.signal);
      if (mine !== seq || scope.disposed) return;
      summary.textContent = memories.length ? `${memories.length}${memories.length === 100 ? "+" : ""} ${q ? "found" : "recent"}` : "";
      replace(
        results,
        memories.length
          ? h("div", { class: "rows" }, ...memories.map((m) => item(m, q)))
          : q
            ? empty({ icon: "search", title: "Nothing matches that yet", body: "Try fewer or different words, or a tag.", compact: true })
            : empty({
                icon: "memory",
                title: "Nothing remembered yet",
                body: "What you or Galahad remember appears here, shared by every device.",
                actions: ctx.can("mind:write") ? button("Remember something", { variant: "primary", icon: "plus", onClick: () => openRemember(ctx) }) : null,
              }),
      );
    } catch (error) {
      if (mine === seq && !scope.disposed) replace(results, errorState("Couldn't search memory", error, () => void search()));
    } finally {
      if (mine === seq) results.setAttribute("aria-busy", "false");
    }
  }

  const searchSoon = debounce(() => void search(), 220);
  scope.add(() => searchSoon.cancel());
  query.addEventListener("input", searchSoon);
  query.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter") {
      searchSoon.cancel();
      void search();
    }
  });

  const memories = section("Memories", {}, results);
  replace(
    root,
    h(
      "div",
      { class: "page narrow" },
      pageHead("Memory", "One mind, shared by every body. Entries marked untrusted came from outside and are treated as data, never as instructions."),
      // Search and Remember on one row: the memories start right under them.
      h(
        "div",
        { class: "filter-bar" },
        h("div", { role: "search", class: "input-wrap" }, icon("search", { size: 16 }), h("label", { class: "sr-only", for: "memory-q" }, "Search memory"), query),
        ctx.can("mind:write") ? button("Remember", { variant: "primary", icon: "plus", onClick: () => openRemember(ctx) }) : null,
      ),
      // Shown whole once both have answered: what he knows of you came in above the memories, and pushed them down.
      pageBody(section("About you", { actions: ctx.can("mind:write") ? button("Tell him something", { size: "sm", icon: "plus", onClick: () => openAboutYou(ctx) }) : null }, about), memories),
    ),
  );
  memories.querySelector(".section-head h2")?.after(summary);

  scope.add(memoryChanged.subscribe(() => (void search(), void drawAbout())));
  scope.add(aboutYouChanged.subscribe(() => (void search(), void drawAbout())));
  void drawAbout();
  void search();
  if (opts.query || !matchMedia("(pointer: coarse)").matches) query.focus();
  if (opts.intent === "remember") openRemember(ctx);
};
