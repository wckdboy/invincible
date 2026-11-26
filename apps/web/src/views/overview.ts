import type { FleetView, SecretView, UsageMeter } from "@galahad/core";
import { isUnavailable } from "../api.ts";
import type { View } from "../context.ts";
import { ledgerSignature } from "../lib/activity.ts";
import { greeting } from "../lib/time.ts";
import type { LedgerEntry } from "../types.ts";
import { button, dot, empty, linkButton, pageBody, pageHead, section, skeletonRows, skeletonStat, statTile } from "../ui/controls.ts";
import { h, keepPlace, replace } from "../ui/dom.ts";
import { ledgerItem } from "./activity.ts";
import { inHandSection } from "./in-hand.ts";
import { meterSlot, usageTile } from "./usage-meter.ts";
import { doctorSection } from "./doctor-card.ts";
import { startNewChat } from "./chat.ts";
import { isOnline, openInvite } from "./fleet.ts";
import { openAddKey, vaultChanged } from "./vault.ts";

/*
 * Is everything well, does anything need me, what has Galahad been doing: the figures, what he has in hand, what he did
 * lately, and the doctor's look. Each node's health is the Fleet's (a tile goes there), the oath's autonomy is Activity's.
 */

export const overviewView: View = (root, ctx, { scope }) => {
  const stats = h("div", { class: "grid stats" }, skeletonStat(), skeletonStat(), skeletonStat(), skeletonStat());
  const recent = h("div", { class: "card" }, skeletonRows(4));
  const lede = ctx.whoami.fleetName ? `Fleet ${ctx.whoami.fleetName}, through ${ctx.whoami.nodeName}.` : `Through ${ctx.whoami.nodeName}.`;
  let vault: { count: number; unlocked: boolean } | null = null;
  /** This period's meter; null until it answers; "none" from a node from before the meter. */
  let usage: UsageMeter | null | "none" = null;
  let ledgerMissing = false;
  let ledgerSeen = "";

  function renderStats(fleet: FleetView | null): void {
    const tiles: HTMLElement[] = [];
    // Every tile keeps its place while what it says loads, as the Vault's and the meter's do: put in once its part had
    // answered, a tile made a new row of them on a laptop and moved everything under it (the PWA's layout bench, on a
    // machine busy with other work, 22 November 2026: the Roundtable answered after the page was there).
    const waiting = (label: string, icon: "server" | "memory" | "user") => statTile({ label, icon, value: "–", note: "loading…" });
    if (!fleet && ctx.can("mind:read")) tiles.push(waiting("Nodes online", "server"));
    if (fleet) {
      const nodes = fleet.devices.filter((d) => d.kind === "node" && !d.revokedAt);
      const online = nodes.filter((d) => isOnline(fleet, d)).length;
      tiles.push(
        statTile({
          label: "Nodes online",
          icon: "server",
          value: [String(online), h("span", { class: "of" }, ` / ${nodes.length}`)],
          note: online === nodes.length ? [dot("ok"), "all well"] : [dot("warn"), `${nodes.length - online} offline`],
          href: "#/fleet",
        }),
      );
    }
    const inbox = ctx.live.inboxCount.value;
    tiles.push(statTile({ label: "Inbox", icon: "inbox", value: String(inbox), note: inbox ? [dot("accent"), "waiting for you"] : "nothing needs you", href: "#/inbox" }));
    if (ctx.can("vault:read")) {
      tiles.push(
        statTile({
          label: "Vault",
          icon: "vault",
          value: vault ? String(vault.count) : "–",
          note: vault ? (vault.unlocked ? [dot("ok"), "sealed keys, usable here"] : [dot("warn"), "locked on this node"]) : "loading…",
          href: "#/vault",
        }),
      );
    }
    // What this period's model calls came to against your budget (a node from before the meter has none to say). Its
    // place is kept while it loads, as the Vault's is: a tile put in once it answers moved the ones after it.
    if (usage && usage !== "none") tiles.push(usageTile(ctx, usage, (next) => { usage = next; renderStats(ctx.live.fleet.value); }));
    else if (usage === null && ctx.can("mind:read")) tiles.push(statTile({ label: "Usage", icon: "gauge", value: "–", note: ["loading…", meterSlot()] }));
    if (fleet) tiles.push(statTile({ label: "Mind", icon: "memory", value: fleet.events.toLocaleString(), note: "events in the shared mind", href: "#/memory" }));
    else if (ctx.can("mind:read")) tiles.push(waiting("Mind", "memory"));
    // The mandate's north star (#28): how often you stepped in on the knights' work, per task done and verified. Said
    // whenever the Roundtable can be, a dash while no task has ended, so its tile is there from the start.
    const team = ctx.live.team.value;
    const star = team?.northStar;
    if (star?.ended) {
      tiles.push(
        statTile({
          label: "You stepped in",
          icon: "user",
          value: star.perCompleted === null ? String(star.interventions) : star.perCompleted.toFixed(1),
          note: star.perCompleted === null ? "times, and no task done yet (30 days)" : `times a task done: ${star.completed} in 30 days`,
          href: "#/team",
        }),
      );
    } else if (team) tiles.push(statTile({ label: "You stepped in", icon: "user", value: "–", note: "no knight's task has ended in 30 days", href: "#/team" }));
    else if (ctx.can("chat") && !ctx.live.teamProblem.value) tiles.push(waiting("You stepped in", "user"));
    replace(stats, ...tiles);
  }

  async function loadUsage(): Promise<void> {
    if (!ctx.can("mind:read")) return;
    try {
      usage = await ctx.api.get<UsageMeter>("/api/usage/meter", scope.signal);
      if (!scope.disposed) renderStats(ctx.live.fleet.value);
    } catch {
      // No tile: a node from before the meter.
      usage = "none";
      if (!scope.disposed) renderStats(ctx.live.fleet.value);
    }
  }

  async function loadVault(): Promise<void> {
    if (!ctx.can("vault:read")) return;
    try {
      const result = await ctx.api.get<{ secrets: SecretView[]; unlocked: boolean }>("/api/secrets", scope.signal);
      vault = { count: result.secrets.length, unlocked: result.unlocked };
      if (!scope.disposed) renderStats(ctx.live.fleet.value);
    } catch {
      /* the tile shows a dash */
    }
  }

  function showLedger(entries: LedgerEntry[]): void {
    if (scope.disposed) return;
    // Nothing new since the last look: leave the cards as they are.
    const seen = ledgerSignature(entries);
    if (seen === ledgerSeen) return;
    ledgerSeen = seen;
    const latest = [...entries].sort((a, b) => (a.hlc < b.hlc ? 1 : -1)).slice(0, 8);
    replace(
      recent,
      latest.length
        ? h("div", { class: "timeline" }, ...latest.map((e) => ledgerItem(ctx, e, true)))
        : empty({ icon: "activity", title: "Quiet so far", body: "What Galahad creates, changes or sends will show up here.", compact: true }),
    );
  }

  async function loadLedger(): Promise<void> {
    if (ledgerMissing) return;
    if (!ctx.can("mind:read")) {
      replace(recent, empty({ icon: "activity", title: "Activity needs the mind:read scope", compact: true }));
      return;
    }
    try {
      // What it showed last time this session, at once (api.peek); then the fresh answer.
      const last = ledgerSeen ? null : ctx.api.peek<{ entries: LedgerEntry[] }>("/api/ledger");
      if (last) showLedger(last.entries);
      showLedger((await ctx.api.get<{ entries: LedgerEntry[] }>("/api/ledger", scope.signal)).entries);
    } catch (error) {
      if (scope.disposed) return;
      ledgerSeen = "";
      if (isUnavailable(error)) ledgerMissing = true;
      replace(
        recent,
        empty({
          icon: "scroll",
          title: isUnavailable(error) ? "The ledger arrives with an upcoming update" : "Couldn't read recent activity",
          body: isUnavailable(error) ? "The oath already gates every action; soon you'll see each one here." : String((error as Error).message ?? error),
          compact: true,
        }),
      );
    }
  }

  const actions = [
    ctx.can("chat")
      ? button("New chat", {
          variant: "primary",
          icon: "chat",
          onClick: () => {
            startNewChat();
            ctx.navigate("chat");
          },
        })
      : null,
    ctx.can("vault:write") ? button("Add key", { icon: "key", onClick: () => openAddKey(ctx) }) : null,
    ctx.can("fleet:admin") ? button("Pair device", { icon: "phone", onClick: () => openInvite(ctx, "client") }) : null,
  ];

  replace(
    root,
    h(
      "div",
      { class: "page" },
      pageHead(`${greeting()}.`, lede, actions),
      // Shown whole once its parts have answered: what he has in hand comes first, and would push the rest down.
      pageBody(
        stats,
        h(
          "div",
          { class: "two-col" },
          h(
            "div",
            { class: "stack loose" },
            // What he's working on now: the turns the node is running, and the quests in hand with their plan and gates.
            inHandSection(ctx, scope),
            section("Recent activity", { actions: linkButton("View all", "#/activity", { variant: "ghost", size: "sm", next: true }) }, recent),
          ),
          // Is everything well on the node you're talking to: a quick look by the doctor, and a full check when you ask.
          h("div", { class: "stack loose" }, doctorSection(ctx, scope)),
        ),
      ),
    ),
  );

  scope.add(
    ctx.live.fleet.watch((fleet) => keepPlace(root, () => renderStats(fleet))),
  );
  scope.add(ctx.live.inboxCount.subscribe(() => renderStats(ctx.live.fleet.value)));
  scope.add(ctx.live.team.subscribe(() => keepPlace(root, () => renderStats(ctx.live.fleet.value))));
  // (Its tile waits for the Roundtable, which a phone doesn't watch from here: asked once, and a failure takes the tile.)
  scope.add(ctx.live.teamProblem.subscribe(() => keepPlace(root, () => renderStats(ctx.live.fleet.value))));
  if (ctx.can("chat") && !ctx.live.team.value) void ctx.live.refreshTeam();
  scope.add(vaultChanged.subscribe(() => void loadVault()));
  void loadVault();
  void loadUsage();
  // Its numbers move as calls are made: looked at again each minute while the page is open.
  const usageTimer = setInterval(() => void loadUsage(), 60_000);
  scope.add(() => clearInterval(usageTimer));
  void loadLedger();
  scope.interval(() => void loadLedger(), 15_000);
  // The mind's count of events moves with every one of them: the live stream doesn't tell of it, so it is asked for
  // while this page shows it, as often as the app asked for the fleet before there was a stream.
  scope.interval(() => void ctx.live.refreshFleet(), 10_000);
};
