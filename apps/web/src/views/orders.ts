import type { ActionView, ConnectorToolView, ConnectorView, OrderView } from "@galahad/core";
import { findSecrets } from "@galahad/core/secret-scan";
import { type Ctx, errorMessage } from "../context.ts";
import {
  type ArgMode,
  type ArgRow,
  DAY_MS,
  DEFAULT_DAYS,
  MAX_LABEL,
  modesFor,
  ORDER_DAYS,
  orderSentence,
  parseCallers,
  patternShape,
  rowsForTool,
  rowsToArgs,
  splitOrders,
  type TermsRead,
  whoWords,
} from "../lib/orders.ts";
import { plural } from "../lib/text.ts";
import { relativeTime, shortDate } from "../lib/time.ts";
import type { ActionClass } from "../types.ts";
import { badge, busy, button, callout, empty, field, formActions, segmented, switchControl, type Tone } from "../ui/controls.ts";
import { confirmAction, openSheet } from "../ui/dialog.ts";
import { type Child, h, keepPlace, nextId, replace } from "../ui/dom.ts";
import { icon, type IconName } from "../ui/icons.ts";
import { signal } from "../ui/signal.ts";
import { toast } from "../ui/toast.ts";
import { CLASS_INFO, deviceName } from "./activity.ts";

/*
 * Standing orders: the owner's answer given in advance. One order names one
 * tool that would ask (outward or delete), narrows its arguments, may name who
 * may use it, and expires. A call it covers goes out at once instead of waiting
 * in the Inbox, and is still filed there with the order that answered it.
 * The node enforces every rule; this page explains them before you sign.
 */

/** Bumped whenever an order is signed or revoked from this page. */
export const ordersChanged = signal(0);

export async function loadOrders(ctx: Ctx, abort?: AbortSignal): Promise<OrderView[]> {
  return (await ctx.api.get<{ orders: OrderView[] }>("/api/orders", abort)).orders;
}

export const ORDER_STATE: Record<OrderView["state"], { label: string; tone: Tone; icon: IconName }> = {
  active: { label: "active", tone: "ok", icon: "check" },
  stale: { label: "no longer applies", tone: "warn", icon: "alert" },
  expired: { label: "expired", tone: "neutral", icon: "clock" },
  revoked: { label: "revoked", tone: "neutral", icon: "x" },
};

const MODE_LABEL: Record<ArgMode, string> = { exact: "Exactly", pattern: "Pattern", any: "Any" };

/** A pattern as words, with the text in mono: "starts with feat/", "any". */
export function patternView(pattern: string): HTMLElement {
  const shape = patternShape(pattern);
  const mono = (text: string) => h("span", { class: "mono" }, text);
  switch (shape.kind) {
    case "any":
      return h("span", { class: "subtle" }, "any");
    case "exact":
      return mono(shape.text);
    case "prefix":
      return h("span", {}, "starts with ", mono(shape.text));
    case "suffix":
      return h("span", {}, "ends with ", mono(shape.text));
    case "contains":
      return h("span", {}, "contains ", mono(shape.text));
    case "glob":
      return h("span", {}, "matches ", mono(shape.text));
  }
}

/**
 * The argument editor: one row per argument, each exactly this value, a
 * pattern (`*` for any run of characters) or anything. Locked rows (a delete
 * made from a call) show their value and can't change.
 */
