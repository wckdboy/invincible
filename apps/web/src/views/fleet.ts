import type { ComputeNodeView, ComputeView, DeviceView, FleetView, PairingView, PeerStatus, QampGrantView } from "@galahad/core";
import { isAbort } from "../api.ts";
import { capacityBlock, computeBody, slotsTile } from "./fleet-compute.ts";
import { encodeQr, qrPath } from "@galahad/core/qr";
import { type Ctx, errorMessage, type View } from "../context.ts";
import { grantEnds, shortDid } from "../lib/grants.ts";
import { makesSandboxes } from "../lib/sandbox.ts";
import { gb, plural, shortId } from "../lib/text.ts";
import { countdown, hlcMs, relativeTime } from "../lib/time.ts";
import { type AnyScope, asCaps, type Caps, type InviteResponse, type PlacementResult } from "../types.ts";
import {
  badge,
  busy,
  button,
  callout,
  copyField,
  disclosure,
  dot,
  empty,
  errorState,
  listRow,
  meter,
  note as noteLine,
  pageBody,
  pageHead,
  rows,
  rangeControl,
  sasCode,
  section,
  segmented,
  skeletonBlock,
  skeletonRows,
  skeletonStat,
  spinner,
  statTile,
} from "../ui/controls.ts";
import { confirmAction, openSheet } from "../ui/dialog.ts";
import { type Child, debounce, h, keepPlace, replace, type Scope } from "../ui/dom.ts";
import { icon, type IconName } from "../ui/icons.ts";
import { toast } from "../ui/toast.ts";

/* Every body that shares the one mind: nodes (and what each can carry), client devices, pairing, placement. */

export const SCOPE_INFO: { scope: AnyScope; label: string }[] = [
  { scope: "chat", label: "Talk to Galahad" },
  { scope: "mind:read", label: "Read memory, fleet, models and activity" },
  { scope: "mind:write", label: "Remember and forget" },
  { scope: "vault:read", label: "See secret names (never values)" },
  { scope: "vault:write", label: "Add, replace and delete keys" },
  { scope: "brain:write", label: "Change providers, the roster, loops and connectors" },
  { scope: "gateway:mint", label: "Mint scoped model-gateway tokens" },
  { scope: "fleet:admin", label: "Invite, approve and revoke devices; decide approvals; dismiss alerts" },
  { scope: "sandbox", label: "Create and use sandboxes" },
  { scope: "connect", label: "Run connector tools (never see their keys)" },
];

export function peerOf(fleet: FleetView, id: string): PeerStatus | undefined {
  return fleet.peers.find((p) => p.device === id);
}

export function isOnline(fleet: FleetView, d: DeviceView): boolean {
  return d.id === fleet.self || Boolean(peerOf(fleet, d.id)?.online);
}

export function capChips(caps: Caps | null): HTMLElement[] {
  if (!caps) return [h("span", { class: "chip" }, icon("info"), "No capability profile yet")];
  const chip = (iconName: IconName, text: string, on = false, title?: string) => h("span", { class: `chip${on ? " on" : ""}`, title: title ?? null }, icon(iconName), text);
  const out: HTMLElement[] = [];
  if (caps.os) out.push(chip("monitor", `${caps.os}/${caps.arch ?? "?"}`));
  if (caps.cores) out.push(chip("cpu", `${caps.cores} cores`, false, caps.cpu));
  if (caps.memoryGb) out.push(chip("ram", gb(caps.memoryGb)));
  for (const g of caps.gpu ?? []) out.push(chip("zap", g.memoryGb ? `${g.name} · ${gb(g.memoryGb)}` : g.name, true));
  if (caps.docker) out.push(chip("sandbox", "Docker", true));
  if (caps.vm?.kvm) out.push(chip("layers", "KVM", true));
  else if (caps.vm?.tools.length) out.push(chip("layers", caps.vm.tools.join(", "), true));
  const models = (caps.localModels ?? []).flatMap((r) => r.models);
  if (models.length) out.push(chip("models", `${plural(models.length, "local model")}`, true, models.join(", ")));
  if (makesSandboxes(caps)) out.push(chip("shield-check", "Sandbox-ready", true));
  if (caps.sandbox?.engine === "container") out.push(chip("shield", "VMs (Apple's container)", true, "Every sandbox is a VM of its own, through Apple's container. A running VM pauses to take more, and none is made with no network at all."));
  else if (caps.sandbox?.vm) out.push(chip("shield", "microVMs", true, "Sandboxes can run in their own KVM microVM, with their own kernel (Kata)"));
  if (caps.hasBattery) out.push(chip("battery", "Battery"));
  return out;
}

