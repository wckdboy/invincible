import type { ProviderView } from "@galahad/core";
import { findSecrets } from "@galahad/core/secret-scan";
import { type Ctx, errorMessage, type View } from "../context.ts";
import { planLine, roleParts } from "../lib/text.ts";
import type { PresetView, RoleSpec } from "../types.ts";
import { badge, busy, button, callout, copyText, empty, errorState, field, pageBody, pageHead, section, segmented, skeletonBlock, skeletonRows } from "../ui/controls.ts";
import { confirmAction, openSheet } from "../ui/dialog.ts";
import { h, keepPlace, nextId, replace } from "../ui/dom.ts";
import { icon, type IconName } from "../ui/icons.ts";
import { toast } from "../ui/toast.ts";
import { modelCost } from "./models-cost.ts";
import { openAddKey } from "./vault.ts";

/*
 * Models are hired by role, not by vendor. The roster (shared by every node)
 * lists, per role, the model to use first and the fallbacks after it.
 * Providers say where models live; their keys stay sealed in the vault.
 */

const NAME_RE = /^[A-Za-z0-9._:-]{1,128}$/;
/** A role you make: a name a knight can carry (core's TeammateRole). */
const ROLE_NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;
const REF_RE = /^[^/\s]+\/\S+$/;
const ROLE_ICON: Record<string, IconName> = { planner: "compass", engineer: "code", reviewer: "review", swift: "zap" };
/** How hard a role's models think: by the step (the default: routine turns less, hard ones more), or one level. */
const THINKS: [NonNullable<RoleSpec["effort"]>, string][] = [["auto", "As each step needs"], ["low", "Low"], ["medium", "Medium"], ["high", "High"], ["xhigh", "Extra high"], ["max", "Max"]];