export function argEditor(
  rows: ArgRow[],
  cls: string,
  options: { locked?: boolean; hints?: Record<string, string | null>; onChange: () => void },
): { el: HTMLElement; focus(name: string): void } {
  const inputs = new Map<string, HTMLInputElement>();
  const items = rows.map((row) => {
    const input = h("input", {
      class: "input mono",
      type: "text",
      value: row.value,
      autocomplete: "off",
      autocorrect: "off",
      spellcheck: "false",
      autocapitalize: "off",
      readonly: options.locked ?? false,
      "aria-label": `${row.name}: ${options.locked ? "exact value" : "value or pattern"}`,
    });
    inputs.set(row.name, input);
    const anyNote = h("div", { class: "small subtle" }, row.pinnable ? "Any value." : "Any value: a list or an object can't be pinned.");
    const sync = () => {
      input.hidden = row.mode === "any";
      anyNote.hidden = row.mode !== "any";
      input.placeholder = row.mode === "pattern" ? "e.g. feat/*" : "The exact value";
      input.setAttribute("aria-label", `${row.name}: ${row.mode === "pattern" ? "pattern" : "exact value"}`);
    };
    input.addEventListener("input", () => {
      row.value = input.value;
      options.onChange();
    });
    const modes = options.locked ? [row.mode] : modesFor(row, cls);
    const control =
      modes.length > 1
        ? segmented(
            modes.map((mode) => ({ value: mode, label: MODE_LABEL[mode] })),
            row.mode,
            (mode) => {
              row.mode = mode;
              sync();
              options.onChange();
            },
            { label: `${row.name}: how it may vary`, small: true },
          ).el
        : row.mode === "any"
          ? badge("any", "neutral")
          : badge("exactly", "neutral", "check");
    sync();
    const hint = options.hints?.[row.name];
    return h(
      "div",
      { class: "item" },
      h(
        "div",
        { class: "grow stack tight" },
        h(
          "div",
          { class: "row wrap between" },
          h("span", { class: "row wrap" }, h("span", { class: "mono strong small" }, row.name), row.inPath ? h("span", { class: "tiny subtle" }, "where it goes") : null),
          control,
        ),
        input,
        anyNote,
        hint ? h("div", { class: "tiny subtle" }, hint) : null,
      ),
    );
  });
  return {
    el: items.length
      ? h("div", { class: "card flat" }, h("div", { class: "rows" }, ...items))
      : h("p", { class: "small subtle" }, "This tool takes no arguments, so the order covers every call to it."),
    focus(name) {
      const input = inputs.get(name);
      if (input && !input.hidden) input.focus();
      else inputs.get(name)?.closest(".item")?.querySelector<HTMLElement>("[role=radio][aria-checked=true]")?.focus();
    },
  };
}

/** The editor's rules as a hint under it. */
function rulesHint(rows: ArgRow[], cls: string, locked: boolean): Child {
  if (cls === "delete") {
    return locked
      ? "A delete names exactly one thing, so every argument stays exactly as asked."
      : "A delete names exactly one thing: exact values only, no *.";
  }
  const where = rows.filter((r) => r.inPath).map((r) => r.name);
  return h(
    "span",
    {},
    where.length ? `Where it goes (${where.join(", ")}) stays named, and at least one stays exact. ` : "",
    "In a pattern, ",
    h("span", { class: "mono" }, "*"),
    " matches any run of characters: ",
    h("span", { class: "mono" }, "feat/*"),
    " covers feat/login and feat/orders. Any means the order doesn't look at it.",
  );
}

/** How long it lasts: 7, 30 or 90 days. */
function daysControl(onChange: () => void): { el: HTMLElement; value(): number } {
  let days: number = DEFAULT_DAYS;
  const control = segmented(
    ORDER_DAYS.map((d) => ({ value: String(d), label: `${d} days` })),
    String(DEFAULT_DAYS),
    (value) => {
      days = Number(value);
      onChange();
    },
    { label: "How long it lasts", small: true },
  );
  return { el: control.el, value: () => days };
}

export interface OrderDraft {
  connector: string;
  tool: string;
  args: Record<string, string>;
  callers: string[] | null;
  days: number;
  label: string;
}

/** Everything typed into an order is replicated in plaintext: a key in it is refused before it leaves. */
function secretProblem(draft: OrderDraft): string | null {
  const texts = [draft.label, ...Object.values(draft.args), ...(draft.callers ?? [])];
  return texts.some((text) => findSecrets(text).length)
    ? "That looks like a key. Orders are shared in plaintext across your fleet; keys belong in the vault."
    : null;
}

const untilWords = (days: number) => shortDate(Date.now() + days * DAY_MS);

