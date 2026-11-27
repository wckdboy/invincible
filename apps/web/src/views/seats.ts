import type { TeamSnapshot } from "@invincible/core/team";
import { HOMED_KINDS, SEAT_HARNESS, servedBy } from "@invincible/core/seat-agents";
import type { SeatSignInCard, SeatUse, SeatView } from "@invincible/core/seats";
import { ApiError } from "../api.ts";
import { errorMessage, type View } from "../context.ts";
import { cardWords, QUICK_ADDS, quickAgent, quickLabel, SEAT_KIND_WORDS, seatMeterWords, seatStateWords, servesChoiceWords, servesWords, signInAction, USE_ELSEWHERE } from "../lib/seats.ts";
import { HARNESS } from "../lib/team.ts";
import { badge, busy, button, callout, card, errorState, list, listRow, note, pageBody, pageHead, section, skeletonRows } from "../ui/controls.ts";
import { confirmAction, openSheet } from "../ui/dialog.ts";
import { h, replace } from "../ui/dom.ts";
import { toast } from "../ui/toast.ts";

/*
 * Seats (core's seats.ts): the accounts you hold with a vendor, each signed in on its vendor's own page, each serving the
 * agents you chose. Adding a Claude or ChatGPT plan is one tap, for the first of your agents on its tool that has none
 * (or none, and it serves none until you choose), and its sign-in begins at once: its card says what the vendor's tool
 * asks of you (its page to open, Codex's code to enter there, or a field for the code Claude's page shows), and the card
 * is the device's alone: never kept. The list says where each stands and whom it serves (worked out from this node's
 * agents: one you removed is served no more), and offers to sign one in again before its sign-in ends. Its agents are
 * chosen in a sheet that says, before you save, what a share means (they are one trust domain), and what a move does.
 * Under each, its meter: its windows still open and its use lately, and where its vendor counts its use, if it asks.
 * Yours alone to change (fleet:admin); read by anyone who may read the mind.
 */