export const modelsView: View = (root, ctx, { scope }) => {
  const write = ctx.can("brain:write");
  // A role row is three lines: seven skeleton rows are about as tall as five roles.
  const rosterBox = h("div", { class: "card" }, skeletonRows(7, { avatar: true }));
  const providersBox = h("div", { class: "card" }, skeletonBlock(120));
  const knownModels = h("datalist", { id: nextId("models") });
  let roster: Record<string, RoleSpec> = {};
  let presets: PresetView[] = [];
  // What each model costs: your prices, and what this node's calls came to (models-cost.ts).
  const cost = modelCost(ctx, scope.signal);

  function addKnown(refs: string[]): void {
    const have = new Set([...knownModels.options].map((o) => o.value));
    for (const ref of refs) if (!have.has(ref)) knownModels.append(h("option", { value: ref }));
  }

  /** A role in one row: who it is, the models it hires in order, and Change. */
  function roleRow(role: string, spec: RoleSpec): HTMLElement {
    // His own models answer, in order; a coding plan's do coding (his quests, the knights' work) and nothing else.
    const { own, plans } = roleParts(spec.models, presets);
    const tools = plans.length ? h("span", { class: "subtle" }, `${own.length ? " · " : ""}coding: ${plans.join(", ")}`) : null;
    const chain = own.length
      ? h("span", { class: "mono small ellipsis", title: spec.models.map((m, i) => `${i + 1}. ${m}`).join("\n") }, own[0], own.length > 1 ? h("span", { class: "subtle" }, ` +${own.length - 1} fallback${own.length > 2 ? "s" : ""}`) : null, tools)
      : plans.length
        ? h("span", { class: "mono small ellipsis", title: "A coding plan answers coding work only" }, tools, h("span", { class: "subtle" }, " · nothing answers outside coding"))
        : h("span", { class: "small", style: "color:var(--warn)" }, "No model: this role can't answer");
    return h(
      "div",
      { class: "item center role-row" },
      h("span", { class: "avatar", style: "color:var(--accent)" }, icon(ROLE_ICON[role] ?? "sparkle", { size: 16 })),
      h(
        "div",
        { class: "grow" },
        h("div", { class: "row", style: "gap:6px" }, h("span", { class: "strong" }, role), spec.custom ? badge("yours", "accent") : spec.configured ? null : badge("default", "neutral"), spec.effort && spec.effort !== "auto" ? badge(`thinks ${THINKS.find(([level]) => level === spec.effort)?.[1].toLowerCase() ?? spec.effort}`, "neutral") : null),
        h("div", { class: "tiny subtle ellipsis" }, spec.description),
        h("div", { class: "row", style: "margin-top:4px;min-width:0" }, chain),
      ),
      write ? h("div", { class: "item-actions" }, button("Change", { size: "sm", icon: "edit", label: `Change the models for ${role}`, onClick: () => openRole(role, spec) })) : null,
    );
  }

  /**
   * The role's models in order, in a sheet: move, remove, add, then Save. Without a role, a new one of yours: its name
   * first. A role you made can be removed here (the node refuses while a knight works on it, and says which).
   */
  function openRole(existing?: string, spec: RoleSpec = { models: [], configured: false, description: "", custom: true, forKnights: true }): void {
    let role = existing ?? "";
    let models = [...spec.models];
    const name = existing ? null : h("input", { class: "input mono", type: "text", placeholder: "frontend", maxlength: 40, autocomplete: "off", autocapitalize: "off", autocorrect: "off", spellcheck: "false", "aria-label": "The role's name" });
    const list = h("div", { class: "reorder", role: "list", "aria-label": existing ? `Models for ${existing}` : "Models for the new role" });
    const input = h("input", { class: "input mono", type: "text", placeholder: "provider/model", list: knownModels.id, autocomplete: "off", autocapitalize: "off", autocorrect: "off", spellcheck: "false", "aria-label": existing ? `Add a model to ${existing}` : "Add a model to the new role" });
    const thinks = h("select", { class: "select", "aria-label": "How hard its models think" }, ...THINKS.map(([level, label]) => h("option", { value: level, selected: (spec.effort ?? "auto") === level }, label)));
    const save = button(existing ? "Save" : "Make role", { variant: "primary", icon: "check" });
    const removeRole = existing && spec.custom ? button("Remove role", { variant: "danger", icon: "trash" }) : null;

    function render(focus?: string): void {
      // (Which of them answer, and in what order: his own. A coding plan's do coding, in their own order.)
      const { own } = roleParts(models, presets);
      const part = (ref: string): string => {
        const at = own.indexOf(ref);
        return at < 0 ? "a coding plan: it does coding (his quests, the knights' work) and answers nothing else" : at === 0 ? "answers first" : `fallback ${at}`;
      };
      replace(
        list,
        ...(models.length
          ? models.map((ref, i) =>
              h(
                "div",
                { class: "r-item", role: "listitem" },
                h("span", { class: "r-index", "aria-hidden": "true" }, String(i + 1)),
                h("span", { class: "mono small grow ellipsis", title: `${ref} · ${part(ref)}` }, ref),
                button(`Move ${ref} up`, { variant: "ghost", size: "sm", iconOnly: true, icon: "chevron-up", disabled: i === 0, onClick: () => move(i, -1) }),
                button(`Move ${ref} down`, { variant: "ghost", size: "sm", iconOnly: true, icon: "chevron-down", disabled: i === models.length - 1, onClick: () => move(i, 1) }),
                button(`Remove ${ref}`, { variant: "ghost", size: "sm", iconOnly: true, icon: "x", onClick: () => remove(i) }),
              ),
            )
          : [h("p", { class: "small subtle" }, "No models: this role can't answer.")]),
      );
      if (focus) list.querySelector<HTMLButtonElement>(`button[aria-label="${CSS.escape(focus)}"]`)?.focus();
    }
    function move(i: number, delta: number): void {
      const [item] = models.splice(i, 1);
      models.splice(i + delta, 0, item!);
      render(`Move ${item!} ${delta < 0 ? "up" : "down"}`);
    }
    function remove(i: number): void {
      models.splice(i, 1);
      render();
    }
    function add(): void {
      const ref = input.value.trim();
      if (!ref) return;
      if (!REF_RE.test(ref)) {
        toast("Use provider/model", { tone: "warn", description: "For example anthropic/claude-opus-5-5, or ollama/* for whatever a local runtime serves." });
        return;
      }
      if (!models.includes(ref)) models = [...models, ref];
      input.value = "";
      render();
    }
    save.addEventListener("click", () =>
      void busy(save, async () => {
        if (name) {
          role = name.value.trim();
          // A knight carries it by this name: lowercase letters, digits and hyphens, and not one the roster has.
          if (!ROLE_NAME_RE.test(role)) return void toast("Name it in lowercase letters, digits and hyphens", { tone: "warn", description: "Starting with a letter, at most 40: frontend, cheap-coder." });
          if (roster[role]) return void toast(`There is a ${role} role already`, { tone: "warn", description: "Change its models from its own row." });
          if (!models.length) return void toast("Give it a model", { tone: "warn", description: "A role with no model can't answer." });
        }
        try {
          let result = await ctx.api.post<{ roster: Record<string, RoleSpec> }>("/api/roster", { role, models });
          // How hard it thinks, when that changed: its own word to the node (an older node has none, and says so).
          if (thinks.value !== (spec.effort ?? "auto")) result = await ctx.api.post<{ roster: Record<string, RoleSpec> }>("/api/roster/effort", { role, effort: thinks.value });
          roster = result.roster;
          sheet.close();
          renderRoster();
          toast(existing ? `${role} updated on every node` : `${role} made: give it to a knight from its editor`, { tone: "ok" });
        } catch (error) {
          toast("Couldn't save the roster", { tone: "error", description: errorMessage(error) });
        }
      }),
    );
    removeRole?.addEventListener("click", () =>
      void busy(removeRole, async () => {
        if (!(await confirmAction({ title: `Remove ${role}?`, body: [h("p", {}, "Its models stay where else you hired them. A knight that works on it must be given another role first.")], confirmLabel: "Remove" }))) return;
        try {
          roster = (await ctx.api.post<{ roster: Record<string, RoleSpec> }>("/api/roster", { role, models: [] })).roster;
          sheet.close();
          renderRoster();
          toast(`${role} removed`, { tone: "info" });
        } catch (error) {
          toast(`Couldn't remove ${role}`, { tone: "error", description: errorMessage(error) });
        }
      }),
    );
    render();
    const sheet = openSheet({
      title: existing ? `Models for ${existing}` : "A role of yours",
      description: existing
        ? "The first answers; the rest are fallbacks, tried in order. provider/* means whatever that local runtime serves."
        : "A name, and the models that answer for it in order. A knight you give it to does its work on them; its plan and the independent review stay the planner's and the reviewer's.",
      body: [
        name ? field("Name", name, { hint: "Lowercase letters, digits and hyphens: frontend, cheap-coder." }) : null,
        list,
        h(
          "form",
          {
            class: "row",
            onsubmit: (event: Event) => {
              event.preventDefault();
              add();
            },
          },
          h("div", { class: "grow" }, input),
          button("Add", { type: "submit", icon: "plus" }),
        ),
        field("Thinks", thinks, { hint: "As each step needs: a routine step less, a hard one (a failure, work sent back) more. A level holds whatever the step." }),
      ],
      footer: [removeRole, button("Cancel", { onClick: () => sheet.close() }), save],
      // On a touch screen the keyboard waits until you tap the field.
      initialFocus: () => (matchMedia("(pointer: coarse)").matches ? (list.querySelector<HTMLElement>("button:not(:disabled)") ?? input) : (name ?? input)),
    });
  }

  function renderRoster(): void {
    keepPlace(rosterBox, () => replace(rosterBox, h("div", { class: "rows" }, ...Object.entries(roster).map(([role, spec]) => roleRow(role, spec)))));
  }

  function providerRow(p: ProviderView): HTMLElement {
    const modelsBox = h("div");
    const local = /^https?:\/\/(127\.0\.0\.1|localhost)/.test(p.baseUrl);
    const keyBadge = p.hasKey ? badge("key sealed", "ok", "check") : local ? badge("local", "accent") : badge(p.keyElsewhere ? "key for another address" : "no key", "warn", "alert");
    // A coding plan (the node's presets say which): its key is for coding tools, and its vendor says which.
    const plan = presets.find((preset) => preset.id === p.id)?.plan;
    // Somewhere other than where its key was added, or than its preset's address: a key added for it needs the address next to it.
    const own = presets.find((preset) => preset.id === p.id)?.baseUrl;
    const elsewhere = !!p.keyElsewhere || (!!own && own !== p.baseUrl);
    const list = button("List models", { size: "sm", variant: "ghost", icon: "models" });
    list.addEventListener("click", () =>
      void busy(list, async () => {
        try {
          const { models } = await ctx.api.post<{ models: string[] }>("/api/providers/models", { id: p.id });
          const refs = models.map((m) => `${p.id}/${m}`);
          addKnown(refs);
          replace(
            modelsBox,
            refs.length
              ? h(
                  "div",
                  { class: "stack tight", style: "margin-top:10px;max-height:280px;overflow:auto" },
                  h("div", { class: "tiny subtle" }, `${refs.length} models · type them into a role above, or copy`),
                  ...refs.map((ref) =>
                    h("div", { class: "row", style: "gap:4px" }, h("span", { class: "mono small grow ellipsis" }, ref), button(`Copy ${ref}`, { size: "sm", variant: "ghost", iconOnly: true, icon: "copy", onClick: () => void copyText(ref) })),
                  ),
                )
              : h("p", { class: "small subtle", style: "margin-top:8px" }, "The provider listed no models."),
          );
        } catch (error) {
          replace(modelsBox, h("div", { style: "margin-top:8px" }, callout("danger", errorMessage(error))));
        }
      }),
    );
    return h(
      "div",
      { class: "item" },
      h("span", { class: "avatar" }, icon(local ? "server" : "globe", { size: 16 })),
      h(
        "div",
        { class: "grow" },
        h("div", { class: "row wrap" }, h("span", { class: "strong" }, p.id), badge(p.kind === "anthropic" ? "Anthropic API" : "OpenAI-compatible", "neutral"), keyBadge, plan ? badge("coding plan", "accent") : null),
        h("div", { class: "meta" }, h("span", { class: "mono" }, p.baseUrl), p.label ? h("span", {}, p.label) : null, p.secret ? h("span", {}, "key: ", h("span", { class: "mono" }, p.secret)) : null),
        p.keyElsewhere
          ? h("div", { class: "meta" }, h("span", {}, "Its key was added for ", h("span", { class: "mono" }, p.keyElsewhere), ", and a key goes only where it was added for: add it again with this address next to it."))
          : null,
        plan
          ? h("div", { class: "meta" }, h("span", {}, `${planLine(presets.find((preset) => preset.id === p.id))} ${plan.says} `, h("a", { href: plan.terms, target: "_blank", rel: "noopener noreferrer" }, "Its terms")))
          : null,
        modelsBox,
      ),
      h(
        "div",
        { class: "item-actions" },
        list,
        !p.hasKey && !local && ctx.can("vault:write") ? button("Add key", { size: "sm", icon: "key", onClick: () => openAddKey(ctx, { provider: p.id, name: p.secret ?? p.id, anotherAddress: elsewhere }) }) : null,
        write
          ? button(`Remove ${p.id}`, {
              size: "sm",
              variant: "ghost",
              iconOnly: true,
              icon: "trash",
              onClick: async () => {
                const ok = await confirmAction({
                  title: `Remove ${p.id}?`,
                  body: "Roles that use its models fall back to the next one in their list. Its key stays in the vault.",
                  confirmLabel: "Remove provider",
                });
                if (!ok) return;
                try {
                  await ctx.api.post("/api/providers/remove", { id: p.id });
                  toast(`${p.id} removed`, { tone: "ok" });
                  void refresh();
                } catch (error) {
                  toast("Couldn't remove it", { tone: "error", description: errorMessage(error) });
                }
              },
            })
          : null,
      ),
    );
  }

  async function refresh(): Promise<void> {
    try {
      const [providers, rosterResponse] = await Promise.all([
        ctx.api.get<{ providers: ProviderView[]; presets: PresetView[] }>("/api/providers", scope.signal),
        ctx.api.get<{ roster: Record<string, RoleSpec> }>("/api/roster", scope.signal),
      ]);
      if (scope.disposed) return;
      presets = providers.presets;
      roster = rosterResponse.roster;
      addKnown(Object.values(roster).flatMap((r) => r.models));
      renderRoster();
      void cost.refresh(roster);
      replace(
        providersBox,
        providers.providers.length
          ? h("div", { class: "rows" }, ...providers.providers.map(providerRow))
          : empty({
              icon: "models",
              title: "No providers yet",
              body: "Adding a key in the vault configures known providers for you. Local runtimes like Ollama need only their address.",
              actions: [ctx.can("vault:write") ? button("Add a key", { variant: "primary", icon: "key", onClick: () => openAddKey(ctx) }) : null, write ? button("Add provider", { icon: "plus", onClick: () => openAddProvider(ctx, presets, refresh) }) : null],
            }),
      );
    } catch (error) {
      if (!scope.disposed) replace(rosterBox, errorState("Couldn't load models", error, () => void refresh()));
    }
  }

  replace(
    root,
    h(
      "div",
      { class: "page" },
      pageHead("Models", "Hired by role, not by vendor. The roster is shared by every node; keys stay sealed in the vault.", write ? button("Add provider", { icon: "plus", onClick: () => openAddProvider(ctx, presets, refresh) }) : null),
      write ? null : callout("quiet", "This device can see the roster but not change it (no brain:write scope)."),
      // (Shown in one frame once none of its parts is still loading: nothing below moves as the roster arrives.)
      pageBody(
        section("Roster", { actions: write ? button("New role", { size: "sm", icon: "plus", onClick: () => openRole() }) : null }, rosterBox),
        section("Providers", {}, providersBox),
        cost.el,
      ),
      knownModels,
    ),
  );
  void refresh();
};