export async function signOrder(ctx: Ctx, draft: OrderDraft, approve?: string): Promise<{ order: OrderView; action?: ActionView }> {
  const result = await ctx.api.post<{ order: OrderView; action?: ActionView }>("/api/orders", {
    connector: draft.connector,
    tool: draft.tool,
    args: draft.args,
    ...(draft.callers ? { callers: draft.callers } : {}),
    days: draft.days,
    label: draft.label,
    ...(approve ? { approve } : {}),
  });
  ordersChanged.update((n) => n + 1);
  return result;
}

/**
 * The common body of both order sheets: the argument editor, who may use it, how
 * long, a label, the sentence it amounts to, and a status line for problems.
 */
function orderForm(options: {
  rows: ArgRow[];
  cls: string;
  locked: boolean;
  hints?: Record<string, string | null>;
  who: { kind: "only"; caller: string } | { kind: "names" };
  label: string;
  connector: string;
  tool: string;
}): {
  parts: HTMLElement[];
  preview: HTMLElement;
  read(): { draft: OrderDraft } | { problem: string; focus?: () => void };
  sync(): void;
} {
  const preview = h("span", { "aria-live": "polite" });
  const sync = () => {
    const terms: TermsRead = rowsToArgs(options.rows, options.cls);
    const callers = who();
    if ("problem" in terms) preview.textContent = terms.problem;
    else if ("problem" in callers) preview.textContent = callers.problem;
    else preview.textContent = orderSentence({ connector: options.connector, tool: options.tool, args: terms.args, free: terms.free, callers: callers.callers, until: untilWords(days.value()) });
  };
  const editor = argEditor(options.rows, options.cls, { locked: options.locked, hints: options.hints, onChange: sync });
  const days = daysControl(sync);

  let only = true;
  const callersInput = h("input", { class: "input mono", type: "text", autocomplete: "off", autocorrect: "off", spellcheck: "false", autocapitalize: "off", placeholder: "Any of Galahad's agents" });
  callersInput.addEventListener("input", sync);
  const who = (): { callers: string[] | null } | { problem: string } =>
    options.who.kind === "only" ? { callers: only ? [options.who.caller] : null } : parseCallers(callersInput.value);
  const whoControl =
    options.who.kind === "only"
      ? switchControl(
          h("span", {}, "Only ", h("span", { class: "mono" }, options.who.caller)),
          true,
          (checked) => {
            only = checked;
            sync();
          },
          { hint: "Off: any of Galahad's agents and loops may use it." },
        )
      : field("Who may use it", callersInput, {
          hint: "Agent names such as claude-code, or loop.<name> for a loop, separated by commas; * matches any run of characters. Empty: any of Galahad's agents.",
        });

  const label = h("input", { class: "input", type: "text", autocomplete: "off", maxlength: MAX_LABEL, value: options.label });

  const parts = [
    h("div", { class: "stack tight" }, h("div", { class: "label" }, "What it covers"), editor.el, h("p", { class: "tiny subtle" }, rulesHint(options.rows, options.cls, options.locked))),
    options.who.kind === "only" ? h("div", { class: "stack tight" }, h("div", { class: "label" }, "Who may use it"), whoControl) : whoControl,
    h("div", { class: "stack tight" }, h("div", { class: "label" }, "How long it lasts"), h("div", {}, days.el)),
    field("Label", label, { hint: "How the order shows up in your inbox and on Connectors." }),
    callout("quiet", preview, { icon: "scroll" }),
  ];

  return {
    parts,
    preview,
    sync,
    read() {
      const terms = rowsToArgs(options.rows, options.cls);
      if ("problem" in terms) return { problem: terms.problem, focus: terms.row ? () => editor.focus(terms.row!) : undefined };
      const callers = who();
      if ("problem" in callers) return { problem: callers.problem, focus: () => callersInput.focus() };
      const text = label.value.trim();
      if (!text) return { problem: "Give the order a label.", focus: () => label.focus() };
      const draft: OrderDraft = { connector: options.connector, tool: options.tool, args: terms.args, callers: callers.callers, days: days.value(), label: text };
      const secret = secretProblem(draft);
      if (secret) return { problem: secret };
      return { draft };
    },
  };
}

