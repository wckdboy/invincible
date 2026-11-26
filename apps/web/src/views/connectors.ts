import type { ArgValue, ConnectorRequestView, ConnectorToolView, ConnectorView, OrderView } from "@galahad/core";
import { findSecrets } from "@galahad/core/secret-scan";
import { chatAppsSection } from "./chat-apps.ts";
import { type Ctx, errorMessage, type View } from "../context.ts";
import { connectorStateOf, KEY_STATE } from "../lib/connector-state.ts";
import { argKind, claimSentence, type ToolClass } from "../lib/connectors.ts";
import { plural } from "../lib/text.ts";
import { duration, relativeTime } from "../lib/time.ts";
import { badge, busy, button, callout, empty, errorState, field, formActions, pageBody, pageHead, secretInput, section, skeletonBlock, type Tone } from "../ui/controls.ts";
import { confirmAction, openSheet } from "../ui/dialog.ts";
import { h, keepPlace, replace } from "../ui/dom.ts";
import { icon, type IconName } from "../ui/icons.ts";
import { signal } from "../ui/signal.ts";
import { toast } from "../ui/toast.ts";
import { CLASS_INFO } from "./activity.ts";
import { classSelect, type McpDeps, mcpBadge, openAddMcp, refreshMcp, saveClasses, serverWords } from "./mcp.ts";
import { mcpLibrarySection } from "./mcp-library.ts";
import { loadOrders, openNewOrder, ordersChanged, renderOrders } from "./orders.ts";
import { vaultChanged } from "./vault.ts";
import { signInBlock } from "./sign-in.ts";

/*
 * Connectors: how Galahad reaches the services you use. Each is a manifest,
 * data rather than code: one pinned origin, the vault secret it signs in with,
 * and tools that are one HTTP request each with an oath class. Reading,
 * creating and changing are his to do (and logged); outward tools and deletes
 * ask you first. A connector's key goes from a password field into the vault,
 * pinned to the connector's origin; no model, arm or loop ever sees it.
 * A remote MCP server is a connector too: its tools are listed from the server,
 * and their classes are yours to choose (views/mcp.ts).
 */

/** Bumped whenever a connector is installed or removed, or its key changes. */
export const connectorsChanged = signal(0);

/**
 * A connector an agent asked you for, in the Inbox and in the chat it was asked in. Asking installs nothing: adding it
 * is yours, where it's added (one Galahad ships, at its Install; any other, as an MCP server).
 */
export function connectorRequestCard(ctx: Ctx, request: ConnectorRequestView): HTMLElement {
  const name = request.label ?? request.connector;
  const note = h("div");
  const add = request.access
    ? button(`Allow ${request.by}`, {
        variant: "primary",
        icon: "check",
        onClick: (event) =>
          void busy(event.currentTarget as HTMLButtonElement, async () => {
            try {
              await ctx.api.post("/api/connectors/access", { id: request.connector, agent: request.agent, allow: true });
              connectorsChanged.update((n) => n + 1);
              toast(`${request.by} may use ${name} now`, { tone: "ok", description: "You can stop it again on Connectors." });
            } catch (error) {
              replace(note, callout("danger", errorMessage(error), { title: "Couldn't allow it" }));
            }
            await ctx.live.refreshConnectorRequests();
          }),
      })
    : button(request.label ? `Add ${request.label}` : "Add as an MCP server", {
        variant: "primary",
        icon: "plus",
        onClick: () => ctx.navigate("connectors", { intent: request.label ? `install:${request.connector}` : "add-mcp" }),
      });
  const dismiss = button("Dismiss", { icon: "x" });
  dismiss.addEventListener("click", () =>
    void busy(dismiss, async () => {
      try {
        await ctx.api.post("/api/connectors/requests/dismiss", { id: request.id });
        toast("Dismissed", { tone: "info", description: "Nothing was added." });
      } catch (error) {
        replace(note, callout("danger", errorMessage(error), { title: "Couldn't dismiss it" }));
      }
      await ctx.live.refreshConnectorRequests();
    }),
  );
  return h(
    "article",
    { class: "card accent", "aria-label": `${request.by} asks for ${name}` },
    h(
      "div",
      { class: "card-body stack" },
      h(
        "div",
        { class: "row top" },
        h("span", { class: "avatar agent" }, icon("plug", { size: 16 })),
        h(
          "div",
          { class: "grow stack tight" },
          h("strong", {}, request.access ? `${request.by} asks to use ${name}` : `${request.by} asks for ${name}`),
          h("p", { class: "small" }, request.why),
          h(
            "p",
            { class: "tiny subtle", title: new Date(request.at).toLocaleString() },
            `Asked ${relativeTime(request.at)}. `,
            request.access ? `${name} is Galahad's alone: allowed, ${request.by} may read it too, until you stop it.` : "Asking installs nothing: it waits for you to add it.",
          ),
        ),
      ),
      ctx.can("brain:write") ? h("div", { class: "row wrap" }, add, dismiss) : null,
      note,
    ),
  );
}

