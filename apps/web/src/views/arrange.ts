import type { TeamSnapshot } from "@galahad/core/team";
import { isAbort } from "../api.ts";
import { type Ctx, errorMessage } from "../context.ts";
import { canMove, GALAHAD, inOrder, leaderOf, moved } from "../lib/arrange.ts";
import { button } from "../ui/controls.ts";
import { h, type Child } from "../ui/dom.ts";
import { signal } from "../ui/signal.ts";
import { toast } from "../ui/toast.ts";

/*
 * Arranging the Roundtable: your order of the knights, and who leads it (POST /api/team/arrange, yours alone; who sits
 * where is lib/arrange.ts). A change is shown at once: it stands in for the node's word until the node has it, so a
 * refresh on the way doesn't put the old order back for a moment. Every list of knights draws through arranged().
 */

interface Arrangement {
  order?: string[];
  primary?: string;
}

/** A change of yours the node hasn't answered yet (null: none). */
export const pending = signal<Arrangement | null>(null);

/** The team as you arranged it: the node's, with a change of yours on its way laid over it. */
export function arranged(snapshot: TeamSnapshot): TeamSnapshot {
  const change = pending.value;
  if (!change) return snapshot;
  return { ...snapshot, teammates: change.order ? inOrder(snapshot.teammates, change.order) : snapshot.teammates, order: change.order ?? snapshot.order, primary: change.primary ?? snapshot.primary };
}

/** Who leads the team as you arranged it (Galahad, unless it names one of your knights). */
export const primaryOf = (snapshot: TeamSnapshot): string => leaderOf(snapshot.teammates.map((knight) => knight.id), snapshot.primary);

/** Your order of the knights, or who leads, changed: shown at once, then said to the node. Resolves to whether the node took it. */
export async function arrange(ctx: Ctx, change: Arrangement): Promise<boolean> {
  const mine = { ...(pending.value ?? {}), ...change };
  pending.set(mine);
  try {
    await ctx.api.post("/api/team/arrange", change);
    await ctx.live.refreshTeam();
    return true;
  } catch (error) {
    if (!isAbort(error)) toast("Couldn't arrange the Roundtable", { tone: "error", description: errorMessage(error) });
    return false;
  } finally {
    // (A later change still on its way goes on standing in.)
    if (pending.value === mine) pending.set(null);
  }
}

/** Who leads, changed, and said in a word: what leading means is what changes. */
export async function makePrimary(ctx: Ctx, id: string, name: string): Promise<void> {
  if (!(await arrange(ctx, { primary: id }))) return;
  if (id === GALAHAD) toast("Galahad leads the Roundtable", { description: "What you say to a room without naming anyone is his to answer again." });
  else toast(`${name} leads the Roundtable`, { description: `What you say to a room ${name} sits in without naming anyone is ${name}'s to answer. Galahad sits beside it.` });
}

/**
 * What arranges one seat at the table, at the end of its row: who leads (pressed on the one that does; pressed again on
 * a knight, the lead goes back to Galahad), then a knight's two moves. Who leads and Galahad don't move (they sit
 * first), so their places are kept empty and the rows' buttons line up. A move that can't be made is said so
 * (aria-disabled), and keeps the focus.
 */
export function arrangeControls(ctx: Ctx, snapshot: TeamSnapshot, seat: { id: string; name: string }): Child[] {
  const order = snapshot.teammates.map((knight) => knight.id);
  const primary = primaryOf(snapshot);
  const leads = seat.id === primary;
  const lead = button(leads ? "Leads" : "Make primary", {
    size: "sm",
    variant: leads ? "default" : "ghost",
    label: `${leads ? "Leads" : "Make primary"}: ${seat.name}`,
    title: leads ? (seat.id === GALAHAD ? "Galahad leads the Roundtable" : "Give the lead back to Galahad") : `What you say to a room ${seat.name} sits in without naming anyone becomes ${seat.name}'s to answer`,
    onClick: () => {
      if (!leads) void makePrimary(ctx, seat.id, seat.name);
      else if (seat.id !== GALAHAD) void makePrimary(ctx, GALAHAD, "Galahad");
    },
  });
  lead.setAttribute("aria-pressed", String(leads));
  lead.classList.add("arrange-lead");
  const still = seat.id === GALAHAD || leads;
  const step = (by: -1 | 1): HTMLElement => {
    const able = canMove(order, seat.id, by, primary);
    const el = button(by < 0 ? "Move up" : "Move down", {
      size: "sm",
      variant: "ghost",
      iconOnly: true,
      icon: by < 0 ? "arrow-up" : "arrow-down",
      label: `Move ${seat.name} ${by < 0 ? "up" : "down"}`,
      onClick: () => able && void arrange(ctx, { order: moved(order, seat.id, by, primary) }),
    });
    if (!able) el.setAttribute("aria-disabled", "true");
    return el;
  };
  return [lead, still ? h("span", { class: "arrange-still", title: seat.id === GALAHAD ? "Galahad sits first, or beside the knight that leads" : "Who leads sits first" }) : [step(-1), step(1)]];
}
