import type { ConnectorToolView, ConnectorView } from "@galahad/core";
import { findSecrets } from "@galahad/core/secret-scan";
import { ApiError } from "../api.ts";
import { type Ctx, errorMessage } from "../context.ts";
import { asksYou, CONNECTOR_ID, claimWords, type Discovered, discoveredSummary, mcpUrlProblem, stopsAsking, suggestId, TOOL_CLASSES, type ToolClass } from "../lib/connectors.ts";
import { list } from "../lib/orders.ts";
import type { ActionClass } from "../types.ts";
import { badge, busy, button, callout, field, formActions, segmented } from "../ui/controls.ts";
import { confirmAction, openSheet, type Sheet } from "../ui/dialog.ts";
import { h, replace } from "../ui/dom.ts";
import { icon } from "../ui/icons.ts";
import { toast } from "../ui/toast.ts";
import { CLASS_INFO } from "./activity.ts";
import { signInBlock } from "./sign-in.ts";

/*
 * Remote MCP servers as connectors. Galahad lists a server's tools when you add
 * it (and again when you refresh), and you choose each tool's class: read, create
 * and modify run freely and are logged; outward and delete ask you first. What a
 * server says about its tools (descriptions, hints) is its claim, shown as data:
 * the hints only propose a class, and its words are never instructions.
 */

/** What the Connectors page lends this module: its change signal, and its sealed key field. */
export interface McpDeps {
  changed(): void;
  keyField(c: ConnectorView, onSealed: () => void): HTMLElement | null;
}

export interface McpInput {
  url: string;
  label?: string;
  auth?: "none" | "bearer" | "header" | "oauth";
  header?: string;
  only?: string[];
  classes?: Record<string, ToolClass>;
}

/** Install or refresh: the node lists the server's tools now and keeps the classes you chose. */
export async function setMcp(ctx: Ctx, id: string, mcp: McpInput): Promise<{ connector: ConnectorView; discovered: Discovered }> {
  return ctx.api.post<{ connector: ConnectorView; discovered: Discovered }>("/api/connectors", { id, mcp });
}

export const CLASS_EXPLAIN = "Read, create and modify run freely, and the ledger records them; outward and delete ask you first. The server's hints only propose a class: you choose.";

/** A tool's class, chosen, with whether that runs freely or asks you beside it (short enough for a phone). */
export function classSelect(tool: Pick<ConnectorToolView, "name" | "class">, onChange: (cls: ToolClass) => void): HTMLElement {
  const note = h("span", { class: "tiny subtle", "aria-live": "polite" });
  const select = h(
    "select",
    { class: "select fit", "aria-label": `${tool.name}: class` },
    ...TOOL_CLASSES.map((cls) => h("option", { value: cls, selected: cls === tool.class }, cls)),
  );
  const sync = () => (note.textContent = asksYou(select.value) ? "asks you" : "runs freely");
  select.addEventListener("change", () => {
    sync();
    onChange(select.value as ToolClass);
  });
  sync();
  return h("span", { class: "row flex-none" }, select, note);
}

/** A tool's description, as the server's words: quoted, never instructions. */
export function serverWords(text: string): HTMLElement {
  return h("div", { class: "quote small", title: "The server's description: its words, treated as data" }, text);
}

/** The class picker for a list of tools, remembering what you changed. */
export function classChooser(tools: ConnectorToolView[], onChange: () => void): { el: HTMLElement; changes(): Record<string, ToolClass> } {
  const picked = new Map<string, ToolClass>();
  const rows = tools.map((tool) => {
    const avatar = h("span", { class: "avatar" });
    const paint = (cls: string) => {
      const info = CLASS_INFO[cls as ActionClass];
      avatar.dataset.tone = info?.tone ?? "neutral";
      avatar.title = info?.label ?? cls;
      replace(avatar, icon(info?.icon ?? "eye", { size: 14 }));
    };
    paint(tool.class);
    const picker = classSelect(tool, (cls) => {
      if (cls === tool.class) picked.delete(tool.name);
      else picked.set(tool.name, cls);
      paint(cls);
      onChange();
    });
    const params = Object.entries(tool.params).map(([name, p]) => (p.required ? name : `[${name}]`)).join(" ");
    return h(
      "div",
      { class: "item" },
      avatar,
      h(
        "div",
        { class: "grow stack tight" },
        h(
          "div",
          { class: "row wrap between" },
          h("span", { class: "row wrap" }, h("span", { class: "mono strong small" }, tool.name), h("span", { class: "tiny subtle" }, claimWords(tool.hints))),
          picker,
        ),
        tool.description ? serverWords(tool.description) : null,
        params ? h("div", { class: "meta mono" }, params) : null,
      ),
    );
  });
  return {
    el: rows.length
      ? h("div", { class: "card flat" }, h("div", { class: "rows" }, ...rows))
      : h("p", { class: "small subtle" }, "The server lists no tools."),
    changes: () => Object.fromEntries(picked),
  };
}

