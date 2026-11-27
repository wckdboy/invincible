import type { ActionView, LoopDraftView, LoopView, QuestionField, QuestionView, ScreenSessionView } from "@invincible/core";
import { type Ctx, errorMessage } from "../context.ts";
import { callerName, defaultLabel, deleteName, rowsFromCall } from "../lib/orders.ts";
import { hlcMs, relativeTime } from "../lib/time.ts";
import type { ActionClass } from "../types.ts";
import { badge, busy, button, callout, card, empty, field, formActions, listRow, note, rows, type Tone } from "../ui/controls.ts";
import { confirmAction, openSheet } from "../ui/dialog.ts";
import { h, replace } from "../ui/dom.ts";
import { icon } from "../ui/icons.ts";
import { toast } from "../ui/toast.ts";
import { CLASS_INFO, deviceName } from "./activity.ts";
import { describeWakes } from "../lib/wakes.ts";
import { describeTask } from "../lib/loops.ts";
import { loopsChanged, showHookSecret } from "./loops.ts";
import { openOrderFromAction } from "./orders.ts";

/*
 * The Inbox's cards: each thing that needs the owner whole, as Needs you opens it in a sheet (views/needs.ts, the page):
 * an approval, a loop it drafted, a service's question, its use of a Mac, and what was decided lately. Approvals scale
 * with stakes: a phone is one click after comparing codes; a machine asks once more; an outward action is shown in full
 * and confirmed; a delete makes you type what it deletes.
 */

const STATE: Record<ActionView["state"], { label: string; tone: Tone }> = {
  waiting: { label: "waiting for you", tone: "warn" },
  approved: { label: "approved · sending", tone: "accent" },
  done: { label: "sent", tone: "ok" },
  failed: { label: "failed", tone: "danger" },
  denied: { label: "declined", tone: "neutral" },
  expired: { label: "expired unanswered", tone: "neutral" },
  lapsed: { label: "approval expired · never sent", tone: "neutral" },
};

/** "loop:morning" → "the loop morning"; who asked, as the owner would say it. */
function askedBy(by: string): HTMLElement {
  const [kind, ...rest] = by.split(":");
  const who = rest.join(":");
  const words: Record<string, string> = { loop: "the loop", arm: "the arm", node: "the node", run: "the run" };
  return words[kind!] && who ? h("span", {}, `${words[kind!]} `, h("span", { class: "mono" }, who)) : h("span", { class: "mono" }, by);
}

function argsList(args: Record<string, unknown>): HTMLElement | null {
  const entries = Object.entries(args);
  if (!entries.length) return null;
  return h(
    "dl",
    { class: "kv" },
    ...entries.flatMap(([key, value]) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      return [h("dt", { class: "mono" }, key), h("dd", { class: "mono pre-wrap" }, text.length > 800 ? `${text.slice(0, 800)}…` : text)];
    }),
  );
}

/** Work a request would send (a shipment's kept changes): read it before you answer. */
function keptWork(ctx: Ctx, action: ActionView): HTMLElement | null {
  const id = action.args.artifact;
  if (typeof id !== "string" || !/^art_[A-Za-z0-9_-]{22}$/.test(id)) return null;
  return h(
    "div",
    { class: "row wrap" },
    button("Read the changes", { size: "sm", icon: "archive", onClick: () => ctx.navigate("artifacts", { intent: id }) }),
    h("span", { class: "tiny subtle" }, "The work this sends, kept with its SHA-256s: changes.patch, and the files themselves under ship/."),
  );
}

