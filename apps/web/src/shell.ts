import type { ActionView, PairingView } from "@galahad/core";
import { type Api, nodeReachable, setNetworkHandler } from "./api.ts";
import type { Ctx, NavigateOptions, Route, View } from "./context.ts";
import type { BrowserIdentity } from "./identity.ts";
import { startLive } from "./live.ts";
import type { LiveLink } from "./lib/live-link.ts";
import { setMotion, setSidebarCollapsed, setTheme, sidebarCollapsed } from "./prefs.ts";
import type { AnyScope, WhoAmI } from "./types.ts";
import { button, dot, kbd, retryFailed } from "./ui/controls.ts";
import { openSheet } from "./ui/dialog.ts";
import { h, isMac, isTyping, replace, Scope } from "./ui/dom.ts";
import { icon } from "./ui/icons.ts";
import { knightFace, orb } from "./ui/orb.ts";
import { knightOfCaller } from "./lib/roster.ts";
import { type Command, isPaletteOpen, openPalette } from "./ui/palette.ts";
import { toast } from "./ui/toast.ts";
import { activityView } from "./views/activity.ts";
import { artifactsView } from "./views/artifacts.ts";
import { archiveView, openNewIdea } from "./views/archive.ts";
import { bankView } from "./views/bank.ts";
import { projectsView } from "./views/projects.ts";
import { chatActivityPill, chatsForPalette, chatView, lookAtWork, startNewChat } from "./views/chat.ts";
import { filterConversations } from "./lib/chats.ts";
import { goToOf, hashOf, homeOf, keyedOf, landingOf, placesFor, routeOf, taskOf } from "./lib/nav.ts";
import { closesKeyboard, keyboardOpen } from "./lib/viewport.ts";
import { conversationFromHash } from "@galahad/core/notify-payload";
import { readOpenMessage } from "./lib/push.ts";
import { badgeMessage, type Badging, showBadge } from "./lib/badge.ts";
import { readsFor } from "./lib/prefetch.ts";
import { reachability } from "./lib/reach.ts";
import { connectionBanner } from "./ui/banner.ts";
import { syncPush } from "./views/notifications.ts";
import { connectorsView } from "./views/connectors.ts";
import { findingsView } from "./views/findings.ts";
import { fleetView, openInvite } from "./views/fleet.ts";
import { inboxView } from "./views/inbox.ts";
import { loopsView, openLoopSheet } from "./views/loops.ts";
import { memoryView, openRemember } from "./views/memory.ts";
import { skillsView } from "./views/skills.ts";
import { modelsView } from "./views/models.ts";
import { moreView } from "./views/more.ts";
import { overviewView } from "./views/overview.ts";
import { openCreateSandbox, sandboxesView } from "./views/sandboxes.ts";
import { forgetThisBrowser, settingsView } from "./views/settings.ts";
import { trialsView } from "./views/trials.ts";
import { teamView } from "./views/team.ts";
import { homeView } from "./views/home.ts";
import { openPlaces } from "./views/places.ts";
import { sidebarNav } from "./views/sidebar.ts";
import { taskView } from "./views/task.ts";
import { giveToRoundtable } from "./views/team-forms.ts";
import { teamLocation } from "./lib/team.ts";
import { openAddKey, vaultView } from "./views/vault.ts";

/** Each place's page (the places themselves, and where each is reached from, are lib/nav.ts). */
const VIEWS: Record<Route, View> = {
  home: homeView,
  chat: chatView,
  team: teamView,
  task: taskView,
  inbox: inboxView,
  more: moreView,
  overview: overviewView,
  projects: projectsView,
  loops: loopsView,
  activity: activityView,
  artifacts: artifactsView,
  trials: trialsView,
  memory: memoryView,
  skills: skillsView,
  archive: archiveView,
  findings: findingsView,
  fleet: fleetView,
  sandboxes: sandboxesView,
  vault: vaultView,
  models: modelsView,
  connectors: connectorsView,
  bank: bankView,
  settings: settingsView,
};

