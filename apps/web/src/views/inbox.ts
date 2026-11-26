import type { ActionView, LoopDraftView, LoopView, NoticeView, QuestionField, QuestionView, ScreenSessionView } from "@galahad/core";
import { type Ctx, errorMessage, type View } from "../context.ts";
import { isWaiting } from "../live.ts";
import { noticeFrom } from "../lib/notices.ts";
import { callerName, defaultLabel, deleteName, rowsFromCall } from "../lib/orders.ts";
import { hlcMs, relativeTime } from "../lib/time.ts";
import type { ActionClass } from "../types.ts";
import { badge, busy, button, callout, card, disclosure, empty, field, formActions, linkButton, listRow, note, pageBody, pageHead, rows, section, skeletonRows, type Tone } from "../ui/controls.ts";
import { confirmAction, openSheet } from "../ui/dialog.ts";
import { h, keepPlace, replace } from "../ui/dom.ts";
import { icon } from "../ui/icons.ts";
import { toast } from "../ui/toast.ts";
import { factRow } from "./about-you.ts";
import { CLASS_INFO, deviceName } from "./activity.ts";
import { connectorRequestCard } from "./connectors.ts";
import { openInvite, pairingCard } from "./fleet.ts";
import { describeWakes } from "../lib/wakes.ts";
import { describeTask, findingRow, loopsChanged, showHookSecret } from "./loops.ts";
import { reachNote } from "./notifications.ts";
import { openOrderFromAction } from "./orders.ts";
import { secretRequestCard } from "./vault.ts";

/*
 * Everything that needs the owner, in one place: devices asking to join,
 * credentials Galahad asked for, actions his oath makes him ask about, and
 * what the heartbeat noticed. Approvals scale with stakes: a phone is one click
 * after comparing codes; a machine asks once more; an outward action is shown
 * in full and confirmed; a delete makes you type what it deletes.
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
  const words: Record<string, string> = { loop: "the loop", arm: "the arm", node: "the node", quest: "the quest" };
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

/** A loop Galahad drafted when you asked for one in chat: it runs nothing until you add it here (or dismiss it). */
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
    { tone: "accent", label: `Galahad drafted a loop: ${draft.label ?? draft.name}` },
    listRow({
      lead: "repeat",
      leadTone: "agent",
      top: true,
      title: h("span", { class: "row wrap" }, h("span", {}, draft.label ?? draft.name), h("span", { class: "mono tiny subtle" }, draft.name)),
      sub: `${draft.schedule === "never" ? "Only when woken" : `${draft.schedule}${draft.tz !== "UTC" ? ` (${draft.tz})` : ""}`}${draft.on ? ` on ${draft.on}` : ""}`,
      meta: [h("span", {}, `Drafted by ${draft.by === "galahad" ? "Galahad" : draft.by}`), h("span", { title: new Date(draft.at).toLocaleString() }, relativeTime(draft.at))],
    }),
    h("p", { class: "small muted wrap-anywhere" }, describeTask(draft.task)),
    draft.wakes.length ? h("p", { class: "small muted wrap-anywhere" }, describeWakes(draft.wakes, draft.cooldownMs)) : null,
    draft.why ? h("div", { class: "quote small" }, draft.why) : null,
    note(draft.replaces ? `Adding it replaces your loop ${draft.name}. ` : "", `It runs nothing until you add it. Unanswered, it's gone ${relativeTime(draft.expires)}.`),
    mayAdd
      ? formActions(dismiss, add)
      : callout("quiet", h("span", {}, "This device can't add loops (no brain:write scope). Add it from one that can, or on a node: ", h("code", {}, `galahad loop add --draft ${draft.id}`))),
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

/** An approval waiting for you, as the Inbox shows it, and Galahad's welcome too (galahad-asks.ts). Nothing leaves until you approve it. */
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
    { tone: destructive ? "danger" : "accent", label: `Galahad asks to ${info?.label.toLowerCase() ?? action.class}: ${action.target}` },
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
        : "Outward actions (posting, sending, pushing, the physical world) ask you, unless a standing order of yours covers them, or they are his knights' work in the repositories you gave them, which he approves himself.",
    ),
    admin
      ? formActions(decline, similar, edit, approve)
      : callout("quiet", h("span", {}, "This device can't answer (no fleet:admin scope). Answer from one that can, or on a node: ", h("code", {}, `galahad action approve ${action.id}`))),
    outcome,
  );
}

