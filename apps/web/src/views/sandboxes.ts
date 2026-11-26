import type { FleetView, ProviderView, SandboxView } from "@galahad/core";
import { ApiError, isUnavailable } from "../api.ts";
import { type Ctx, errorMessage, type View } from "../context.ts";
import { diskUse, gatewayUse, IMAGES, isLab, ISOLATION, type IsolationChoice, isolationPlan, makesSandboxes } from "../lib/sandbox.ts";
import { gb, parseCommand, plural } from "../lib/text.ts";
import { duration, minutesLabel, relativeTime } from "../lib/time.ts";
import { asCaps, type ExecResult, type NetworkMode } from "../types.ts";
import { badge, busy, button, callout, disclosure, empty, errorState, field, formActions, meter, pageBody, pageHead, rangeControl, section, segmented, skeletonBlock, switchControl, type Tone } from "../ui/controls.ts";
import { confirmAction, openSheet } from "../ui/dialog.ts";
import { h, replace } from "../ui/dom.ts";
import { icon, type IconName } from "../ui/icons.ts";
import { signal } from "../ui/signal.ts";
import { toast } from "../ui/toast.ts";
import { openKeepWork } from "./artifacts.ts";
import { isOnline } from "./fleet.ts";
import { openTerminal } from "./terminal.ts";

/*
 * Sandboxes: disposable machines with an explicit network boundary.
 *   isolated  no network at all
 *   gateway   models only, via scoped expiring tokens; no internet (default)
 *   online    internet and models
 * The backend ships alongside this UI; on nodes without it (404/424) the
 * page says so plainly instead of failing.
 */

export const NETWORK: Record<NetworkMode, { label: string; icon: IconName; tone: Tone; color: string; explain: string }> = {
  isolated: { label: "Isolated", icon: "isolated", tone: "ok", color: "var(--ok)", explain: "No network at all. The safest choice for untrusted code and files." },
  gateway: {
    label: "Gateway",
    icon: "gateway",
    tone: "info",
    color: "var(--info)",
    explain: "No internet. Models only, through scoped, expiring gateway tokens; your keys never enter the sandbox.",
  },
  online: {
    label: "Online",
    icon: "globe",
    tone: "warn",
    color: "var(--warn)",
    explain: "Internet and models. What it reads from the web is untrusted: keep secrets and private data out of it.",
  },
};

const TTL_STEPS = [15, 30, 60, 120, 240, 480, 720, 1440, 2880, 10080];
/** Workspace sizes to choose from, in GB (the node takes 1 to 2048; 20 by default). */
const DISK_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1024, 2048];
const DISK_DEFAULT = 20;
const NO_DISK_LIMIT = "This machine can't cap a sandbox's disk: its workspace shares the machine's drive, so a runaway job could fill it.";
const sandboxesChanged = signal(0);

const statusTone = (status: string): Tone => (/run|ready|up/i.test(status) ? "ok" : /start|creat|pull/i.test(status) ? "info" : /err|fail|dead/i.test(status) ? "danger" : "neutral");

function sandboxNodes(fleet: FleetView | null): { name: string; cores: number; memoryGb: number; vm: boolean; mac: boolean }[] {
  if (!fleet) return [];
  return fleet.devices
    .filter((d) => d.kind === "node" && !d.revokedAt && isOnline(fleet, d))
    .map((d) => ({ d, caps: asCaps(d.caps) }))
    .filter(({ caps }) => caps && makesSandboxes(caps))
    .map(({ d, caps }) => ({ name: d.name, cores: caps?.cores ?? 4, memoryGb: caps?.memoryGb ?? 8, vm: Boolean(caps?.sandbox?.vm), mac: caps?.sandbox?.engine === "container" }));
}

