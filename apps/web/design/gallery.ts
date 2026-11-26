/*
 * The gallery: every component of the app (src/ui/controls.ts, and the sheet and smart selector beside it) drawn by the
 * app's own code, on the app's own stylesheet, in each of its states. For review: a change to a component is seen here
 * on its own, light and dark, at a phone's width and a desktop's, before it is seen on a page.
 *
 *   bun apps/web/measure/first-load.ts --gallery <dir>    its screenshots (no node needed)
 *
 * It is not part of the app: the node serves only what assets.ts names. The screenshot tool bundles it and serves it on
 * loopback with index.html's head (the tokens and all the CSS), its font and its pictures.
 */
import { arrive, badge, button, callout, card, chipInput, copyField, count, disclosure, dot, empty, errorState, field, formActions, kbd, kv, linkButton, list, listRow, meta, meter, note, pageHead, rangeControl, rows, sasCode, secretInput, section, segmented, setCount, skeletonBlock, skeletonRows, skeletonStat, spinner, statTile, switchControl, type Tone } from "../src/ui/controls.ts";
import { bannerPill, connectionBanner } from "../src/ui/banner.ts";
import { type ConfirmOptions, confirmAction, openSheet } from "../src/ui/dialog.ts";
import { leadMark, seat, stateChip } from "../src/ui/avatar.ts";
import type { KnightState } from "../src/lib/knight-state.ts";
import { h, Scope } from "../src/ui/dom.ts";
import { icon } from "../src/ui/icons.ts";
import { selector } from "../src/ui/selector.ts";
import { knightFace, orb } from "../src/ui/orb.ts";
import { toast, toastCard, type ToastOptions } from "../src/ui/toast.ts";
import type { Ctx } from "../src/context.ts";
import { questionCard } from "../src/views/inbox.ts";
import { findingRow } from "../src/views/loops.ts";

const TONES: Tone[] = ["ok", "warn", "danger", "info", "accent", "agent", "neutral", "needs"];
/** Each state a knight can be in, with the face it shows in it. */
const SEATED: [KnightState, "working" | "asking" | "concerned" | "resting" | "waiting" | "pleased" | "idle"][] = [["working", "working"], ["needs", "asking"], ["failed", "concerned"], ["paused", "resting"], ["queued", "waiting"], ["verified", "pleased"], ["resting", "idle"]];
const chip = (state: KnightState) => stateChip(state) ?? h("span", { class: "tiny subtle" }, "at rest: no chip");
const scope = new Scope();

/** One component: its name as code calls it, what it's for, and its states side by side. */
const shown = (name: string, about: string, ...states: (HTMLElement | null)[]) =>
  section(name, { note: about }, h("div", { class: "gallery-states" }, ...states));
/** A state, captioned. */
const state = (caption: string, ...content: (Node | string | null)[]) => h("div", { class: "gallery-state" }, h("div", { class: "gallery-caption" }, caption), ...content);

const scale = h(
  "div",
  { class: "stack tight" },
  ...[1, 2, 3, 4, 5, 6, 8, 10, 12, 16].map((n) => h("div", { class: "row" }, h("span", { class: "mono tiny gallery-key" }, `--sp-${n}`), h("span", { class: "gallery-bar", style: `width:var(--sp-${n})` }))),
);
const rhythm = kv([
  ["--page-gap", "a page's head and its sections, apart (24)"],
  ["--section-gap", "a section's head and what is in it (12)"],
  ["--card-pad", "a card's content, head, rows and foot from its edge (16)"],
  ["--row-pad", "above and below a row's text (12)"],
  ["--form-gap", "the fields of a form, apart (16)"],
  ["--field-gap", "a field's label, control and hint (8)"],
]);

// A sheet as it opens, drawn in the page's flow so it can be seen beside the rest (the real thing is modal).
function sheetInPlace(): HTMLElement {
  const name = h("input", { class: "input", placeholder: "Release plan", autocomplete: "off", autocorrect: "off", spellcheck: "false" });
  const sheet = openSheet({
    title: "New project",
    description: "Instructions he follows in every chat of it.",
    body: [field("Name", name, { hint: "Shown in the chat's menu." }), field("Instructions", h("textarea", { class: "textarea", rows: 3 }))],
    footer: [button("Cancel"), button("Make project", { variant: "primary" })],
  });
  sheet.el.close();
  sheet.el.classList.add("gallery-sheet", "shown");
  sheet.el.show();
  return h("div", { class: "gallery-sheet-frame" }, sheet.el);
}