/**
 * His ask to use a Mac itself (docs/MAC.md, M4), or his session there while it lasts: what for (his words), for how
 * long, and your answer: let him (asked once more, saying what it gives him), say no, or end it sooner.
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
    end.addEventListener("click", () => void answer("/api/screen/end", { id: s.id }, end, "Ended: nothing of that Mac is his now."));
    return card(
      { tone: "warn", label: `Galahad is using ${s.nodeName} itself` },
      listRow({ lead: "mark", leadTone: "agent", top: true, title: `Galahad is using ${s.nodeName} itself`, sub: `Until ${clock(s.until!)}, or until you end it.`, meta: [h("span", { title: new Date(s.until!).toLocaleString() }, `ends ${relativeTime(s.until!)}`)] }),
      h("div", { class: "quote small" }, s.why),
      admin ? formActions(end) : callout("quiet", h("span", {}, "This device can't end it (no fleet:admin scope): ", h("code", {}, `galahad screen end ${s.id}`))),
      outcome,
    );
  }
  const yes = button("Let him…", { variant: "primary", icon: "check" });
  const no = button("Not now", { icon: "x" });
  yes.addEventListener("click", async () => {
    const ok = await confirmAction({
      title: `Let Galahad use ${s.nodeName} itself?`,
      body: [
        h("p", {}, `For ${s.minutes} minutes from now: he sees its screen, uses its apps and runs commands as its user, held to your rules. You can watch it and end it any time.`),
        h("p", {}, "That account holds the node's keys, so a misled model could act as you there: let him only for work you want done that way."),
      ],
      confirmLabel: `Let him, for ${s.minutes} minutes`,
      tone: "primary",
    });
    if (ok) await answer("/api/screen/decide", { id: s.id, allow: true }, yes, `Allowed for ${s.minutes} minutes.`);
  });
  no.addEventListener("click", () => void answer("/api/screen/decide", { id: s.id, allow: false }, no, "Said no: nothing of it is his."));
  return card(
    { tone: "accent", label: `Galahad asks to use ${s.nodeName} itself` },
    listRow({ lead: "mark", leadTone: "agent", top: true, title: `Galahad asks to use ${s.nodeName} itself`, sub: `For ${s.minutes} minutes, if you let him.`, meta: [h("span", { title: new Date(s.askedAt).toLocaleString() }, relativeTime(s.askedAt))] }),
    h("div", { class: "quote small" }, s.why),
    note(`Answer by ${clock(s.answerBy)}. No answer means no.`),
    admin ? formActions(no, yes) : callout("quiet", h("span", {}, "This device can't answer (no fleet:admin scope): ", h("code", {}, `galahad screen approve ${s.id}`))),
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

function decidedRow(ctx: Ctx, action: ActionView): HTMLElement {
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
      // What you said with it; for one you edited, which it was sent as; for one he approved himself, why (it says so).
      action.note ? h("span", { class: "wrap-anywhere" }, action.note) : null,
    ],
    body: action.receipt ? h("details", { class: "process" }, h("summary", { "data-key": `receipt:${action.id}` }, icon("chevron-right", { size: 14, class: "chev" }), "Receipt"), h("pre", { class: "result process-body" }, action.receipt)) : null,
  });
}

export const inboxView: View = (root, ctx, { scope }) => {
  const pairingsBox = h("div", { class: "stack" });
  const requestsBox = h("div", { class: "stack" });
  const draftsBox = h("div", { class: "stack" });
  const connectorsBox = h("div", { class: "stack" });
  const actionsBox = h("div", { class: "stack" });
  const screenBox = h("div", { class: "stack" });
  const questionsBox = h("div", { class: "stack" });
  const noticesBox = card({ flush: true });
  const historyRows = rows();
  const historySummary = h("span", { class: "small strong" });
  const allClear = h("div");
  const admin = ctx.can("fleet:admin");
  const vault = ctx.can("vault:read");
  const read = ctx.can("mind:read");

  const waiting = () => ctx.live.actions.value.filter((a) => isWaiting(a));
  const openScreen = () => ctx.live.screenSessions.value.filter((x) => x.state === "waiting" || x.state === "allowed");
  const openQuestions = () => ctx.live.questions.value.filter((q) => q.expires > Date.now());
  const openNotices = () => ctx.live.notices.value.filter((n) => !n.dismissed);

  async function dismiss(n: NoticeView, trigger: HTMLButtonElement): Promise<void> {
    await busy(trigger, async () => {
      try {
        await ctx.api.post("/api/notices/dismiss", { key: n.key });
        toast("Dismissed", { description: "It stays quiet until it changes." });
        await ctx.live.refreshNotices();
      } catch (error) {
        toast("Couldn't dismiss it", { tone: "error", description: errorMessage(error) });
      }
    });
  }

  // Each list re-renders only when it changes, so a half-typed key in a request card survives a new pairing.
  const renderPairings = () => {
    const pairings = ctx.live.pairings.value;
    replace(pairingsBox, ...pairings.map((p) => pairingCard(ctx, p)));
    pairingsSection.hidden = !admin || !pairings.length;
    renderAllClear();
  };
  const renderRequests = () => {
    const requests = ctx.live.secretRequests.value;
    replace(requestsBox, ...requests.map((r) => secretRequestCard(ctx, r)));
    requestsSection.hidden = !vault || !requests.length;
    renderAllClear();
  };
  let shownWaiting = "";
  const renderActions = () => {
    const list = waiting();
    // Cards are rebuilt only when what waits changes, not when the history moves on.
    const signature = JSON.stringify(list);
    if (signature !== shownWaiting) {
      shownWaiting = signature;
      replace(actionsBox, ...list.map((a) => actionCard(ctx, a)));
    }
    actionsSection.hidden = !list.length;
    const decided = ctx.live.actions.value.filter((a) => !isWaiting(a)).slice(0, 6);
    keepPlace(historyRows, () => replace(historyRows, ...decided.map((a) => decidedRow(ctx, a))));
    historySummary.textContent = `Recent decisions (${decided.length})`;
    history.hidden = !decided.length;
    renderAllClear();
  };
  const renderNotices = () => {
    const list = openNotices();
    // Dismissing is yours alone: it needs fleet:admin, which agents never hold.
    const write = ctx.can("fleet:admin");
    replace(
      noticesBox,
      rows(
        ...list.map((n) =>
          findingRow(
            ctx,
            // What a rule of yours told you leads with a bell, as in the iPhone and Mac apps.
            n.severity === "info" && n.source.startsWith("rule:") ? { ...n, icon: "bell" } : n,
            [h("span", {}, noticeFrom(n.source)), h("span", { title: new Date(n.at).toLocaleString() }, relativeTime(n.at))],
            write ? button("Dismiss", { size: "sm", variant: "ghost", icon: "x", label: `Dismiss: ${n.title}`, onClick: (event) => void dismiss(n, event.currentTarget as HTMLButtonElement) }) : null,
          ),
        ),
      ),
    );
    noticesSection.hidden = !list.length;
    renderAllClear();
  };

  let shownScreen = "";
  // (Drawn again only when a question comes or goes: what you've half filled in stays.)
  let shownQuestions = "";
  const renderQuestions = () => {
    const list = openQuestions();
    const signature = JSON.stringify(list.map((q) => q.id));
    if (signature !== shownQuestions) {
      shownQuestions = signature;
      replace(questionsBox, ...list.map((q) => questionCard(ctx, q)));
    }
    questionsSection.hidden = !list.length;
    renderAllClear();
  };
  const renderScreen = () => {
    const list = openScreen();
    const signature = JSON.stringify(list);
    if (signature !== shownScreen) {
      shownScreen = signature;
      replace(screenBox, ...list.map((x) => screenSessionCard(ctx, x)));
    }
    screenSection.hidden = !list.length;
    renderAllClear();
  };

  const renderDrafts = () => {
    const drafts = ctx.live.loopDrafts.value;
    replace(draftsBox, ...drafts.map((d) => loopDraftCard(ctx, d)));
    draftsSection.hidden = !drafts.length;
    renderAllClear();
  };

  const renderAboutYou = () => {
    const facts = ctx.live.aboutYou.value;
    replace(aboutYouBox, ...facts.map((m) => factRow(ctx, m, true)));
    aboutYouSection.hidden = !facts.length;
    renderAllClear();
  };

  const renderConnectorRequests = () => {
    const requests = ctx.live.connectorRequests.value;
    replace(connectorsBox, ...requests.map((r) => connectorRequestCard(ctx, r)));
    connectorsSection.hidden = !requests.length;
    renderAllClear();
  };

  const renderAllClear = () => {
    const pending = ctx.live.pairings.value.length + ctx.live.secretRequests.value.length + waiting().length + openNotices().length + ctx.live.loopDrafts.value.length + ctx.live.aboutYou.value.length + ctx.live.connectorRequests.value.length + openScreen().length + openQuestions().length;
    // Until the first answer, a skeleton: "nothing needs you" would be a guess, and pushed away a moment later.
    const loaded = ctx.live.inboxLoaded.value;
    allClear.hidden = loaded && pending > 0;
    replace(
      allClear,
      !loaded
        ? card({ flush: true }, skeletonRows(2, { avatar: true }))
        : pending === 0
        ? card(
            { flush: true },
            empty({
              icon: "check-circle",
              title: "Nothing needs you",
              body: "When a device asks to join, Galahad needs a credential or a connector, or wants to do something his oath says to ask about, or the heartbeat spots trouble, it waits here.",
              actions: admin ? button("Pair a device", { icon: "plus", onClick: () => openInvite(ctx, "client") }) : null,
            }),
          )
        : null,
    );
  };

  const pairingsSection = section("Devices asking to join", {}, pairingsBox);
  const screenSection = section("His use of a Mac itself", {}, screenBox);
  const questionsSection = section("Services ask you", { note: "An MCP server asked you something in the middle of a call of Galahad's. Only you answer it, never a model; what you send goes to that service alone." }, questionsBox);
  const actionsSection = section(
    "Galahad asks your leave",
    { note: "What spends money, speaks for you, or can't be undone (anything outward, every delete) waits for you unless a standing order answers it; his knights' work in the repositories you gave them he approves himself. Approved, it's sent once; no answer in 24 hours means no." },
    actionsBox,
  );
  const requestsSection = section("Credentials Galahad asked for", {}, requestsBox);
  const go = (text: string, place: string) => linkButton(text, `#/${place}`, { variant: "ghost", size: "sm", next: true });
  const connectorsSection = section(
    "Connectors asked for",
    { actions: go("Connectors", "connectors"), note: "A service Galahad or a knight needs and doesn't have. Asking installs nothing; once you add it, every one of them can use it." },
    connectorsBox,
  );
  const draftsSection = section("Loops Galahad drafted", { actions: go("Loops", "loops"), note: "You asked in chat for something on a schedule. Each runs only once you add it." }, draftsBox);
  const aboutYouBox = h("div", { class: "card rows" });
  const aboutYouSection = section(
    "Facts he noticed about you",
    { actions: go("Memory", "memory"), note: "Each goes with every answer of his once you keep it, in your words if you like. Until then it is only his note." },
    aboutYouBox,
  );
  const noticesSection = section("Noticed", { actions: go("Loops", "loops") }, noticesBox);
  // Kept across re-renders so it stays open while the outbox changes.
  const history = disclosure(historySummary, { flush: true, hidden: true }, historyRows);
  // First, while it matters: that he can't reach this device when Galahad is closed, and the one thing to do.
  const reach = reachNote(ctx, scope);

  replace(
    root,
    h(
      "div",
      { class: "page narrow" },
      pageHead("Inbox", "Everything that needs you. Nothing here happens without your say."),
      // Shown whole once the Inbox has been read: what waits comes in at once, not section by section.
      pageBody(reach.el, allClear, pairingsSection, screenSection, questionsSection, actionsSection, requestsSection, connectorsSection, draftsSection, aboutYouSection, noticesSection, read ? history : null),
    ),
  );

  scope.add(ctx.live.pairings.subscribe(renderPairings));
  scope.add(ctx.live.secretRequests.subscribe(renderRequests));
  scope.add(ctx.live.loopDrafts.subscribe(renderDrafts));
  scope.add(ctx.live.connectorRequests.subscribe(renderConnectorRequests));
  scope.add(ctx.live.aboutYou.subscribe(renderAboutYou));
  scope.add(ctx.live.actions.subscribe(renderActions));
  scope.add(ctx.live.screenSessions.subscribe(renderScreen));
  scope.add(ctx.live.questions.subscribe(renderQuestions));
  scope.add(ctx.live.notices.subscribe(renderNotices));
  scope.add(ctx.live.inboxLoaded.subscribe(renderAllClear));
  renderPairings();
  renderRequests();
  renderDrafts();
  renderConnectorRequests();
  renderAboutYou();
  renderActions();
  renderQuestions();
  renderNotices();
  void ctx.live.refreshInbox();
  // Each part is read again as the node's live stream says it changed (live.ts); while that stream is down, the whole
  // Inbox every two seconds while it is open.
  scope.add(ctx.live.follow([], () => ctx.live.refreshInbox(), 2000));
  // Deadlines tick without a re-render (that would lose a half-made decision).
  scope.interval(() => {
    for (const el of root.querySelectorAll<HTMLElement>(".expires")) {
      const at = Number(el.dataset.expires);
      el.textContent = at > Date.now() ? `Expires ${relativeTime(at)}` : "Expired";
    }
  }, 30_000);
};