/** What the order editor knows about a call's arguments from the tool itself: each parameter's description. */
function paramHints(tool: ConnectorToolView | undefined): Record<string, string | null> {
  return Object.fromEntries(Object.entries(tool?.params ?? {}).map(([name, p]) => [name, p.description]));
}

/**
 * "Approve and allow similar": approve this waiting call and sign an order that
 * answers calls like it the same way. Where it went starts pinned to exactly
 * this; everything else starts free. A delete stays pinned to exactly what it
 * deletes, and you type its name, as with any delete.
 */
export function openOrderFromAction(
  ctx: Ctx,
  action: ActionView,
  options: { rows: ArgRow[]; caller: string; label: string; node: string; confirmName: string; onDone(): void },
): void {
  const cls = action.class;
  const destructive = cls === "delete";
  const info = CLASS_INFO[cls as ActionClass];
  const form = orderForm({ rows: options.rows, cls, locked: destructive, who: { kind: "only", caller: options.caller }, label: options.label, connector: action.connector, tool: action.tool });
  const status = h("div");
  const sign = button(destructive ? "Approve delete and sign" : "Approve and sign", { variant: destructive ? "danger-solid" : "primary", type: "submit", icon: "check" });
  const typedId = nextId("confirm");
  const typed = destructive ? h("input", { class: "input mono", id: typedId, type: "text", autocomplete: "off", autocorrect: "off", spellcheck: "false", autocapitalize: "off" }) : null;
  if (typed) {
    sign.disabled = true;
    typed.addEventListener("input", () => (sign.disabled = typed.value !== options.confirmName));
  }
  const body = h(
    "form",
    {
      class: "stack loose",
      autocomplete: "off",
      onsubmit: (event: Event) => {
        event.preventDefault();
        replace(status);
        if (typed && typed.value !== options.confirmName) return;
        const read = form.read();
        if ("problem" in read) {
          replace(status, callout("warn", read.problem));
          read.focus?.();
          return;
        }
        void busy(sign, async () => {
          try {
            const { order } = await signOrder(ctx, read.draft, action.id);
            sheet.close();
            toast(`Signed: ${order.label}`, {
              tone: "ok",
              description: `${options.node} ${destructive ? "deletes" : "sends"} this one once, now. Calls like it go without asking until ${shortDate(order.until)}.`,
            });
            options.onDone();
          } catch (error) {
            replace(status, callout("danger", errorMessage(error), { title: "Not signed" }));
            options.onDone();
          }
        });
      },
    },
    h(
      "div",
      { class: "stack tight" },
      h("div", { class: "row wrap" }, h("span", { class: "strong mono" }, `${action.connector}.${action.tool}`), info ? badge(info.label.toLowerCase(), info.tone, info.icon) : badge(cls, "warn")),
      h("div", { class: "mono small wrap-anywhere" }, action.target),
      h(
        "p",
        { class: "small muted" },
        destructive
          ? `Signing also approves this delete: ${options.node} deletes it once, now. It can't be brought back.`
          : `Signing also approves this request: ${options.node} sends it once, now.`,
      ),
    ),
    ...form.parts,
    typed
      ? h("div", { class: "field" }, h("label", { for: typedId }, "Type ", h("span", { class: "mono strong" }, options.confirmName), " to confirm"), typed)
      : null,
    status,
    formActions(button("Cancel", { onClick: () => sheet.close() }), sign),
  );
  const sheet = openSheet({
    title: "Approve and allow similar",
    description: "A standing order is your answer given in advance. Calls it covers go out without asking until it expires.",
    body,
    size: "wide",
    initialFocus: () => body.querySelector<HTMLElement>("[role=radio][aria-checked=true]") ?? typed,
  });
  form.sync();
}

