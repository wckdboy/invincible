import type { ProviderView, SecretRequestView, SecretView } from "@galahad/core";
import { type Ctx, errorMessage, type View } from "../context.ts";
import { detectProvider, detectSignIn, planLine, providerSetup, type SignInForm } from "../lib/text.ts";
import { hlcMs, relativeTime } from "../lib/time.ts";
import type { PresetView } from "../types.ts";
import { badge, busy, button, callout, empty, errorState, field, listRow, pageBody, pageHead, rows, secretInput, section, skeletonRows } from "../ui/controls.ts";
import { confirmAction, openSheet } from "../ui/dialog.ts";
import { h, replace } from "../ui/dom.ts";
import { icon } from "../ui/icons.ts";
import { signal } from "../ui/signal.ts";
import { toast } from "../ui/toast.ts";

/*
 * Keys go from a password field straight into the vault on a full node, where
 * they are sealed for your full nodes only. They are never stored in this
 * browser, never logged, never shown again, and never handed to a model:
 * Galahad's arms use scoped gateway tokens instead. The UI only ever shows a
 * hint like "…3456", which the server computes.
 */

const NAME_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** Bumped whenever a secret is sealed or deleted, so open views refresh. */
export const vaultChanged = signal(0);

interface ProvidersResponse {
  providers: ProviderView[];
  presets: PresetView[];
  /** The forms of subscription sign-ins the node knows (absent from an older node). */
  signIns?: SignInForm[];
}

let providerCache: ProvidersResponse | null = null;

async function loadProviders(ctx: Ctx): Promise<ProvidersResponse> {
  if (!ctx.can("mind:read")) return { providers: [], presets: [] };
  providerCache = await ctx.api.get<ProvidersResponse>("/api/providers");
  return providerCache;
}

async function ensureProviderConfigured(ctx: Ctx, data: ProvidersResponse, providerId: string, secretName: string, baseUrl?: string): Promise<string | null> {
  const { request, say } = providerSetup(data, providerId, secretName, ctx.can("brain:write"), baseUrl);
  if (request) await ctx.api.post("/api/providers", request);
  return say;
}

/**
 * Seals a value into the vault, then wires up the provider if it's a known preset. `baseUrl`: where the key may go, for
 * a preset with no address of its own (a Cloudflare AI Gateway): the key is pinned there, and the provider set up there.
 */