export function openCreateSandbox(ctx: Ctx): void {
  if (!ctx.can("sandbox")) {
    toast("This device can't create sandboxes", { tone: "warn", description: "It needs the sandbox scope." });
    return;
  }
  const nodes = sandboxNodes(ctx.live.fleet.value);
  const maxCores = Math.max(2, ...nodes.map((n) => n.cores), 2);
  const maxMemory = Math.max(4, ...nodes.map((n) => n.memoryGb));
  let network: NetworkMode = "gateway";
  let isolation: IsolationChoice = "auto";
  let lab = false;
  let persistent = false;
  const providers = new Set<string>();

  const explain = h("div");
  const providersBox = h("div", { class: "chips", role: "group", "aria-label": "Providers it may use" }, h("span", { class: "tiny subtle" }, "Loading providers…"));
  const providersHint = h("div", { class: "hint" });
  const summary = h("div", { class: "notice-strip tnum" });

  const cpus = rangeControl({ label: "CPUs", min: 1, max: Math.min(64, maxCores), step: 1, value: Math.min(2, maxCores), format: (v) => `${v}`, onInput: () => sync() });
  const memory = rangeControl({ label: "Memory", min: 1, max: Math.min(256, maxMemory), step: 1, value: Math.min(4, maxMemory), format: (v) => gb(v), onInput: () => sync() });
  const disk = rangeControl({
    label: "Disk",
    min: 0,
    max: DISK_STEPS.length - 1,
    step: 1,
    value: DISK_STEPS.indexOf(DISK_DEFAULT),
    format: (i) => gb(DISK_STEPS[i] ?? DISK_DEFAULT),
    onInput: () => sync(),
    scale: ["1 GB", "2 TB"],
  });
  const ttl = rangeControl({
    label: "Expires after",
    min: 0,
    max: TTL_STEPS.length - 1,
    step: 1,
    value: TTL_STEPS.indexOf(60),
    format: (i) => minutesLabel(TTL_STEPS[i] ?? 60),
    onInput: () => sync(),
    scale: ["15 min", "7 d"],
  });
  const image = h("input", { class: "input mono", type: "text", placeholder: "default image", autocomplete: "off", autocorrect: "off", spellcheck: "false", autocapitalize: "off" });
  const quest = h("input", { class: "input", type: "text", placeholder: "e.g. try the new parser on untrusted samples", autocomplete: "off", maxlength: 200 });
  const where = h(
    "select",
    { class: "select" },
    h("option", { value: "" }, "Let Galahad place it"),
    ...nodes.map((n) => h("option", { value: n.name }, `On ${n.name}`)),
  );

  // Without a choice, it's made on the node this device talks to.
  const host = () => {
    const name = where.value || ctx.whoami.nodeName;
    const node = nodes.find((n) => n.name === name);
    return { name, vm: node?.vm ?? false, mac: node?.mac ?? false };
  };
  const plan = () => isolationPlan(isolation, network, host());

  function sync(): void {
    replace(explain, h("div", { class: "net-explain", "data-tone": NETWORK[network].tone }, icon(NETWORK[network].icon, { size: 16 }), h("div", {}, h("strong", {}, NETWORK[network].label), ". ", NETWORK[network].explain)));
    const p = plan();
    isolationControl.disable("vm", !p.vmAvailable, p.vmReason ?? undefined);
    if (isolation === "vm" && !p.vmAvailable) {
      isolation = "auto";
      isolationControl.set("auto");
    }
    isolationNote.textContent = p.note;
    imageNote.textContent = lab ? IMAGES.lab : IMAGES.workshop;
    image.disabled = lab;
    image.placeholder = lab ? "the Lab's own image" : "default image";
    vmNote.textContent = p.vmReason ? `MicroVM isn't available: ${p.vmReason}` : "";
    vmNote.hidden = !p.vmReason;
    const isolated = network === "isolated";
    for (const chip of providersBox.querySelectorAll<HTMLButtonElement>("button")) chip.disabled = isolated;
    providersHint.textContent = isolated ? "An isolated sandbox can't reach any model." : providers.size ? "Only these providers' models are reachable, through the gateway." : "None chosen: no model is reachable. Choose the providers whose models it may call.";
    replace(
      summary,
      icon(NETWORK[network].icon),
      `${lab ? "Lab · " : ""}${plural(cpus.value(), "CPU")} · ${gb(memory.value())} · ${gb(DISK_STEPS[disk.value()] ?? DISK_DEFAULT)} disk · ${NETWORK[network].label.toLowerCase()} · ${ISOLATION[p.isolation].label} · ${persistent ? "persistent" : `expires in ${minutesLabel(TTL_STEPS[ttl.value()] ?? 60)}`}`,
    );
  }

  const networkControl = segmented(
    (Object.keys(NETWORK) as NetworkMode[]).map((mode) => ({ value: mode, label: NETWORK[mode].label, icon: NETWORK[mode].icon, tone: NETWORK[mode].color })),
    network,
    (value) => {
      network = value;
      sync();
    },
    { label: "Network", block: true },
  );

  const imageNote = h("p", { class: "tiny subtle", "aria-live": "polite" });
  const imageControl = segmented<"workshop" | "lab">(
    [
      { value: "workshop", label: "Workshop", icon: "terminal" },
      { value: "lab", label: "Lab", icon: "flask" },
    ],
    "workshop",
    (value) => {
      lab = value === "lab";
      sync();
    },
    { label: "Image", small: true },
  );
  const isolationNote = h("p", { class: "tiny subtle", "aria-live": "polite" });
  const vmNote = h("p", { class: "tiny subtle" });
  const isolationControl = segmented<IsolationChoice>(
    [
      { value: "auto", label: "Automatic" },
      { value: "container", label: "Container" },
      { value: "vm", label: "MicroVM", icon: "shield" },
    ],
    isolation,
    (value) => {
      isolation = value;
      sync();
    },
    { label: "Isolation", small: true },
  );
  where.addEventListener("change", () => sync());

  const status = h("div");
  const create = button("Create sandbox", { variant: "primary", type: "submit", icon: "sandbox" });
  const form = h(
    "form",
    {
      class: "stack loose",
      onsubmit: (event: Event) => {
        event.preventDefault();
        const body = {
          network,
          cpus: cpus.value(),
          memoryGb: memory.value(),
          diskGb: DISK_STEPS[disk.value()] ?? DISK_DEFAULT,
          ...(plan().send ? { isolation: plan().send } : {}),
          ...(persistent ? { persistent: true } : { ttlMinutes: TTL_STEPS[ttl.value()] ?? 60 }),
          ...(network !== "isolated" && providers.size ? { providers: [...providers] } : {}),
          ...(lab ? { lab: true } : image.value.trim() ? { image: image.value.trim() } : {}),
          ...(quest.value.trim() ? { quest: quest.value.trim() } : {}),
          ...(where.value ? { on: where.value } : {}),
        };
        void busy(create, async () => {
          try {
            const { sandbox } = await ctx.api.post<{ sandbox: SandboxView }>("/api/sandboxes", body);
            sheet.close();
            sandboxesChanged.update((n) => n + 1);
            toast(`${sandbox.name} is ready`, { tone: "ok", description: `On ${sandbox.node}, ${NETWORK[sandbox.network]?.label.toLowerCase() ?? sandbox.network}.` });
          } catch (error) {
            replace(status, isUnavailable(error) ? callout("warn", "Sandboxes aren't available on that node yet.") : callout("danger", errorMessage(error)));
          }
        });
      },
    },
    h("div", { class: "stack tight" }, h("div", { class: "label" }, "Network"), networkControl.el, explain),
    h("div", { class: "stack tight" }, h("div", { class: "label" }, "Image"), h("div", {}, imageControl.el), imageNote),
    h("div", { class: "stack tight" }, h("div", { class: "label" }, "Isolation"), h("div", {}, isolationControl.el), h("div", { class: "stack snug" }, isolationNote, vmNote)),
    h("div", { class: "fields" }, cpus.el, memory.el),
    h("div", { class: "stack tight" }, disk.el, h("p", { class: "tiny subtle" }, "Its workspace can't grow past this. On a machine that can't cap disks, the sandbox says so.")),
    ttl.el,
    switchControl("Keep it after it expires", false, (on) => {
      persistent = on;
      ttl.input.disabled = on;
      sync();
    }, { hint: "Persistent sandboxes outlive their TTL. Under the oath, destroying one asks your approval." }),
    h("div", { class: "field" }, h("div", { class: "label" }, "Models it may use"), providersBox, providersHint),
    h("div", { class: "fields" }, field("What is it for? (optional)", quest), field("Image (optional)", image)),
    field("Where", where, { hint: nodes.length ? `${plural(nodes.length, "machine")} can host sandboxes right now.` : "No online machine reports Docker or a VM runtime; Galahad will try this node." }),
    summary,
    status,
    formActions(button("Cancel", { onClick: () => sheet.close() }), create),
  );
  const sheet = openSheet({ title: "Create a sandbox", description: "A disposable machine with a clear network boundary.", body: form, size: "wide" });
  sync();

  if (ctx.can("mind:read")) {
    ctx.api
      .get<{ providers: ProviderView[] }>("/api/providers")
      .then(({ providers: list }) => {
        if (sheet.scope.disposed) return;
        replace(
          providersBox,
          ...(list.length
            ? list.map((p) => {
                const chip = h("button", { class: "chip", type: "button", "aria-pressed": "false" }, icon("models"), p.id);
                chip.addEventListener("click", () => {
                  providers.has(p.id) ? providers.delete(p.id) : providers.add(p.id);
                  chip.setAttribute("aria-pressed", String(providers.has(p.id)));
                  sync();
                });
                return chip;
              })
            : [h("span", { class: "tiny subtle" }, "No providers configured yet.")]),
        );
        sync();
      })
      .catch(() => replace(providersBox, h("span", { class: "tiny subtle" }, "Couldn't load providers.")));
  } else replace(providersBox, h("span", { class: "tiny subtle" }, "Provider list needs the mind:read scope."));
}