function statusLine(fleet: FleetView, d: DeviceView): HTMLElement {
  if (d.id === fleet.self) return h("span", { class: "row tight" }, dot("ok", { live: true }), "online · serving you");
  const peer = peerOf(fleet, d.id);
  if (peer?.online) return h("span", { class: "row tight tnum" }, dot("ok", { live: true }), `online${peer.rttMs !== null ? ` · ${peer.rttMs} ms` : ""}`);
  return h(
    "span",
    { class: "row tight", title: peer?.error ?? "" },
    dot(null),
    peer?.lastSeen ? `offline · seen ${relativeTime(peer.lastSeen)}` : "offline",
  );
}

async function revoke(ctx: Ctx, d: DeviceView): Promise<void> {
  const ok = await confirmAction({
    title: `Revoke ${d.name}?`,
    body:
      d.kind === "node"
        ? [
            h("p", {}, "It's removed from the fleet and the vault is rotated, so it can't read anything written from now on."),
            h("p", {}, "It could read the keys in the vault until now: rotate those at their providers too."),
          ]
        : h("p", {}, "It will no longer be able to reach Galahad. Pairing it again needs a fresh invite."),
    confirmLabel: "Revoke device",
    typeToConfirm: d.name,
  });
  if (!ok) return;
  try {
    const result = await ctx.api.post<{ resealed?: string[] }>("/api/devices/revoke", { device: d.id, reason: "revoked from the PWA" });
    toast(`${d.name} revoked`, {
      tone: "ok",
      description: result.resealed?.length ? `Rotate these at their providers: ${result.resealed.join(", ")}` : undefined,
      duration: result.resealed?.length ? 0 : undefined,
    });
    await ctx.live.refreshFleet();
  } catch (error) {
    toast("Couldn't revoke it", { tone: "error", description: errorMessage(error) });
  }
}

function nodeCard(ctx: Ctx, fleet: FleetView, d: DeviceView, compute: ComputeNodeView | null, changed: () => void): HTMLElement {
  const caps = asCaps(d.caps);
  const peer = peerOf(fleet, d.id);
  const presence = peer?.presence ?? null;
  const self = d.id === fleet.self;
  const loads: Child[] = [];
  if (presence && caps?.cores) {
    const load = Math.min(1, presence.load / (presence.cores || caps.cores));
    loads.push(
      h("div", {}, h("div", { class: "load-label" }, h("span", {}, "CPU load"), h("span", {}, `${Math.round(load * 100)}%`)), meter(load, load > 0.85 ? "var(--warn)" : undefined, "CPU load")),
    );
  }
  if (presence && caps?.memoryGb) {
    const used = 1 - presence.freeMemoryGb / caps.memoryGb;
    loads.push(
      h("div", {}, h("div", { class: "load-label" }, h("span", {}, "Memory"), h("span", {}, `${gb(presence.freeMemoryGb)} free`)), meter(used, used > 0.9 ? "var(--warn)" : undefined, "Memory used")),
    );
  }
  const joined = hlcMs(d.enrolledAt);
  return h(
    "article",
    { class: "card node-card", "aria-label": d.name },
    h(
      "div",
      { class: "node-head" },
      h("span", { class: "node-icon" }, icon(caps?.hasBattery ? "laptop" : "server")),
      h(
        "div",
        { class: "grow" },
        h("div", { class: "row wrap" }, h("span", { class: "node-name" }, d.name), self ? badge("this node", "accent") : null, d.role !== "full" ? badge(d.role) : null),
        h("div", { class: "node-sub" }, statusLine(fleet, d), presence?.onBattery ? badge(`on battery${presence.batteryPercent !== null ? ` · ${presence.batteryPercent}%` : ""}`, "warn", "battery") : null),
      ),
      ctx.can("fleet:admin") && !self ? button(`Revoke ${d.name}`, { variant: "ghost", size: "sm", iconOnly: true, icon: "logout", onClick: () => void revoke(ctx, d) }) : null,
    ),
    h(
      "div",
      { class: "node-body" },
      h("div", { class: "chips" }, ...capChips(caps)),
      loads.length ? h("div", { class: "loads" }, ...loads) : null,
      // What it measured, the ceiling he may not pass, and its slots in use and waiting.
      compute ? capacityBlock(ctx, compute, changed) : null,
      h("div", { class: "tiny subtle row wrap" }, d.endpoint ? h("span", { class: "mono" }, d.endpoint) : null, h("span", { class: "mono" }, shortId(d.id)), joined ? h("span", {}, `joined ${relativeTime(joined)}`) : null),
    ),
  );
}