/** A loop the primary drafted when you asked for one in chat: it runs nothing until you add it here (or dismiss it). */
export function loopDraftCard(ctx: Ctx, draft: LoopDraftView): HTMLElement {
  const outcome = h("div");
  const mayAdd = ctx.can("brain:write");
  const add = button(draft.replaces ? "Add, replacing yours" : "Add loop", { variant: "primary", icon: "check" });
  const dismiss = button("Dismiss", { icon: "x" });
  const answer = async (trigger: HTMLButtonElement, adding: boolean) =>
    busy(trigger, async () => {
      try {
        if (adding) {
          const { loop, hookSecret } = await ctx.api.post<{ loop: LoopView; hookSecret?: string }>("/api/loops", {
            name: draft.name,
            schedule: draft.schedule,
            tz: draft.tz,
            task: draft.task,
            ...(draft.wakes.length ? { wakes: draft.wakes } : {}),
            ...(draft.cooldownMs ? { cooldownMs: draft.cooldownMs } : {}),
            ...(draft.on ? { on: draft.on } : {}),
            ...(draft.label ? { label: draft.label } : {}),
            draft: draft.id,
          });
          loopsChanged.update((n) => n + 1);
          toast(`Added loop ${draft.name}`, { tone: "ok", description: draft.schedule === "never" ? "It runs when what wakes it happens: see Loops." : "It runs on its schedule from now: see Loops." });
          if (hookSecret) showHookSecret(loop, hookSecret);
        } else {
          await ctx.api.post("/api/loops/drafts/dismiss", { id: draft.id });
          toast("Dismissed", { tone: "info", description: "Nothing was added." });
        }
      } catch (error) {
        replace(outcome, callout("danger", errorMessage(error), { title: adding ? "Couldn't add it" : "Couldn't dismiss it" }));
      }
      await ctx.live.refreshLoopDrafts();
    });
  add.addEventListener("click", () => void answer(add, true));
  dismiss.addEventListener("click", () => void answer(dismiss, false));
  return card(
    { tone: "accent", label: `Your agent drafted a loop: ${draft.label ?? draft.name}` },
    listRow({
      lead: "repeat",
      leadTone: "agent",
      top: true,
      title: h("span", { class: "row wrap" }, h("span", {}, draft.label ?? draft.name), h("span", { class: "mono tiny subtle" }, draft.name)),
      sub: `${draft.schedule === "never" ? "Only when woken" : `${draft.schedule}${draft.tz !== "UTC" ? ` (${draft.tz})` : ""}`}${draft.on ? ` on ${draft.on}` : ""}`,
      meta: [h("span", {}, `Drafted by ${draft.by === "primary" ? "your agent" : draft.by}`), h("span", { title: new Date(draft.at).toLocaleString() }, relativeTime(draft.at))],
    }),
    h("p", { class: "small muted wrap-anywhere" }, describeTask(draft.task)),
    draft.wakes.length ? h("p", { class: "small muted wrap-anywhere" }, describeWakes(draft.wakes, draft.cooldownMs)) : null,
    draft.why ? h("div", { class: "quote small" }, draft.why) : null,
    note(draft.replaces ? `Adding it replaces your loop ${draft.name}. ` : "", `It runs nothing until you add it. Unanswered, it's gone ${relativeTime(draft.expires)}.`),
    mayAdd
      ? formActions(dismiss, add)
      : callout("quiet", h("span", {}, "This device can't add loops (no brain:write scope). Add it from one that can, or on a node: ", h("code", {}, `invincible loop add --draft ${draft.id}`))),
    outcome,
  );
}

/** The texts a request carries that you may put your own words in before your yes (a message's, a pull request's). */
const editableTexts = (action: ActionView): [string, string][] => Object.entries(action.args).filter((entry): entry is [string, string] => typeof entry[1] === "string");

/**
 * Your own words in a request before your yes: each text it carries, to change. Only what you changed goes; your
 * version is what's sent, and the one it was asked as is declined, saying which it became.
 */