/** An order from scratch: one installed connector's tool that asks, narrowed. */
export function openNewOrder(ctx: Ctx, connectors: ConnectorView[]): void {
  const usable = connectors.filter((c) => c.installed && c.tools.some((t) => t.asks));
  const connectorSelect = h("select", { class: "select" }, h("option", { value: "" }, "Choose…"), ...usable.map((c) => h("option", { value: c.id }, c.label)));
  const toolSelect = h("select", { class: "select", disabled: true }, h("option", { value: "" }, "Choose a connector first"));
  const toolNote = h("div");
  const formBox = h("div", { class: "stack loose" });
  const status = h("div");
  const sign = button("Sign order", { variant: "primary", type: "submit", icon: "check" });
  let form: ReturnType<typeof orderForm> | null = null;

  const tools = () => usable.find((c) => c.id === connectorSelect.value)?.tools.filter((t) => t.asks) ?? [];
  function syncTools(): void {
    const list = tools();
    toolSelect.disabled = !list.length;
    replace(toolSelect, ...(list.length ? [h("option", { value: "" }, "Choose…"), ...list.map((t) => h("option", { value: t.name }, `${t.name} (${t.class})`))] : [h("option", { value: "" }, "Choose a connector first")]));
    syncForm();
  }
  function syncForm(): void {
    replace(status);
    const tool = tools().find((t) => t.name === toolSelect.value);
    if (!tool) {
      form = null;
      replace(toolNote);
      replace(formBox);
      return;
    }
    const rows = rowsForTool(tool.params, tool.class, tool.path);
    form = orderForm({ rows, cls: tool.class, locked: false, hints: paramHints(tool), who: { kind: "names" }, label: `${connectorSelect.value}.${tool.name}`, connector: connectorSelect.value, tool: tool.name });
    replace(toolNote, h("p", { class: "small muted" }, tool.description));
    replace(formBox, ...form.parts);
    form.sync();
  }
  connectorSelect.addEventListener("change", syncTools);
  toolSelect.addEventListener("change", syncForm);

  const body = h(
    "form",
    {
      class: "stack loose",
      autocomplete: "off",
      onsubmit: (event: Event) => {
        event.preventDefault();
        replace(status);
        const target = !connectorSelect.value ? connectorSelect : !form ? toolSelect : null;
        if (target || !form) {
          replace(status, callout("warn", target === connectorSelect ? "Choose a connector." : "Choose a tool."));
          (target ?? toolSelect).focus();
          return;
        }
        const read = form.read();
        if ("problem" in read) {
          replace(status, callout("warn", read.problem));
          read.focus?.();
          return;
        }
        void busy(sign, async () => {
          try {
            const { order } = await signOrder(ctx, read.draft);
            sheet.close();
            toast(`Signed: ${order.label}`, { tone: "ok", description: `Calls it covers go without asking until ${shortDate(order.until)}. Each is still in your inbox.` });
          } catch (error) {
            replace(status, callout("danger", errorMessage(error), { title: "Not signed" }));
          }
        });
      },
    },
    h("div", { class: "fields" }, field("Connector", connectorSelect), field("Tool", toolSelect, { hint: "Only tools that ask you: outward ones and deletes." })),
    toolNote,
    formBox,
    status,
    formActions(button("Cancel", { onClick: () => sheet.close() }), sign),
  );
  const sheet = openSheet({
    title: "Add a standing order",
    description: "Your answer given in advance, for one tool that would ask you. Narrow it to what you mean; it expires.",
    body,
    size: "wide",
    initialFocus: () => connectorSelect,
  });
}

async function revoke(ctx: Ctx, order: OrderView, trigger: HTMLButtonElement): Promise<void> {
  const ok = await confirmAction({
    title: `Revoke "${order.label}"?`,
    body: h(
      "p",
      {},
      order.state === "stale"
        ? "It already no longer applies; revoking clears it away. To allow these calls again, sign a new order."
        : `${order.connector}.${order.tool} asks you again from now on. To allow it again, sign a new order.`,
    ),
    confirmLabel: "Revoke order",
  });
  if (!ok) return;
  await busy(trigger, async () => {
    try {
      await ctx.api.post("/api/orders/revoke", { id: order.id });
      ordersChanged.update((n) => n + 1);
      toast("Revoked", { tone: "ok", description: `${order.label}: those calls ask you again.` });
    } catch (error) {
      toast("Couldn't revoke it", { tone: "error", description: errorMessage(error) });
    }
  });
}