// A confirmation as it opens, drawn in the page's flow as the sheet above is.
function confirmInPlace(options: ConfirmOptions): HTMLElement {
  void confirmAction(options);
  const sheet = [...document.querySelectorAll<HTMLDialogElement>("dialog.sheet")].at(-1)!;
  sheet.close();
  sheet.classList.add("gallery-sheet", "shown");
  sheet.show();
  return h("div", { class: "gallery-sheet-frame" }, sheet);
}

// ---- the alerts: what tells you something happened, or needs you ----
const toasts = (...each: [string, ToastOptions][]) => h("div", { class: "gallery-toasts" }, ...each.map(([title, options]) => toastCard(title, options)));
// The banner as the shell raises it under its top bar (ui/banner.ts), here in the page's flow.
const banner = (said: Parameters<typeof bannerPill>[0]) => h("div", { class: "gallery-banner" }, bannerPill(said));
// The Roundtable's strip while its updates are paused (views/team.ts).
const teamNotice = h("div", { class: "team-notice", role: "status" }, icon("offline", { size: 14 }), h("span", { class: "grow" }, "Updates paused. What you see may be out of date."), button("Retry", { size: "sm" }));
// The card at the top of the Inbox while he can't reach this device (views/notifications.ts reachNote), each way it reads.
const reachOff = h(
  "div",
  { class: "reach-note" },
  callout("warn", h("div", { class: "stack tight" }, h("div", {}, "They were on until 18 Nov: Apple's push service stopped taking them.")), {
    title: "He can't reach this device when Galahad is closed.",
    icon: "bell",
    actions: [button("Turn on notifications", { size: "sm", variant: "primary", icon: "bell" }), button("Not now", { size: "sm", variant: "ghost" })],
  }),
);
const reachOn = h(
  "div",
  { class: "reach-note" },
  callout("ok", h("div", { class: "stack tight" }, h("div", {}, "He can reach this device when Galahad is closed. Send a test to see one arrive.")), { title: "Notifications are on", actions: button("Send a test", { size: "sm", icon: "bell" }) }),
);
// The Inbox's notices, as its "Noticed" section lists them (views/inbox.ts, views/loops.ts findingRow).
const notices = card(
  { flush: true },
  rows(
    findingRow({} as Ctx, { severity: "alert", title: "The vault's disk is nearly full", body: "keep has 3% of its disk left; sealing a key may fail." }, [h("span", {}, "The heartbeat"), h("span", {}, "4 min ago")], button("Dismiss", { size: "sm", variant: "ghost", icon: "x" })),
    findingRow({} as Ctx, { severity: "warn", title: "CI failed on main", body: "Two runs in a row: the link tests." }, [h("span", {}, "CI"), h("span", {}, "1 h ago")], button("Dismiss", { size: "sm", variant: "ghost", icon: "x" })),
    findingRow({} as Ctx, { severity: "info", title: "A push to main", body: "wckdboy pushed 3 commits.", icon: "bell" }, [h("span", {}, "Your rule pushes"), h("span", {}, "2 h ago")], button("Dismiss", { size: "sm", variant: "ghost", icon: "x" })),
  ),
);
// A count and a dot that change as the app's do: a figure rolling, and one breath for something new that needs you.
const waiting = count(2, false, "needs");
const needsDot = dot("needs");
const liveNeeds = h("span", { class: "row tight small" }, needsDot, "Needs you", waiting);
const more = () => {
  setCount(waiting, Number(waiting.dataset.count) + 1);
  arrive(waiting);
  arrive(needsDot);
  const card = document.querySelector<HTMLElement>(".gallery-alert-card");
  if (card) arrive(card);
};
const fewer = () => setCount(waiting, Math.max(0, Number(waiting.dataset.count) - 1));
// The real banner, hanging at the top of this page as it hangs under the app's top bar.
const liveBanner = h("div", { class: "banner", role: "status", hidden: true, style: "--banner-top: 0px" });
const reach = connectionBanner(liveBanner, () => {}, scope.signal);
// To see them move (the screenshots are taken with motion reduced, so each is still where it ends).
// (Each marked data-demo, for a capture to press: toast, three, lose, reach, confirm.)
const tryThem = h(
  "div",
  { class: "row wrap gallery-try" },
  button("A toast", { onClick: () => toast("Sealed", { tone: "ok", description: "Every full node can use it. No model ever sees it." }) }),
  button("Three at once", {
    onClick: () => {
      toast("Copied");
      setTimeout(() => toast("Galahad asks your leave", { lead: orb({ size: 28 }), description: "github.pr.create: wckdboy/galahad", action: { label: "Review", run: () => {} } }), 160);
      setTimeout(() => toast("Couldn't dismiss it", { tone: "error", description: "The node didn't answer." }), 320);
    },
  }),
  button("Lose Galahad", { onClick: () => reach(false) }),
  button("Reach him again", { onClick: () => reach(true) }),
  button("A confirmation", { onClick: () => void confirmAction({ title: "Revoke Owner's iPhone?", body: "It is cut off at once and must be paired again.", confirmLabel: "Revoke", typeToConfirm: "Owner's iPhone" }) }),
);