const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");

export function openConsole(ctx: Ctx, sandbox: SandboxView, on: string | null): void {
  const out = h("div", { class: "console-out", role: "log", "aria-live": "polite", tabindex: 0 });
  const input = h("input", { type: "text", autocomplete: "off", autocorrect: "off", spellcheck: "false", autocapitalize: "off", "aria-label": "Command", placeholder: "ls -la" });
  const run = button("Run", { size: "sm", icon: "play", type: "submit" });
  const history: string[] = [];
  let cursor = 0;
  const line = (cls: string, text: string) => out.append(h("div", { class: cls }, text));
  line("sys", `${sandbox.name} on ${sandbox.node} · ${sandbox.network} · commands run with a 60 s timeout`);

  async function exec(event: Event): Promise<void> {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    const parsed = parseCommand(text);
    history.push(text);
    cursor = history.length;
    input.value = "";
    line("cmd", `$ ${text}`);
    if (parsed.viaShell) line("sys", "(shell syntax: running through sh -c)");
    await busy(run, async () => {
      input.disabled = true;
      try {
        const result = await ctx.api.post<ExecResult>("/api/sandboxes/exec", { id: sandbox.id, cmd: parsed.argv, timeoutSec: 60, ...(on ? { on } : {}) });
        if (result.stdout) line("", stripAnsi(result.stdout).replace(/\n$/, ""));
        if (result.stderr) line("err", stripAnsi(result.stderr).replace(/\n$/, ""));
        line("sys", `exit ${result.exitCode} · ${duration(result.durationMs)}${result.truncated ? " · output truncated" : ""}`);
      } catch (error) {
        line("err", errorMessage(error));
      } finally {
        input.disabled = false;
        input.focus();
        out.scrollTop = out.scrollHeight;
      }
    });
  }

  input.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "ArrowUp" && cursor > 0) {
      event.preventDefault();
      input.value = history[--cursor] ?? "";
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      cursor = Math.min(history.length, cursor + 1);
      input.value = history[cursor] ?? "";
    } else if (event.key === "l" && event.ctrlKey) {
      event.preventDefault();
      replace(out);
    }
  });

  openSheet({
    title: sandbox.name,
    description: h("span", { class: "row wrap" }, badge(NETWORK[sandbox.network]?.label ?? sandbox.network, NETWORK[sandbox.network]?.tone ?? "neutral", NETWORK[sandbox.network]?.icon), h("span", {}, `${plural(sandbox.cpus, "CPU")} · ${gb(sandbox.memoryGb)} · ${sandbox.image}`)),
    size: "wide",
    body: h("form", { class: "console", onsubmit: (event: Event) => void exec(event) }, out, h("div", { class: "console-in" }, h("span", { "aria-hidden": "true" }, "$"), input, run)),
    initialFocus: () => input,
  });
}

