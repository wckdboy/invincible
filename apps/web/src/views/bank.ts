import type { BankStatusView } from "@galahad/core";
import { isUnavailable } from "../api.ts";
import { type Ctx, errorMessage, type View } from "../context.ts";
import { type BankCallback, budgetLabel, consentLeft, offReason } from "../lib/bank.ts";
import { isGrantArm } from "../lib/grants.ts";
import { badge, busy, button, callout, empty, errorState, meter, pageHead, section, skeletonRows, spinner, switchControl } from "../ui/controls.ts";
import { confirmAction } from "../ui/dialog.ts";
import { h, replace } from "../ui/dom.ts";
import { icon } from "../ui/icons.ts";
import { toast } from "../ui/toast.ts";

/*
 * Bank: your own accounts, read-only, through Enable Banking. Here you authorise
 * Galahad at the bank (and again every 89 days), see what's connected, and choose
 * which agents may read it. Agents can't do any of this: authorising needs
 * fleet:admin, which no agent can hold. Balances and transactions aren't shown here;
 * agents you allow read them through their bank tools.
 */

/** What the bank's redirect brought back, handed over by the boot (in memory only, read once). */
let returned: BankCallback | null = null;
export const handBankCallback = (callback: BankCallback): void => {
  returned = callback;
};

interface ArmView {
  label: string;
  scopes: string[];
}

