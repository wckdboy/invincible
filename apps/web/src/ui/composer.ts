import { cx, h, type Child } from "./dom.ts";

/*
 * The one message box (the usability pass, I11: Home's was a capsule, and a chat's, a task's and an agent's a tall box of
 * two rows with a grey square to send, so the app had two shapes for one thing). Every message box is this one: a
 * capsule holding what leads it (a paperclip), the field, what trails it (Steer and Queue while it works, Give a task)
 * and the send circle (or Stop, in its place, while it answers); the files going with it above the field; and its hint
 * under the capsule, said only while you type in it or it works. Where what trails it doesn't fit beside the field (a
 * phone, a task's Steer this task and Queue for after it), it goes under the field, inside the capsule.
 */

export interface ComposerParts {
  /** What sending does (the form's submit: Enter, or the send circle). */
  onSubmit: (event: Event) => void;
  field: HTMLTextAreaElement;
  /** The send circle, and Stop where it answers (one of them shown at a time): last in the capsule. */
  send: Child[];
  /** Before the field: a paperclip. */
  lead?: Child[];
  /** After the field, before the send circle: Steer, Queue, Give a task. */
  trail?: Child[];
  /** The files going with the message (its tray's row), above the field. */
  files?: Child;
  /** A file input of its own, hidden. */
  chooser?: Child;
  /** What its keys do now, or when it will be answered: under the capsule, only while you type or it works. */
  hint?: Child[];
  className?: string;
}

/** A message box in the one shape (the parts above), as a form. */
export function composerBox(parts: ComposerParts): HTMLFormElement {
  return h(
    "form",
    { class: cx("composer", parts.className), onsubmit: parts.onSubmit },
    parts.files ?? null,
    h(
      "div",
      { class: "composer-row" },
      parts.lead?.length ? h("div", { class: "composer-lead" }, ...parts.lead) : null,
      parts.field,
      h("div", { class: "composer-trail" }, ...(parts.trail ?? []), ...parts.send),
    ),
    parts.chooser ?? null,
    parts.hint?.length ? h("div", { class: "composer-hint" }, ...parts.hint) : null,
  );
}