const host = (origin: string | null): string => origin?.replace(/^https?:\/\//, "") ?? "";

export async function loadConnectors(ctx: Ctx, abort?: AbortSignal): Promise<ConnectorView[]> {
  return (await ctx.api.get<{ connectors: ConnectorView[] }>("/api/connectors", abort)).connectors;
}

export type ArgsRead = { args: Record<string, ArgValue> } | { problem: string; focus: HTMLElement };

const LONG_TEXT = /^(body|text|message|content|description)$/;

/**
 * Form fields for a tool's parameters, typed from its declaration: a choice for
 * enums and booleans, a number field for numbers, text otherwise. Arguments leave
 * this machine and approvals replicate in plaintext, so a key typed here is refused.
 */
export function argFields(tool: ConnectorToolView, initial: Record<string, unknown> = {}): { el: HTMLElement; read(): ArgsRead } {
  const readers: (() => ArgsRead | { name: string; value: ArgValue | undefined })[] = [];
  const fields: HTMLElement[] = [];
  for (const [name, p] of Object.entries(tool.params)) {
    const start = initial[name];
    const kind = argKind(p.type);
    const label = p.required ? name : `${name} (optional)`;
    const hint = kind === "json" ? `${p.description ? `${p.description} ` : ""}As JSON, such as ["bug", "docs"].` : (p.description ?? undefined);
    if (p.enum || kind === "boolean") {
      const options: [string, string][] = kind === "boolean" ? [["true", "yes"], ["false", "no"]] : p.enum!.map((v) => [v, v]);
      const select = h(
        "select",
        { class: "select" },
        h("option", { value: "" }, p.required ? "Choose…" : "Not set"),
        ...options.map(([value, text]) => h("option", { value, selected: start !== undefined && String(start) === value }, text)),
      );
      fields.push(field(label, select, { hint }));
      readers.push(() => {
        if (!select.value) return p.required ? { problem: `Choose ${name}.`, focus: select } : { name, value: undefined };
        return { name, value: kind === "boolean" ? select.value === "true" : select.value };
      });
      continue;
    }
    const numeric = kind === "integer" || kind === "number";
    const json = kind === "json";
    const control = json
      ? h("textarea", { class: "textarea mono", rows: 3, autocorrect: "off", spellcheck: "false", autocapitalize: "off" })
      : !numeric && LONG_TEXT.test(name)
      ? h("textarea", { class: "textarea", rows: 4, spellcheck: "true" })
      : h("input", {
          class: numeric ? "input tnum" : "input",
          type: numeric ? "number" : "text",
          inputmode: kind === "integer" ? "numeric" : numeric ? "decimal" : null,
          step: kind === "integer" ? 1 : numeric ? "any" : null,
          autocomplete: "off",
          autocorrect: "off",
          spellcheck: "false",
          autocapitalize: "off",
        });
    if (start !== undefined && start !== null) control.value = json && typeof start === "object" ? JSON.stringify(start) : String(start);
    fields.push(field(label, control, { hint }));
    readers.push(() => {
      const raw = control.value.trim();
      if (!raw) return p.required ? { problem: `${name} is required.`, focus: control } : { name, value: undefined };
      if (numeric) {
        const n = Number(raw);
        if (!Number.isFinite(n) || (kind === "integer" && !Number.isInteger(n))) return { problem: `${name} must be ${kind === "integer" ? "a whole number" : "a number"}.`, focus: control };
        return { name, value: n };
      }
      if (findSecrets(raw).length) {
        control.value = "";
        return { problem: `${name} looks like it holds a key, so it was cleared. Connectors take keys from the vault, never from their arguments.`, focus: control };
      }
      if (json) {
        try {
          return { name, value: JSON.parse(raw) as ArgValue };
        } catch {
          return { problem: `${name} takes JSON (a list or an object), such as ["bug", "docs"].`, focus: control };
        }
      }
      return { name, value: raw };
    });
  }
  return {
    el: fields.length ? h("div", { class: "stack" }, ...fields) : h("p", { class: "small subtle" }, "This tool takes nothing."),
    read() {
      const args: Record<string, ArgValue> = {};
      for (const reader of readers) {
        const result = reader();
        if ("problem" in result) return result;
        if ("name" in result && result.value !== undefined) args[result.name] = result.value;
      }
      return { args };
    },
  };
}

/** What a tool's class means for you, in a sentence. */
export function classNote(cls: string, who: "you" | "loop"): HTMLElement | null {
  if (cls === "outward") {
    return who === "you"
      ? callout("warn", "It's outward: others may see it, or it acts in the world. You're the one asking, so it goes as soon as you confirm.", { title: "Sent when you confirm" })
      : callout("warn", "It's outward, so each run files a request in your Inbox instead of sending. Nothing goes until you approve it.", { title: "Each run asks you" });
  }
  if (cls === "delete") {
    return who === "you"
      ? callout("danger", "It deletes something, and that can't be undone. You're the one asking, so it goes as soon as you confirm.", { title: "Deletes for good" })
      : callout("warn", "It deletes, so each run files a request in your Inbox instead. Nothing is deleted until you approve it.", { title: "Each run asks you" });
  }
  if (cls === "create" || cls === "modify") return callout("quiet", "It creates or changes something. That's Galahad's to do, and the ledger records it.");
  return null;
}

/** The value a delete names (a bucket, say), for typed confirmation; else the tool's name. */
function deleteName(tool: ConnectorToolView, args: Record<string, ArgValue>): string {
  const last = Object.entries(tool.params).filter(([, p]) => p.required && p.type === "string").map(([name]) => name).at(-1);
  const value = last ? args[last] : undefined;
  return typeof value === "string" && value ? value : tool.name;
}

type CallOutcome =
  | { status: "done"; class: string; target: string; result: { ok: boolean; status: number; body: string; truncated: boolean; durationMs: number; mcp?: boolean } }
  | { status: "asked"; action: string; class: string; target: string; expires: number };

function outcomeView(outcome: CallOutcome): HTMLElement {
  if (outcome.status === "asked") return callout("info", `Filed for approval: it waits in your Inbox as ${outcome.action}.`);
  const r = outcome.result;
  let body = r.body;
  try {
    body = JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    /* not JSON: shown as it came */
  }
  return h(
    "div",
    { class: "stack tight", "aria-live": "polite" },
    h(
      "div",
      { class: "row wrap tiny subtle" },
      badge(r.mcp ? (r.ok ? "ok" : "tool error") : String(r.status), r.ok ? "ok" : "danger"),
      h("span", { class: "mono wrap-anywhere" }, outcome.target),
      h("span", { class: "tnum" }, duration(r.durationMs)),
      r.truncated ? h("span", {}, "clipped") : null,
    ),
    body ? h("pre", { class: "result" }, body) : h("p", { class: "small subtle" }, "No body."),
  );
}

/** Run one tool now, as you. Outward tools and deletes confirm first: your asking is the approval. */
export function openRunTool(ctx: Ctx, c: ConnectorView, tool: ConnectorToolView): void {
  const info = CLASS_INFO[tool.class];
  const args = argFields(tool);
  const status = h("div");
  const out = h("div");
  const run = button(tool.asks ? "Send" : "Run", { variant: "primary", type: "submit", icon: tool.asks ? "external" : "play" });
  const form = h(
    "form",
    {
      class: "stack loose",
      autocomplete: "off",
      onsubmit: async (event: Event) => {
        event.preventDefault();
        replace(status);
        const read = args.read();
        if ("problem" in read) {
          replace(status, callout("warn", read.problem));
          read.focus.focus();
          return;
        }
        if (tool.asks) {
          const ok = await confirmAction({
            title: tool.class === "delete" ? `Delete with ${c.label}?` : `Send with ${c.label}?`,
            body: [
              h("p", {}, h("span", { class: "mono strong" }, `${c.id}.${tool.name}`), ` goes to ${host(c.origin)} once, now.`),
              h("p", {}, tool.class === "delete" ? "What it deletes can't be brought back." : "Others may see it, and it can't be called back."),
            ],
            confirmLabel: tool.class === "delete" ? "Delete it" : "Send it",
            tone: tool.class === "delete" ? "danger" : "primary",
            typeToConfirm: tool.class === "delete" ? deleteName(tool, read.args) : undefined,
          });
          if (!ok) return;
        }
        await busy(run, async () => {
          try {
            const outcome = await ctx.api.post<CallOutcome>("/api/connectors/call", { connector: c.id, tool: tool.name, args: read.args });
            if (!sheet.scope.disposed) replace(out, outcomeView(outcome));
          } catch (error) {
            replace(status, callout("danger", errorMessage(error), { title: "It didn't run" }));
          }
        });
      },
    },
    h("div", { class: "row wrap" }, badge(info?.label.toLowerCase() ?? tool.class, info?.tone ?? "neutral", info?.icon), h("span", { class: "mono small subtle" }, `${tool.method} · ${host(c.origin)}`)),
    classNote(tool.class, "you"),
    args.el,
    status,
    formActions(button("Close", { onClick: () => sheet.close() }), run),
    out,
  );
  const sheet = openSheet({ title: `${c.label} · ${tool.name}`, description: tool.description, body: form, size: "wide" });
}

/** Active standing orders per tool ("github.pr.create" → 2). */
type OrderCounts = Map<string, number>;

function toolRow(ctx: Ctx, c: ConnectorView, tool: ConnectorToolView, orders: number, pick: ((cls: ToolClass) => void) | null): HTMLElement {
  const info = CLASS_INFO[tool.class];
  const params = Object.entries(tool.params).map(([name, p]) => (p.required ? name : `[${name}]`)).join(" ");
  const mcp = c.kind === "mcp";
  return h(
    "div",
    { class: "item" },
    h("span", { class: "avatar", "data-tone": info?.tone ?? "neutral", title: info?.label ?? tool.class }, icon(info?.icon ?? "eye", { size: 14 })),
    h(
      "div",
      { class: "item-text" },
      h(
        "div",
        { class: "row wrap" },
        h("span", { class: "mono strong small" }, tool.name),
        pick ? null : badge(tool.class, info?.tone ?? "neutral"),
        tool.asks && !pick ? badge("asks you", "warn", "shield") : null,
        orders
          ? h(
              "span",
              { title: `${orders === 1 ? "A standing order of yours answers" : `${orders} standing orders of yours answer`} some of these calls without asking. See Standing orders.` },
              badge("standing order", "accent", "scroll"),
            )
          : null,
      ),
      mcp ? h("div", { class: "tiny subtle" }, claimSentence(tool.hints)) : null,
      mcp ? h("div", { class: "item-body" }, serverWords(tool.description)) : h("div", { class: "small muted" }, tool.description),
      params ? h("div", { class: "meta mono" }, params) : null,
      pick ? h("div", { class: "row wrap item-body" }, h("span", { class: "tiny subtle" }, "Class"), classSelect(tool, pick)) : null,
    ),
    c.installed && ctx.can("connect")
      ? h("div", { class: "item-actions" }, button(`Run ${tool.name}`, { size: "sm", variant: "ghost", icon: "play", label: `Run ${c.id}.${tool.name}`, onClick: () => openRunTool(ctx, c, tool) }))
      : null,
  );
}

function keyBlock(ctx: Ctx, c: ConnectorView, onSealed?: () => void): HTMLElement | null {
  if (!c.installed || !c.secret || c.key === "none-needed") return null;
  const state = KEY_STATE[c.key];
  const secret = secretInput({ label: `Key for ${c.label}` });
  const seal = button("Seal", { variant: c.key === "ready" ? "default" : "primary", type: "submit", icon: "vault" });
  const status = h("div");
  const form = h(
    "form",
    {
      class: "row",
      autocomplete: "off",
      hidden: c.key === "ready",
      onsubmit: (event: Event) => {
        event.preventDefault();
        // Read, then clear at once: the key lives in this page as briefly as possible.
        const value = secret.input.value.trim();
        secret.input.value = "";
        if (!value) {
          secret.input.focus();
          return;
        }
        void busy(seal, async () => {
          try {
            await ctx.api.post("/api/secrets", { name: c.secret, value, connector: c.id });
            vaultChanged.update((n) => n + 1);
            toast(`${c.label}'s key sealed`, { tone: "ok", description: `Only ever sent to ${host(c.origin)}. No model ever sees it.` });
            onSealed?.();
          } catch (error) {
            replace(status, callout("danger", `${errorMessage(error)}. The field was cleared for safety; paste the key again.`));
            secret.input.focus();
          }
        });
      },
    },
    h("div", { class: "grow" }, secret.wrap),
    seal,
  );
  const write = ctx.can("vault:write");
  return h(
    "div",
    { class: "stack tight" },
    h("p", { class: "small" }, state?.explain ?? `Key: ${c.key}`),
    c.keyHelp && c.key !== "ready" ? h("p", { class: "tiny subtle wrap-anywhere" }, `Where to get one: ${c.keyHelp}.`) : null,
    h(
      "div",
      { class: "row wrap tiny subtle" },
      h("span", {}, "Vault secret ", h("span", { class: "mono" }, c.secret)),
      write && c.key === "ready"
        ? button("Replace key", {
            size: "sm",
            variant: "ghost",
            icon: "edit",
            onClick: (event) => {
              form.hidden = false;
              (event.currentTarget as HTMLElement).remove();
              secret.input.focus();
            },
          })
        : null,
    ),
    write ? form : c.key === "ready" ? null : callout("quiet", "This device can't add keys (no vault:write scope)."),
    status,
  );
}

function installBlock(ctx: Ctx, c: ConnectorView): HTMLElement | null {
  if (c.installed || !ctx.can("brain:write")) return null;
  const status = h("div");
  const origin = c.needsOrigin
    ? h("input", { class: "input mono", type: "url", inputmode: "url", autocomplete: "off", autocorrect: "off", spellcheck: "false", autocapitalize: "off", placeholder: "http://homeassistant.local:8123" })
    : null;
  const install = button("Install", { variant: "primary", size: "sm", type: "submit", icon: "plus" });
  return h(
    "form",
    {
      class: "stack tight",
      autocomplete: "off",
      onsubmit: (event: Event) => {
        event.preventDefault();
        replace(status);
        let address: string | undefined;
        if (origin) {
          try {
            const url = new URL(origin.value.trim());
            if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("not http");
            address = url.origin;
          } catch {
            replace(status, callout("warn", "Give its address, such as http://homeassistant.local:8123."));
            origin.focus();
            return;
          }
        }
        void busy(install, async () => {
          try {
            const { connector } = await ctx.api.post<{ connector: ConnectorView }>("/api/connectors", { id: c.id, ...(address ? { origin: address } : {}) });
            connectorsChanged.update((n) => n + 1);
            toast(`${connector.label} installed`, {
              tone: "ok",
              description:
                connector.oauth?.provider === "mcp" && connector.key !== "ready"
                  ? "Sign in on its card next: its tools are listed then."
                  : connector.key === "missing" || connector.key === "wrong-origin"
                    ? "Add its key next. Until then it can't do anything."
                    : `${plural(connector.tools.length, "tool")}, on every node.`,
            });
          } catch (error) {
            replace(status, callout("danger", errorMessage(error), { title: "Couldn't install it" }));
          }
        });
      },
    },
    origin ? field("Its address", origin, { hint: "Where it runs on your network. Plain http only for this machine and private networks." }) : null,
    status,
    h("div", { class: "row" }, install),
  );
}

/** Who may use it, when it's Galahad's alone (mail), and whether what it reads stays in the answer that read it. */
function accessBlock(ctx: Ctx, c: ConnectorView): HTMLElement | null {
  if (!c.access && !c.private) return null;
  const allowed = c.access?.allowed ?? [];
  const stop = (agent: string) =>
    void ctx.api
      .post("/api/connectors/access", { id: c.id, agent, allow: false })
      .then(() => {
        connectorsChanged.update((n) => n + 1);
        toast(`${agentName(agent)} may not use ${c.label} any more`, { tone: "ok", description: "It asks first again." });
      })
      .catch((error: unknown) => toast("Couldn't change it", { tone: "error", description: errorMessage(error) }));
  return h(
    "div",
    { class: "stack tight" },
    c.access
      ? h(
          "p",
          // (An icon is a block of its own: beside the words it needs a row, or it takes a line.)
          { class: "small row top tight" },
          h("span", { class: "line-icon" }, icon("shield-check", { size: 13 })),
          h(
            "span",
            {},
            "Galahad's alone",
            allowed.length ? ", and " : ": a knight or another agent asks you first.",
            ...allowed.map((agent, i) => [
              i ? ", " : "",
              h("span", { class: "strong" }, agentName(agent)),
              c.installed && ctx.can("brain:write") ? h("button", { class: "btn ghost sm icon-only", type: "button", "aria-label": `Stop ${agentName(agent)} using it`, title: "Stop", onclick: () => stop(agent) }, icon("x", { size: 12 })) : null,
            ]),
            allowed.length ? "." : null,
          ),
        )
      : null,
    c.private ? h("p", { class: "tiny subtle" }, "What it reads stays in the answer that read it: nothing else that could carry it out runs after it, as for your bank.") : null,
  );
}

/** An agent as you know it: a knight by its id (team.<tag>.kay is Kay), anything else by its label. */
const agentName = (label: string): string => {
  const knight = /^team\.[0-9a-f]+\.(.+)$/.exec(label)?.[1];
  return knight ? knight.charAt(0).toUpperCase() + knight.slice(1) : label;
};

async function remove(ctx: Ctx, c: ConnectorView): Promise<void> {
  const ok = await confirmAction({
    title: `Remove ${c.label}?`,
    body: [h("p", {}, "Galahad can't reach it any more, and loops that call it fail until you install it again."), c.secret ? h("p", {}, "Its key stays in the vault until you delete it there.") : null],
    confirmLabel: "Remove connector",
  });
  if (!ok) return;
  try {
    await ctx.api.post("/api/connectors/remove", { id: c.id });
    connectorsChanged.update((n) => n + 1);
    toast(`${c.label} removed`, { tone: "ok" });
  } catch (error) {
    toast("Couldn't remove it", { tone: "error", description: errorMessage(error) });
  }
}

function connectorCard(ctx: Ctx, c: ConnectorView, orders: OrderCounts, deps: McpDeps): HTMLElement {
  const state = connectorStateOf(c);
  const asking = c.tools.filter((t) => t.asks).length;
  const mcp = c.kind === "mcp" && c.installed;
  // (One you sign in to lists its tools once you have: until then there's nothing to refresh.)
  const signedOut = c.oauth?.provider === "mcp" && c.key !== "ready";
  const write = ctx.can("brain:write");
  // Your class choices for an MCP server's tools, until you save them.
  const picked = new Map<string, ToolClass>();
  const saveNote = h("div");
  const save = button("Save classes", { size: "sm", variant: "primary", icon: "check" });
  const undo = button("Undo", { size: "sm", variant: "ghost" });
  const saveBar = h("div", { class: "row wrap end", hidden: true }, h("span", { class: "tiny subtle grow" }, ""), undo, save);
  const syncSave = () => {
    saveBar.hidden = !picked.size;
    saveBar.firstElementChild!.textContent = picked.size ? `${plural(picked.size, "class", "classes")} changed, not saved yet.` : "";
  };
  const pick = (tool: ConnectorToolView) => (cls: ToolClass) => {
    if (cls === tool.class) picked.delete(tool.name);
    else picked.set(tool.name, cls);
    syncSave();
  };
  save.addEventListener("click", () =>
    void busy(save, async () => {
      replace(saveNote);
      const result = await saveClasses(ctx, c, Object.fromEntries(picked), deps);
      if (result.problem) replace(saveNote, callout("danger", result.problem, { title: "Not saved" }));
    }),
  );
  undo.addEventListener("click", () => deps.changed());
  const refresh = mcp && write && !signedOut
    ? button("Refresh tools", {
        size: "sm",
        icon: "refresh",
        onClick: (event) => void busy(event.currentTarget as HTMLButtonElement, () => refreshMcp(ctx, c, deps)),
      })
    : null;
  return h(
    "article",
    { class: "card", "aria-label": c.label, "data-connector": c.id },
    h(
      "div",
      { class: "card-body stack" },
      h(
        "div",
        { class: "row top" },
        h("span", { class: "avatar" }, icon("plug", { size: 16 })),
        h(
          "div",
          { class: "item-text" },
          h(
            "div",
            { class: "row wrap" },
            h("span", { class: "strong" }, c.label),
            c.installed ? (state ? badge(state.label, state.tone, state.icon) : badge(c.key)) : badge("not installed", "neutral"),
            mcp ? mcpBadge() : null,
          ),
          h(
            "div",
            { class: "tiny subtle row wrap" },
            h("span", { class: "mono" }, c.id),
            mcp && c.url
              ? h("span", { class: "mono wrap-anywhere", title: "Galahad talks to this server and nowhere else" }, `only to ${c.url.replace(/^https?:\/\//, "")}`)
              : c.origin
                ? h("span", { class: "mono", title: "Every request goes to this origin and nowhere else" }, `only to ${host(c.origin)}`)
                : h("span", {}, c.needsOrigin ? "runs at an address of yours" : ""),
          ),
        ),
        c.installed && ctx.can("brain:write") ? button(`Remove ${c.label}`, { size: "sm", variant: "ghost", iconOnly: true, icon: "trash", onClick: () => void remove(ctx, c) }) : null,
      ),
      c.description ? h("p", { class: "small muted" }, c.description) : null,
      c.problem ? callout("warn", c.problem) : null,
      accessBlock(ctx, c),
      // One that signs in as you (mail) has an app and a sign-in where another has its key.
      c.oauth ? signInBlock(ctx, c) : keyBlock(ctx, c, mcp && !c.tools.length ? () => void refreshMcp(ctx, c, deps) : undefined),
      installBlock(ctx, c),
      mcp
        ? h(
            "div",
            { class: "row wrap" },
            h(
              "span",
              { class: "tiny subtle grow" },
              c.tools.length
                ? "Its tools and their descriptions come from the server. You choose what each may do."
                : signedOut
                  ? "No tools yet: sign in, and Galahad lists them."
                  : c.key === "missing"
                    ? "No tools yet: add its key, and Galahad lists them."
                    : "No tools yet. Refresh to list them.",
            ),
            refresh,
          )
        : null,
      c.tools.length
        ? h(
            "details",
            { class: "process" },
            h(
              "summary",
              { "data-key": `tools:${c.id}` },
              icon("chevron-right", { size: 14, class: "chev" }),
              `${plural(c.tools.length, "tool")}${asking ? ` · ${asking} ask${asking === 1 ? "s" : ""} you first` : ""}`,
            ),
            h(
              "div",
              { class: "card flat process-body" },
              h("div", { class: "rows" }, ...c.tools.map((t) => toolRow(ctx, c, t, orders.get(`${c.id}.${t.name}`) ?? 0, mcp && write ? pick(t) : null))),
            ),
          )
        : null,
      mcp ? saveBar : null,
      mcp ? saveNote : null,
    ),
  );
}

export const connectorsView: View = (root, ctx, { scope, opts }) => {
  const installedBox = h("div", { class: "grid wide" }, skeletonBlock(320), skeletonBlock(320));
  const availableBox = h("div", { class: "grid wide" });
  const note = h("div");
  const deps: McpDeps = {
    changed: () => connectorsChanged.update((n) => n + 1),
    keyField: (c, onSealed) => keyBlock(ctx, c, onSealed),
  };
  const addMcp = ctx.can("brain:write") ? button("Add an MCP server", { size: "sm", icon: "plus", onClick: () => openAddMcp(ctx, connectors, deps) }) : null;
  const installedSection = section("Installed", { actions: addMcp }, installedBox);
  const availableSection = section("Available", { id: "connectors-available" }, availableBox);
  // The library of hosted MCP servers, searched on the node (mcp-library.ts).
  const library = mcpLibrarySection(ctx, deps);
  // Chat apps: Telegram, through a bot of yours (chat-apps.ts).
  const chatApps = chatAppsSection(ctx);
  const read = ctx.can("mind:read");
  const admin = ctx.can("fleet:admin");
  const ordersBox = h("div", { class: "stack" }, skeletonBlock(96));
  let connectors: ConnectorView[] = [];
  let orders: OrderView[] = [];
  let shownOrders = "";
  const canAdd = () => admin && connectors.some((c) => c.installed && c.tools.some((t) => t.asks));
  const addOrder = button("Add a standing order", { size: "sm", variant: "ghost", icon: "plus", onClick: () => openNewOrder(ctx, connectors) });
  addOrder.hidden = true;
  const ordersSection = section(
    "Standing orders",
    {
      actions: admin ? addOrder : null,
      note: "Your answers given in advance. A call an order covers goes out at once instead of waiting for you, and still shows up in your Inbox. Each names one tool, narrows its arguments and expires.",
    },
    ordersBox,
  );
  ordersSection.hidden = !read;
  const counts = (): OrderCounts => {
    const map: OrderCounts = new Map();
    for (const o of orders) if (o.state === "active") map.set(`${o.connector}.${o.tool}`, (map.get(`${o.connector}.${o.tool}`) ?? 0) + 1);
    return map;
  };
  function showOrders(): void {
    shownOrders = JSON.stringify(orders);
    addOrder.hidden = !canAdd();
    renderOrders(ordersBox, ctx, orders, canAdd() ? () => openNewOrder(ctx, connectors) : null);
  }

  function render(list: ConnectorView[]): void {
    const installed = list.filter((c) => c.installed);
    const available = list.filter((c) => !c.installed);
    const active = counts();
    replace(
      note,
      installed.length && !ctx.can("connect")
        ? callout("quiet", "This device can't run tools itself (it has no connect scope; it was likely paired before connectors existed). Galahad and your loops still can.")
        : null,
    );
    replace(
      installedBox,
      ...(installed.length
        ? installed.map((c) => connectorCard(ctx, c, active, deps))
        : [
            h(
              "div",
              { class: "card" },
              empty({
                icon: "plug",
                title: "Nothing installed yet",
                body: "Install one below, or add an MCP server, and add its key. Every node can use it; no model ever sees the key.",
                compact: true,
              }),
            ),
          ]),
    );
    // (The library's servers are in the library, below; the ones Galahad ships, as cards.)
    const shipped = available.filter((c) => c.kind !== "mcp");
    replace(availableBox, ...shipped.map((c) => connectorCard(ctx, c, active, deps)));
    availableSection.hidden = !shipped.length;
  }

  async function fetchOrders(): Promise<OrderView[] | null> {
    if (!read) return null;
    try {
      return await loadOrders(ctx, scope.signal);
    } catch (error) {
      if (!scope.disposed) replace(ordersBox, errorState("Couldn't load standing orders", error, () => void refresh()));
      return null;
    }
  }

  // Arrived to add something (the palette's "Add an MCP server", "Add a connector"): once, when the list is in.
  let arrived = opts.intent ?? null;
  async function refresh(): Promise<void> {
    try {
      const [list, signed] = await Promise.all([loadConnectors(ctx, scope.signal), fetchOrders()]);
      if (scope.disposed) return;
      connectors = list;
      if (signed) orders = signed;
      keepPlace(root, () => render(list));
      if (signed) showOrders();
      if (arrived === "add-mcp" && ctx.can("brain:write")) openAddMcp(ctx, connectors, deps);
      else if (arrived === "catalog") requestAnimationFrame(() => availableSection.scrollIntoView({ block: "start", behavior: "smooth" }));
      else if (arrived?.startsWith("install:")) {
        // From an agent's request: to the one asked for, its Install ready.
        const card = availableBox.querySelector<HTMLElement>(`[data-connector="${CSS.escape(arrived.slice(8))}"]`);
        requestAnimationFrame(() => {
          (card ?? availableSection).scrollIntoView({ block: "center", behavior: "smooth" });
          card?.querySelector<HTMLButtonElement>("button[type=submit]")?.focus({ preventScroll: true });
        });
      }
      arrived = null;
    } catch (error) {
      if (!scope.disposed) replace(installedBox, errorState("Couldn't load connectors", error, () => void refresh()));
    }
  }

  // Use counts move as agents use orders: only the orders list re-renders, so a half-typed key stays put.
  async function refreshOrders(): Promise<void> {
    const signed = await fetchOrders();
    if (!signed || scope.disposed) return;
    const before = [...counts()].sort().join();
    orders = signed;
    if (JSON.stringify(signed) !== shownOrders) showOrders();
    if ([...counts()].sort().join() !== before) keepPlace(root, () => render(connectors));
  }

  replace(
    root,
    h(
      "div",
      { class: "page" },
      pageHead("Connectors", "How Galahad reaches the services you use. Reading, creating and changing are his to do, and logged. Anything outward, and every delete, asks you first, but his and the knights' work in the repositories you gave them, which he approves himself."),
      ctx.can("brain:write") ? null : callout("quiet", "This device can see connectors but not install or remove them (no brain:write scope)."),
      note,
      // Shown whole once the connectors and the orders have answered: each part came in on its own, pushing the next.
      pageBody(
        installedSection,
        chatApps.el,
        ordersSection,
        availableSection,
        library.el,
        h("p", { class: "note" }, "A service of your own: describe it in a manifest and run ", h("span", { class: "mono" }, "galahad connector add --manifest file.json"), " on a node."),
      ),
    ),
  );

  // A connector installed answers whoever asked for it: their request leaves the Inbox at once.
  scope.add(connectorsChanged.subscribe(() => (void refresh(), void ctx.live.refreshConnectorRequests(), library.refresh())));
  scope.add(vaultChanged.subscribe(() => void refresh()));
  scope.add(ordersChanged.subscribe(() => void refreshOrders()));
  if (read) scope.interval(() => void refreshOrders(), 15_000);
  void refresh();
  library.refresh();
  void chatApps.refresh();
};