function openEdit(ctx: Ctx, action: ActionView, node: string): void {
  const texts = editableTexts(action);
  const fields = texts.map(([key, value]) => {
    const area = h("textarea", { class: "textarea mono", rows: Math.min(12, Math.max(2, value.split("\n").length + 1)), maxlength: 8000, spellcheck: "true" }) as HTMLTextAreaElement;
    area.value = value;
    return { key, value, area };
  });
  const status = h("div");
  const send = button("Approve and send as edited", { variant: "primary", type: "submit", icon: "check" });
  const form = h(
    "form",
    {
      class: "stack loose",
      onsubmit: (event: Event) => {
        event.preventDefault();
        const edits = Object.fromEntries(fields.filter((f) => f.area.value !== f.value).map((f) => [f.key, f.area.value]));
        if (!Object.keys(edits).length) {
          replace(status, callout("quiet", "Nothing is changed yet. Change a text, or close this and approve it as it is."));
          return;
        }
        void busy(send, async () => {
          try {
            const { action: sent } = await ctx.api.post<{ action: ActionView }>("/api/actions/decide", { id: action.id, approve: true, edits });
            sheet.close();
            toast("Approved as you edited it", { tone: "ok", description: `${node} sends your version once, now (${sent.id}).` });
          } catch (error) {
            replace(status, callout("danger", errorMessage(error), { title: "Couldn't approve it" }));
          }
          await ctx.live.refreshActions();
        });
      },
    },
    ...fields.map((f) => field(f.key, f.area)),
    note(`Your version is what ${node} sends, once, to `, h("span", { class: "mono" }, action.target), `. The request as it was asked is declined, saying which it became.`),
    status,
    formActions(button("Cancel", { onClick: () => sheet.close() }), send),
  );
  const sheet = openSheet({ title: "Edit, then approve", description: `${action.connector}.${action.tool}, asked by ${callerName(action.by)}`, body: form, size: "wide", initialFocus: () => fields[0]?.area });
}

/**
 * Your answer to an action that waits for you, said to the node (`yes`: approve it, as it is). What became of it is a
 * toast; a refusal is handed to `problem`, where the card that asked shows it.
 */
export async function answerAction(ctx: Ctx, action: ActionView, yes: boolean, trigger: HTMLButtonElement, problem: (callout: HTMLElement) => void): Promise<void> {
  const node = deviceName(ctx, action.node);
  await busy(trigger, async () => {
    try {
      await ctx.api.post("/api/actions/decide", { id: action.id, approve: yes });
      toast(yes ? "Approved" : "Declined", {
        tone: yes ? "ok" : "info",
        description: yes ? `${node} sends it once, now.` : "Nothing was sent.",
      });
      await ctx.live.refreshActions();
    } catch (error) {
      problem(callout("danger", errorMessage(error), { title: yes ? "Couldn't approve" : "Couldn't decline" }));
      await ctx.live.refreshActions();
    }
  });
}

/** Approve an action: the card says what and why; this says what happens next, once more, before anything leaves (a
 * delete makes you type what it deletes). */
export async function approveAction(ctx: Ctx, action: ActionView, trigger: HTMLButtonElement, problem: (callout: HTMLElement) => void): Promise<void> {
  const destructive = action.class === "delete";
  const node = deviceName(ctx, action.node);
  const ok = await confirmAction({
    title: destructive ? "Approve this delete?" : "Approve and send?",
    body: [
      h("p", {}, h("span", { class: "mono strong wrap-anywhere" }, action.target), ` through ${action.connector}.`),
      h(
        "p",
        {},
        destructive
          ? `${node} deletes it once, as soon as you approve. It can't be brought back.`
          : `${node} sends it once, as soon as you approve. It can't be called back, and if it fails it isn't retried.`,
      ),
    ],
    confirmLabel: destructive ? "Approve delete" : "Approve and send",
    tone: destructive ? "danger" : "primary",
    typeToConfirm: destructive ? deleteName(action) : undefined,
  });
  if (ok) await answerAction(ctx, action, true, trigger, problem);
}

/** Approve it, and answer calls like it the same way next time: a standing order, signed in the same step. */
export function allowSimilar(ctx: Ctx, action: ActionView): void {
  openOrderFromAction(ctx, action, {
    rows: rowsFromCall(action),
    caller: callerName(action.by),
    label: defaultLabel(action),
    node: deviceName(ctx, action.node),
    confirmName: deleteName(action),
    onDone: () => void ctx.live.refreshActions(),
  });
}