const picker = selector({
  label: "Filter",
  scope,
  search: false,
  current: () => ({ text: "Ideas, models · this week", icon: "filter", active: true }),
  groups: () => [{ id: "kind", label: "Kind", mode: "many", options: [{ value: "idea", label: "Ideas", selected: true }] }],
  onSelect: () => {},
});

const segment = segmented(
  [
    { value: "system", label: "System", icon: "monitor" },
    { value: "light", label: "Light", icon: "sun" },
    { value: "dark", label: "Dark", icon: "moon" },
  ],
  "system",
  () => {},
  { label: "Theme" },
);
const tags = chipInput({ placeholder: "Add tags, then Enter" });
const range = rangeControl({ label: "Threads", min: 1, max: 24, step: 1, value: 12, format: (v) => `${v} of 24`, scale: ["1", "24"] });
const busyButton = button("Saving", { variant: "primary", icon: "check" });
busyButton.setAttribute("aria-busy", "true");
busyButton.disabled = true;
busyButton.querySelector("svg")?.replaceWith(spinner());

const page = h(
  "main",
  { class: "view" },
  h(
    "div",
    { class: "page" },
    pageHead("Components", "Every part of a page, drawn by the app's own code on its own stylesheet. A page made of these lines up with every other.", [button("Secondary"), button("Primary action", { variant: "primary", icon: "plus" })]),

    section("The rhythm", { note: "One scale, in steps of 4 px; what each kind of box takes from it is a token." }, card({}, h("div", { class: "gallery-split" }, scale, rhythm))),

    shown(
      "section()",
      "A part of a page under its small heading: a count beside it, its links at the end, a note under it.",
      state("with a count, a link and a note", section("Phones and browsers", { count: "3", actions: linkButton("View all", "#", { variant: "ghost", size: "sm", next: true }), note: "Each has its own key; revoke one and it's cut off at once." }, list([listRow({ lead: "phone", title: "iPhone", sub: "this device" })]))),
    ),

    shown(
      "card()",
      "Content on raised ground; its head, rows and foot start at one leading edge.",
      state("padded", card({}, h("p", {}, "A card's content sits at --card-pad from its edge, as a stack."), note("And a note under it."))),
      state("head and foot", card({ title: "Autonomy", icon: "shield", actions: h("span", { class: "tiny subtle" }, "last 24 h"), foot: note("Set by the oath. Only you can amend it.") }, h("p", { class: "small" }, "What he may do alone, and what asks you."))),
      state("toned", card({ tone: "accent" }, h("p", { class: "small" }, "Yours.")), card({ tone: "warn" }, h("p", { class: "small" }, "Wants a look.")), card({ tone: "danger" }, h("p", { class: "small" }, "Destructive."))),
    ),

    shown(
      "list() · listRow()",
      "Every list: a lead, a title, a line under it, a meta line and a trail, at the row's padding.",
      state(
        "rows",
        list([
          listRow({ lead: "server", title: "keep", sub: "this node", meta: [h("span", {}, "online"), h("span", {}, "16 cores · 32 GB")], trail: badge("online", "ok") }),
          listRow({ lead: "repeat", title: "Nightly backup", sub: "Every day at 03:00", href: "#", chevron: true }),
          listRow({ lead: "key", leadTone: "warn", title: "github-token", sub: "Asked for: to open the pull request.", trail: button("Seal", { size: "sm", variant: "primary" }) }),
          listRow({ title: "Theme", sub: "Follows your system unless you choose.", trail: segment.el, wrap: true }),
          listRow({ top: true, title: "A longer entry", sub: "Its parts sit at the top when its text runs to several lines, as a memory's or a notice's does, so the lead stays beside its first line.", meta: [badge("yours", "accent"), h("span", {}, "2 min ago")] }),
          listRow({
            lead: "check",
            leadTone: "ok",
            top: true,
            title: h("span", { class: "row wrap" }, h("span", { class: "mono" }, "github.pr.create"), badge("sent", "ok")),
            sub: h("span", { class: "mono" }, "wckdboy/galahad#212"),
            meta: [h("span", {}, "asked by the loop nightly"), h("span", {}, "1 h ago")],
            body: h("details", { class: "process", open: true }, h("summary", {}, icon("chevron-right", { size: 14, class: "chev" }), "Receipt"), h("pre", { class: "result process-body" }, "201 Created · pull request 212")),
          }),
        ]),
      ),
      state("none yet", list([], { empty: { icon: "repeat", title: "No loops yet", body: "Work he does on a schedule appears here." } })),
    ),

    shown(
      "disclosure()",
      "A card that opens on request: one line until it's wanted.",
      state("closed", disclosure([h("span", { class: "grow" }, "How a sandbox reaches the network"), badge("isolated", "ok")], {}, h("p", { class: "small" }, "Hidden."))),
      state("open", disclosure("Why these numbers", { open: true }, h("p", { class: "small muted" }, "Strength is what it measured; the ceiling is yours."))),
      state("a list in it", disclosure("Recent decisions (2)", { open: true, flush: true }, h("div", { class: "rows" }, listRow({ lead: "check-circle", leadTone: "ok", title: "Approved: push to main", meta: [h("span", {}, "5 min ago")] }), listRow({ lead: "x-circle", leadTone: "danger", title: "Declined: delete bucket", meta: [h("span", {}, "1 h ago")] })))),
    ),

    shown(
      "button() · linkButton() · formActions()",
      "One primary action a view; the rest default or ghost. A form ends with its actions, the primary one last.",
      state("variants", h("div", { class: "row wrap" }, button("Primary", { variant: "primary" }), button("Default"), button("Ghost", { variant: "ghost" }), button("Danger", { variant: "danger" }), button("Delete", { variant: "danger-solid" }))),
      state("sizes and icons", h("div", { class: "row wrap" }, button("Large", { size: "lg", variant: "primary" }), button("Add", { icon: "plus" }), button("Small", { size: "sm", icon: "refresh" }), button("Search", { iconOnly: true, icon: "search" }), button("Copy", { size: "sm", iconOnly: true, icon: "copy" }))),
      state("busy and disabled", h("div", { class: "row wrap" }, busyButton, button("Not allowed", { disabled: true }))),
      state("links", h("div", { class: "row wrap" }, linkButton("View all", "#", { variant: "ghost", size: "sm", next: true }), linkButton("All projects", "#", { variant: "ghost", size: "sm", icon: "chevron-left" }))),
      state("form actions", formActions(button("Cancel"), button("Save", { variant: "primary" }))),
    ),

    shown(
      "badge() · dot() · count() · kbd()",
      "Colour means something: a tone is status, trust, verdict or risk, never decoration.",
      state("badges", h("div", { class: "row wrap" }, ...TONES.map((tone) => badge(tone, tone)), badge("running", "info", "play"))),
      state("dots", h("div", { class: "row wrap" }, ...TONES.map((tone) => h("span", { class: "row tight small" }, dot(tone), tone)), h("span", { class: "row tight small" }, dot("ok", { live: true }), "live"))),
      state("counts and keys", h("div", { class: "row wrap" }, count(3), count(128), count(2, true), ...kbd("⌘", "K"), h("span", { class: "chip" }, icon("cpu"), "8 cores"), h("span", { class: "tag" }, "#release"))),
      state("spinners", h("div", { class: "row wrap" }, spinner(), spinner("sm"), spinner("xs"))),
    ),

    shown(
      "seat() · stateChip() · leadMark()",
      "A knight in its seat: its face, still, its state said beside it by the chip, in words and its colour; and the mark of the one who leads.",
      state("each state, on a row's face", h("div", { class: "gallery-seats" }, ...SEATED.map(([each, expression]) => h("div", { class: "stack snug gallery-seat" }, seat({ id: "percival", name: "Percival", state: each, expression, size: 32 }), chip(each))))),
      state("on a card, and as a portrait", h("div", { class: "row wrap" }, seat({ id: "percival", name: "Percival", state: "working", expression: "working", size: 84 }), seat({ id: "gareth", name: "Gareth", state: "needs", expression: "asking", size: 104 }))),
      state("who leads", h("div", { class: "row wrap" }, h("strong", {}, "Lin"), leadMark("Lin"), stateChip("working")), h("div", { class: "row wrap" }, h("strong", {}, "Galahad"), leadMark())),
    ),

    shown(
      "callout()",
      "What a part of a page wants you to know, in its tone, with a way forward.",
      state("tones", h("div", { class: "stack" }, callout("info", "Fetched from the node a moment ago."), callout("ok", "Sealed. No model ever sees it.", { title: "In the vault" }), callout("warn", "No disk limit here: a sandbox can fill this host's disk.", { title: "No disk limit", actions: button("How to fix it", { size: "sm" }) }), callout("danger", "The vault couldn't be unlocked on this node."), callout("quiet", "This device can see loops but not change them."))),
    ),

    shown(
      "empty() · errorState() · skeletons",
      "What will appear, and the next step; a courteous error with a way forward; placeholders as tall as what replaces them.",
      state("empty", card({}, empty({ icon: "inbox", title: "Nothing needs you", body: "When something waits for your answer, it's here.", actions: button("Pair a device", { icon: "plus" }) }))),
      state("error", card({}, errorState("Couldn't read the ledger", new Error("The node didn't answer."), () => {}))),
      state("loading", card({ flush: true }, skeletonRows(2, { avatar: true })), h("div", { class: "grid stats" }, skeletonStat(), skeletonStat()), skeletonBlock(64)),
    ),

    shown(
      "statTile() · meter() · kv() · meta()",
      "Figures in tabular numerals; a meter turns amber past its line.",
      state("tiles", h("div", { class: "grid stats" }, statTile({ label: "Nodes online", icon: "server", value: ["2", h("span", { class: "of" }, " / 3")], note: [dot("warn"), "1 offline"] }), statTile({ label: "Inbox", icon: "inbox", value: "0", note: "nothing needs you" }))),
      state("meters", h("div", { class: "stack" }, meter(0.42, undefined, "Disk"), meter(0.91, "var(--warn)", "Disk"))),
      state("facts", kv([["Name", "Owner's iPhone"], ["Device key", h("span", { class: "mono" }, "b3f1…09ac")]]), meta(h("span", {}, "quest q-17"), h("span", {}, "on keep"), h("span", {}, "12:04"))),
    ),

    shown(
      "field() and its controls",
      "A label, the control, a hint under it; an error said beside the field it's about.",
      state("text", field("Name", h("input", { class: "input", placeholder: "Release plan", autocomplete: "off", autocorrect: "off", spellcheck: "false" }), { hint: "Shown in the chat's menu." })),
      state("with an error", field("Schedule", h("input", { class: "input mono", value: "every 61 minutes", autocomplete: "off", autocorrect: "off", spellcheck: "false" }), { error: h("div", { class: "error" }, "Every 1 to 60 minutes.") })),
      state("select and text area", h("div", { class: "fields" }, field("Role", h("select", { class: "select" }, h("option", {}, "engineer"), h("option", {}, "planner"))), field("Notes", h("textarea", { class: "textarea", rows: 2 })))),
      state("a key", field("API key", secretInput().wrap, { hint: "Sealed at once; only its last four characters are ever shown." })),
      state("choices", h("div", { class: "stack" }, segment.el.cloneNode(true) as HTMLElement, switchControl("Notifications on this device", true, () => {}, { hint: "Through the browser's push service." }), range.el, tags.el, picker.el)),
      state("codes", copyField("galahad invite --client"), sasCode("023811")),
    ),

    shown(
      "questionCard()",
      "An MCP server's question in the middle of a call: its words quoted as its, a field for each thing it asks, then Send or No.",
      state(
        "every kind of field",
        // (Drawn as the Inbox draws it; its buttons answer nobody here.)
        questionCard({ can: () => true, api: { post: async () => ({}) }, live: { refreshQuestions: async () => {} } } as unknown as Ctx, {
          id: "qn_gallery00000000",
          connector: "tracker",
          label: "Tracker",
          message: "Which repository should the issue go in, and how urgent is it?",
          askedAt: Date.now(),
          expires: Date.now() + 4 * 60_000,
          fields: [
            { name: "repo", kind: "text", title: "Repository", description: "owner/name", required: true, format: null, minLength: null, maxLength: 100, default: null },
            { name: "count", kind: "number", title: "How many copies", description: null, required: false, integer: true, minimum: 1, maximum: 10, default: 1 },
            { name: "urgent", kind: "yes-no", title: "Urgent", description: null, required: false, default: false },
            { name: "area", kind: "one", title: "Area", description: null, required: true, options: [{ value: "node", title: "The node" }, { value: "pwa", title: "The app" }], default: null },
            { name: "labels", kind: "many", title: "Labels", description: null, required: false, options: [{ value: "bug", title: "Bug" }, { value: "docs", title: "Docs" }], minItems: null, maxItems: 2, default: ["bug"] },
          ],
        }),
      ),
    ),

    section("openSheet()", { note: "A centred dialog on a wide screen, a tray from the bottom on a phone; its actions in its foot." }, sheetInPlace()),

    shown(
      "toast()",
      "What just happened, for a moment at the bottom of the screen: newest in front, the rest tucked behind; errors stay longer and are read out at once.",
      state("each tone", toasts(["Copied", {}], ["Sealed", { tone: "ok", description: "Every full node can use it. No model ever sees it." }], ["No disk limit here", { tone: "warn", description: "A sandbox can fill this host's disk." }], ["Couldn't dismiss it", { tone: "error", description: "The node didn't answer." }])),
      state("with an action", toasts(["Owner's iPad asks to join", { description: "Compare the six-digit code before you approve.", action: { label: "Review", run: () => {} } }])),
      state(
        "about a knight, or him: their orb, still",
        toasts(
          ["Ada's work is verified", { tone: "ok", lead: knightFace({ id: "ada", size: 28 }), description: "Its gates passed, and a reviewer that didn't write it agreed.", action: { label: "Review", run: () => {} } }],
          ["Galahad asks your leave", { lead: orb({ size: 28 }), description: "github.pr.create: wckdboy/galahad", action: { label: "Review", run: () => {} } }],
        ),
      ),
    ),

    shown(
      "The banner",
      "Under the top bar, over the page, while Galahad can't be reached; for a moment once he is again, then gone. Nothing under it moves.",
      state("can't reach him: trying again, a slow line of light along its foot", banner("unreachable")),
      state("offline: no error", banner("offline")),
      state("reached again, for a moment", banner("reconnected")),
    ),

    shown(
      "count() · dot(\"needs\")",
      "What waits on you: the count beside a place, the amber dot where something needs you.",
      state("counts: ink, quiet, and amber for what waits on you", h("div", { class: "row wrap" }, count(1), count(12), count(128), count(3, true), count(2, false, "needs"))),
      state("needs you", h("div", { class: "row wrap" }, h("span", { class: "row tight small" }, dot("needs"), "Needs you"), h("span", { class: "row tight small" }, dot("work", { live: true }), "Working"))),
      state("changing: the figure rolls, and something new breathes once", h("div", { class: "row wrap" }, liveNeeds, button("Something new", { size: "sm", onClick: more }), button("One answered", { size: "sm", variant: "ghost", onClick: fewer }))),
      state(
        "a card that holds what needs you: .alert-card, data-tone \"needs\"",
        h(
          "article",
          { class: "alert-card gallery-alert-card", "data-tone": "needs" },
          h("div", { class: "row tight tiny subtle" }, knightFace({ id: "ada", size: 20 }), "Ada · Fix the flaky link test"),
          h("p", { class: "small" }, "Outward · ", h("span", { class: "mono" }, "github.pr.create"), " wckdboy/galahad"),
          h("div", { class: "row wrap" }, button("Allow once", { size: "sm", variant: "primary" }), button("Deny", { size: "sm" })),
        ),
      ),
    ),

    shown(
      "confirmAction()",
      "Asks before doing something that can't be taken back; what is gone for good makes you type its name.",
      state("plain", confirmInPlace({ title: "Rotate the vault key?", body: "Every node re-seals what it holds. Keys stay where they are.", confirmLabel: "Rotate", tone: "primary" })),
      state("typed, destructive", confirmInPlace({ title: "Revoke Owner's iPhone?", body: "It is cut off at once and must be paired again.", confirmLabel: "Revoke", typeToConfirm: "Owner's iPhone" })),
    ),

    shown(
      "Notices",
      "What the node noticed, the Roundtable's strip while its updates are paused, and the card that says he can't reach this device.",
      state("the Inbox's notices", notices),
      state("the Roundtable's strip", teamNotice),
      state("he can't reach this device", reachOff),
      state("and once he can", reachOn),
    ),

    section("See them move", { note: "The screenshots are taken with motion reduced; these raise the real thing." }, tryThem),
    h("div", { "data-ready": "" }),
  ),
);

