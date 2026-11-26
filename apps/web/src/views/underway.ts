import type { LookView, UnderwayView } from "@galahad/core";
import { isAbort } from "../api.ts";
import { type Ctx, errorMessage } from "../context.ts";
import { lookWords, nextLookMs, taskWords } from "../lib/underway.ts";
import { workerAvatar } from "../ui/avatar.ts";
import { button } from "../ui/controls.ts";
import { h, replace } from "../ui/dom.ts";
import { icon } from "../ui/icons.ts";
import { toast } from "../ui/toast.ts";
import { controlTeam } from "./team-forms.ts";

/*
 * Above a chat's message box, what is under way there (your word, 24 November 2026, after OpenMausBot's hand-off rows):
 * each task he gave a knight from this chat that hasn't ended, its knight's face and how it stands, opened at a tap and
 * stopped with its own Stop; and each look he set himself here, when it comes and what at, called off with Cancel.
 * Asked of the node when its live stream says the team or the chats changed (a task moved on, a look set, taken or
 * called off). While that stream is down: every few seconds while a task is under way or he is answering, just after a
 * look of his comes due (so it goes from here as he takes it), else every half minute.
 */

export interface Underway {
  el: HTMLElement;
  /** The kept chat on screen (null: none, or a temporary one), and whether he is answering in it. */
  show(conversation: string | null, answering: boolean): void;
  /** Ask again now (his answer ended, say). */
  refresh(): void;
  stop(): void;
}

export function underway(ctx: Ctx): Underway {
  const el = h("div", { class: "underway", role: "region", "aria-label": "Under way in this chat", hidden: true });
  let conversation: string | null = null;
  let answering = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let asking: AbortController | null = null;
  let stopped = false;
  let shown = "";

  const schedule = (ms: number) => {
    if (timer) clearTimeout(timer);
    // (While the node's live stream is open, it says when to ask: nothing is asked on a timer.)
    timer = stopped || !conversation || ctx.live.streaming.value ? null : setTimeout(() => void ask(), ms);
  };
  const unfollow = ctx.live.follow(["team", "turns"], () => ask(), null, 2000);

  async function ask(): Promise<void> {
    if (!conversation || stopped) return;
    const asked = conversation;
    asking?.abort();
    const controller = new AbortController();
    asking = controller;
    try {
      const view = await ctx.api.post<UnderwayView>("/api/conversations/underway", { id: asked }, controller.signal);
      if (asked !== conversation || stopped) return;
      draw(view);
      schedule(nextLookMs({ tasks: view.tasks.length, looks: view.looks.map((look) => look.at) }, answering, Date.now()));
    } catch (error) {
      if (isAbort(error)) return;
      // A node from before this, or a chat gone: nothing is shown, and it is asked again in a while.
      draw({ tasks: [], looks: [] });
      schedule(30_000);
    }
  }

  function draw(view: UnderwayView): void {
    const signature = JSON.stringify([view.tasks.map((t) => [t.id, t.status, t.progress]), view.looks.map((l) => [l.id, l.at])]);
    if (signature === shown) return;
    shown = signature;
    el.hidden = !view.tasks.length && !view.looks.length;
    const now = Date.now();
    const canStop = ctx.can("fleet:admin");
    replace(
      el,
      ...view.tasks.map((task) => {
        const words = taskWords(task);
        const open = h("button", { type: "button", class: "underway-main", title: `Open ${words.who}'s conversation` }, workerAvatar({ id: task.assignee, name: task.name, size: 24, still: true }), h("span", { class: "underway-words" }, h("span", { class: "underway-who" }, `${words.who} · ${words.state}`), h("span", { class: "underway-what" }, words.what)));
        open.addEventListener("click", () => ctx.navigate("team", { room: task.room }));
        const stop = canStop
          ? button("Stop", {
              size: "sm",
              icon: "stop",
              title: `Stop ${words.who}'s work on this`,
              onClick: async () => {
                if (await controlTeam(ctx, { task: task.id, action: "stop" })) void ask();
              },
            })
          : null;
        return h("div", { class: "underway-row", "data-kind": "task" }, open, stop);
      }),
      ...view.looks.map((look: LookView) =>
        h(
          "div",
          { class: "underway-row", "data-kind": "look" },
          h("span", { class: "underway-main" }, icon("clock", { size: 18, class: "subtle" }), h("span", { class: "underway-words" }, h("span", { class: "underway-what" }, lookWords(look, now)))),
          button("Cancel", {
            size: "sm",
            variant: "ghost",
            title: "He won't look again then",
            onClick: async () => {
              try {
                await ctx.api.post("/api/looks/cancel", { id: look.id });
                void ask();
              } catch (error) {
                if (!isAbort(error)) toast("Couldn't call it off", { tone: "error", description: errorMessage(error) });
              }
            },
          }),
        ),
      ),
    );
  }

  return {
    el,
    show(next, nowAnswering) {
      const changed = next !== conversation;
      const started = nowAnswering && !answering;
      conversation = next;
      answering = nowAnswering;
      if (!next) {
        asking?.abort();
        draw({ tasks: [], looks: [] });
        schedule(0);
        return;
      }
      if (changed) shown = "";
      if (changed || started) void ask();
    },
    refresh() {
      void ask();
    },
    stop() {
      stopped = true;
      unfollow();
      asking?.abort();
      if (timer) clearTimeout(timer);
    },
  };
}