function openAddProvider(ctx: Ctx, presets: PresetView[], onDone: () => Promise<void>): void {
  const id = h("input", { class: "input mono", type: "text", autocomplete: "off", autocorrect: "off", spellcheck: "false", autocapitalize: "off", placeholder: "e.g. verda" });
  const preset = h("select", { class: "select" }, h("option", { value: "" }, "No preset"), ...presets.map((p) => h("option", { value: p.id }, p.id)));
  const url = h("input", { class: "input mono", type: "url", autocomplete: "off", autocorrect: "off", spellcheck: "false", placeholder: "https://…/v1" });
  const secret = h("input", { class: "input mono", type: "text", autocomplete: "off", autocorrect: "off", spellcheck: "false", placeholder: "defaults to the id", maxlength: 128 });
  const label = h("input", { class: "input", type: "text", autocomplete: "off", maxlength: 128 });
  let kind: "openai" | "anthropic" = "openai";
  const kindControl = segmented(
    [
      { value: "openai", label: "OpenAI-compatible" },
      { value: "anthropic", label: "Anthropic" },
    ],
    kind,
    (value) => (kind = value as typeof kind),
    { label: "API", block: true },
  );
  const status = h("div");
  preset.addEventListener("change", () => {
    const chosen = presets.find((p) => p.id === preset.value);
    if (!chosen) return;
    if (!id.value) id.value = chosen.id;
    kind = chosen.kind;
    kindControl.set(chosen.kind);
    url.value = chosen.baseUrl;
    // A coding plan says what it is for (and what its vendor says of it) before it is saved.
    const plan = planLine(chosen);
    replace(status, plan ? callout("info", [plan, " ", chosen.plan!.says], { title: chosen.plan!.name }) : null, chosen.note ? callout("info", chosen.note) : null);
  });
  const save = button("Save provider", { variant: "primary", type: "submit", icon: "check" });
  const form = h(
    "form",
    {
      class: "stack loose",
      onsubmit: (event: Event) => {
        event.preventDefault();
        // Provider settings replicate in plaintext: a key pasted into any of these fields stops here.
        for (const input of [id, url, secret, label]) {
          const finding = findSecrets(input.value)[0];
          if (!finding) continue;
          const key = input.value.slice(finding.index, finding.index + finding.length);
          input.value = "";
          replace(
            status,
            callout("warn", `That looks like a ${finding.kind}. Provider settings are shared in plaintext, so it wasn't saved. This form wants the vault secret's name, not the key.`, {
              title: "Keys belong in the vault",
              icon: "shield",
              actions: ctx.can("vault:write")
                ? button("Store it in the vault instead", {
                    variant: "primary",
                    size: "sm",
                    icon: "vault",
                    onClick: () => {
                      sheet.close();
                      openAddKey(ctx, { prefill: key, provider: id.value.trim() || null });
                    },
                  })
                : null,
            }),
          );
          return;
        }
        const providerId = id.value.trim();
        if (!NAME_RE.test(providerId)) {
          replace(status, callout("warn", "Give the provider an id (letters, digits and . _ : -)."));
          return;
        }
        const secretName = secret.value.trim() || providerId;
        void busy(save, async () => {
          try {
            const { providers: now } = await ctx.api.post<{ providers: ProviderView[] }>("/api/providers", {
              id: providerId,
              ...(preset.value ? { preset: preset.value } : {}),
              ...(url.value.trim() ? { baseUrl: url.value.trim() } : {}),
              kind,
              secret: secretName,
              ...(label.value.trim() ? { label: label.value.trim() } : {}),
            });
            sheet.close();
            // Pointed somewhere its key wasn't added for: the key stays where it was, and you're told so at once.
            const elsewhere = now.find((p) => p.id === providerId)?.keyElsewhere;
            toast(
              `${providerId} configured`,
              elsewhere
                ? { tone: "warn", description: `Its key was added for ${elsewhere}, and a key goes only where it was added for: add it again for this address.` }
                : { tone: "ok", description: `Its key is read from the vault secret "${secretName}".` },
            );
            await onDone();
          } catch (error) {
            replace(status, callout("danger", errorMessage(error)));
          }
        });
      },
    },
    h("div", { class: "fields" }, field("Preset", preset), field("Id", id)),
    field("Base URL", url, { hint: "The OpenAI- or Anthropic-compatible endpoint." }),
    h("div", { class: "stack tight" }, h("div", { class: "label" }, "API"), kindControl.el),
    h("div", { class: "fields" }, field("Vault secret name", secret, { hint: "The name of a secret in the vault, never the key itself." }), field("Label (optional)", label)),
    status,
    h("div", { class: "row", style: "justify-content:flex-end" }, button("Cancel", { onClick: () => sheet.close() }), save),
  );
  const sheet = openSheet({ title: "Add or update a provider", description: "Where models live. The key itself stays in the vault.", body: form });
}
