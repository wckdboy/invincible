import type { SandboxView } from "@invincible/core";
import type { Agent } from "@invincible/core/team";
import { isAbort } from "../api.ts";
import { type Ctx, errorMessage } from "../context.ts";
import { hasDesktop } from "../lib/desktop.ts";
import { busy, button, callout } from "../ui/controls.ts";
import { openSheet } from "../ui/dialog.ts";
import { h, replace } from "../ui/dom.ts";
import { toast } from "../ui/toast.ts";
import { type DesktopViewer, desktopViewer } from "./desktop.ts";
import { growVm, remakeVm } from "./team-forms.ts";
import { openTerminal } from "./terminal.ts";

/*
 * The primary's own computer, from its chat: a VM that is its, made as an agent's is under its reserved handle
 * (POST /api/team/provision { id: "primary" }, with a desktop unless you say otherwise), and worked on by it alone with
 * its computer tool. Here you watch its screen and take it over, open a terminal there, and give it more; or, while it
 * has none, give it one.
 */

const HIM: Pick<Agent, "id" | "name"> = { id: "primary", name: "Your agent" };

export function openComputer(ctx: Ctx): void {
  const sheet = openSheet({
    title: "Its computer",
    description: "A Linux VM that is its, with a desktop and a browser, kept between conversations. It works on it with its computer tool; you can watch it, take it over and open a terminal there.",
    size: "wide",
    body: h("div", { class: "stack loose" }),
  });
  const canMake = ctx.can("fleet:admin") && ctx.can("sandbox");
  let viewer: DesktopViewer | null = null;
  sheet.scope.add(() => viewer?.dispose());

  async function draw(): Promise<void> {
    let vm: SandboxView | null;
    try {
      vm = (await ctx.api.post<{ workspace: SandboxView | null }>("/api/team/workspace", { id: HIM.id }, sheet.scope.signal)).workspace;
    } catch (error) {
      if (isAbort(error)) return;
      replace(sheet.body, callout("warn", errorMessage(error), { title: "Its computer can't be reached", actions: button("Try again", { size: "sm", icon: "refresh", onClick: () => void draw() }) }));
      return;
    }
    viewer?.dispose();
    viewer = null;
    if (!vm) {
      const give = button("Give it a computer", { variant: "primary", icon: "plus" });
      give.addEventListener("click", () =>
        void busy(give, async () => {
          await ctx.api.post("/api/team/provision", { id: HIM.id });
          toast("Its computer is ready", { description: "It can work on it now, and you can watch it here." });
          await ctx.live.refreshTeam();
          await draw();
        }),
      );
      replace(
        sheet.body,
        h("p", {}, "It has none yet. One of its own is a VM like an agent's: its to work on, with a desktop and a browser, and its work kept from day to day."),
        canMake ? give : h("p", { class: "small muted" }, "Giving it one needs fleet:admin and sandbox access on an owner device."),
      );
      return;
    }
    const shown = vm;
    const again = () => void draw();
    if (hasDesktop(shown) && shown.status === "running" && ctx.can("sandbox")) viewer = desktopViewer(ctx, HIM, sheet.body, canMake ? () => remakeVm(ctx, HIM, shown, again, { desktop: true }) : null);
    // A terminal where its computer is on the node you are talking to (terminals aren't forwarded).
    const here = ctx.live.team.value?.computer?.node === ctx.whoami.node;
    replace(
      sheet.body,
      viewer?.el ?? null,
      h("p", { class: "small muted" }, `On ${shown.node} · ${shown.cpus} CPUs · ${shown.memoryGb} GB memory · ${shown.disk ? `${shown.disk.limitGb} GB disk` : "Unlimited disk"} · ${shown.network}`),
      h(
        "div",
        { class: "row wrap" },
        here && ctx.can("sandbox") ? button("Open terminal", { size: "sm", icon: "terminal", onClick: () => void openTerminal(ctx, { id: shown.id, name: "Its computer" }) }) : null,
        canMake ? button("Give it more", { size: "sm", icon: "plus", onClick: () => growVm(ctx, HIM, shown, again) }) : null,
        canMake ? button("Make it again", { size: "sm", icon: "retry", onClick: () => remakeVm(ctx, HIM, shown, again) }) : null,
      ),
    );
  }
  void draw();
}