export async function sealSecret(ctx: Ctx, name: string, value: string, providerId: string | null, label?: string, baseUrl?: string): Promise<string | null> {
  await ctx.api.post("/api/secrets", {
    name,
    value,
    ...(providerId ? { provider: providerId } : {}),
    ...(label ? { label } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  });
  vaultChanged.update((n) => n + 1);
  if (!providerId) return null;
  try {
    return await ensureProviderConfigured(ctx, providerCache ?? (await loadProviders(ctx)), providerId, name, baseUrl);
  } catch (error) {
    return `The key is sealed, but configuring ${providerId} failed: ${errorMessage(error)}`;
  }
}

export interface AddKeyOptions {
  /** A key handed over from chat or memory. It was never sent anywhere. */
  prefill?: string;
  name?: string;
  provider?: string | null;
  /** The address field open from the start: the provider is somewhere other than where its key was, or its preset's address. */
  anotherAddress?: boolean;
}

export function openAddKey(ctx: Ctx, options: AddKeyOptions = {}): void {
  if (!ctx.can("vault:write")) {
    toast("This device can't add keys", { tone: "warn", description: "It was paired without the vault:write scope." });
    return;
  }
  const secret = secretInput({ id: "key-value" });
  const providerSelect = h("select", { class: "select", id: "key-provider" }, h("option", { value: "" }, "Choose a provider…"));
  const name = h("input", { class: "input mono", type: "text", id: "key-name", autocomplete: "off", autocorrect: "off", spellcheck: "false", autocapitalize: "off", placeholder: "e.g. anthropic", value: options.name ?? "" });
  const label = h("input", { class: "input", type: "text", id: "key-label", autocomplete: "off", placeholder: "e.g. personal account", maxlength: 128 });
  // A preset with no address of its own (a Cloudflare AI Gateway) is given one here, next to its key: the key is pinned to it.
  // Any other provider may be given another (its plan's other region), once you ask for the field.
  const address = h("input", { class: "input mono", type: "url", id: "key-base-url", autocomplete: "off", autocorrect: "off", spellcheck: "false", autocapitalize: "off", placeholder: "https://…" });
  const addressHint = h("span");
  const addressField = field("Base URL", address, { id: "key-base-url", hint: addressHint });
  let another = options.anotherAddress ?? false;
  const anotherRow = h(
    "div",
    { class: "row" },
    button("Another address", {
      size: "sm",
      variant: "ghost",
      icon: "globe",
      onClick: () => {
        another = true;
        showAddress();
        address.focus();
      },
    }),
  );
  const detected = h("div", { class: "row wrap", style: "min-height:24px", "aria-live": "polite" });
  const status = h("div");
  let data: ProvidersResponse = providerCache ?? { providers: [], presets: [] };
  let manual = Boolean(options.provider);
  const chosenPreset = () => data.presets.find((p) => p.id === providerSelect.value);
  /** The chosen provider is a preset with no address of its own: the key goes only where you say (never one read back from its configuration). */
  const needsAddress = (): boolean => {
    const chosen = chosenPreset();
    return !!chosen && !chosen.baseUrl;
  };
  /** Another address than its own, for a provider chosen: only one you type, here, next to the key. */
  const mayGiveAnother = (): boolean => !!providerSelect.value && providerSelect.value !== "__other" && !needsAddress();
  /** A secret of yours alone may be pinned to its API's address, so a knight can be given it to use and never see (PLAN #17). */
  const plain = (): boolean => providerSelect.value === "__other";
  const addressShown = (): boolean => needsAddress() || plain() || (another && mayGiveAnother());
  const showAddress = () => {
    addressField.hidden = !addressShown();
    anotherRow.hidden = addressShown() || !mayGiveAnother();
    const own = chosenPreset()?.baseUrl;
    replace(
      addressHint,
      needsAddress()
        ? "It has no address of its own: the key is only ever sent to this one."
        : plain()
          ? "Optional: its API's https address, the one place it is ever sent, so a knight can be given it to use through the gateway without seeing it. Left empty, it is sent nowhere."
          : own
          ? `Its own is ${own}. Give another only where its page shows one (another region's): the key is only ever sent to the address you give.`
          : "The key is only ever sent to the address you give.",
    );
  };

  function syncOptions(): void {
    const ids = [...new Set([...data.presets.map((p) => p.id), ...data.providers.map((p) => p.id)])].sort();
    const currentValue = providerSelect.value || options.provider || "";
    replace(
      providerSelect,
      h("option", { value: "" }, "Choose a provider…"),
      ...ids.map((id) => h("option", { value: id, selected: id === currentValue }, id)),
      h("option", { value: "__other", selected: currentValue === "__other" }, "Other (secret only)"),
    );
  }

  function onKey(): void {
    const value = secret.input.value.trim();
    if (!value) {
      replace(detected);
      showAddress();
      return;
    }
    // A subscription's sign-in is not a key: said at once, before anything is chosen or sent.
    const pasted = detectSignIn(value, data.signIns);
    if (pasted) {
      replace(detected, signInCallout(pasted));
      return;
    }
    const found = detectProvider(value, data.presets, data.signIns);
    if (found && !manual) {
      providerSelect.value = found;
      if (!name.value || data.presets.some((p) => p.id === name.value)) name.value = found;
    }
    // A coding plan says what it is for, whether it was recognised or chosen.
    const plan = planLine(data.presets.find((p) => p.id === providerSelect.value));
    showAddress();
    replace(
      detected,
      found
        ? [badge(`Recognised: ${found}`, "ok", "check"), manual && providerSelect.value !== found ? h("span", { class: "tiny subtle" }, `You chose ${providerSelect.value || "none"}`) : null]
        : h("span", { class: "tiny subtle" }, "Not recognised from its prefix. Choose the provider below."),
      plan ? h("span", { class: "tiny subtle", style: "flex-basis:100%" }, plan) : null,
    );
  }

  secret.input.addEventListener("input", onKey);
  providerSelect.addEventListener("change", () => {
    manual = true;
    if (providerSelect.value && providerSelect.value !== "__other") name.value = providerSelect.value;
    onKey();
  });

  const seal = button("Seal into the vault", { variant: "primary", type: "submit", icon: "vault" });
  const form = h(
    "form",
    {
      class: "stack loose",
      autocomplete: "off",
      onsubmit: (event: Event) => {
        event.preventDefault();
        // Read, then clear at once: the key lives in this page as briefly as possible.
        const value = secret.input.value.trim();
        secret.input.value = "";
        replace(detected);
        const chosen = providerSelect.value;
        const providerId = chosen && chosen !== "__other" ? chosen : null;
        const secretName = (name.value.trim() || providerId || "").trim();
        const baseUrl = addressShown() ? address.value.trim() : "";
        if (!value) {
          replace(status, callout("warn", "Paste a key first."));
          secret.input.focus();
          return;
        }
        if (!NAME_RE.test(secretName)) {
          replace(status, callout("warn", "Give the secret a name (letters, digits and . _ : - only), then paste the key again. The field was cleared for safety."));
          name.focus();
          return;
        }
        if (baseUrl && !/^https:\/\/[^\s/]+/.test(baseUrl)) {
          replace(status, callout("warn", "The base URL is an https:// address, then paste the key again. The field was cleared for safety."));
          address.focus();
          return;
        }
        // Never sealed as a provider's key (the node refuses it too); as a secret of your own, with no provider, it is yours to keep.
        const pasted = providerId ? detectSignIn(value, data.signIns) : null;
        if (pasted) {
          replace(status, signInCallout(pasted));
          return;
        }
        void busy(seal, async () => {
          try {
            const extra = await sealSecret(ctx, secretName, value, providerId, label.value.trim() || undefined, baseUrl || undefined);
            sheet.close();
            toast(`${secretName} sealed`, { tone: "ok", description: extra ?? "Every full node can use it. No model ever sees it." });
          } catch (error) {
            replace(status, callout("danger", `${errorMessage(error)}. The field was cleared for safety; paste the key again.`));
            secret.input.focus();
          }
        });
      },
    },
    field("API key or secret", secret.wrap, { id: "key-value", hint: "Recognised from its prefix where possible. Paste it; it is never shown again." }),
    detected,
    h("div", { class: "fields" }, field("Provider", providerSelect), field("Name", name, { hint: "How Galahad refers to it." })),
    anotherRow,
    addressField,
    field("Label (optional)", label),
    callout("quiet", "Sealed for your full nodes only. Never stored in this browser, never shown again, never seen by a model.", { icon: "shield-check" }),
    status,
    h("div", { class: "row", style: "justify-content:flex-end" }, button("Cancel", { onClick: () => sheet.close() }), seal),
  );

  const sheet = openSheet({
    title: options.name ? `Replace ${options.name}` : "Add a key",
    description: "Seal an API key into the vault, once, for every node.",
    body: form,
    initialFocus: () => secret.input,
    onClose: () => {
      secret.input.value = "";
    },
  });

  syncOptions();
  showAddress();
  if (options.prefill) {
    secret.input.value = options.prefill;
    replace(status, callout("info", "Moved here from your message. It was not sent anywhere. Check the provider, then seal it."));
  }
  onKey();
  loadProviders(ctx)
    .then((loaded) => {
      data = loaded;
      if (sheet.scope.disposed) return;
      syncOptions();
      onKey();
    })
    .catch(() => {
      /* presets need mind:read; manual naming still works */
    });
}

/** Why a subscription's sign-in isn't taken as a key, and where it belongs. */
const signInCallout = (pasted: SignInForm["signIn"]): HTMLElement => callout("warn", pasted.why, { title: `A ${pasted.tool} sign-in, not an API key` });

/** An open request from Galahad for a credential, with an inline sealed field. */
export function secretRequestCard(ctx: Ctx, request: SecretRequestView): HTMLElement {
  const ms = hlcMs(request.requestedAt);
  const secret = secretInput({ label: `Value for ${request.name}` });
  const seal = button("Seal", { variant: "primary", type: "submit", icon: "vault" });
  const status = h("div");
  // A key that no longer matters (or that you won't give): out of the Inbox until he asks for it again.
  const dismiss = ctx.can("vault:write")
    ? button("Dismiss", {
        size: "sm",
        variant: "ghost",
        icon: "x",
        label: `Dismiss: ${request.name}`,
        onClick: (event) =>
          void busy(event.currentTarget as HTMLButtonElement, async () => {
            try {
              await ctx.api.post("/api/secret-requests/dismiss", { name: request.name });
              toast("Dismissed", { description: "It's back only if he asks for it again." });
              await ctx.live.refreshInbox();
            } catch (error) {
              replace(status, callout("danger", errorMessage(error), { title: "Couldn't dismiss it" }));
            }
          }),
      })
    : null;
  return h(
    "article",
    { class: "card accent" },
    h(
      "div",
      { class: "card-body stack" },
      h(
        "div",
        { class: "row top" },
        h("span", { class: "avatar agent" }, icon("mark", { size: 16 })),
        h(
          "div",
          { class: "grow stack tight" },
          h("div", { class: "row wrap" }, h("strong", {}, "Galahad asks for "), h("span", { class: "mono strong" }, request.name), request.provider ? badge(request.provider, "neutral") : null),
          h("p", { class: "small" }, request.purpose),
          h("p", { class: "tiny subtle" }, ms ? `Asked ${relativeTime(ms)}. ` : "", "He'll learn that it exists, never what it is."),
        ),
        dismiss,
      ),
      ctx.can("vault:write")
        ? h(
            "form",
            {
              class: "row",
              autocomplete: "off",
              onsubmit: (event: Event) => {
                event.preventDefault();
                const value = secret.input.value.trim();
                secret.input.value = "";
                if (!value) return;
                void busy(seal, async () => {
                  try {
                    const extra = await sealSecret(ctx, request.name, value, request.provider);
                    toast(`${request.name} sealed`, { tone: "ok", description: extra ?? "Galahad can use it now." });
                    await ctx.live.refreshInbox();
                  } catch (error) {
                    replace(status, callout("danger", `${errorMessage(error)}. Paste it again.`));
                  }
                });
              },
            },
            h("div", { class: "grow" }, secret.wrap),
            seal,
          )
        : callout("quiet", "This device can't fill secret requests (no vault:write scope)."),
      status,
    ),
  );
}

function explainer(unlocked: boolean | null): HTMLElement {
  return h(
    "section",
    { class: "card pad stack", "aria-label": "How keys are kept" },
    h(
      "div",
      { class: "flow", "aria-label": "Your key goes from this browser, sealed, to your full nodes; models never see it" },
      h("span", { class: "node-pill" }, icon("laptop"), "This browser"),
      h("span", { class: "arrow", "aria-hidden": "true" }, "→"),
      h("span", { class: "node-pill" }, icon("vault"), "Sealed for full nodes"),
      h("span", { class: "arrow", "aria-hidden": "true" }, "→"),
      h("span", { class: "node-pill" }, icon("gateway"), "Gateway adds it per call"),
      h("span", { class: "arrow", "aria-hidden": "true" }, "→"),
      h("span", { class: "node-pill" }, icon("models"), h("span", { class: "blocked" }, "Models"), "never see it"),
    ),
    h(
      "p",
      { class: "small muted" },
      "Keys are encrypted for your full nodes and nothing else. They're never stored in this browser and never shown again. Galahad's tools and models get short-lived, scoped gateway tokens, never the key itself.",
    ),
    unlocked === false ? callout("warn", "This node holds no vault grant yet, so it can't use these keys. Another full node can.", { title: "Locked on this node" }) : null,
  );
}

export const vaultView: View = (root, ctx, { scope, opts }) => {
  const write = ctx.can("vault:write");
  const listBox = h("div", { class: "card" }, skeletonRows(3, { avatar: true }));
  const requestsBox = h("div", { class: "stack" });
  const explainerBox = h("div", {}, explainer(null));
  let count = "";
  const listSection = section("Sealed secrets", {
    actions: write
      ? button("Rotate vault key", {
          size: "sm",
          variant: "ghost",
          icon: "refresh",
          onClick: async (event) => {
            // currentTarget is null once we await; keep the button now.
            const trigger = event.currentTarget as HTMLButtonElement;
            const ok = await confirmAction({
              title: "Rotate the vault key?",
              body: "Every secret is re-sealed for the current full nodes. Nodes revoked since the last rotation lose any chance of reading them. Nothing changes at your providers.",
              confirmLabel: "Rotate",
              tone: "primary",
            });
            if (!ok) return;
            await busy(trigger, async () => {
              try {
                const result = await ctx.api.post<{ resealed: string[] }>("/api/vault/rotate", {});
                toast("Vault key rotated", { tone: "ok", description: `${result.resealed.length} secret${result.resealed.length === 1 ? "" : "s"} re-sealed.` });
              } catch (error) {
                toast("Couldn't rotate the vault", { tone: "error", description: errorMessage(error) });
              }
            });
          },
        })
      : null,
  }, listBox);

  async function remove(s: SecretView): Promise<void> {
    const ok = await confirmAction({
      title: `Delete ${s.name}?`,
      body: [
        h("p", {}, "It is removed from the vault on every node. Tools and providers using it stop working until you add a key again."),
        h("p", {}, "This doesn't revoke the key at its provider; do that there if it may have leaked."),
      ],
      confirmLabel: "Delete secret",
      typeToConfirm: s.name,
    });
    if (!ok) return;
    try {
      await ctx.api.post("/api/secrets/delete", { name: s.name });
      vaultChanged.update((n) => n + 1);
      toast(`${s.name} deleted`, { tone: "ok" });
    } catch (error) {
      toast("Couldn't delete it", { tone: "error", description: errorMessage(error) });
    }
  }

  function row(s: SecretView): HTMLElement {
    const ms = hlcMs(s.updatedAt);
    return listRow({
      lead: "key",
      title: h("span", { class: "row wrap" }, h("span", { class: "mono" }, s.name), s.provider ? badge(s.provider, "neutral") : null, s.hint ? h("span", { class: "mono subtle small", title: "Only the last characters are ever shown" }, s.hint) : null),
      meta: [
        s.label ? h("span", {}, s.label) : null,
        // Keys are pinned: shown so you can see exactly where this one may ever go.
        s.origin
          ? h("span", { class: "mono", title: "This key is only ever sent to this host" }, `only to ${s.origin.replace(/^https?:\/\//, "")}`)
          : h("span", { title: "Unpinned keys are never used; replace it to pin it" }, "unpinned · not used"),
        ms ? h("span", { title: new Date(ms).toLocaleString() }, `updated ${relativeTime(ms)}`) : null,
      ],
      trail: write
        ? h(
            "span",
            { class: "row tight reveal" },
            button("Replace", { size: "sm", variant: "ghost", icon: "edit", onClick: () => openAddKey(ctx, { name: s.name, provider: s.provider }) }),
            button(`Delete ${s.name}`, { size: "sm", variant: "ghost", iconOnly: true, icon: "trash", onClick: () => void remove(s) }),
          )
        : null,
    });
  }

  async function refresh(): Promise<void> {
    try {
      const [secrets, requests] = await Promise.all([
        ctx.api.get<{ secrets: SecretView[]; unlocked: boolean }>("/api/secrets", scope.signal),
        ctx.api.get<{ requests: SecretRequestView[] }>("/api/secret-requests", scope.signal),
      ]);
      if (scope.disposed) return;
      replace(explainerBox, explainer(secrets.unlocked));
      replace(
        requestsBox,
        requests.requests.length ? section("Galahad is asking", { count: String(requests.requests.length) }, ...requests.requests.map((r) => secretRequestCard(ctx, r))) : null,
      );
      count = String(secrets.secrets.length);
      listSection.querySelector(".count-label")?.remove();
      listSection.querySelector(".section-head h2")?.after(h("span", { class: "count-label tnum" }, count));
      replace(
        listBox,
        secrets.secrets.length
          ? rows(...secrets.secrets.map(row))
          : empty({
              icon: "vault",
              title: "The vault is empty",
              body: "Add a model provider's key once, and every full node can use it.",
              actions: write ? button("Add a key", { variant: "primary", icon: "plus", onClick: () => openAddKey(ctx) }) : null,
            }),
      );
    } catch (error) {
      if (!scope.disposed) replace(listBox, errorState("Couldn't open the vault", error, () => void refresh()));
    }
  }

  replace(
    root,
    h(
      "div",
      { class: "page narrow" },
      pageHead(
        "Vault",
        "Add a key once and every full node can use it. Keys never come back out.",
        write ? button("Add key", { variant: "primary", icon: "plus", onClick: () => openAddKey(ctx) }) : null,
      ),
      write ? null : callout("quiet", "This device can see secret names, but not add or change keys."),
      // Shown whole once the vault has answered: what he asks for and the explainer came in above the keys, and pushed them.
      pageBody(requestsBox, explainerBox, listSection),
    ),
  );

  scope.add(vaultChanged.subscribe(() => void refresh()));
  void refresh();
  if (opts.prefillKey) openAddKey(ctx, { prefill: opts.prefillKey });
  else if (opts.intent === "add-key") openAddKey(ctx);
};