/**
 * Save your classes: the node lists the tools again and applies them. Anything
 * that would stop asking you is confirmed first, since the server's claims are
 * only claims.
 */
export async function saveClasses(ctx: Ctx, c: ConnectorView, changes: Record<string, ToolClass>, deps: McpDeps): Promise<{ saved: boolean; problem?: string }> {
  if (!Object.keys(changes).length || !c.url) return { saved: false };
  const freed = stopsAsking(c.tools, changes);
  if (freed.length) {
    const ok = await confirmAction({
      title: freed.length === 1 ? `Let ${freed[0]} run without asking?` : `Let ${freed.length} tools run without asking?`,
      body: [
        h("p", {}, h("span", { class: "mono" }, list(freed)), ` will run whenever an agent or a loop calls ${freed.length === 1 ? "it" : "them"}, without asking you. The ledger still records each call.`),
        h("p", {}, "What the server says about its tools is only its claim. Choose this only for what you'd let Galahad do alone."),
      ],
      confirmLabel: "Save classes",
      tone: "primary",
    });
    if (!ok) return { saved: false };
  }
  try {
    const { connector, discovered } = await setMcp(ctx, c.id, { url: c.url, classes: changes });
    deps.changed();
    const asking = connector.tools.filter((t) => t.asks).length;
    toast("Classes saved", {
      tone: "ok",
      description: `${connector.label}: ${asking} ask${asking === 1 ? "s" : ""} you, ${connector.tools.length - asking} run${connector.tools.length - asking === 1 ? "s" : ""} freely.${discovered.changed.length ? ` Changed on the server: ${discovered.changed.join(", ")}.` : ""}`,
    });
    return { saved: true };
  } catch (error) {
    return { saved: false, problem: errorMessage(error) };
  }
}

/** What a listing found that differs from before: new tools, changed ones (with what that means), gone ones. */
export function reportView(d: Discovered): HTMLElement | null {
  if (!d.added.length && !d.changed.length && !d.removed.length) return null;
  return h(
    "div",
    { class: "stack tight" },
    d.added.length ? h("p", { class: "small" }, "New: ", h("span", { class: "mono" }, d.added.join(", ")), ". They start from the server's hints; check their classes.") : null,
    d.changed.length
      ? callout(
          "warn",
          h("span", {}, h("span", { class: "mono" }, d.changed.join(", ")), " changed on the server since you installed it. Your classes stay; standing orders on them stop applying."),
          { title: "Changed on the server" },
        )
      : null,
    d.removed.length ? h("p", { class: "small" }, "Gone from the server: ", h("span", { class: "mono" }, d.removed.join(", ")), ".") : null,
  );
}

/** The tools a listing found, with a class picker each, in an open sheet. */
function showTools(ctx: Ctx, sheet: Sheet, c: ConnectorView, d: Discovered, deps: McpDeps, first: boolean): void {
  const status = h("div");
  const save = button("Save classes", { variant: "primary", icon: "check", disabled: true });
  const chooser = classChooser(c.tools, () => {
    save.disabled = !Object.keys(chooser.changes()).length;
  });
  save.addEventListener("click", () =>
    void busy(save, async () => {
      replace(status);
      const result = await saveClasses(ctx, c, chooser.changes(), deps);
      if (result.saved) sheet.close();
      else if (result.problem) replace(status, callout("danger", result.problem, { title: "Not saved" }));
    }),
  );
  replace(
    sheet.body,
    h(
      "div",
      { class: "stack loose" },
      h(
        "div",
        { class: "stack tight" },
        h("p", { class: "row wrap" }, icon("check-circle", { size: 16 }), h("span", { class: "strong" }, discoveredSummary(c.label, d))),
        h("p", { class: "mono tiny subtle wrap-anywhere" }, c.url ?? ""),
      ),
      first ? null : reportView(d),
      h("p", { class: "small muted" }, CLASS_EXPLAIN),
      chooser.el,
      h("p", { class: "tiny subtle" }, "Descriptions are the server's words, shown as it gave them: data, never instructions."),
      status,
      formActions(button(first ? "Done" : "Close", { onClick: () => sheet.close() }), save),
    ),
  );
}

