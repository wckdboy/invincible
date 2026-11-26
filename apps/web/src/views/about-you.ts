import type { MemoryView } from "@galahad/core";
import { findSecrets } from "@galahad/core/secret-scan";
import { type Ctx, errorMessage } from "../context.ts";
import { badge, busy, button, callout, field, formActions } from "../ui/controls.ts";
import { confirmAction, openSheet } from "../ui/dialog.ts";
import { h, replace } from "../ui/dom.ts";
import { signal } from "../ui/signal.ts";
import { toast } from "../ui/toast.ts";

/*
 * What he knows of you (ABOUT_YOU_TAG): the facts you kept, which go with every answer of his, and the ones he
 * proposed, which wait for you here and in the Inbox. He proposes; you keep (in your words, if you like) or drop.
 */

/** core's ABOUT_YOU_TAG, said again here: a value from @galahad/core's index would bring every schema into the app. */
const ABOUT_YOU_TAG = "about-you";

/** Bumped when a fact changed here, so the Memory page and the Inbox show it at once. */
export const aboutYouChanged = signal(0);

const changed = (ctx: Ctx) => {
  aboutYouChanged.update((n) => n + 1);
  void ctx.live.refreshAboutYou();
};

/** One fact: what it says, whose it is, and what you can do with it. */
export function factRow(ctx: Ctx, m: MemoryView, proposed: boolean): HTMLElement {
  const keep = button("Keep", { size: "sm", variant: "primary", icon: "check" });
  keep.addEventListener("click", () =>
    void busy(keep, async () => {
      try {
        await ctx.api.post("/api/about-you/keep", { id: m.id });
        toast("Kept: it goes with every answer of his", { tone: "ok" });
        changed(ctx);
      } catch (error) {
        toast("Couldn't keep it", { tone: "error", description: errorMessage(error) });
      }
    }),
  );
  const drop = button(proposed ? "Drop" : "Remove", { size: "sm", variant: "ghost", icon: "trash" });
  drop.addEventListener("click", () =>
    void busy(drop, async () => {
      if (!proposed && !(await confirmAction({ title: "Remove this fact?", body: [h("p", { class: "wrap-anywhere" }, m.text), h("p", {}, "It goes with his answers no more, on every device.")], confirmLabel: "Remove" }))) return;
      try {
        await ctx.api.post("/api/memories/forget", { id: m.id });
        toast(proposed ? "Dropped" : "Removed: it goes with his answers no more", { tone: "info" });
        changed(ctx);
      } catch (error) {
        toast(proposed ? "Couldn't drop it" : "Couldn't remove it", { tone: "error", description: errorMessage(error) });
      }
    }),
  );
  // The fact across the whole width (a phone has no room beside it), then whose it is and what you can do.
  return h(
    "div",
    { class: "item fact" },
    h("div", { class: "wrap-anywhere pre-wrap" }, m.text),
    h(
      "div",
      { class: "row wrap between" },
      proposed ? badge("He noticed it: yours to keep", "agent", "mark") : badge("Kept: with every answer", "accent", "user"),
      ctx.can("mind:write")
        ? h("div", { class: "row wrap" }, proposed ? keep : null, button(proposed ? "In my words" : "Reword", { size: "sm", onClick: () => openAboutYou(ctx, m) }), drop)
        : null,
    ),
  );
}

/** A fact of yours to keep: new, or his proposal (or one you kept) in your words. */
export function openAboutYou(ctx: Ctx, from?: MemoryView): void {
  if (!ctx.can("mind:write")) {
    toast("This device can't write to memory", { tone: "warn" });
    return;
  }
  const text = h("textarea", { class: "textarea", id: "about-you-text", rows: 3, maxlength: 2000, placeholder: "Short answers, the command first." });
  text.value = from?.text ?? "";
  const status = h("div");
  const save = button("Keep", { variant: "primary", type: "submit", icon: "check" });
  const form = h(
    "form",
    {
      class: "stack loose",
      onsubmit: (event: Event) => {
        event.preventDefault();
        const value = text.value.trim();
        if (!value) return text.focus();
        const secret = findSecrets(value)[0];
        if (secret) return void replace(status, callout("warn", `That looks like a ${secret.kind}: it goes with every answer, so it wasn't kept. A key belongs in the vault.`));
        void busy(save, async () => {
          try {
            if (from) await ctx.api.post("/api/about-you/keep", { id: from.id, text: value });
            else await ctx.api.post("/api/memories", { text: value, tags: [ABOUT_YOU_TAG] });
            sheet.close();
            toast("Kept: it goes with every answer of his", { tone: "ok" });
            changed(ctx);
          } catch (error) {
            replace(status, callout("danger", errorMessage(error)));
          }
        });
      },
    },
    field("About you", text, { hint: "A preference, a convention, what not to do: in a line, as he should keep to it." }),
    status,
    formActions(button("Cancel", { onClick: () => sheet.close() }), save),
  );
  const sheet = openSheet({ title: from ? "In your words" : "Tell him something about you", body: form, initialFocus: () => text });
}