/** An approval waiting for you, as the Inbox shows it, and the primary's welcome too (primary-asks.ts). Nothing leaves until you approve it. */
export function actionCard(ctx: Ctx, action: ActionView): HTMLElement {
  const info = CLASS_INFO[action.class as ActionClass];
  const destructive = action.class === "delete";
  const node = deviceName(ctx, action.node);
  const asked = hlcMs(action.requestedAt);
  const expires = h("span", { class: "tnum expires", "data-expires": String(action.expires) }, `Expires ${relativeTime(action.expires)}`);
  const outcome = h("div");
  const admin = ctx.can("fleet:admin");
  const approve = button(destructive ? "Approve delete…" : "Approve…", { variant: "primary", icon: "check" });
  const decline = button("Decline", { variant: "danger", icon: "x" });
  // Approve, and answer calls like it the same way next time: a standing order, signed in the same step.
  const similar = button("Approve and allow similar…", { icon: "scroll" });
  // Your own words in it before your yes (never a delete's: what it deletes is typed to approve it).
  const edit = !destructive && editableTexts(action).length ? button("Edit…", { icon: "edit" }) : null;
  edit?.addEventListener("click", () => openEdit(ctx, action, node));
  const problem = (shown: HTMLElement) => replace(outcome, shown);

  approve.addEventListener("click", () => void approveAction(ctx, action, approve, problem));
  decline.addEventListener("click", () => void answerAction(ctx, action, false, decline, problem));
  similar.addEventListener("click", () => allowSimilar(ctx, action));

  return card(
    { tone: destructive ? "danger" : "accent", label: `Your agent asks to ${info?.label.toLowerCase() ?? action.class}: ${action.target}` },
    listRow({
      lead: "mark",
      leadTone: "agent",
      top: true,
      title: h("span", { class: "row wrap" }, h("span", { class: "mono" }, `${action.connector}.${action.tool}`), info ? badge(info.label.toLowerCase(), info.tone, info.icon) : badge(action.class, "warn")),
      sub: h("span", { class: "mono" }, action.target),
      meta: [h("span", {}, "Asked by ", askedBy(action.by)), h("span", {}, `on ${node}`), asked ? h("span", { title: new Date(asked).toLocaleString() }, relativeTime(asked)) : null],
    }),
    action.why ? h("div", { class: "quote small" }, action.why) : null,
    argsList(action.args),
    keptWork(ctx, action),
    note(
      expires,
      ". No answer means no. ",
      destructive
        ? "Deleting anything persistent asks you, unless a standing order of yours names exactly this."
        : "Outward actions (posting, sending, pushing, the physical world) ask you, unless a standing order of yours covers them, or they are its agents' work in the repositories you gave them, which it approves itself.",
    ),
    admin
      ? formActions(decline, similar, edit, approve)
      : callout("quiet", h("span", {}, "This device can't answer (no fleet:admin scope). Answer from one that can, or on a node: ", h("code", {}, `invincible action approve ${action.id}`))),
    outcome,
  );
}

/**
 * Its ask to use a Mac itself (docs/MAC.md, M4), or its session there while it lasts: what for (its words), for how
 * long, and your answer: let it (asked once more, saying what it gives it), say no, or end it sooner.
 */
