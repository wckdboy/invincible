import { holdWords, type QueuedMessage, type QueueHold } from "@galahad/core/turns";
import { findSecrets } from "@galahad/core/secret-scan";
import { plural } from "../lib/text.ts";
import { stopsIn } from "../lib/turns.ts";
import { button } from "../ui/controls.ts";
import { h, replace } from "../ui/dom.ts";
import { icon } from "../ui/icons.ts";
import { toast } from "../ui/toast.ts";

/*
 * What's waiting while Galahad works, above the composer: the messages you sent to
 * steer him that haven't reached him yet, and the
 * ones you queued on the node, each editable and removable, with Send now. After a
 * stop, a failure or a restart the queue is held: nothing is sent until you resume
 * or discard it. And one line that says what unattended work may and may not do.
 */

export interface QueueState {
  queue: readonly QueuedMessage[];
  held: QueueHold | null;
  /** Steers on their way to him. */
  steering: readonly string[];
  busy: boolean;
  /** When the node stops the running turn by itself. */
  deadline: number | null;
}

export interface QueueActions {
  edit(id: number, text: string): Promise<string | null>;
  remove(id: number): Promise<string | null>;
  discard(): Promise<string | null>;
  sendNow(id: number): Promise<string | null>;
  resume(): Promise<string | null>;
}

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export function queuePanel(actions: QueueActions, opts: { compact?: boolean } = {}): { el: HTMLElement; render(state: QueueState): void } {
  const el = h("div", { class: `chat-queue${opts.compact ? " compact" : ""}`, hidden: true });
  let editing: number | null = null;
  let seen = "";

  const act = (work: Promise<string | null>, failed: string): void => {
    void work.then((problem) => {
      if (problem) toast(failed, { tone: "error", description: problem });
    });
  };

  function row(q: QueuedMessage, state: QueueState): HTMLElement {
    if (editing === q.id) {
      const field = h("textarea", { class: "textarea", rows: 2, "aria-label": "Queued message" }) as HTMLTextAreaElement;
      field.value = q.text;
      const note = h("div", { class: "tiny chat-queue-note", role: "alert", hidden: true });
      const done = (): void => {
        editing = null;
        seen = "";
        render(last!);
      };
      const save = (): void => {
        const text = field.value.trim();
        if (!text) return;
        // Checked here as in the composer: nothing credential-shaped is kept on the node or sent to a model.
        const finding = findSecrets(text)[0];
        if (finding) {
          note.hidden = false;
          note.textContent = `That looks like a ${finding.kind}. It won't be queued: keys belong in the vault.`;
          return;
        }
        act(actions.edit(q.id, text), "Couldn't change it");
        done();
      };
      field.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          save();
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          done();
        }
      });
      requestAnimationFrame(() => field.focus());
      return h("li", { class: "chat-queue-item editing" }, field, note, h("div", { class: "row" }, button("Save", { size: "sm", variant: "primary", onClick: save }), button("Cancel", { size: "sm", variant: "ghost", onClick: done })));
    }
    return h(
      "li",
      { class: "chat-queue-item" },
      h("span", { class: "chat-queue-text", title: q.text }, clip(q.text, opts.compact ? 90 : 220), q.by ? h("span", { class: "subtle" }, ` · from ${q.by}`) : null),
      h(
        "span",
        { class: "chat-queue-actions" },
        button("Send now", {
          size: "sm",
          variant: "ghost",
          title: state.busy ? "Tell him now: it reaches him at his next safe point" : "Send it now, as a turn",
          onClick: () => act(actions.sendNow(q.id), "Couldn't send it"),
        }),
        button("Edit", { size: "sm", variant: "ghost", icon: "edit", iconOnly: true, label: "Edit this queued message", onClick: () => ((editing = q.id), (seen = ""), render(last!)) }),
        button("Remove", { size: "sm", variant: "ghost", icon: "x", iconOnly: true, label: "Remove this queued message", onClick: () => act(actions.remove(q.id), "Couldn't remove it") }),
      ),
    );
  }

  let last: QueueState | null = null;
  function render(state: QueueState): void {
    last = state;
    if (editing !== null && !state.queue.some((q) => q.id === editing)) editing = null;
    // The minute it stops by itself is part of what's shown: a new minute is a change.
    const minute = state.busy && state.deadline ? stopsIn(state.deadline, Date.now()) : "";
    const signature = JSON.stringify([state.queue, state.held, state.steering, state.busy, minute, editing]);
    if (signature === seen) return;
    seen = signature;
    const parts: HTMLElement[] = [];
    if (state.steering.length) {
      parts.push(
        h(
          "div",
          { class: "chat-queue-steer", role: "status" },
          h("span", { class: "spinner", "aria-hidden": "true" }),
          h("div", {}, h("div", { class: "tiny strong" }, `On ${state.steering.length === 1 ? "its" : "their"} way to him: he's told at his next safe point (a tool that's running finishes first)`), ...state.steering.map((text) => h("div", { class: "chat-queue-text" }, clip(text, opts.compact ? 90 : 220)))),
        ),
      );
    }
    if (state.queue.length) {
      const head = state.held
        ? h(
            "div",
            { class: "chat-queue-head held", role: "status" },
            icon("pause", { size: 14 }),
            h("span", { class: "grow" }, h("strong", {}, `${plural(state.queue.length, "message")} held`), `: ${holdWords(state.held)}. Nothing is sent until you resume.`),
            button("Resume", { size: "sm", variant: "primary", icon: "play", onClick: () => act(actions.resume(), "Couldn't resume") }),
            button("Discard", { size: "sm", variant: "ghost", title: "Discard everything queued behind this chat", onClick: () => act(actions.discard(), "Couldn't discard them") }),
          )
        : h("div", { class: "chat-queue-head" }, icon("clock", { size: 14 }), h("span", { class: "grow" }, h("strong", {}, `${plural(state.queue.length, "message")} queued`), state.busy ? ": sent in order when he's done with this turn." : ": waiting for room on the node."));
      parts.push(head, h("ol", { class: "chat-queue-list" }, ...state.queue.map((q) => row(q, state))));
    }
    if (state.busy) {
      // What work that goes on unattended may and may not do, and when it ends by itself.
      parts.push(
        h(
          "div",
          { class: "chat-queue-foot tiny" },
          icon("shield-check", { size: 13 }),
          h("span", {}, `He keeps working if you leave this page${minute ? `, and ${minute}` : ""}. Anything that needs you (an approval, a key) waits in your Inbox: nothing is approved for you.`),
        ),
      );
    }
    el.hidden = !parts.length;
    replace(el, ...parts);
  }

  return { el, render };
}