export interface ShellBase {
  api: Api;
  identity: BrowserIdentity;
  whoami: WhoAmI;
  /** The node's live stream, opened as the app booted (live.ts openLink); one is opened with the shell otherwise. */
  link?: LiveLink;
}

export function renderShell(root: HTMLElement, base: ShellBase): { dispose(): void } {
  const lifetime = new AbortController();
  const scopes = new Set<AnyScope>(base.whoami.scopes);
  const can = (scope: AnyScope) => scopes.has(scope);
  const visible = placesFor(can);
  // (Whether this device sees the work at all: a device that may not chat has no sidebar of it, and opens on its Inbox.)
  const hasWork = visible.some((spec) => spec.id === "home");
  const narrow = matchMedia("(max-width: 959px)");
  const home = (): Route => homeOf(visible, { narrow: narrow.matches });

  let current: Route | null = null;
  let viewScope: Scope | null = null;
  let pending: { route: Route; opts: NavigateOptions } | null = null;
  let titleObserver: IntersectionObserver | null = null;

  const live = startLive(base.api, can, {
    onNewPairing(pairing: PairingView) {
      if (current === "inbox") return;
      toast(`${pairing.name} asks to join`, {
        description: "Compare the six-digit code before you approve.",
        action: { label: "Review", run: () => ctx.navigate("inbox") },
        duration: 12_000,
      });
    },
    onNewAction(action: ActionView) {
      if (current === "inbox") return;
      // Who asks, by name and with their orb, still: a knight while its task runs, else Galahad (his loops are his).
      const knight = knightOfCaller(action.by);
      const mate = knight ? live.team.value?.teammates.find((one) => one.id === knight) : undefined;
      const who = knight ? (mate?.name ?? knight) : "Galahad";
      toast(action.class === "delete" ? `${who} asks to delete something` : `${who} asks your leave`, {
        description: `${action.connector}.${action.tool}: ${action.target}`,
        lead: knight ? knightFace({ id: knight, profile: mate?.avatar, size: 28 }) : orb({ size: 28 }),
        action: { label: "Review", run: () => ctx.navigate("inbox") },
        duration: 12_000,
      });
    },
  }, { link: base.link });
  // One failed request is doubted, and the node asked once more, before the banner says it can't be reached (lib/reach.ts).
  setNetworkHandler(
    reachability({
      set: (ok) => live.online.set(ok),
      says: () => live.online.value,
      browserOffline: () => !navigator.onLine,
      probe: () => nodeReachable(),
      after: (ms, run) => {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      },
    }),
  );

  const ctx: Ctx = {
    ...base,
    can,
    live,
    navigate(route, opts = {}) {
      const target = visible.find((r) => r.id === route) ? route : home();
      pending = { route: target, opts };
      const hash = hashOf(target, opts);
      if (location.hash === hash) render();
      else location.hash = hash;
    },
    palette: (query, from) => {
      // Your chats and projects, so the palette can find them by name.
      chatsForPalette(base.api, { chat: can("chat"), read: can("mind:read") });
      openPalette(paletteSource, query, from);
    },
  };

  // ---------- layout ----------
  const main = h("main", { class: "view", id: "main", tabindex: -1 });
  const banner = h("div", { class: "banner", role: "status", hidden: true });
  const topTitle = h("span", { class: "title" });
  // (Where the app opens depends on the screen: these follow it.)
  const homeLinks: HTMLAnchorElement[] = [];
  const homeLink = (className: string, label: string, ...content: (HTMLElement | SVGElement)[]): HTMLAnchorElement => {
    const a = h("a", { class: className, href: `#/${home()}`, "aria-label": label, title: label }, ...content);
    homeLinks.push(a);
    return a;
  };

  // The sidebar, on a wide screen (views/sidebar.ts): Galahad pinned, the work by attention, the machine and the knights
  // at its foot, everything else under "…". A phone has none: its first screen is Home, and "…" is in each header.
  const sidebar = hasWork ? sidebarNav(ctx, { toggle: () => toggleSidebar() }) : null;
  // A sidebar folded away comes back from the top of the page, as T3 Code's does.
  const expand = button("Show the sidebar", { variant: "ghost", size: "sm", iconOnly: true, icon: "sidebar", title: "Show the sidebar  ( [ )", onClick: () => toggleSidebar() });
  expand.classList.add("side-expand");
  // Search on a phone: a button at the top bar's end, which the palette grows out of; everything else beside it ("…").
  const searchButton = (): HTMLButtonElement =>
    button("Search", { variant: "ghost", iconOnly: true, icon: "search", onClick: (event) => ctx.palette(undefined, event.currentTarget as Element), label: `Search and commands (${isMac() ? "⌘" : "Ctrl"}+K)` });
  const placesButton = (): HTMLButtonElement => {
    const el = button("Everything else", { variant: "ghost", iconOnly: true, icon: "more", onClick: (event) => openPlaces(ctx, event.currentTarget as Element) });
    el.classList.add("places-button");
    return el;
  };

  const topSearch = searchButton();
  topSearch.classList.add("topbar-search");
  // Top bar (a place's page; Home and a thread have their own header): the way home, the title once the page's own has
  // scrolled away, and at its end what is going on, search and everything else.
  const fleetPill = h("a", { class: "fleet-pill", href: "#/fleet", hidden: !can("mind:read") });
  const topbar = h(
    "header",
    { class: "topbar" },
    homeLink("brand-mini", "Home", icon("chevron-left", { size: 18 }), h("img", { src: "/icon-64.png", alt: "", width: 22, height: 22, decoding: "async" })),
    topTitle,
    h(
      "div",
      { class: "actions" },
      chatActivityPill(),
      fleetPill,
      topSearch,
      placesButton(),
    ),
  );

  // (A device with no work to show has no sidebar: its top bar keeps the way home, search and "…" on any screen.)
  const shell = h("div", { class: "shell", "data-sidebar-none": sidebar ? null : "" }, sidebar?.el ?? null, h("div", { class: "main-col" }, sidebar ? expand : null, topbar, banner, main));
  replace(root, shell);

  // ---------- the on-screen keyboard ----------
  // iOS keeps the page full height under its keyboard: while you type, what is docked at the bottom (Home's message box)
  // sits right above the keyboard, not behind the home indicator's strip.
  const viewport = window.visualViewport;
  if (viewport) {
    let fullHeight = window.innerHeight;
    const syncKeyboard = () => {
      fullHeight = Math.max(fullHeight, window.innerHeight);
      const open = keyboardOpen({ coarse: matchMedia("(pointer: coarse)").matches, typing: isTyping(document.activeElement), fullHeight, visibleHeight: viewport.height });
      if (open) document.documentElement.dataset.keyboard = "open";
      else delete document.documentElement.dataset.keyboard;
    };
    viewport.addEventListener("resize", syncKeyboard, { signal: lifetime.signal });
    document.addEventListener("focusin", syncKeyboard, { signal: lifetime.signal });
    document.addEventListener("focusout", () => setTimeout(syncKeyboard, 50), { signal: lifetime.signal });
    window.addEventListener("orientationchange", () => (fullHeight = 0), { signal: lifetime.signal });
    lifetime.signal.addEventListener("abort", () => delete document.documentElement.dataset.keyboard);
  }
  // A finger's tap on the page that no field, button or link takes puts the keyboard away (lib/viewport.ts closesKeyboard):
  // iOS leaves it up after such a tap.
  const TAKES_A_TAP = "input, textarea, select, button, a[href], label, summary, form, video, audio, iframe, [contenteditable]:not([contenteditable='false']), [role='button'], [role='link'], [role='menuitem'], [role='tab'], [role='option'], [role='switch'], [role='checkbox'], [role='slider'], [tabindex]:not([tabindex='-1'])";
  let down: { x: number; y: number; at: number; id: number } | null = null;
  document.addEventListener("pointerdown", (event) => (down = event.isPrimary ? { x: event.clientX, y: event.clientY, at: event.timeStamp, id: event.pointerId } : null), { capture: true, passive: true, signal: lifetime.signal });
  document.addEventListener(
    "pointerup",
    (event) => {
      const tapped = down;
      down = null;
      const typed = document.activeElement;
      if (!tapped || tapped.id !== event.pointerId || !(event.target instanceof Element) || !(typed instanceof HTMLElement)) return;
      const tap = { coarse: event.pointerType === "touch", typing: isTyping(typed), takesTap: event.target.closest(TAKES_A_TAP) !== null };
      if (closesKeyboard({ ...tap, from: [tapped.x, tapped.y], to: [event.clientX, event.clientY], ms: event.timeStamp - tapped.at })) typed.blur();
    },
    { capture: true, passive: true, signal: lifetime.signal },
  );

  // Warm what the first moves need once the page has settled: Galahad's kept chats, so a first visit to Chat is instant.
  if (can("chat")) setTimeout(() => !lifetime.signal.aborted && chatsForPalette(base.api, { chat: true, read: false }), 600);
  // A press on a link to a place asks for what that place reads first, a tap's length before the tap (lib/prefetch.ts).
  const visibleIds = visible.map((place) => place.id);
  const ahead = (event: Event) => {
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href^="#/"]') : null;
    if (!link) return;
    const href = link.getAttribute("href") ?? "";
    // (A task's thread reads its trail first: asked as the view asks it, so the answer is the view's.)
    const task = taskOf(href);
    if (task && visibleIds.includes("task")) base.api.post("/api/team/trail", { task, after: 0 }).catch(() => {});
    for (const read of readsFor(href, visibleIds)) {
      (typeof read === "string" ? base.api.get(read) : base.api.post(read.post, read.body)).catch(() => {});
    }
  };
  document.addEventListener("pointerdown", ahead, { capture: true, passive: true, signal: lifetime.signal });

  // ---------- live chrome ----------
  // What waits in the Inbox is counted in the page's title (the sidebar, Home and "…" count it where they show it).
  live.inboxCount.watch((n) => {
    document.title = document.title.replace(/^\(\d+\+?\) /, "");
    if (n) document.title = `(${n}) ${document.title}`;
  });
  // The number on the app's icon: what waits in the Inbox, once it has been read (lib/badge.ts). The service worker
  // is told it too, and counts on from there the pushes that come while the app is closed.
  const toIcon = () => {
    if (!live.inboxLoaded.value) return;
    const n = live.inboxCount.value;
    void showBadge(navigator as Badging, n);
    if (isSecureContext && "serviceWorker" in navigator) {
      navigator.serviceWorker.ready.then((registration) => registration.active?.postMessage(badgeMessage(n))).catch(() => {});
    }
  };
  live.inboxCount.subscribe(toIcon);
  live.inboxLoaded.watch(toIcon);
  live.fleet.watch((fleet) => {
    if (!fleet) {
      // As wide as it will be, the counts' places held by figure spaces (a tabular digit's width), so the pill doesn't
      // grow under the pointer when the fleet answers.
      replace(fleetPill, dot(null), h("span", { class: "tnum" }, `${base.whoami.fleetName ?? "fleet"} · \u2007/\u2007 online`));
      return;
    }
    const nodes = fleet.devices.filter((d) => d.kind === "node" && !d.revokedAt);
    const onlineCount = nodes.filter((d) => d.id === fleet.self || fleet.peers.find((p) => p.device === d.id)?.online).length;
    const tone = onlineCount === nodes.length ? "ok" : onlineCount === 0 ? "danger" : "warn";
    replace(fleetPill, dot(tone, { live: true }), h("span", { class: "tnum" }, `${fleet.name || base.whoami.fleetName || "fleet"} · ${onlineCount}/${nodes.length} online`));
    fleetPill.setAttribute("aria-label", `Fleet ${fleet.name}: ${onlineCount} of ${nodes.length} nodes online`);
  });
  // The banner under the top bar while Galahad can't be reached, and "Reconnected" for a moment once he can (ui/banner.ts).
  const reach = connectionBanner(banner, () => void live.refreshFleet(), lifetime.signal);
  live.online.subscribe((ok) => {
    reach(ok);
    // Whatever failed while the node was away is asked again, so the page heals by itself.
    if (ok) retryFailed(main);
  });

  function toggleSidebar(): void {
    setSidebarCollapsed(!sidebarCollapsed());
  }

  // ---------- routing ----------
  // (The Roundtable is #/team, and #/roundtable as well.)
  const routeFromHash = (): Route | null => routeOf(location.hash, visible);

  /** How often the team is asked for (while the node's live stream is down): every two seconds where the work is the page
   * (Home, a task, the Roundtable), slowly while it is only the sidebar, never when nothing shows it. */
  const watch = (): void => live.watchTeam(!hasWork ? null : current === "home" || current === "task" || current === "team" ? 2000 : narrow.matches ? null : 6000);
  narrow.addEventListener("change", () => (watch(), syncHome()), { signal: lifetime.signal });
  const syncHome = (): void => {
    for (const a of homeLinks) a.href = `#/${home()}`;
  };

  function render(): void {
    const route = routeFromHash() ?? home();
    const spec = visible.find((r) => r.id === route)!;
    const opts = pending?.route === route ? pending.opts : route === "team" ? teamLocation(location.hash) : route === "task" ? { task: taskOf(location.hash) ?? undefined } : {};
    pending = null;
    viewScope?.dispose();
    viewScope = new Scope();
    const changed = current !== route;
    current = route;
    shell.dataset.route = route;
    // A thread (his, a knight's, a room's, a task's) has no top bar: its header is whose it is. On a phone it is the whole
    // screen, with its way back. Home has its own header too.
    shell.dataset.pane = route === "home" ? "home" : route === "chat" || route === "task" || (route === "team" && opts.room) ? "timeline" : "page";
    sidebar?.at({ route, task: route === "task" ? (opts.task ?? null) : null });
    watch();
    topTitle.textContent = spec.label;
    const n = live.inboxCount.value;
    document.title = `${n ? `(${n}) ` : ""}${spec.label} · Galahad`;
    replace(main);
    VIEWS[route](main, ctx, { scope: viewScope, opts });
    // The top bar names the page only once the page's own heading has scrolled away.
    titleObserver?.disconnect();
    const heading = main.querySelector<HTMLElement>(".page-head h1");
    topTitle.classList.toggle("tucked", Boolean(heading));
    if (heading) {
      titleObserver = new IntersectionObserver(([entry]) => topTitle.classList.toggle("tucked", Boolean(entry?.isIntersecting)), { rootMargin: "-60px 0px 0px 0px" });
      titleObserver.observe(heading);
    }
    if (changed) {
      window.scrollTo({ top: 0 });
      if (document.activeElement === document.body || document.activeElement?.closest(".sidebar")) main.focus({ preventScroll: true });
    }
  }

  // A notification named a kept chat in the address ("#/chat?c=…"): that's the chat to show.
  const chatFromAddress = (): void => {
    const conversation = conversationFromHash(location.hash);
    if (conversation) pending = { route: "chat", opts: { conversation } };
  };
  window.addEventListener("hashchange", chatFromAddress, { signal: lifetime.signal });
  window.addEventListener("hashchange", render, { signal: lifetime.signal });
  // A notification tapped while the app is open: the service worker says where to go. And when the browser
  // replaces this device's push subscription, the node is handed the new one.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener(
      "message",
      (event: MessageEvent) => {
        const open = readOpenMessage(event.data);
        if (open) ctx.navigate(open.route, open.conversation ? { conversation: open.conversation } : {});
        else if ((event.data as { type?: string } | null)?.type === "galahad:push-changed") void syncPush(base.api);
      },
      { signal: lifetime.signal },
    );
  }

  // ---------- command palette ----------
  const paletteSource = {
    commands(): Command[] {
      const go: Command[] = goToOf(visible).map((spec) => ({
        id: `go:${spec.id}`,
        label: spec.label,
        group: "Go to",
        icon: spec.icon,
        keywords: [...spec.keywords],
        hint: spec.key ? `G ${spec.key.toUpperCase()}` : undefined,
        run: () => ctx.navigate(spec.id),
      }));
      const actions: Command[] = [];
      if (can("chat")) actions.push({ id: "new-chat", label: "New chat", group: "Actions", icon: "chat", keywords: ["clear", "conversation"], run: () => (startNewChat(), ctx.navigate("chat")) });
      if (can("vault:write")) actions.push({ id: "add-key", label: "Add an API key", group: "Actions", icon: "key", keywords: ["vault", "secret", "seal", "token", "credential"], run: () => openAddKey(ctx) });
      if (can("brain:write")) actions.push({ id: "add-mcp", label: "Add an MCP server", group: "Actions", icon: "plug", keywords: ["mcp", "tools", "server", "connect"], run: () => ctx.navigate("connectors", { intent: "add-mcp" }) });
      if (can("brain:write")) actions.push({ id: "add-connector", label: "Add a connector", group: "Actions", icon: "plug", keywords: ["github", "cloudflare", "home assistant", "install", "service"], run: () => ctx.navigate("connectors", { intent: "catalog" }) });
      if (can("fleet:admin") && can("chat")) actions.push({ id: "give", label: "Give a task to the Roundtable", group: "Actions", icon: "layers", keywords: ["task", "knights", "delegate", "best suited", "assign"], run: () => giveToRoundtable(ctx) });
      if (can("fleet:admin")) {
        actions.push({ id: "invite-client", label: "Pair a phone or browser", group: "Actions", icon: "phone", keywords: ["invite", "device", "add"], run: () => openInvite(ctx, "client") });
        actions.push({ id: "invite-node", label: "Add a machine to the fleet", group: "Actions", icon: "server", keywords: ["invite", "node", "join"], run: () => openInvite(ctx, "node") });
      }
      if (can("mind:write")) actions.push({ id: "remember", label: "Remember something", group: "Actions", icon: "memory", keywords: ["note", "add memory"], run: () => openRemember(ctx) });
      if (can("mind:write")) actions.push({ id: "new-idea", label: "New idea", group: "Actions", icon: "lightbulb", keywords: ["archive", "note", "keep", "thought"], run: () => openNewIdea(ctx) });
      if (can("sandbox")) actions.push({ id: "create-sandbox", label: "Create a sandbox", group: "Actions", icon: "sandbox", keywords: ["container", "vm", "new"], run: () => openCreateSandbox(ctx) });
      if (can("mind:read")) actions.push({ id: "place", label: "Where would this run?", group: "Actions", icon: "compass", keywords: ["placement", "playground", "schedule"], run: () => ctx.navigate("fleet", { intent: "place" }) });
      if (can("brain:write")) actions.push({ id: "add-loop", label: "Add a loop", group: "Actions", icon: "repeat", keywords: ["schedule", "cron", "every", "routine"], run: () => openLoopSheet(ctx) });
      if (can("mind:read")) actions.push({ id: "heartbeat", label: "Run the heartbeat's checks now", group: "Actions", icon: "review", keywords: ["health", "check", "notices"], run: () => ctx.navigate("loops", { intent: "check" }) });
      const appearance: Command[] = [
        { id: "theme-system", label: "Theme: match system", group: "Appearance", icon: "monitor", keywords: ["auto"], run: () => setTheme("system") },
        { id: "theme-light", label: "Theme: light", group: "Appearance", icon: "sun", run: () => setTheme("light") },
        { id: "theme-dark", label: "Theme: dark", group: "Appearance", icon: "moon", run: () => setTheme("dark") },
        { id: "motion-reduce", label: "Reduce motion", group: "Appearance", icon: "zap", keywords: ["animation", "accessibility"], run: () => setMotion("reduce") },
        { id: "motion-system", label: "Motion: match system", group: "Appearance", icon: "zap", keywords: ["animation"], run: () => setMotion("system") },
        { id: "sidebar", label: "Show or hide the sidebar", group: "Appearance", icon: "sidebar", hint: "[", run: toggleSidebar },
      ];
      const device: Command[] = [
        { id: "places", label: "Everything else…", group: "Go to", icon: "more", keywords: ["places", "menu", "index", "more", "settings"], run: () => openPlaces(ctx) },
        { id: "shortcuts", label: "Keyboard shortcuts", group: "Help", icon: "command", hint: "?", run: openShortcuts },
        { id: "forget", label: "Forget this browser…", group: "Help", icon: "logout", keywords: ["sign out", "unpair", "remove key"], run: () => void forgetThisBrowser() },
      ];
      return [...go, ...actions, ...appearance, ...device];
    },
    dynamic(query: string): Command[] {
      const out: Command[] = [];
      const { chats, projects } = chatsForPalette(base.api, { chat: can("chat"), read: can("mind:read") });
      const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      for (const p of projects.filter((p) => words.every((w) => `${p.name} ${p.id}`.toLowerCase().includes(w))).slice(0, 3)) {
        out.push({ id: `project:${p.id}`, label: p.name, group: "Projects", icon: "folder", run: () => ctx.navigate("projects", { project: p.id }) });
      }
      for (const c of filterConversations(chats, query, projectName).slice(0, 5)) {
        out.push({ id: `chat:${c.id}`, label: c.title, group: "Chats", icon: c.pinned ? "pin" : "chat", hint: c.project ? projectName(c.project) : undefined, run: () => ctx.navigate("chat", { conversation: c.id }) });
      }
      if (can("mind:read")) out.push({ id: "q-memory", label: `Search memory for “${query}”`, group: "Search", icon: "memory", run: () => ctx.navigate("memory", { query }) });
      if (can("chat")) out.push({ id: "q-chat", label: `Ask Galahad: “${query}”`, group: "Search", icon: "mark", run: () => ctx.navigate("chat", { query }) });
      return out;
    },
  };

  function openShortcuts(): void {
    const mod = isMac() ? "⌘" : "Ctrl";
    const row = (label: string, ...keys: string[]) => [h("span", {}, label), h("span", { class: "keys" }, ...kbd(...keys))];
    openSheet({
      title: "Keyboard shortcuts",
      size: "small",
      body: h(
        "div",
        { class: "help-list" },
        ...row("Search and commands", mod, "K"),
        ...row("Show shortcuts", "?"),
        ...row("Show or hide the sidebar", "["),
        ...keyedOf(visible).flatMap((spec) => row(`Go to ${spec.label}`, "G", spec.key.toUpperCase())),
        ...row("Send message", "Enter"),
        ...row("New line in a message", "Shift", "Enter"),
        ...row("Stop Galahad answering", "Esc"),
      ),
    });
  }

  // ---------- keyboard ----------
  let gPressed = 0;
  document.addEventListener("keydown", onKey, { signal: lifetime.signal });
  function onKey(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
      event.preventDefault();
      ctx.palette();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target) || isPaletteOpen() || document.querySelector("dialog[open]")) return;
    if (event.key === "?") {
      event.preventDefault();
      openShortcuts();
    } else if (event.key === "[") {
      toggleSidebar();
    } else if (event.key === "/") {
      event.preventDefault();
      ctx.palette();
    } else if (event.key.toLowerCase() === "g") {
      gPressed = Date.now();
    } else if (Date.now() - gPressed < 1200) {
      const spec = keyedOf(visible).find((r) => r.key === event.key.toLowerCase());
      gPressed = 0;
      if (spec) {
        event.preventDefault();
        ctx.navigate(spec.id);
      }
    }
  }

  // ---------- go ----------
  // His line says what he is doing wherever it shows (the sidebar's pinned row, Home's header): asked for here while no
  // chat is on screen to ask it.
  const work = (): void => {
    if (hasWork && (!narrow.matches || current === "home")) void lookAtWork(base.api, { chat: can("chat"), read: can("mind:read") });
  };
  // (Asked again when the turns or the quests change; every 15 s while the node's stream is down.)
  lifetime.signal.addEventListener("abort", live.follow(["turns", "quests"], work, 15_000));
  chatFromAddress();
  const initial = routeFromHash() ?? home();
  // (Tidied to its page; Team's address keeps its room and tab, and a task's its id, which is what a reload comes back to.)
  const landing = landingOf(initial, location.hash);
  if (location.hash !== landing) history.replaceState(null, "", landing);
  render();
  work();
  return {
    dispose() {
      lifetime.abort();
      sidebar?.dispose();
      viewScope?.dispose();
      titleObserver?.disconnect();
      live.stop();
    },
  };
}