export function screenSessionCard(ctx: Ctx, s: ScreenSessionView): HTMLElement {
  const outcome = h("div");
  const admin = ctx.can("fleet:admin");
  const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  async function answer(path: string, body: Record<string, unknown>, trigger: HTMLButtonElement, said: string): Promise<void> {
    await busy(trigger, async () => {
      try {
        await ctx.api.post(path, body);
        toast(said);
      } catch (error) {
        replace(outcome, callout("danger", errorMessage(error), { title: "Couldn't do that" }));
      }
      await ctx.live.refreshScreenSessions();
    });
  }
  if (s.state === "allowed") {
    const end = button("End now", { variant: "danger", icon: "x" });
    end.addEventListener("click", () => void answer("/api/screen/end", { id: s.id }, end, "Ended: nothing of that Mac is its now."));
    return card(
      { tone: "warn", label: `Your agent is using ${s.nodeName} itself` },
      listRow({ lead: "mark", leadTone: "agent", top: true, title: `Your agent is using ${s.nodeName} itself`, sub: `Until ${clock(s.until!)}, or until you end it.`, meta: [h("span", { title: new Date(s.until!).toLocaleString() }, `ends ${relativeTime(s.until!)}`)] }),
      h("div", { class: "quote small" }, s.why),
      admin ? formActions(end) : callout("quiet", h("span", {}, "This device can't end it (no fleet:admin scope): ", h("code", {}, `invincible screen end ${s.id}`))),
      outcome,
    );
  }
  const yes = button("Let it…", { variant: "primary", icon: "check" });
  const no = button("Not now", { icon: "x" });
  yes.addEventListener("click", async () => {
    const ok = await confirmAction({
      title: `Let your agent use ${s.nodeName} itself?`,
      body: [
        h("p", {}, `For ${s.minutes} minutes from now: it sees its screen, uses its apps and runs commands as its user, held to your rules. You can watch it and end it any time.`),
        h("p", {}, "That account holds the node's keys, so a misled model could act as you there: let it only for work you want done that way."),
      ],
      confirmLabel: `Let it, for ${s.minutes} minutes`,
      tone: "primary",
    });
    if (ok) await answer("/api/screen/decide", { id: s.id, allow: true }, yes, `Allowed for ${s.minutes} minutes.`);
  });
  no.addEventListener("click", () => void answer("/api/screen/decide", { id: s.id, allow: false }, no, "Said no: nothing of it is its."));
  return card(
    { tone: "accent", label: `Your agent asks to use ${s.nodeName} itself` },
    listRow({ lead: "mark", leadTone: "agent", top: true, title: `Your agent asks to use ${s.nodeName} itself`, sub: `For ${s.minutes} minutes, if you let it.`, meta: [h("span", { title: new Date(s.askedAt).toLocaleString() }, relativeTime(s.askedAt))] }),
    h("div", { class: "quote small" }, s.why),
    note(`Answer by ${clock(s.answerBy)}. No answer means no.`),
    admin ? formActions(no, yes) : callout("quiet", h("span", {}, "This device can't answer (no fleet:admin scope): ", h("code", {}, `invincible screen approve ${s.id}`))),
    outcome,
  );
}

/** One field of a service's question, as an input, and what it holds now (undefined: left empty). */
function questionInput(f: QuestionField): { el: HTMLElement; value: () => unknown } {
  switch (f.kind) {
    case "text": {
      const type = f.format === "email" ? "email" : f.format === "uri" ? "url" : f.format === "date" ? "date" : f.format === "date-time" ? "datetime-local" : "text";
      const input = h("input", { class: "input", type, maxlength: f.maxLength, value: f.default ?? "", required: f.required, autocomplete: "off", autocorrect: "off", spellcheck: "false" });
      return { el: input, value: () => (input.value.trim() ? input.value : undefined) };
    }
    case "number": {
      const input = h("input", { class: "input", type: "number", step: f.integer ? 1 : "any", min: f.minimum, max: f.maximum, value: f.default ?? "", required: f.required });
      return { el: input, value: () => (input.value === "" ? undefined : Number(input.value)) };
    }
    case "yes-no": {
      const box = h("input", { type: "checkbox", checked: f.default ?? false });
      return { el: h("label", { class: "row" }, box, h("span", {}, "Yes")), value: () => box.checked };
    }
    case "one": {
      const select = h("select", { class: "select", required: f.required }, h("option", { value: "" }, "Choose…"), ...f.options.map((o) => h("option", { value: o.value, selected: o.value === f.default }, o.title)));
      return { el: select, value: () => select.value || undefined };
    }
    case "many": {
      const boxes = f.options.map((o) => ({ o, box: h("input", { type: "checkbox", checked: f.default?.includes(o.value) ?? false }) }));
      return { el: h("div", { class: "stack tight" }, ...boxes.map(({ o, box }) => h("label", { class: "row" }, box, h("span", {}, o.title)))), value: () => boxes.filter((b) => b.box.checked).map((b) => b.o.value) };
    }
  }
}

