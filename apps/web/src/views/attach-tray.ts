import type { AttachmentRef, AttachmentType } from "@galahad/core";
import { ATTACHMENT_LIMITS } from "@galahad/core/attachments";
import { type Ctx, errorMessage } from "../context.ts";
import { bytesLabel } from "../lib/artifacts.ts";
import { ATTACH_ACCEPT, knownLook, lookOf, prepare, upload } from "../lib/attachments.ts";
import { button, spinner } from "../ui/controls.ts";
import { openSheet } from "../ui/dialog.ts";
import { h, replace } from "../ui/dom.ts";
import { icon } from "../ui/icons.ts";
import { toast } from "../ui/toast.ts";

/*
 * Files with your next message, in your chat with Galahad and at the Roundtable: chosen with the paperclip, pasted (a
 * picture copied alone) or dropped on the message box. Each is made ready as it's added (a picture made smaller, its
 * metadata left behind) and sent up to the node, and the message then names them. Where they wait is the caller's, so a
 * chat keeps them while you look elsewhere, as it keeps its words.
 */

/** A file waiting to go with your next message: going up to the node, up (what the message carries), or not taken. */
export interface Waiting {
  key: number;
  name: string;
  type: AttachmentType | null;
  size: number;
  preview: string | null;
  state: "going" | "up" | "failed";
  ref?: AttachmentRef;
  problem?: string;
}

export interface Tray {
  /** The paperclip. */
  button: HTMLButtonElement;
  /** The files waiting, above the message box. */
  row: HTMLElement;
  /** The chooser the paperclip opens (hidden: put it in the form). */
  chooser: HTMLInputElement;
  add(files: File[]): void;
  /** What the message carries: the files that are up. */
  carried(): AttachmentRef[];
  /** A file is still going up: the message waits for it. */
  going(): boolean;
  /** Sent with the message: the box is clear of them (one not taken stays, to remove). */
  sent(): void;
  /** Pictures pasted alone in `input`, and files dropped on `form`, are added. */
  take(input: HTMLTextAreaElement, form: HTMLElement): void;
  render(): void;
}

let keys = 0;