const css = h(
  "style",
  {},
  `.gallery-states { display: grid; gap: var(--sp-4); grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr)); align-items: start; }
   .gallery-state { display: flex; flex-direction: column; gap: var(--sp-2); min-width: 0; }
   .gallery-caption { font: 500 11px/1.4 var(--font-mono); color: var(--text-3); }
   .gallery-split { display: grid; gap: var(--sp-6); grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); }
   .gallery-key { width: 7ch; }
   .gallery-seats { display: flex; flex-wrap: wrap; gap: var(--sp-4); }
   .gallery-seat { align-items: center; }
   .gallery-bar { display: inline-block; height: 12px; background: var(--accent-fill); border-radius: 2px; }
   .gallery-sheet-frame { position: relative; padding: var(--sp-4) 0; }
   dialog.sheet.gallery-sheet { position: relative; inset: auto; margin: 0 auto; opacity: 1; transform: none; max-height: none; }
   .gallery-state dialog.sheet.gallery-sheet { max-width: 100%; }
   .gallery-alert-card { display: flex; flex-direction: column; gap: var(--sp-2); padding: 12px 14px; }
   .gallery-banner { display: flex; justify-content: center; padding: var(--sp-1) 0 var(--sp-3); }
   .gallery-banner .banner-pill { margin-top: 0; }
   .gallery-toasts { display: flex; flex-direction: column; gap: var(--sp-2); max-width: 380px; }
   .gallery-toasts .toast { position: relative; inset: auto; transform: none; opacity: 1; }`,
);
for (const [label, demo] of [["A toast", "toast"], ["Three at once", "three"], ["Lose Galahad", "lose"], ["Reach him again", "reach"], ["A confirmation", "confirm"]]) {
  const button = [...tryThem.querySelectorAll("button")].find((each) => each.textContent === label);
  if (button) button.dataset.demo = demo;
}
document.getElementById("gallery")!.append(css, liveBanner, page);