/** Re-list an MCP server's tools and show what changed, with the class pickers. */
export async function refreshMcp(ctx: Ctx, c: ConnectorView, deps: McpDeps): Promise<void> {
  if (!c.url) return;
  try {
    const { connector, discovered } = await setMcp(ctx, c.id, { url: c.url });
    deps.changed();
    if (discovered.needsSignIn) {
      toast(`${c.label} isn't signed in`, { tone: "warn", description: "Sign in on its card: its tools are listed then." });
      return;
    }
    if (discovered.needsKey) {
      toast(`${c.label} still needs its key`, { tone: "warn", description: "Add it on its card, then refresh." });
      return;
    }
    const sheet = openSheet({ title: `${connector.label}'s tools`, description: "Listed from the server just now.", size: "wide", body: h("div") });
    showTools(ctx, sheet, connector, discovered, deps, false);
  } catch (error) {
    toast(`Couldn't refresh ${c.label}`, { tone: "error", description: errorMessage(error) });
  }
}

/** Add an MCP server: its address, a name, how its key is sent; then its key if it needs one, then its tools. */
export function openAddMcp(ctx: Ctx, installed: ConnectorView[], deps: McpDeps): void {
  const address = h("input", { class: "input mono", type: "url", inputmode: "url", autocomplete: "off", autocorrect: "off", spellcheck: "false", autocapitalize: "off", placeholder: "https://mcp.example.com/mcp" });
  const id = h("input", { class: "input mono", type: "text", autocomplete: "off", autocorrect: "off", spellcheck: "false", autocapitalize: "off", maxlength: 40, placeholder: "e.g. tracker" });
  const label = h("input", { class: "input", type: "text", autocomplete: "off", maxlength: 64, placeholder: "e.g. Tracker" });
  const header = h("input", { class: "input mono", type: "text", autocomplete: "off", autocorrect: "off", spellcheck: "false", autocapitalize: "off", maxlength: 64, placeholder: "x-api-key" });
  const only = h("input", { class: "input mono", type: "text", autocomplete: "off", autocorrect: "off", spellcheck: "false", autocapitalize: "off", placeholder: "search, createIssue" });
  let idEdited = false;
  let auth: "none" | "bearer" | "header" | "oauth" = "none";

  const headerField = field("Header name", header, { hint: "The header the server reads its key from." });
  const onlyField = field("Only these tools", only, { hint: "The server's own tool names, separated by commas. Up to 64." });
  onlyField.hidden = true;
  const authHint = h("div", { class: "tiny subtle" });
  const syncAuth = () => {
    headerField.hidden = auth !== "header";
    authHint.textContent =
      auth === "none"
        ? "It answers without a key."
        : auth === "bearer"
          ? "Sent as Authorization: Bearer, and only to this server. You'll seal the key next."
          : auth === "header"
            ? "Sent in a header of the server's choosing, and only to this server. You'll seal the key next."
            : "You sign in as yourself, in your browser, next: no key and no app of yours. Galahad registers itself with the server then.";
  };
  const authControl = segmented(
    [
      { value: "none", label: "None" },
      { value: "bearer", label: "Bearer" },
      { value: "header", label: "A header" },
      { value: "oauth", label: "Sign in" },
    ],
    auth,
    (value) => {
      auth = value as typeof auth;
      syncAuth();
    },
    { label: "Its key or sign-in", small: true },
  );
  syncAuth();

  address.addEventListener("input", () => {
    if (!idEdited) id.placeholder = suggestId(address.value) ?? "e.g. tracker";
  });
  id.addEventListener("input", () => (idEdited = id.value.trim() !== ""));

  const status = h("div");
  const connect = button("Connect", { variant: "primary", type: "submit", icon: "plug" });
  const form = h(
    "form",
    {
      class: "stack loose",
      autocomplete: "off",
      onsubmit: (event: Event) => {
        event.preventDefault();
        replace(status);
        const stop = (problem: string, focus: HTMLElement) => {
          replace(status, callout("warn", problem));
          focus.focus();
        };
        const url = address.value.trim();
        const urlProblem = mcpUrlProblem(url);
        if (urlProblem) return stop(urlProblem, address);
        if (findSecrets(url).length) return stop("That address looks like it holds a key. Keys go in the vault, never in a URL.", address);
        const name = id.value.trim() || suggestId(url) || "";
        if (!CONNECTOR_ID.test(name)) return stop("Give it an id: lowercase letters, digits and -, starting with a letter.", id);
        const existing = installed.find((c) => c.id === name);
        if (existing && existing.kind !== "mcp") return stop(`${name} is already a connector of another kind. Choose another id.`, id);
        if (auth === "header" && !/^[A-Za-z0-9-]{1,64}$/.test(header.value.trim())) return stop("Name the header: letters, digits and -.", header);
        const text = label.value.trim();
        if (text && findSecrets(text).length) return stop("That name looks like a key. Keys go in the vault.", label);
        const picked = only.value.split(/[\s,]+/).filter(Boolean);
        const input: McpInput = {
          url,
          ...(text ? { label: text } : {}),
          auth,
          ...(auth === "header" ? { header: header.value.trim() } : {}),
          ...(picked.length ? { only: picked } : {}),
        };
        void busy(connect, async () => {
          try {
            const { connector, discovered } = await setMcp(ctx, name, input);
            deps.changed();
            if (discovered.needsSignIn) signInStep(ctx, sheet, connector);
            else if (discovered.needsKey) keyStep(ctx, sheet, connector, url, deps);
            else showTools(ctx, sheet, connector, discovered, deps, true);
          } catch (error) {
            const status413 = error instanceof ApiError && error.status === 413;
            const status424 = error instanceof ApiError && error.status === 424;
            if (status413) onlyField.hidden = false;
            replace(
              status,
              callout("danger", errorMessage(error), { title: "Couldn't connect" }),
              status413 ? h("p", { class: "small muted" }, "Name the tools you need under Only these tools, and connect again.") : null,
              status424 && auth === "none" ? h("p", { class: "small muted" }, "If it wants a key or a sign-in, choose which under Its key or sign-in, and connect again.") : null,
            );
            if (status413) only.focus();
          }
        });
      },
    },
    field("Address", address, { hint: "The server's endpoint (streamable HTTP). Galahad talks to it and nowhere else." }),
    h("div", { class: "fields" }, field("Id", id, { hint: "How agents and loops name it." }), field("Name (optional)", label)),
    h("div", { class: "stack tight" }, h("div", { class: "label" }, "Its key or sign-in"), h("div", {}, authControl.el), authHint),
    headerField,
    onlyField,
    callout("quiet", "Galahad lists its tools once, and you choose what each may do. Its key, if it has one, goes into the vault and is only ever sent to this server."),
    status,
    h("div", { class: "row wrap", style: "justify-content:flex-end" }, button("Cancel", { onClick: () => sheet.close() }), connect),
  );

  const sheet = openSheet({
    title: "Add an MCP server",
    description: "A remote MCP server becomes a connector: its tools, with the classes you choose.",
    body: form,
    size: "wide",
    initialFocus: () => address,
  });
}