export function attachTray(ctx: Ctx, o: { files: { get(): Waiting[]; set(next: Waiting[]): void }; enabled(): boolean; changed(): void; disposed(): boolean }): Tray {
  const chooser = h("input", { type: "file", multiple: true, accept: ATTACH_ACCEPT, hidden: true, "aria-hidden": "true", tabindex: "-1" });
  const clip = button("Attach pictures or files", { variant: "ghost", size: "sm", icon: "paperclip", iconOnly: true, onClick: () => chooser.click() });
  const row = h("div", { class: "composer-files", role: "list", "aria-label": "Files with your message" });

  function render(): void {
    const waiting = o.files.get();
    row.hidden = waiting.length === 0;
    clip.disabled = !o.enabled() || waiting.length >= ATTACHMENT_LIMITS.perMessage;
    replace(
      row,
      ...waiting.map((f) => {
        const remove = button(`Remove ${f.name}`, {
          variant: "ghost",
          size: "sm",
          icon: "x",
          iconOnly: true,
          onClick: () => {
            o.files.set(o.files.get().filter((w) => w.key !== f.key));
            render();
            o.changed();
          },
        });
        const look = f.preview ? h("img", { class: "file-look", src: f.preview, alt: "" }) : h("span", { class: "file-look file-kind" }, icon(f.state === "failed" ? "alert" : "file", { size: 18 }));
        const said = f.state === "going" ? "Sending…" : f.state === "failed" ? (f.problem ?? "Not taken") : bytesLabel(f.size);
        return h(
          "div",
          { class: `composer-file ${f.state}`, role: "listitem", title: f.problem ?? f.name },
          h("span", { class: "file-look-wrap" }, look, f.state === "going" ? spinner("xs") : null),
          h("span", { class: "file-words" }, h("span", { class: "file-name ellipsis" }, f.name), h("span", { class: "file-said ellipsis" }, said)),
          remove,
        );
      }),
    );
  }

  /** Files added: each made ready (a picture made smaller, its metadata left behind), then sent up to the node. */
  function add(files: File[]): void {
    if (!o.enabled() || !files.length) return;
    const room = ATTACHMENT_LIMITS.perMessage - o.files.get().length;
    if (files.length > room) toast(`${ATTACHMENT_LIMITS.perMessage} files go with a message at most`, { tone: "warn", description: room === 1 ? "The first is added." : room > 1 ? `The first ${room} are added.` : "Remove one to add another." });
    for (const file of files.slice(0, Math.max(0, room))) {
      const f: Waiting = { key: ++keys, name: file.name || "file", type: null, size: file.size, preview: null, state: "going" };
      o.files.set([...o.files.get(), f]);
      void (async () => {
        const ready = await prepare(file);
        if ("problem" in ready) {
          o.files.set(o.files.get().filter((w) => w.key !== f.key));
          toast("Not added", { tone: "warn", description: ready.problem });
        } else {
          Object.assign(f, { name: ready.name, type: ready.type, size: ready.bytes.length, preview: ready.preview });
          render();
          try {
            f.ref = await upload(ctx.api, ready);
            knownLook(f.ref, ready.preview);
            f.state = "up";
          } catch (error) {
            Object.assign(f, { state: "failed", problem: errorMessage(error) });
          }
        }
        if (!o.disposed()) {
          render();
          o.changed();
        }
      })();
    }
    render();
    o.changed();
  }
  chooser.addEventListener("change", () => {
    add([...(chooser.files ?? [])]);
    chooser.value = "";
  });

  function take(input: HTMLTextAreaElement, form: HTMLElement): void {
    // A picture pasted alone is attached; one that comes with text (a page copied) is pasted as its text.
    input.addEventListener("paste", (event: ClipboardEvent) => {
      const files = [...(event.clipboardData?.files ?? [])];
      if (!files.length || event.clipboardData?.types.includes("text/plain")) return;
      event.preventDefault();
      add(files);
    });
    // Files dropped on the message box are attached.
    form.addEventListener("dragover", (event: DragEvent) => {
      if (!o.enabled() || !event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      form.classList.add("dropping");
    });
    form.addEventListener("dragleave", () => form.classList.remove("dropping"));
    form.addEventListener("drop", (event: DragEvent) => {
      form.classList.remove("dropping");
      if (!o.enabled() || !event.dataTransfer?.files.length) return;
      event.preventDefault();
      add([...event.dataTransfer.files]);
    });
  }

  return {
    button: clip,
    row,
    chooser,
    add,
    carried: () => o.files.get().flatMap((f) => (f.state === "up" && f.ref ? [f.ref] : [])),
    going: () => o.files.get().some((f) => f.state === "going"),
    sent: () => {
      o.files.set(o.files.get().filter((f) => f.state !== "up"));
      render();
      o.changed();
    },
    take,
    render,
  };
}

/** What a message of yours carried: its pictures, each opened large with a tap, and its texts by name and size. */
export function attachedView(ctx: Ctx, refs: AttachmentRef[]): HTMLElement {
  return h(
    "div",
    { class: "attached", role: "list", "aria-label": "Files with it" },
    ...refs.map((ref) => {
      if (ref.type === "text/plain") return h("span", { class: "attached-file", role: "listitem", title: ref.name }, icon("file", { size: 16 }), h("span", { class: "ellipsis" }, ref.name), h("span", { class: "subtle" }, bytesLabel(ref.bytes)));
      const img = h("img", { alt: ref.name, decoding: "async" });
      // (Shimmering until its look comes, as a skeleton does.)
      const shown = h("button", { class: "attached-picture skeleton", type: "button", role: "listitem", "aria-label": `Open ${ref.name}`, title: ref.name }, img);
      void lookOf(ctx.api, ref).then((look) => {
        shown.classList.remove("skeleton");
        if (look) img.src = look;
        else shown.classList.add("gone");
      });
      shown.addEventListener("click", () => {
        if (!img.src) return;
        openSheet({ title: ref.name, description: bytesLabel(ref.bytes), size: "wide", body: h("img", { class: "attached-large", src: img.src, alt: ref.name }) });
      });
      return shown;
    }),
  );
}