function clientRow(ctx: Ctx, fleet: FleetView, d: DeviceView): HTMLElement {
  const me = d.id === ctx.identity.device;
  const joined = hlcMs(d.enrolledAt);
  const revokedAt = d.revokedAt ? hlcMs(d.revokedAt) : null;
  const all = SCOPE_INFO.filter((s) => s.scope !== "sandbox").every((s) => d.scopes.includes(s.scope as never));
  return listRow({
    lead: /iPhone|Android|iPad/.test(d.name) ? "phone" : "laptop",
    title: h("span", { class: "row wrap" }, d.name, me ? badge("this browser", "accent") : null, d.revokedAt ? badge("revoked", "danger") : null),
    meta: [
      h("span", { title: d.scopes.join(", ") }, all ? "all scopes" : d.scopes.join(" · ") || "no scopes"),
      joined ? h("span", {}, `joined ${relativeTime(joined)}`) : null,
      revokedAt ? h("span", {}, `revoked ${relativeTime(revokedAt)}`) : null,
    ],
    trail:
      ctx.can("fleet:admin") && !d.revokedAt && d.id !== fleet.self
        ? h("span", { class: "reveal" }, button(me ? "Revoke this browser" : `Revoke ${d.name}`, { variant: "ghost", size: "sm", icon: "logout", label: `Revoke ${d.name}`, onClick: () => void revoke(ctx, d) }))
        : null,
  });
}

/** A pending pairing, with its code. Approving a machine asks once more: it receives the vault. */
/** A pending pairing, with its code. Outcome feedback is shown inline (the card may live in a sheet). */
export function pairingCard(ctx: Ctx, p: PairingView, onDone?: (outcome: "approved" | "rejected") => void): HTMLElement {
  const node = p.kind === "node";
  const note = h("div");
  const approve = button("Codes match: approve", { variant: "primary", icon: "check", disabled: p.conflict });
  const reject = button("Reject", { variant: "danger", icon: "x" });
  approve.addEventListener("click", async () => {
    if (node) {
      const ok = await confirmAction({
        title: `Approve ${p.name} as a full node?`,
        body: [h("p", {}, "A full node receives every key in the vault and a full copy of the mind."), h("p", {}, `Approve only if ${p.name} showed ${p.sas}.`)],
        confirmLabel: "Approve machine",
        tone: "primary",
      });
      if (!ok) return;
    }
    await busy(approve, async () => {
      try {
        await ctx.api.post("/api/pairings/approve", { invite: p.invite, device: p.device });
        if (onDone) onDone("approved");
        else toast(`${p.name} has joined the fleet`, { tone: "ok" });
        await Promise.all([ctx.live.refreshInbox(), ctx.live.refreshFleet()]);
      } catch (error) {
        replace(note, callout("danger", errorMessage(error), { title: "Couldn't approve" }));
      }
    });
  });
  reject.addEventListener("click", () =>
    void busy(reject, async () => {
      try {
        await ctx.api.post("/api/pairings/reject", { invite: p.invite, device: p.device });
        if (onDone) onDone("rejected");
        else toast(`${p.name} was turned away`);
        await ctx.live.refreshInbox();
      } catch (error) {
        replace(note, callout("danger", errorMessage(error), { title: "Couldn't reject" }));
      }
    }),
  );
  return h(
    "article",
    { class: `card ${p.conflict ? "danger" : "accent"}`, "aria-label": `${p.name} asks to join` },
    h(
      "div",
      { class: "card-body stack" },
      h(
        "div",
        { class: "row top" },
        h("span", { class: "avatar" }, icon(node ? "server" : "phone", { size: 16 })),
        h(
          "div",
          { class: "grow" },
          h("div", { class: "strong" }, `${p.name} asks to join`),
          h("div", { class: "tiny subtle" }, node ? "A machine. It would become a full node." : "A phone or browser.", ` Asked ${relativeTime(p.requestedAt)}.`),
        ),
      ),
      sasCode(p.sas),
      p.conflict
        ? callout("danger", "Two devices used this invite. It may have been intercepted: reject, then create a new invite.", { title: "Possible interception" })
        : node
          ? callout(
              "info",
              h(
                "span",
                {},
                "A new machine receives the whole vault, so it's approved from a terminal on an existing node, never from a phone. There, run ",
                h("code", {}, "galahad pairings"),
                ", check this same code, then approve. You can still reject it here.",
              ),
              { title: "Approve machines from a terminal" },
            )
          : h("p", { class: "small muted centered" }, `Approve only if ${p.name} shows exactly this code.`),
      h("div", { class: "row wrap centered" }, ...(node ? [reject] : [reject, approve])),
      note,
    ),
  );
}