function orderItem(ctx: Ctx, order: OrderView): HTMLElement {
  const state = ORDER_STATE[order.state] ?? { label: order.state, tone: "neutral" as Tone, icon: "info" as IconName };
  const info = CLASS_INFO[order.class as ActionClass];
  const args = Object.entries(order.args);
  const live = order.state === "active" || order.state === "stale";
  const until =
    order.state === "expired"
      ? `expired ${relativeTime(order.until)}`
      : order.state === "revoked"
        ? `was to last until ${shortDate(order.until)}`
        : `until ${shortDate(order.until)}`;
  return h(
    "div",
    { class: "item" },
    h("span", { class: "avatar", "data-tone": order.state === "active" ? "accent" : state.tone, title: `Standing order: ${state.label}` }, icon("scroll", { size: 14 })),
    h(
      "div",
      { class: "grow stack tight" },
      h(
        "div",
        { class: "stack snug" },
        h("div", { class: "row wrap" }, h("span", { class: "strong small" }, order.label), badge(state.label, state.tone, state.icon)),
        h("div", { class: "row wrap tiny subtle" }, h("span", { class: "mono" }, `${order.connector}.${order.tool}`), h("span", { class: "toned", "data-tone": info?.tone ?? "neutral" }, info?.label.toLowerCase() ?? order.class)),
      ),
      args.length
        ? h("dl", { class: "kv" }, ...args.flatMap(([name, pattern]) => [h("dt", { class: "mono" }, name), h("dd", {}, patternView(pattern))]))
        : h("p", { class: "small subtle" }, "Any arguments."),
      order.state === "stale"
        ? callout(
            "warn",
            `${order.connector}.${order.tool} changed after you signed this (another path, other parameters or another origin), so it no longer applies: those calls ask you again. Revoke it, and sign a new one if you still want it.`,
            { title: "No longer applies" },
          )
        : null,
      h(
        "div",
        { class: "meta" },
        h("span", {}, whoWords(order.callers)),
        h("span", { class: "tnum", title: new Date(order.until).toLocaleString() }, until),
        h("span", { class: "tnum" }, order.uses ? `used ${plural(order.uses, "time")}${order.lastUsed ? `, last ${relativeTime(order.lastUsed)}` : ""}` : "not used yet"),
        h("span", { title: new Date(order.signedAt).toLocaleString() }, `signed ${relativeTime(order.signedAt)}${order.signedVia ? ` from ${deviceName(ctx, order.signedVia)}` : " on a node"}`),
      ),
    ),
    live && ctx.can("fleet:admin")
      ? h(
          "div",
          { class: "item-actions" },
          button("Revoke", { size: "sm", variant: "ghost", icon: "x", label: `Revoke ${order.label}`, onClick: (event) => void revoke(ctx, order, event.currentTarget as HTMLButtonElement) }),
        )
      : null,
  );
}

/** The orders on the Connectors page: the ones meant to apply, then the old ones folded away. */
export function renderOrders(box: HTMLElement, ctx: Ctx, orders: OrderView[], onAdd: (() => void) | null): void {
  const { current, old } = splitOrders(orders);
  keepPlace(box, () =>
    replace(
      box,
      current.length
        ? h("div", { class: "card" }, h("div", { class: "rows" }, ...current.map((o) => orderItem(ctx, o))))
        : h(
            "div",
            { class: "card" },
            empty({
              icon: "scroll",
              title: "No standing orders",
              body: "Everything outward, and every delete, asks you. When you approve one in your Inbox, Approve and allow similar answers calls like it the same way next time.",
              actions: onAdd ? button("Add a standing order", { icon: "plus", onClick: onAdd }) : null,
              compact: true,
            }),
          ),
      old.length
        ? h(
            "details",
            { class: "process" },
            h("summary", { "data-key": "orders:old" }, icon("chevron-right", { size: 14, class: "chev" }), `Old orders (${old.length})`),
            h("div", { class: "card flat process-body" }, h("div", { class: "rows" }, ...old.map((o) => orderItem(ctx, o)))),
          )
        : null,
    ),
  );
}
