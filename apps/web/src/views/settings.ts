import type { View } from "../context.ts";
import { forgetIdentity } from "../identity.ts";
import { shortId } from "../lib/text.ts";
import { chatEnter, type ChatEnterPref, type MotionPref, motionPref, setChatEnter, setMotion, setTheme, type ThemePref, themePref } from "../prefs.ts";
import { button, callout, card, copyText, kv, list, listRow, note, pageHead, section, segmented } from "../ui/controls.ts";
import { confirmAction } from "../ui/dialog.ts";
import { h, replace } from "../ui/dom.ts";
import { icon } from "../ui/icons.ts";
import { appMark } from "../ui/orb.ts";
import { SCOPE_INFO } from "./fleet.ts";
import { dropBrowserSubscription, notificationsSection } from "./notifications.ts";

/* Appearance, this device's identity and permissions, what's kept here, and the way out. */

export const APP_VERSION = "0.1.0";

export async function forgetThisBrowser(): Promise<void> {
  const ok = await confirmAction({
    title: "Forget this browser?",
    body: [
      h("p", {}, "Its device key is deleted from this browser for good. You'll need a fresh invite to pair it again."),
      h("p", {}, "The fleet still lists it until you revoke it from another device's Fleet page."),
    ],
    confirmLabel: "Forget this browser",
  });
  if (!ok) return;
  // Its push subscription goes with it (the node drops its copy when the push service says it's gone).
  await dropBrowserSubscription();
  await forgetIdentity();
  location.hash = "";
  location.reload();
}

export const settingsView: View = (root, ctx, { scope }) => {
  const theme = segmented<ThemePref>(
    [
      { value: "system", label: "System", icon: "monitor" },
      { value: "light", label: "Light", icon: "sun" },
      { value: "dark", label: "Dark", icon: "moon" },
    ],
    themePref(),
    setTheme,
    { label: "Theme" },
  );
  const motion = segmented<MotionPref>(
    [
      { value: "system", label: "System" },
      { value: "reduce", label: "Reduced" },
      { value: "full", label: "Full" },
    ],
    motionPref(),
    setMotion,
    { label: "Motion" },
  );

  // What Enter does when you send a message while he's working (the other is Ctrl or ⌘ with Enter, or its own button).
  const enter = segmented<ChatEnterPref>(
    [
      { value: "steer", label: "Steers him" },
      { value: "queue", label: "Queues it" },
    ],
    chatEnter(),
    setChatEnter,
    { label: "Enter while he works" },
  );

  const row = (label: string, hint: string, control: HTMLElement) => listRow({ title: label, sub: hint, trail: control, wrap: true });

  const known = SCOPE_INFO.filter((s) => s.scope !== "sandbox" || ctx.whoami.scopes.includes("sandbox"));
  replace(
    root,
    h(
      "div",
      { class: "page narrow" },
      pageHead("Settings", "How Galahad looks on this device, and what this device may do."),
      section("Appearance", {}, list([row("Theme", "Follows your system unless you choose.", theme.el), row("Motion", "Reduced keeps every change instant.", motion.el)])),
      ctx.can("chat")
        ? section(
            "Chat",
            {},
            list([
              row(
                "Enter while he works",
                "Steer: your message reaches him now, at his next safe point. Queue: it's kept on the node and sent when he's done. Ctrl or ⌘ with Enter does the other; on a phone each has its own button.",
                enter.el,
              ),
            ]),
          )
        : null,
      // He comes to you: notifications on this device, what he tells you and when he stays silent.
      notificationsSection(ctx, scope),
      section(
        "This device",
        {},
        card(
          {},
          kv([
            ["Name", ctx.identity.name],
            ["Device key", h("span", { class: "row" }, h("span", { class: "mono" }, shortId(ctx.identity.device, 16)), button("Copy device id", { size: "sm", variant: "ghost", iconOnly: true, icon: "copy", onClick: () => void copyText(ctx.identity.device, "Device id copied") }))],
            ["Talks to", [ctx.whoami.nodeName, h("span", { class: "subtle mono" }, ` · ${location.host}`)]],
            ["Fleet", [ctx.whoami.fleetName ?? "unnamed", h("span", { class: "subtle mono" }, ` · ${shortId(ctx.whoami.fleet, 10)}`)]],
          ]),
          h(
            "div",
            { class: "stack tight" },
            h("div", { class: "label" }, "What this device may do"),
            h(
              "div",
              { class: "scope-list" },
              ...known.map((s) => {
                const on = ctx.whoami.scopes.includes(s.scope);
                return h(
                  "div",
                  { class: `scope ${on ? "on" : "off"}` },
                  icon(on ? "check-circle" : "minus", { size: 15, label: on ? "granted" : "not granted" }),
                  h("div", {}, h("div", { class: "scope-name" }, s.scope), h("div", { class: "tiny subtle" }, s.label)),
                );
              }),
            ),
          ),
          note("Scopes are set when a device is paired. To change them, pair again with a new invite and revoke the old entry."),
        ),
      ),
      section(
        "Kept on this device",
        {},
        list([
          listRow({ lead: "key", top: true, title: "A device key", sub: "In IndexedDB, created non-extractable: it can sign, but nothing can read it out, not even this page." }),
          listRow({ lead: "settings", top: true, title: "Display preferences", sub: "Theme, motion, sidebar, chat role, what Enter does while he works, which kept chat you had open (its id, never a word of it), and how the Roundtable is laid out here (a board or a list, the sidebar's folded sections, a knight's side panel), in localStorage. Nothing else." }),
          listRow({ lead: "bell", top: true, title: "A push subscription, once you turn notifications on", sub: "Made by your browser, with keys only it can read with; the node is handed its address and public key, as this device's. Turning notifications off removes it in both places." }),
          listRow({ lead: "chat", top: true, title: "Chats: not on this device", sub: "Kept privately on the node you talk to, with what you queued behind them, and deleted there when you delete them; temporary chats aren't kept at all. Keys you paste are never kept." }),
        ]),
      ),
      section(
        "Leave",
        {},
        list([listRow({ title: "Forget this browser", sub: "Deletes this browser's device key. Revoke it on the Fleet page too, from any device.", trail: button("Forget this browser…", { variant: "danger", icon: "logout", onClick: () => void forgetThisBrowser() }), wrap: true })], { tone: "danger" }),
      ),
      section(
        "About",
        {},
        list([
          listRow({
            lead: appMark(40),
            title: "Galahad",
            sub: `App ${APP_VERSION} · served by ${ctx.whoami.nodeName} · one mind, many bodies`,
            trail: button("Shortcuts", { size: "sm", variant: "ghost", icon: "command", onClick: () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "?" })) }),
          }),
        ]),
      ),
      ctx.whoami.scopes.length ? null : callout("warn", "This device has no scopes. Pair it again with a new invite."),
    ),
  );
};