async function destroy(ctx: Ctx, sandbox: SandboxView, on: string | null): Promise<void> {
  const ok = await confirmAction({
    title: `Destroy ${sandbox.name}?`,
    body: sandbox.ephemeral
      ? "It and everything inside it are deleted. It was ephemeral, so nothing else depends on it."
      : [h("p", {}, "It's persistent: everything inside it is deleted for good."), h("p", {}, "Under the oath, Galahad may ask for your approval first.")],
    confirmLabel: "Destroy sandbox",
  });
  if (!ok) return;
  try {
    await ctx.api.post("/api/sandboxes/destroy", { id: sandbox.id, ...(on ? { on } : {}) });
    toast(`${sandbox.name} destroyed`, { tone: "ok" });
    sandboxesChanged.update((n) => n + 1);
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      toast("The oath asks for approval first", { tone: "warn", description: error.message, duration: 10_000 });
    } else toast("Couldn't destroy it", { tone: "error", description: errorMessage(error) });
  }
}

/** How it's isolated: its own microVM stands out; a container is the quiet default. */
function isolationBadge(sandbox: SandboxView): HTMLElement | null {
  if (sandbox.isolation === "vm") return h("span", { title: ISOLATION.vm.explain }, badge(ISOLATION.vm.label, "ok", "shield-check"));
  if (sandbox.isolation === "container") return h("span", { class: "badge outline", title: ISOLATION.container.explain }, ISOLATION.container.label);
  return null;
}