// An invite can carry only what this device holds (the node refuses more), so only those are offered.
const KNOWN_SCOPES = (ctx: Ctx) => SCOPE_INFO.filter((s) => ctx.can(s.scope));

/** An invite link as a QR code a phone's camera opens: black on white with its quiet zone, built as DOM (no markup strings). */
function inviteQr(url: string): HTMLElement {
  const code = encodeQr(url, "M");
  const side = code.size + 8;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${side} ${side}`);
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("aria-hidden", "true");
  const paper = document.createElementNS(ns, "rect");
  paper.setAttribute("width", String(side));
  paper.setAttribute("height", String(side));
  paper.setAttribute("fill", "#fff");
  const ink = document.createElementNS(ns, "path");
  ink.setAttribute("d", qrPath(code, 4));
  ink.setAttribute("fill", "#000");
  svg.append(paper, ink);
  const box = h("div", { class: "invite-qr", role: "img", "aria-label": "A QR code of the invite link: scan it with the new device's camera" });
  box.append(svg);
  return box;
}

export function openInvite(ctx: Ctx, initialKind: "client" | "node" = "client"): void {
  if (!ctx.can("fleet:admin")) {
    toast("This device can't invite others", { tone: "warn", description: "It needs the fleet:admin scope." });
    return;
  }
  let kind = initialKind;
  let access: "owner" | "limited" | "custom" = "owner";
  const chosen = new Set<AnyScope>(["chat", "mind:read"]);
  const body = h("div", { class: "stack loose" });
  const sheetTitle = () => (kind === "client" ? "Pair a phone or browser" : "Add a machine");

  const sheet = openSheet({ title: sheetTitle(), description: "Invites work once and expire in ten minutes.", body });
  const titleEl = sheet.el.querySelector("h2");
  const pending = h("div", { class: "stack", "aria-live": "polite" });
  const note = h("div");
  let inviteScope: Scope | null = null;
  let outcome: { name: string; result: "approved" | "rejected" } | null = null;

  function scopesFor(): AnyScope[] | undefined {
    if (kind !== "client" || access === "owner") return undefined;
    if (access === "limited") return ["chat", "mind:read"];
    return [...chosen];
  }

  function chooser(): void {
    inviteScope?.dispose();
    if (titleEl) titleEl.textContent = sheetTitle();
    const kindControl = segmented(
      [
        { value: "client", label: "Phone or browser", icon: "phone" },
        { value: "node", label: "Machine", icon: "server" },
      ],
      kind,
      (value) => {
        kind = value as "client" | "node";
        chooser();
      },
      { label: "What are you adding?", block: true },
    );
    const custom = h(
      "div",
      { class: "scope-list", hidden: access !== "custom" },
      ...KNOWN_SCOPES(ctx).map((s) => {
        const input = h("input", { type: "checkbox", checked: chosen.has(s.scope) });
        input.addEventListener("change", () => (input.checked ? chosen.add(s.scope) : chosen.delete(s.scope)));
        return h("label", { class: "scope" }, input, h("span", {}, h("div", { class: "scope-name" }, s.scope), h("div", { class: "tiny subtle" }, s.label)));
      }),
    );
    const accessControl = segmented(
      [
        { value: "owner", label: "Everything", icon: "shield" },
        { value: "limited", label: "Chat & read", icon: "chat" },
        { value: "custom", label: "Custom", icon: "settings" },
      ],
      access,
      (value) => {
        access = value as typeof access;
        custom.hidden = access !== "custom";
      },
      { label: "What may it do?", block: true },
    );
    const create = button("Create invite", { variant: "primary", icon: "link", block: true });
    create.addEventListener("click", () => void busy(create, createInvite));
    replace(note);
    replace(
      body,
      kindControl.el,
      kind === "client"
        ? h("div", { class: "stack tight" }, h("div", { class: "label" }, "What may it do?"), accessControl.el, custom, h("p", { class: "tiny subtle" }, "Least privilege is wise for phones you carry. You can always pair again with more."))
        : callout("info", "A machine becomes a full node: it holds a copy of the mind and can use the vault. You'll confirm once more when it asks to join.", { icon: "server" }),
      note,
      create,
    );
  }

  async function createInvite(): Promise<void> {
    const scopes = scopesFor();
    if (scopes && !scopes.length) {
      replace(note, callout("warn", "Choose at least one thing it may do."));
      return;
    }
    try {
      const invite = await ctx.api.post<InviteResponse>("/api/invites", { kind, origin: location.origin, ...(scopes ? { scopes } : {}) });
      showInvite(invite, scopes);
    } catch (error) {
      replace(note, callout("danger", errorMessage(error), { title: "Couldn't create an invite" }));
    }
  }

  function showInvite(invite: InviteResponse, scopes: AnyScope[] | undefined): void {
    inviteScope?.dispose();
    inviteScope = sheet.scope.child();
    const ring = h("span", { class: "ring", "aria-hidden": "true" });
    const left = h("span", { class: "tnum" });
    const total = Math.max(1, invite.expiresAt - Date.now());
    const tick = () => {
      const ms = Math.max(0, invite.expiresAt - Date.now());
      ring.style.setProperty("--p", String(ms / total));
      left.textContent = ms ? `Valid for ${countdown(ms)} · single use` : "Expired. Create a new one.";
    };
    tick();
    inviteScope.interval(tick, 1000);
    const value = kind === "client" ? (invite.url ?? invite.invite) : `galahad join ${invite.invite}`;
    replace(
      body,
      h(
        "div",
        { class: "stack tight" },
        h("div", { class: "label" }, kind === "client" ? "Scan this with the phone's camera, or open the link on it" : "Run this on the new machine"),
        kind === "client" && invite.url ? inviteQr(invite.url) : null,
        copyField(value, kind === "client" ? "Copy invite link" : "Copy join command"),
        h("div", { class: "row small muted" }, ring, left),
      ),
      callout("warn", "Treat it like a password. When the device asks to join, its code appears below: approve only if both screens show the same code.", { icon: "shield" }),
      scopes ? noteLine(`It may: ${scopes.join(", ")}`) : null,
      pending,
      h("div", { class: "row between" }, button("Start over", { variant: "ghost", icon: "chevron-left", onClick: chooser }), button("Done", { onClick: () => sheet.close() })),
    );
    outcome = null;
    const renderPending = (list: PairingView[]) => {
      if (outcome) {
        replace(
          pending,
          outcome.result === "approved"
            ? callout("ok", `${outcome.name} has joined the fleet.`, { icon: "shield-check" })
            : callout("quiet", `${outcome.name} was turned away. Create a new invite to try again.`),
        );
        return;
      }
      const mine = list.filter((p) => p.invite === invite.id);
      replace(
        pending,
        ...(mine.length
          ? mine.map((p) =>
              pairingCard(ctx, p, (result) => {
                outcome = { name: p.name, result };
                renderPending(ctx.live.pairings.value);
              }),
            )
          : [h("div", { class: "row small muted centered" }, spinner("sm"), "Waiting for the device…")]),
      );
    };
    inviteScope.add(ctx.live.pairings.watch(renderPending));
    // The device asking to join is told by the node's live stream as it asks; while that is down, asked for faster
    // while someone is in the middle of pairing.
    inviteScope.add(ctx.live.follow([], () => ctx.live.refreshInbox(), 1500));
  }

  chooser();
}

function placementPlayground(ctx: Ctx, scope: Scope): HTMLElement {
  const needs: Record<string, boolean> = {};
  const toggles: [string, string, IconName][] = [
    ["docker", "Docker", "sandbox"],
    ["vm", "VM", "layers"],
    ["gpu", "GPU", "zap"],
    ["localModels", "Local models", "models"],
    ["longRunning", "Long-running", "clock"],
    ["interactive", "Interactive", "user"],
    ["untrusted", "Untrusted input", "alert"],
  ];
  const out = h("div", { class: "place-rank" }, skeletonBlock(48));
  const verdict = h("div", { class: "sr-only", role: "status" });
  let minMemory = 0;
  let seq = 0;

  async function run(): Promise<void> {
    const mine = ++seq;
    const body: Record<string, unknown> = Object.fromEntries(Object.entries(needs).filter(([, v]) => v));
    if (minMemory) body.minMemoryGb = minMemory;
    try {
      const result = await ctx.api.post<PlacementResult>("/api/place", body, scope.signal);
      if (mine !== seq || scope.disposed) return;
      verdict.textContent = result.ranked[0] ? `Best fit: ${result.ranked[0].name}. ${result.rejected.length} ruled out.` : "No machine fits all of that right now.";
      replace(
        out,
        ...result.ranked.map((r, i) =>
          h(
            "div",
            { class: `place-row${i === 0 ? " first" : ""}` },
            h("span", { class: "rank" }, String(i + 1)),
            h("div", { class: "grow stack tight" }, h("div", { class: "row" }, h("span", { class: "strong" }, r.name), i === 0 ? h("span", { class: "best-fit" }, "best fit") : null), r.reasons.length ? h("div", { class: "chips" }, ...r.reasons.map((reason) => h("span", { class: "chip" }, reason))) : null),
            h("span", { class: "mono small tnum", title: "score" }, String(r.score)),
          ),
        ),
        ...result.rejected.map((r) =>
          h("div", { class: "place-row rejected" }, icon("x", { size: 14 }), h("div", { class: "grow" }, h("span", { class: "strong" }, r.name), h("span", { class: "small" }, ` · ${r.reason}`)), h("span", {})),
        ),
        !result.ranked.length ? callout("warn", "No machine fits all of that right now.") : null,
      );
    } catch (error) {
      if (mine === seq && !scope.disposed) replace(out, errorState("Couldn't ask the placer", error, () => void run()));
    }
  }
  const runSoon = debounce(() => void run(), 150);
  scope.add(() => runSoon.cancel());

  const chips = toggles.map(([key, label, iconName]) => {
    const chip = h("button", { class: "chip", type: "button", "aria-pressed": "false" }, icon(iconName), label);
    chip.addEventListener("click", () => {
      needs[key] = !needs[key];
      chip.setAttribute("aria-pressed", String(needs[key]));
      runSoon();
    });
    return chip;
  });
  const memory = rangeControl({
    label: "At least this much memory",
    min: 0,
    max: 128,
    step: 4,
    value: 0,
    format: (v) => (v ? `${v} GB` : "any"),
    onInput: (v) => {
      minMemory = v;
      runSoon();
    },
    scale: ["any", "128 GB"],
  });
  void run();
  return h(
    "div",
    { class: "card pad stack loose", id: "placement" },
    h("div", { class: "stack tight" }, h("h3", {}, "Where would this run?"), h("p", { class: "small muted" }, "Describe a piece of work; Galahad ranks your machines and says why. Nothing runs.")),
    h("div", { class: "chips", role: "group", "aria-label": "The work needs" }, ...chips),
    memory.el,
    out,
    verdict,
  );
}

interface ArmInfo {
  label: string;
  scopes: string[];
  createdAt?: number;
}

/**
 * Agents that hold their own key to Galahad (coding agents over MCP): what each may do, and
 * Revoke, so one can be cut off from any device. Giving one a key stays at a terminal. One on
 * another of your machines is a Q-AMP grant (an arm `qamp.<id>`): its row says whose key it is,
 * what it may call and when it ends, and Revoke ends the grant, its bridge and all.
 */
function agentsSection(ctx: Ctx, scope: Scope): HTMLElement | null {
  if (!ctx.can("fleet:admin")) return null;
  const box = h("div", { class: "card" }, skeletonRows(2, { avatar: true }));
  const count = h("span", { class: "count-label tnum" });

  async function revoke(arm: ArmInfo, grant: QampGrantView | undefined): Promise<void> {
    const ok = await confirmAction({
      title: `Revoke ${arm.label}?`,
      body: h(
        "p",
        {},
        grant
          ? "Its grant ends at once: its key to Galahad is deleted, so the agent's next call is refused, and its bridge stops. To give it again, grant it from a terminal (galahad qamp grant)."
          : "Its key stops working at once: it can no longer read the mind, run sandboxes or use your models. To bring it back, install it again from a terminal.",
      ),
      confirmLabel: "Revoke",
      typeToConfirm: arm.label,
    });
    if (!ok) return;
    try {
      if (grant) await ctx.api.post("/api/qamp/revoke", { id: grant.id }, scope.signal);
      else await ctx.api.post("/api/arms/revoke", { label: arm.label }, scope.signal);
      toast(`${arm.label} can't reach Galahad any more`, { tone: "ok" });
      void load();
    } catch (error) {
      toast("Couldn't revoke it", { tone: "error", description: errorMessage(error) });
    }
  }

  async function load(): Promise<void> {
    try {
      const [{ arms }, grants] = await Promise.all([
        ctx.api.get<{ arms: ArmInfo[] }>("/api/arms", scope.signal),
        // A node from before grants has no such list: none.
        ctx.api.get<{ grants: QampGrantView[] }>("/api/qamp/grants", scope.signal).then(
          (r) => r.grants,
          () => [] as QampGrantView[],
        ),
      ]);
      if (scope.disposed) return;
      const grantOf = new Map(grants.map((g) => [g.label, g]));
      count.textContent = arms.length ? String(arms.length) : "";
      replace(
        box,
        arms.length
          ? rows(
              ...arms.map((arm) => {
                const grant = grantOf.get(arm.label);
                return listRow({
                  lead: grant ? "link" : "terminal",
                  title: h("span", { class: "mono" }, arm.label),
                  meta: grant
                    ? [
                        h("span", { class: "mono", title: grant.agent }, `agent ${shortDid(grant.agent)}`),
                        ...grant.tools.map((t) => h("span", { class: "tag mono" }, t)),
                        h("span", { title: new Date(grant.endsAt).toLocaleString() }, grantEnds(grant.endsAt)),
                      ]
                    : [...arm.scopes.map((s) => h("span", { class: "tag mono" }, s)), arm.createdAt ? h("span", {}, `since ${relativeTime(arm.createdAt)}`) : null],
                  trail: button("Revoke", { size: "sm", variant: "danger", icon: "ban", label: `Revoke ${arm.label}`, onClick: () => void revoke(arm, grant) }),
                });
              }),
            )
          : empty({ icon: "terminal", title: "No agents yet", body: "A coding agent gets Galahad's mind and sandboxes from a terminal on a node.", compact: true }),
      );
    } catch (error) {
      if (!scope.disposed) replace(box, errorState("Couldn't list the agents", error, () => void load()));
    }
  }

  void load();
  const section_ = section(
    "Agents",
    {
      note: [
        "Coding agents with their own key to Galahad. Add one on a node: ",
        h("span", { class: "mono" }, "galahad mcp install claude"),
        " (or opencode, codex, hermes); one on another machine of yours, for a while: ",
        h("span", { class: "mono" }, "galahad qamp grant"),
        ".",
      ],
    },
    box,
  );
  section_.querySelector(".section-head h2")?.after(count);
  return section_;
}