/** The next step for a server that takes a key, in its sheet: the key, sealed; then its tools, listed. */
export function keyStep(ctx: Ctx, sheet: Sheet, connector: ConnectorView, url: string, deps: McpDeps): void {
  const note = h("div");
  const onSealed = () => {
    replace(note, h("p", { class: "small muted row", style: "gap:8px" }, h("span", { class: "spinner", "aria-hidden": "true" }), "Sealed. Listing its tools…"));
    setMcp(ctx, connector.id, { url })
      .then(({ connector: listed, discovered }) => {
        deps.changed();
        if (sheet.scope.disposed) return;
        if (discovered.needsKey) replace(note, callout("warn", "It still has no key. Seal it again."));
        else showTools(ctx, sheet, listed, discovered, deps, true);
      })
      .catch((error: unknown) => {
        if (!sheet.scope.disposed) replace(note, callout("danger", errorMessage(error), { title: "Couldn't list its tools" }));
      });
  };
  replace(
    sheet.body,
    h(
      "div",
      { class: "stack loose" },
      callout("info", `${connector.label} is installed without tools yet: it needs its key first. Galahad lists its tools as soon as the key is sealed.`, { title: "Add its key" }),
      deps.keyField(connector, onSealed),
      note,
      formActions(button("Later", { onClick: () => sheet.close() })),
    ),
  );
  sheet.body.querySelector<HTMLInputElement>("input[type=password]")?.focus();
}

/** Its key for a server just added (from the library): its own sheet, so you stay where you were. */
export function openKey(ctx: Ctx, connector: ConnectorView, deps: McpDeps): void {
  const sheet = openSheet({ title: `${connector.label}'s key`, description: "Sealed in the vault, sent to this server alone.", body: h("div") });
  keyStep(ctx, sheet, connector, connector.url ?? "", deps);
}

/** The next step for a server you sign in to, in its sheet: the sign-in, and the sheet closes once you're in (its tools listed). */
export function signInStep(ctx: Ctx, sheet: Sheet, connector: ConnectorView): void {
  replace(
    sheet.body,
    h(
      "div",
      { class: "stack loose" },
      callout("info", `${connector.label} is added. Its tools are listed once you've signed in.`, { title: "Sign in next" }),
      signInBlock(ctx, connector, { onSignedIn: () => sheet.close() }),
      formActions(button("Later", { onClick: () => sheet.close() })),
    ),
  );
}

/** Sign in to a server just added (from the library): its own sheet, so you stay where you were. */
export function openSignIn(ctx: Ctx, connector: ConnectorView): void {
  const sheet = openSheet({ title: `Sign in to ${connector.label}`, description: "As yourself, in your browser.", body: h("div") });
  signInStep(ctx, sheet, connector);
}

/** The few words an MCP card adds: where it talks to, and that tool descriptions are the server's. */
export function mcpBadge(): HTMLElement {
  return badge("MCP server", "neutral", "plug");
}