/** Disk used of its limit, with a meter; or a plain warning when its machine can't cap it. */
function diskLine(sandbox: SandboxView): HTMLElement {
  const use = diskUse(sandbox.disk ?? null);
  return h(
    "div",
    {},
    h(
      "div",
      { class: "load-label" },
      h("span", {}, "Disk"),
      sandbox.disk ? h("span", { class: "tnum" }, use.text) : h("span", { title: NO_DISK_LIMIT }, badge(use.text, "warn", "alert")),
    ),
    use.fraction !== null ? meter(use.fraction, use.nearlyFull ? "var(--warn)" : undefined, `Disk: ${use.text}`) : null,
  );
}

function sandboxCard(ctx: Ctx, sandbox: SandboxView, on: string | null): HTMLElement {
  const net = NETWORK[sandbox.network];
  const expires = h("span", { class: "tnum" });
  const tick = () => {
    expires.textContent = sandbox.ephemeral || sandbox.expiresAt ? (sandbox.expiresAt > Date.now() ? `expires ${relativeTime(sandbox.expiresAt)}` : "expired") : "persistent";
  };
  tick();
  return h(
    "article",
    { class: "card node-card" },
    h(
      "div",
      { class: "node-head" },
      h("span", { class: "node-icon" }, icon("sandbox")),
      h(
        "div",
        { class: "grow" },
        h(
          "div",
          { class: "row wrap" },
          h("span", { class: "node-name mono" }, sandbox.name),
          badge(sandbox.status, statusTone(sandbox.status)),
          net ? badge(net.label, net.tone, net.icon) : badge(sandbox.network),
          isolationBadge(sandbox),
        ),
        h("div", { class: "node-sub" }, sandbox.quest ? h("span", {}, sandbox.quest) : h("span", {}, "no quest"), h("span", {}, "·"), expires, ...(sandbox.ephemeral || sandbox.expiresAt ? [h("span", {}, "·"), h("span", {}, sandbox.ephemeral ? "ephemeral" : "persistent")] : [])),
      ),
    ),
    h(
      "div",
      { class: "node-body" },
      h(
        "div",
        { class: "chips" },
        h("span", { class: "chip" }, icon("cpu"), plural(sandbox.cpus, "CPU")),
        h("span", { class: "chip" }, icon("ram"), gb(sandbox.memoryGb)),
        isLab(sandbox.image) ? h("span", { class: "chip on", title: IMAGES.lab }, icon("flask"), "Lab") : null,
        h("span", { class: "chip mono" }, icon("layers"), sandbox.image),
        ...sandbox.providers.map((p) => {
          const use = gatewayUse(p);
          return h("span", { class: "chip", title: use.title }, icon(use.kind === "search" ? "globe" : "models"), use.label);
        }),
      ),
      diskLine(sandbox),
      h(
        "div",
        { class: "row" },
        // A terminal on this node; a sandbox on another has the one-command console.
        on === null
          ? button("Terminal", { size: "sm", icon: "terminal", onClick: () => void openTerminal(ctx, sandbox) })
          : button("Console", { size: "sm", icon: "terminal", onClick: () => openConsole(ctx, sandbox, on) }),
        /run|up/i.test(sandbox.status) && ctx.can("sandbox")
          ? button("Keep work…", { size: "sm", icon: "archive", title: "Keep its /work/out (or another folder) after it's gone", onClick: () => openKeepWork(ctx, sandbox, on) })
          : null,
        h("span", { class: "spacer" }),
        button("Destroy", { size: "sm", variant: "danger", icon: "trash", onClick: () => void destroy(ctx, sandbox, on) }),
      ),
    ),
  );
}