export const seatsView: View = (root, ctx, { scope }) => {
  const yours = ctx.can("fleet:admin");
  const listBox = h("div", {}, card({ flush: true }, skeletonRows(2)));
  const cardBox = h("div", { class: "stack" });
  let seats: SeatView[] = [];
  /** This node's agents, as its team lists them (null: not to be read here). Only a seat whose home is on this node serves them. */
  let roster: TeamSnapshot["agents"] | null = null;
  /** This node's seats' use lately, by id (the meter: core's SeatUse). */
  let use: Record<string, SeatUse> = {};
  const here = ctx.whoami.node;
  const rosterOf = (seat: Pick<SeatView, "node">) => (seat.node === here ? roster : null);
  /** The sign-in under way from this device, and the code field it may have. */
  let signing: { card: SeatSignInCard; label: string; kind: SeatView["kind"] } | null = null;
  /** Why a seat you asked for wasn't added yet, said where its card would be: a node of the fleet that can't read its kind, to update first. */
  let held: string | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;

  const adds = yours ? h("div", { class: "row wrap" }, ...QUICK_ADDS.map((quick) => button(quick.button, { variant: "primary", icon: "plus", onClick: (event) => void add(event.currentTarget as HTMLButtonElement, quick.kind) }))) : null;
  replace(
    root,
    pageHead("Seats", "The accounts you hold with Claude, ChatGPT and others, each signed in on its vendor's own page. Each serves one agent of yours (a new one, the first on its tool that has none), and agents share one only when you say so. A running task never moves to a second account of the same vendor.", adds),
    pageBody(cardBox, section("Your seats", {}, listBox), note("Invincible never signs in for you and never holds a sign-in: the vendor's own tool keeps it in the seat's home on this node, and says only whether it is signed in, how, its plan, and when its sign-in ends.")),
  );

  function row(seat: SeatView): HTMLElement {
    const now = Date.now();
    const state = seatStateWords(seat.state, seat.plan, now);
    const action = yours ? signInAction(seat, now) : null;
    const serves = servesWords(seat, rosterOf(seat));
    // (Its agents are chosen on the node that holds its home, of that node's: only a seat with a home serves agents.)
    const choosable = yours && roster !== null && seat.node === here && HOMED_KINDS.includes(seat.kind);
    return listRow({
      lead: "user",
      leadTone: state.tone === "ok" ? "ok" : state.tone === "warn" ? "warn" : state.tone === "work" ? "work" : "neutral",
      title: seat.label,
      sub: `${SEAT_KIND_WORDS[seat.kind].name} · ${SEAT_KIND_WORDS[seat.kind].how}`,
      meta: [badge(state.word, state.tone === "ok" ? "ok" : state.tone === "warn" ? "warn" : state.tone === "work" ? "work" : "neutral"), HOMED_KINDS.includes(seat.kind) ? h("span", {}, serves.word) : null],
      trail: yours
        ? h(
            "span",
            { class: "row tight" },
            action ? button(action, { size: "sm", onClick: (event) => void signIn(event.currentTarget as HTMLButtonElement, seat) }) : null,
            choosable ? button("Agents", { size: "sm", variant: "ghost", label: `The agents ${seat.label} serves`, onClick: () => chooseAgents(seat) }) : null,
            button(`Remove ${seat.label}`, { size: "sm", variant: "ghost", iconOnly: true, icon: "trash", onClick: () => void remove(seat) }),
          )
        : null,
      body: meter(seat, now),
      key: `seat:${seat.id}`,
      // (On a phone its buttons go under its words, which keep their width.)
      wrap: yours,
    });
  }

  /** A seat's meter, a line for each window and one for its use, and where its vendor counts its use (a ChatGPT plan's, in ChatGPT's settings). */
  function meter(seat: SeatView, now: number): HTMLElement | undefined {
    const words = seatMeterWords(seat, use[seat.id], now);
    const elsewhere = USE_ELSEWHERE[seat.kind];
    if (!words.length && !elsewhere) return undefined;
    return h(
      "div",
      { class: "stack tight" },
      ...words.map((line) => h("p", { class: "tiny subtle tnum" }, line)),
      elsewhere ? h("a", { class: "tiny", href: elsewhere.url, target: "_blank", rel: "noopener noreferrer" }, elsewhere.words) : null,
    );
  }

  function drawCard(): void {
    if (!signing) {
      replace(cardBox, held ? callout("warn", h("p", { class: "small" }, held), { title: "Not added yet", actions: button("Dismiss", { variant: "ghost", onClick: () => ((held = null), drawCard()) }) }) : null);
      return;
    }
    const { card: open, label, kind } = signing;
    const words = cardWords(open, kind);
    const code = open.kind === "paste-code" ? (h("input", { class: "input mono", type: "text", autocomplete: "off", autocorrect: "off", autocapitalize: "off", spellcheck: "false", "aria-label": "The code its page shows", placeholder: "Paste the code it shows" }) as HTMLInputElement) : null;
    const submit = code ? button("Sign in", { variant: "primary", onClick: (event) => void answer(event.currentTarget as HTMLButtonElement, code) }) : null;
    const opened = h("a", { class: "btn primary", href: open.url, target: "_blank", rel: "noopener noreferrer" }, words.open);
    replace(
      cardBox,
      callout(
        "info",
        h(
          "div",
          { class: "stack" },
          words.first ? h("p", { class: "small" }, words.first) : null,
          h("ol", { class: "seat-steps" }, ...words.steps.map((step) => h("li", {}, step))),
          open.code ? h("div", { class: "row" }, h("span", { class: "mono seat-code", "aria-label": `The code: ${open.code}` }, open.code), button("Copy", { size: "sm", icon: "copy", onClick: () => void navigator.clipboard?.writeText(open.code!).then(() => toast("Copied")) })) : null,
          code ? h("div", { class: "row" }, code, submit) : null,
        ),
        { title: `${words.title} · ${label}`, icon: "user", actions: h("span", { class: "row tight" }, opened, button("Cancel", { variant: "ghost", onClick: () => void cancel() })) },
      ),
    );
  }

  async function refresh(): Promise<void> {
    try {
      const [listed, team] = await Promise.all([ctx.api.get<{ seats: SeatView[]; use?: Record<string, SeatUse> }>("/api/seats", scope.signal), yours ? ctx.api.get<TeamSnapshot>("/api/team", scope.signal).catch(() => null) : null]);
      if (scope.disposed) return;
      seats = listed.seats;
      use = listed.use ?? {};
      roster = team?.agents ?? null;
      // Its sign-in ended (ready, or not): the card goes, and the list says how.
      if (signing && seats.find((seat) => seat.id === signing!.card.seat)?.state.is !== "signing-in") {
        const ended = seats.find((seat) => seat.id === signing!.card.seat);
        if (ended?.state.is === "ready") toast(`${ended.label} is signed in`, { tone: "ok" });
        signing = null;
        drawCard();
        stopPolling();
      }
      replace(listBox, list(seats.map(row), { empty: { icon: "user", title: "No seats yet", body: yours ? "Add a Claude, ChatGPT or Gemini plan: it signs in on its vendor's page." : "The owner adds them." } }));
    } catch (error) {
      if (!scope.disposed) replace(listBox, errorState("The seats can't be read", error, () => void refresh()));
    }
  }

  function startPolling(): void {
    stopPolling();
    // (While a sign-in waits for you: how it stands, every two seconds, until it has ended.)
    poll = setInterval(() => void refresh(), 2_000);
  }
  function stopPolling(): void {
    if (poll) clearInterval(poll);
    poll = null;
  }
  scope.add(() => stopPolling());

  async function begin(seat: Pick<SeatView, "id" | "kind" | "label" | "node" | "serves">): Promise<void> {
    const started = await ctx.api.post<{ card: SeatSignInCard }>("/api/seats/sign-in", { id: seat.id }, scope.signal);
    held = null;
    const serves = servesWords(seat, rosterOf(seat));
    signing = { card: started.card, label: seat.serves.length ? `${seat.label}, ${serves.word.charAt(0).toLowerCase()}${serves.word.slice(1)}` : seat.label, kind: seat.kind };
    drawCard();
    startPolling();
  }

  async function add(trigger: HTMLButtonElement, kind: SeatView["kind"]): Promise<void> {
    held = null;
    drawCard();
    await busy(trigger, async () => {
      let added: { seat: SeatView } | null = null;
      try {
        // For the first of your agents on its tool that no seat of its kind serves yet (its card and its row say whom).
        const agent = roster ? quickAgent(kind, seats, roster) : null;
        added = await ctx.api.post<{ seat: SeatView }>("/api/seats", { kind, label: quickLabel(kind, seats), ...(agent ? { agent: agent.id } : {}) }, scope.signal);
        await refresh();
        await begin(added.seat);
      } catch (error) {
        // Not added: a node of the fleet can't read its kind yet. Its card says which, and that it is updated first.
        if (!added && error instanceof ApiError && error.status === 409) {
          held = error.message;
          drawCard();
          return;
        }
        toast("The seat wasn't signed in", { tone: "error", description: errorMessage(error) });
        await refresh();
      }
    });
  }

  async function signIn(trigger: HTMLButtonElement, seat: SeatView): Promise<void> {
    await busy(trigger, async () => {
      try {
        await begin(seat);
      } catch (error) {
        toast("It couldn't start signing in", { tone: "error", description: errorMessage(error) });
      }
    });
  }

  async function answer(trigger: HTMLButtonElement, field: HTMLInputElement): Promise<void> {
    const code = field.value.trim();
    if (!signing || !code) return;
    await busy(trigger, async () => {
      try {
        await ctx.api.post("/api/seats/sign-in/answer", { id: signing!.card.seat, attempt: signing!.card.attempt, code }, scope.signal);
        field.value = "";
        field.disabled = true;
      } catch (error) {
        toast("The code didn't reach it", { tone: "error", description: errorMessage(error) });
      }
    });
  }

  async function cancel(): Promise<void> {
    if (!signing) return;
    const { card: open } = signing;
    try {
      await ctx.api.post("/api/seats/sign-in/cancel", { id: open.seat, attempt: open.attempt }, scope.signal);
    } catch (error) {
      toast("It couldn't be cancelled", { tone: "error", description: errorMessage(error) });
    }
    signing = null;
    drawCard();
    stopPolling();
    await refresh();
  }

  /**
   * The agents a seat serves, chosen in a sheet: this node's agents on its tool (and any it serves now). Before you save,
   * it says what the choice means: agents sharing a seat are one trust domain, and one in place of another runs with what
   * that one's runs left in its home. A share is sent as one you said.
   */
  function chooseAgents(seat: SeatView): void {
    const agents = (roster ?? []).filter((agent) => agent.harness === SEAT_HARNESS[seat.kind] || seat.serves.some((one) => one.id === agent.id));
    const tool = HARNESS[SEAT_HARNESS[seat.kind] as keyof typeof HARNESS] ?? "its tool";
    const current = servedBy(seat, agents);
    const chosen = new Set(current.map((agent) => agent.id));
    const named = (ids: Iterable<string>) => agents.filter((agent) => [...ids].includes(agent.id)).map((agent) => agent.name || agent.id);
    const means = h("div", { class: "stack tight" });
    const save = button("Save", { variant: "primary", block: true });
    const update = () => {
      const words = servesChoiceWords(seat.label, current.map((agent) => agent.name || agent.id), named(chosen));
      replace(means, words ? callout("warn", words, { icon: "agents" }) : null);
      save.querySelector("span")?.replaceChildren(chosen.size > 1 ? `Share with ${chosen.size} agents` : "Save");
    };
    const boxes = agents.map((agent) => {
      const box = h("input", { type: "checkbox", checked: chosen.has(agent.id) }) as HTMLInputElement;
      box.addEventListener("change", () => {
        if (box.checked) chosen.add(agent.id);
        else chosen.delete(agent.id);
        update();
      });
      // (One on another tool is said to take it only once it works in this seat's.)
      const on = HARNESS[agent.harness] ?? agent.harness;
      return h("label", { class: "scope" }, box, h("span", {}, h("strong", {}, agent.name || agent.id), h("div", { class: "tiny subtle" }, agent.harness === SEAT_HARNESS[seat.kind] ? on : `${on}: it takes this seat only once it works in ${tool}`)));
    });
    const sheet = openSheet({
      title: `The agents ${seat.label} serves`,
      description: "A seat serves one agent. Agents that share one share its home, and what one's runs leave there the next runs with: share a seat only between agents you would trust with each other's work.",
      body: h("div", { class: "stack" }, agents.length ? h("div", { class: "scope-list" }, ...boxes) : callout("info", `None of this node's agents works in ${tool} yet: one that does can take this seat once you choose it here.`), means),
      footer: save,
    });
    save.addEventListener("click", () =>
      void busy(save, async () => {
        const ids = agents.filter((agent) => chosen.has(agent.id)).map((agent) => agent.id);
        try {
          const done = await ctx.api.post<{ seat: SeatView }>("/api/seats/serves", { id: seat.id, agents: ids, ...(ids.length > 1 ? { shared: true } : {}) }, scope.signal);
          sheet.close();
          toast(`${seat.label}: ${servesWords(done.seat, rosterOf(done.seat)).word}`, { tone: "ok" });
        } catch (error) {
          toast("Its agents weren't changed", { tone: "error", description: errorMessage(error) });
        }
        await refresh();
      }),
    );
    update();
  }

  async function remove(seat: SeatView): Promise<void> {
    const ok = await confirmAction({ title: `Remove ${seat.label}?`, body: "Its sign-in on this node goes with it, and no agent can use it again until you add it again and sign it in.", confirmLabel: "Remove", tone: "danger" });
    if (!ok) return;
    try {
      await ctx.api.post("/api/seats/remove", { id: seat.id }, scope.signal);
      toast(`${seat.label} removed`);
    } catch (error) {
      toast("It wasn't removed", { tone: "error", description: errorMessage(error) });
    }
    await refresh();
  }

  void refresh();
};