/** An MCP server's question, mid-call: its words quoted (never as yours), its form, and Send or No. Its call waits. */
export function questionCard(ctx: Ctx, q: QuestionView): HTMLElement {
  const outcome = h("div");
  const inputs = q.fields.map((f) => ({ f, ...questionInput(f) }));
  async function answer(accept: boolean, trigger: HTMLButtonElement): Promise<void> {
    const content = Object.fromEntries(inputs.flatMap(({ f, value }) => (value() === undefined ? [] : [[f.name, value()]])));
    await busy(trigger, async () => {
      try {
        await ctx.api.post("/api/questions/answer", { id: q.id, accept, ...(accept ? { content } : {}) });
        toast(accept ? `Sent to ${q.label}` : `Said no to ${q.label}`, { description: "Its call goes on." });
        await ctx.live.refreshQuestions();
      } catch (error) {
        replace(outcome, callout("danger", errorMessage(error), { title: "Not sent" }));
      }
    });
  }
  const send = button("Send", { variant: "primary", icon: "check" });
  const no = button("No", { icon: "x" });
  send.addEventListener("click", () => void answer(true, send));
  no.addEventListener("click", () => void answer(false, no));
  return card(
    { tone: "accent", label: `${q.label} asks you` },
    listRow({ lead: "plug", top: true, title: `${q.label} asks you`, sub: "Its call waits for your answer. No answer, and it goes on without one.", meta: [h("span", { class: "expires", "data-expires": String(q.expires) }, `Expires ${relativeTime(q.expires)}`)] }),
    h("div", { class: "quote small" }, q.message),
    ...inputs.map(({ f, el }) => field(f.required ? f.title : `${f.title} (optional)`, el, f.description ? { hint: f.description } : {})),
    note("A service's own form: never type a password or a key into it. Keys belong in the vault."),
    ctx.can("fleet:admin") ? formActions(no, send) : callout("quiet", "This device can't answer (no fleet:admin scope)."),
    outcome,
  );
}

/** An approval that was answered, or expired, as Recent decisions lists it: what, how it ended, who asked, and how. */
export function decidedRow(ctx: Ctx, action: ActionView): HTMLElement {
  const state = STATE[action.state] ?? { label: action.state, tone: "neutral" as Tone };
  const asked = hlcMs(action.requestedAt);
  return listRow({
    lead: action.state === "done" ? "check" : action.state === "failed" ? "x" : action.state === "approved" ? "external" : "minus",
    leadTone: state.tone,
    top: true,
    title: h("span", { class: "row wrap" }, h("span", { class: "mono" }, `${action.connector}.${action.tool}`), badge(state.label, state.tone)),
    sub: h("span", { class: "mono" }, action.target),
    meta: [
      h("span", {}, "asked by ", askedBy(action.by)),
      asked ? h("span", {}, relativeTime(asked)) : null,
      action.order
        ? h("span", { class: "row tight" }, icon("scroll", { size: 12 }), `answered by your standing order "${action.order.label}"`)
        : action.decidedVia && !action.self
          ? h("span", {}, `answered from ${deviceName(ctx, action.decidedVia)}`)
          : null,
      // What you said with it; for one you edited, which it was sent as; for one it approved itself, why (it says so).
      action.note ? h("span", { class: "wrap-anywhere" }, action.note) : null,
    ],
    body: action.receipt ? h("details", { class: "process" }, h("summary", { "data-key": `receipt:${action.id}` }, icon("chevron-right", { size: 14, class: "chev" }), "Receipt"), h("pre", { class: "result process-body" }, action.receipt)) : null,
  });
}