export const sandboxesView: View = (root, ctx, { scope, opts }) => {
  const body = h("div", { class: "stack loose" }, skeletonBlock(160));

  async function load(): Promise<void> {
    if (!ctx.can("sandbox")) {
      replace(
        body,
        h(
          "div",
          { class: "card" },
          empty({
            icon: "shield",
            title: "This device can't use sandboxes yet",
            body: "It was paired before sandboxes existed, or without them. Pair it again with an invite that allows sandboxes, then revoke the old entry.",
          }),
        ),
      );
      return;
    }
    let local: { node: string; sandboxes: SandboxView[] } | null = null;
    try {
      local = await ctx.api.post<{ node: string; sandboxes: SandboxView[] }>("/api/sandboxes/list", {}, scope.signal);
    } catch (error) {
      if (scope.disposed) return;
      // This node isn't a sandbox host (no Docker here): the fleet's other hosts are still listed.
      if (!(error instanceof ApiError && error.status === 424)) {
        replace(
          body,
          isUnavailable(error)
            ? h(
                "div",
                { class: "card" },
                empty({
                  icon: "sandbox",
                  title: "Sandboxes aren't available on this node yet",
                  body: "They arrive with an upcoming update: disposable machines for untrusted or risky work, each with its own network boundary and expiry.",
                }),
              )
            : errorState("Couldn't list sandboxes", error, () => void load()),
        );
        return;
      }
    }
    const self = local?.node ?? ctx.whoami.nodeName;
    const others = sandboxNodes(ctx.live.fleet.value).filter((n) => n.name !== self);
    const remote = await Promise.all(
      others.map(async (n) => {
        try {
          return { name: n.name, result: await ctx.api.post<{ node: string; sandboxes: SandboxView[] }>("/api/sandboxes/list", { on: n.name }, scope.signal), error: null as unknown };
        } catch (error) {
          return { name: n.name, result: null, error };
        }
      }),
    );
    if (scope.disposed) return;
    const group = (name: string, list: SandboxView[] | null, error: unknown, on: string | null) =>
      section(
        name,
        { count: list ? plural(list.length, "sandbox", "sandboxes") : "" },
        list
          ? list.length
            ? h(
                "div",
                { class: "stack" },
                list.some((s) => !s.disk) ? callout("warn", `${NO_DISK_LIMIT} Your Inbox has a notice that says how to fix it.`, { title: "No disk limit here" }) : null,
                h("div", { class: "grid wide" }, ...list.map((s) => sandboxCard(ctx, s, on))),
              )
            : h("div", { class: "card" }, empty({ icon: "sandbox", title: "None running", compact: true }))
          : h("div", { class: "card pad" }, callout("quiet", isUnavailable(error) ? "Not available on this node yet." : `Couldn't reach it: ${errorMessage(error)}`)),
      );
    const here = local
      ? group(`${local.node} · this node`, local.sandboxes, null, null)
      : section(
          `${self} · this node`,
          {},
          h(
            "div",
            { class: "card pad" },
            callout("quiet", others.length ? "This node doesn't run sandboxes (it has no Docker). Your sandbox hosts are below." : "This node doesn't run sandboxes: it has no Docker, and no other node in the fleet does either. Install Docker on one of your servers and it becomes a sandbox host.", { icon: "sandbox" }),
          ),
        );
    replace(body, here, ...remote.map((r) => group(r.name, r.result?.sandboxes ?? null, r.error, r.name)));
  }

  replace(
    root,
    h(
      "div",
      { class: "page" },
      pageHead(
        "Sandboxes",
        "Disposable machines for untrusted or risky work. Each has a clear network boundary and expires on its own.",
        ctx.can("sandbox") ? button("Create sandbox", { variant: "primary", icon: "plus", onClick: () => openCreateSandbox(ctx) }) : null,
      ),
      // Shown whole once every host has answered: the hosts' sections came in one by one, and pushed this down.
      pageBody(
        body,
        // What each network boundary means: one line until it's wanted (the create form explains the one you pick).
        disclosure(
          [h("span", { class: "grow" }, "How a sandbox reaches the network"), h("span", { class: "row wrap" }, ...(Object.keys(NETWORK) as NetworkMode[]).map((mode) => badge(NETWORK[mode].label, NETWORK[mode].tone, NETWORK[mode].icon)))],
          {},
          ...(Object.keys(NETWORK) as NetworkMode[]).map((mode) =>
            h(
              "div",
              { class: "net-explain", "data-tone": NETWORK[mode].tone },
              icon(NETWORK[mode].icon, { size: 16 }),
              h(
                "div",
                { class: "small" },
                h("strong", {}, NETWORK[mode].label),
                h("div", { class: "muted" }, NETWORK[mode].explain),
                mode === "online" ? h("div", { class: "muted" }, "It runs in its own microVM where the host supports it.") : null,
              ),
            ),
          ),
        ),
      ),
    ),
  );

  scope.add(sandboxesChanged.subscribe(() => void load()));
  if (ctx.can("sandbox")) scope.interval(() => void load(), 30_000);
  void load();
  if (opts.intent === "create") openCreateSandbox(ctx);
};
