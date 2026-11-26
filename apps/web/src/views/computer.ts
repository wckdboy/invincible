import type { SandboxView } from "@galahad/core";
import type { Teammate } from "@galahad/core/team";
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
 * Galahad's own computer, from his chat: a VM that is his, made as a knight's is under his reserved handle
 * (POST /api/team/provision { id: "galahad" }, with a desktop unless you say otherwise), and worked on by him alone with
 * his computer tool. Here you watch his screen and take it over, open a terminal there, and give it more; or, while he
 * has none, give him one.
 */

const HIM: Pick<Teammate, "id" | "name"> = { id: "galahad", name: "Galahad" };

export function openComputer(ctx: Ctx): void {
  const sheet = openSheet({
    title: "His computer",
    description: "A Linux VM that is his, with a desktop and a browser, kept between conversations. He works on it with his computer tool; you can watch it, take it over and open a terminal there.",
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
      replace(sheet.body, callout("warn", errorMessage(error), { title: "His computer can't be reached", actions: button("Try again", { size: "sm", icon: "refresh", onClick: () => void draw() }) }));
      return;
    }
    viewer?.dispose();
    viewer = null;
    if (!vm) {
      const give = button("Give him a computer", { variant: "primary", icon: "plus" });
      give.addEventListener("click", () =>
        void busy(give, async () => {
          await ctx.api.post("/api/team/provision", { id: HIM.id });
          toast("His computer is ready", { description: "He can work on it now, and you can watch it here." });
          await ctx.live.refreshTeam();
          await draw();
        }),
      );
      replace(
        sheet.body,
        h("p", {}, "He has none yet. One of his own is a VM like a knight's: his to work on, with a desktop and a browser, and its work kept from day to day."),
        canMake ? give : h("p", { class: "small muted" }, "Giving him one needs fleet:admin and sandbox access on an owner device."),
      );
      return;
    }
    const shown = vm;
    const again = () => void draw();
    if (hasDesktop(shown) && shown.status === "running" && ctx.can("sandbox")) viewer = desktopViewer(ctx, HIM, sheet.body, canMake ? () => remakeVm(ctx, HIM, shown, again, { desktop: true }) : null);
    // A terminal where his computer is on the node you are talking to (terminals aren't forwarded).
    const here = ctx.live.team.value?.computer?.node === ctx.whoami.node;
    replace(
      sheet.body,
      viewer?.el ?? null,
      h("p", { class: "small muted" }, `On ${shown.node} · ${shown.cpus} CPUs · ${shown.memoryGb} GB memory · ${shown.disk ? `${shown.disk.limitGb} GB disk` : "Unlimited disk"} · ${shown.network}`),
      h(
        "div",
        { class: "row wrap" },
        here && ctx.can("sandbox") ? button("Open terminal", { size: "sm", icon: "terminal", onClick: () => void openTerminal(ctx, { id: shown.id, name: "His computer" }) }) : null,
        canMake ? button("Give it more", { size: "sm", icon: "plus", onClick: () => growVm(ctx, HIM, shown, again) }) : null,
        canMake ? button("Make it again", { size: "sm", icon: "retry", onClick: () => remakeVm(ctx, HIM, shown, again) }) : null,
      ),
    );
  }
  void draw();
}