export const bankView: View = (root, ctx, { scope }) => {
  const admin = ctx.can("fleet:admin");
  const status = h("div", { class: "stack" }, h("div", { class: "card" }, skeletonRows(3)));
  const outcome = h("div");
  const agents = h("div");

  async function finish(callback: BankCallback): Promise<void> {
    if (callback.error || !callback.code || !callback.state) {
      replace(outcome, callout("danger", callback.error ?? "The bank sent you back without an authorisation code.", { title: "Not connected" }));
      return;
    }
    replace(outcome, callout("info", h("span", { class: "row" }, spinner("sm"), "Confirming with the bank…")));
    try {
      const done = await ctx.api.post<{ accounts: number; ibans: string[]; validUntil: string }>("/api/bank/complete", { code: callback.code, state: callback.state }, scope.signal);
      replace(outcome, callout("ok", `${done.accounts} account${done.accounts === 1 ? "" : "s"} (${done.ibans.join(", ")}), read-only, until ${new Date(done.validUntil).toLocaleDateString()}.`, { title: "Connected" }));
      void refresh();
    } catch (error) {
      replace(outcome, callout("danger", errorMessage(error), { title: "Not connected" }));
    }
  }

  async function connect(trigger: HTMLButtonElement): Promise<void> {
    const ok = await confirmAction({
      title: "Authorise Galahad at your bank?",
      body: [
        h("p", {}, "You'll go to your bank's page to sign in and allow read-only access to your accounts' balances and transactions for 89 days. Nothing can move money."),
        h("p", { class: "small muted" }, "Do this in the browser that finishes it: the bank sends you back here, to this device. On an iPhone, use Safari (paired), not the Home Screen app, which can't receive the return."),
      ],
      confirmLabel: "Go to the bank",
      tone: "primary",
    });
    if (!ok) return;
    await busy(trigger, async () => {
      try {
        const { url } = await ctx.api.post<{ url: string }>("/api/bank/connect", {}, scope.signal);
        if (!/^https:\/\//.test(url)) throw new Error("the bank's address isn't https");
        location.assign(url);
      } catch (error) {
        replace(outcome, callout("danger", errorMessage(error), { title: "Couldn't start" }));
      }
    });
  }

  async function disconnect(trigger: HTMLButtonElement): Promise<void> {
    const ok = await confirmAction({
      title: "Disconnect the bank?",
      body: [h("p", {}, "The consent ends at the bank, and the session and cached data are forgotten here. Agents lose bank access until you connect again.")],
      confirmLabel: "Disconnect",
      tone: "danger",
    });
    if (!ok) return;
    await busy(trigger, async () => {
      try {
        const { ended } = await ctx.api.post<{ ended: boolean }>("/api/bank/disconnect", {}, scope.signal);
        toast(ended ? "Disconnected" : "Forgotten here", { tone: "info", description: ended ? "The bank ended the consent." : "The bank didn't confirm; the consent expires on its own." });
        void refresh();
      } catch (error) {
        replace(outcome, callout("danger", errorMessage(error), { title: "Couldn't disconnect" }));
      }
    });
  }

  function render(s: BankStatusView): void {
    const connected = s.accounts.length > 0 && !s.reauthorizationRequired;
    const actions = admin
      ? h(
          "div",
          { class: "row wrap" },
          s.configured && !s.problem ? button(connected ? "Re-authorize" : `Connect ${s.aspsp ?? "the bank"}`, { variant: connected ? "default" : "primary", icon: "link", onClick: (e) => void connect(e.currentTarget as HTMLButtonElement) }) : null,
          connected ? button("Disconnect", { variant: "danger", icon: "x", onClick: (e) => void disconnect(e.currentTarget as HTMLButtonElement) }) : null,
        )
      : null;
    replace(
      status,
      h(
        "div",
        { class: "card" },
        h(
          "div",
          { class: "card-body stack" },
          h(
            "div",
            { class: "row wrap" },
            h("span", { class: "avatar" }, icon("bank", { size: 14 })),
            h("span", { class: "strong" }, s.aspsp ?? "Your bank"),
            s.problem ? badge("off", "danger", "alert") : connected ? badge("connected", "ok", "check") : badge(s.configured ? "not connected" : "not set up", "warn"),
          ),
          // Off: the node's reason, once, with what it means (not "off" three times over).
          s.problem
            ? callout("warn", [offReason(s.message), " Agents can't read the bank while it's off", admin ? h("span", {}, "; ", h("span", { class: "mono" }, "galahad bank status"), " on the node says more.") : "."], { title: "Bank access is off on this node" })
            : h("p", { class: "small" }, s.message),
          connected && s.daysRemaining !== null
            ? h("div", { class: "stack tight" }, meter(consentLeft(s), s.daysRemaining > 14 ? "var(--ok)" : "var(--warn)", "Consent left"), h("span", { class: "tiny subtle" }, `${s.daysRemaining} day${s.daysRemaining === 1 ? "" : "s"} left, until ${new Date(s.validUntil!).toLocaleDateString()}`))
            : null,
          !s.configured && !s.problem && admin ? callout("quiet", h("span", {}, "Set up on the node first: ", h("span", { class: "mono" }, "galahad bank setup --app-id … --key … --redirect-url …"), ". See docs/BANK.md.")) : null,
          actions,
        ),
      ),
      s.accounts.length
        ? section(
            "Accounts",
            { count: String(s.accounts.length) },
            h(
              "div",
              { class: "card" },
              h(
                "div",
                { class: "rows" },
                ...s.accounts.map((a) => {
                  const b = s.budget.find((x) => x.account === a.uid);
                  return h(
                    "div",
                    { class: "item" },
                    h("span", { class: "avatar" }, icon("vault", { size: 14 })),
                    h("div", { class: "grow" }, h("div", { class: "row wrap" }, h("span", { class: "strong small" }, a.name || "Account"), h("span", { class: "mono small" }, a.iban ?? ""), a.currency ? h("span", { class: "tiny subtle" }, a.currency) : null), b ? h("div", { class: "meta" }, h("span", {}, budgetLabel(b))) : null),
                  );
                }),
              ),
            ),
          )
        : null,
    );
  }

  async function refresh(): Promise<void> {
    try {
      render(await ctx.api.get<BankStatusView>("/api/bank/status", scope.signal));
    } catch (error) {
      if (scope.disposed) return;
      replace(
        status,
        isUnavailable(error)
          ? empty({ icon: "bank", title: "Bank access isn't available on this node yet", body: "It arrives with an update.", compact: true })
          : errorState("Couldn't load the bank's status", error, () => void refresh()),
      );
    }
  }

  async function loadAgents(): Promise<void> {
    if (!admin) return;
    try {
      // A Q-AMP grant's arm holds its tools' scopes and nothing else (the node refuses more): never one to give the bank.
      const arms = (await ctx.api.get<{ arms: ArmView[] }>("/api/arms", scope.signal)).arms.filter((arm) => !isGrantArm(arm.label));
      replace(
        agents,
        section(
          "Agents that may read it",
          {},
          arms.length
            ? h(
                "div",
                { class: "card" },
                h(
                  "div",
                  { class: "card-body stack" },
                  ...arms.map((arm) =>
                    switchControl(
                      h("span", { class: "mono" }, arm.label),
                      arm.scopes.includes("bank:read"),
                      (on) =>
                        void ctx.api
                          .post("/api/arms/grant", on ? { label: arm.label, add: ["bank:read"] } : { label: arm.label, remove: ["bank:read"] }, scope.signal)
                          .then(() => toast(on ? `${arm.label} may read the bank` : `${arm.label} can no longer read the bank`, { tone: "info", description: "It applies when the agent's MCP server next starts." }))
                          .catch((error: unknown) => toast("Couldn't change it", { tone: "error", description: errorMessage(error) })),
                      { hint: "Balances and transactions, read-only, cached, a few bank fetches a day." },
                    ),
                  ),
                ),
              )
            : h("p", { class: "small muted" }, "No agents connected yet (galahad mcp install …)."),
        ),
      );
    } catch {
      replace(agents);
    }
  }

  replace(
    root,
    h(
      "div",
      { class: "page narrow" },
      pageHead("Bank", "Your own accounts, read-only, through Enable Banking: balances and transactions for the agents you allow. Nothing here can move money."),
      outcome,
      status,
      agents,
    ),
  );
  if (returned) {
    const callback = returned;
    returned = null;
    void finish(callback);
  }
  void refresh();
  void loadAgents();
  scope.interval(() => void refresh(), 60_000);
};