export const fleetView: View = (root, ctx, { scope, opts }) => {
  const admin = ctx.can("fleet:admin");
  const stats = h("div", { class: "grid stats" }, skeletonStat(), skeletonStat(), skeletonStat());
  // One node card's height: most fleets have one or two, side by side on a desktop.
  const nodesBox = h("div", { class: "grid wide" }, skeletonBlock(170));
  const clientsBox = h("div", { class: "card" }, skeletonRows(1, { avatar: true }));
  const revokedBox = h("div");
  const errorBox = h("div");
  // Compute: the census, read beside the fleet and again every few seconds while the page is open.
  const computeBox = h("div", {}, skeletonBlock(96));
  const computeSection = section("Compute", { id: "compute" }, computeBox);
  let compute: ComputeView | null = null;
  let computeKey = "";

  async function loadCompute(): Promise<void> {
    try {
      const next = await ctx.api.get<ComputeView>("/api/compute", scope.signal);
      if (scope.disposed) return;
      // Nothing changed: nothing is redrawn (an open "why", a hovered button stay as they are).
      const key = JSON.stringify(next);
      if (key === computeKey) return;
      computeKey = key;
      compute = next;
      keepPlace(root, () => render(ctx.live.fleet.value));
    } catch (error) {
      if (scope.disposed || isAbort(error)) return;
      // A node from before compute: the page is what it was.
      if (!compute) computeSection.hidden = true;
    }
  }

  function render(fleet: FleetView | null): void {
    if (!fleet) return;
    replace(errorBox);
    // The "why these numbers" you opened stay open across a redraw.
    const opened = new Set([...nodesBox.querySelectorAll<HTMLElement>("article[aria-label]")].filter((card) => card.querySelector("details[open]")).map((card) => card.getAttribute("aria-label")));
    const active = fleet.devices.filter((d) => !d.revokedAt);
    const nodes = active.filter((d) => d.kind === "node").sort((a, b) => Number(b.id === fleet.self) - Number(a.id === fleet.self) || a.name.localeCompare(b.name));
    const clients = active.filter((d) => d.kind === "client").sort((a, b) => Number(b.id === ctx.identity.device) - Number(a.id === ctx.identity.device) || a.name.localeCompare(b.name));
    const revoked = fleet.devices.filter((d) => d.revokedAt);
    const online = nodes.filter((d) => isOnline(fleet, d)).length;
    const rtts = fleet.peers.filter((p) => p.online && p.rttMs !== null).map((p) => p.rttMs!);
    replace(
      stats,
      statTile({ label: "Nodes online", icon: "server", value: [String(online), h("span", { class: "of" }, ` / ${nodes.length}`)], note: rtts.length ? `median ${rtts.sort((a, b) => a - b)[Math.floor(rtts.length / 2)]} ms` : "this node only" }),
      statTile({ label: "Client devices", icon: "phone", value: String(clients.length), note: "phones and browsers" }),
      statTile({ label: "Mind", icon: "memory", value: fleet.events.toLocaleString(), note: h("span", { class: "mono", title: fleet.digest }, `events · ${fleet.digest.slice(0, 10)}`) }),
      compute ? slotsTile(compute) : null,
    );
    const computeOf = new Map((compute?.nodes ?? []).map((n) => [n.id, n]));
    replace(nodesBox, ...nodes.map((d) => nodeCard(ctx, fleet, d, computeOf.get(d.id) ?? null, () => void loadCompute())));
    for (const card of nodesBox.querySelectorAll<HTMLElement>("article[aria-label]")) if (opened.has(card.getAttribute("aria-label"))) card.querySelector("details")?.setAttribute("open", "");
    if (compute) replace(computeBox, computeBody(ctx, compute, () => void loadCompute()));
    replace(
      clientsBox,
      clients.length
        ? h("div", { class: "rows" }, ...clients.map((d) => clientRow(ctx, fleet, d)))
        : empty({ icon: "phone", title: "No phones or browsers yet", body: "Pair one to talk to Galahad from anywhere on your tailnet.", compact: true, actions: admin ? button("Pair a phone or browser", { icon: "plus", onClick: () => openInvite(ctx, "client") }) : null }),
    );
    replace(
      revokedBox,
      revoked.length
        ? disclosure(`Revoked devices (${revoked.length})`, { flush: true }, rows(...revoked.map((d) => clientRow(ctx, fleet, d))))
        : null,
    );
  }

  replace(
    root,
    h(
      "div",
      { class: "page" },
      pageHead(
        "Fleet",
        "Every body that shares the one mind.",
        admin ? [button("Add a machine", { icon: "server", onClick: () => openInvite(ctx, "node") }), button("Pair a device", { variant: "primary", icon: "plus", onClick: () => openInvite(ctx, "client") })] : null,
      ),
      errorBox,
      // Shown whole once the fleet, its compute and its agents have answered: a node's card grows by its capacity.
      pageBody(stats, section("Nodes", {}, nodesBox), computeSection, section("Phones and browsers", {}, clientsBox), revokedBox, agentsSection(ctx, scope), section("Placement", {}, placementPlayground(ctx, scope))),
    ),
  );

  scope.add(ctx.live.fleet.watch((fleet) => keepPlace(root, () => render(fleet))));
  ctx.live.refreshFleet().then(() => {
    if (!ctx.live.fleet.value && !scope.disposed) replace(errorBox, errorState("Couldn't load the fleet", new Error("The node didn't answer."), () => void ctx.live.refreshFleet()));
  });
  void loadCompute();
  scope.interval(() => void loadCompute(), 5_000);
  // Each node's load and round trip, and the mind's count, move all the time: the live stream doesn't tell of them, so
  // they are asked for while this page shows them, as often as the app asked for the fleet before there was a stream.
  scope.interval(() => void ctx.live.refreshFleet(), 10_000);
  if (opts.intent === "invite") openInvite(ctx, "client");
  if (opts.intent === "place") requestAnimationFrame(() => root.querySelector("#placement")?.scrollIntoView({ block: "start", behavior: "smooth" }));
};
