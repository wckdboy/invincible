import type { SeatSignInCard, SeatView } from "@invincible/core/seats";
import { errorMessage, type View } from "../context.ts";
import { cardWords, QUICK_ADDS, quickLabel, SEAT_KIND_WORDS, seatStateWords, signInAction } from "../lib/seats.ts";
import { badge, busy, button, callout, card, errorState, list, listRow, note, pageBody, pageHead, section, skeletonRows } from "../ui/controls.ts";
import { confirmAction } from "../ui/dialog.ts";
import { h, replace } from "../ui/dom.ts";
import { toast } from "../ui/toast.ts";

/*
 * Seats (core's seats.ts): the accounts you hold with a vendor, that any agent may use, each signed in on its vendor's own
 * page. Adding a Claude or ChatGPT plan is one tap, and its sign-in begins at once: its card says what the vendor's tool
 * asks of you (its page to open, Codex's code to enter there, or a field for the code Claude's page shows), and the card
 * is the device's alone: never kept. The list says where each stands, and offers to sign one in again before its sign-in
 * ends. Yours alone to change (fleet:admin); read by anyone who may read the mind.
 */

export const seatsView: View = (root, ctx, { scope }) => {
  const yours = ctx.can("fleet:admin");
  const listBox = h("div", {}, card({ flush: true }, skeletonRows(2)));
  const cardBox = h("div", { class: "stack" });
  let seats: SeatView[] = [];
  /** The sign-in under way from this device, and the code field it may have. */
  let signing: { card: SeatSignInCard; label: string } | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;

  const adds = yours ? h("div", { class: "row wrap" }, ...QUICK_ADDS.map((quick) => button(quick.button, { variant: "primary", icon: "plus", onClick: (event) => void add(event.currentTarget as HTMLButtonElement, quick.kind) }))) : null;
  replace(
    root,
    pageHead("Seats", "The accounts you hold with Claude, ChatGPT and others, each signed in on its vendor's own page. Any agent may use them; a running task never moves to a second account of the same vendor.", adds),
    pageBody(cardBox, section("Your seats", {}, listBox), note("Invincible never signs in for you and never holds a sign-in: the vendor's own tool keeps it in the seat's home on this node, and says only whether it is signed in, how, its plan, and when its sign-in ends.")),
  );

  function row(seat: SeatView): HTMLElement {
    const now = Date.now();
    const state = seatStateWords(seat.state, seat.plan, now);
    const action = yours ? signInAction(seat, now) : null;
    return listRow({
      lead: "user",
      leadTone: state.tone === "ok" ? "ok" : state.tone === "warn" ? "warn" : state.tone === "work" ? "work" : "neutral",
      title: seat.label,
      sub: `${SEAT_KIND_WORDS[seat.kind].name} · ${SEAT_KIND_WORDS[seat.kind].how}`,
      meta: [badge(state.word, state.tone === "ok" ? "ok" : state.tone === "warn" ? "warn" : state.tone === "work" ? "work" : "neutral")],
      trail: yours
        ? h(
            "span",
            { class: "row tight" },
            action ? button(action, { size: "sm", onClick: (event) => void signIn(event.currentTarget as HTMLButtonElement, seat) }) : null,
            button(`Remove ${seat.label}`, { size: "sm", variant: "ghost", iconOnly: true, icon: "trash", onClick: () => void remove(seat) }),
          )
        : null,
      key: `seat:${seat.id}`,
    });
  }

  function drawCard(): void {
    if (!signing) {
      replace(cardBox);
      return;
    }
    const { card: open, label } = signing;
    const words = cardWords(open);
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
      const listed = await ctx.api.get<{ seats: SeatView[] }>("/api/seats", scope.signal);
      if (scope.disposed) return;
      seats = listed.seats;
      // Its sign-in ended (ready, or not): the card goes, and the list says how.
      if (signing && seats.find((seat) => seat.id === signing!.card.seat)?.state.is !== "signing-in") {
        const ended = seats.find((seat) => seat.id === signing!.card.seat);
        if (ended?.state.is === "ready") toast(`${ended.label} is signed in`, { tone: "ok" });
        signing = null;
        drawCard();
        stopPolling();
      }
      replace(listBox, list(seats.map(row), { empty: { icon: "user", title: "No seats yet", body: yours ? "Add a Claude or ChatGPT plan: it signs in on its vendor's page." : "The owner adds them." } }));
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

  async function begin(seat: Pick<SeatView, "id" | "label">): Promise<void> {
    const started = await ctx.api.post<{ card: SeatSignInCard }>("/api/seats/sign-in", { id: seat.id }, scope.signal);
    signing = { card: started.card, label: seat.label };
    drawCard();
    startPolling();
  }

  async function add(trigger: HTMLButtonElement, kind: SeatView["kind"]): Promise<void> {
    await busy(trigger, async () => {
      try {
        const added = await ctx.api.post<{ seat: SeatView }>("/api/seats", { kind, label: quickLabel(kind, seats) }, scope.signal);
        await refresh();
        await begin(added.seat);
      } catch (error) {
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
