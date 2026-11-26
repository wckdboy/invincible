import type { RuleView } from "@galahad/core";
import { findSecrets } from "@galahad/core/secret-scan";
import { type Ctx, errorMessage } from "../context.ts";
import { type RuleDoes, ruleFromForm, ruleParts, ruleWhen } from "../lib/rules.ts";
import { absoluteTime, relativeTime } from "../lib/time.ts";
import { busy, button, callout, card, errorState, field, formActions, list, listRow, note, section, segmented, skeletonRows } from "../ui/controls.ts";
import { confirmAction, openSheet } from "../ui/dialog.ts";
import { h, keepPlace, replace, type Scope } from "../ui/dom.ts";
import { toast } from "../ui/toast.ts";
import { deviceName } from "./activity.ts";

/*
 * Tripwires and checks, on the Loops page: your rules on the commands his work runs (core's rules.ts). Before each
 * command of his quests (yours from a terminal, his loops', a trial's) and of a knight's task on his own runner, and
 * before each gate, a tripwire halts the work or refuses that command, and he is told which and why. After such a
 * command has succeeded, a check runs a command of yours, and he is told at once if it fails; a rule that tells you
 * puts a notice in your Inbox once such a command has run (and a notification of its own kind). Data you write, never a
 * model's judgment; yours alone to set (fleet:admin). A coding tool's own commands inside its VM aren't seen, and the
 * section says so.
 */

const PATH = "/api/rules";

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** What a rule does, and when, as a sentence: what it matches, and what it runs, shown as written. */
const sentence = (rule: NonNullable<RuleView["rule"]>): HTMLElement =>
  h("span", {}, ...ruleParts(rule).map((part, i) => (part.kind === "words" ? (i ? part.text : capital(part.text)) : h("span", { class: "mono" }, part.text))), ".");

/** How a rule's row leads: what it does, at a glance. */
const LEAD: Record<RuleDoes, { icon: "ban" | "shield" | "shield-check" | "bell"; tone: "danger" | "warn" | "info" }> = {
  halt: { icon: "ban", tone: "danger" },
  refuse: { icon: "shield", tone: "warn" },
  check: { icon: "shield-check", tone: "info" },
  tell: { icon: "bell", tone: "info" },
};

/** The Tripwires section, and how to bring it up to date (the page asks now and then). */
export function tripwiresSection(ctx: Ctx, scope: Scope): { el: HTMLElement; refresh(): Promise<void> } {
  const yours = ctx.can("fleet:admin");
  const box = h("div", {}, card({ flush: true }, skeletonRows(2)));
  let signature = "";

  function row(r: RuleView): HTMLElement {
    const lead = r.rule ? LEAD[r.rule.does] : null;
    return listRow({
      lead: lead?.icon ?? "shield",
      leadTone: lead?.tone ?? "neutral",
      top: true,
      title: h("span", { class: "mono" }, r.name),
      sub: r.rule ? sentence(r.rule) : "A newer node's rule: this node doesn't understand it, and doesn't apply it.",
      meta: [h("span", { title: absoluteTime(r.setAt) }, `Set ${relativeTime(r.setAt)}`), h("span", {}, r.setVia ? `from ${deviceName(ctx, r.setVia)}` : "from a terminal")],
      trail: yours ? button(`Remove ${r.name}`, { size: "sm", variant: "ghost", iconOnly: true, icon: "trash", onClick: () => void remove(r) }) : null,
      key: `rule:${r.name}`,
    });
  }

  function render(rules: RuleView[]): void {
    replace(
      box,
      list(rules.map(row), {
        empty: {
          icon: "shield",
          title: "No tripwires or checks",
          body: "A tripwire halts the work, or refuses a command, whose words match a glob of yours: *.lock, .env*, migrations/**, rm. A check runs a command of yours after one that matches: bunx tsc --noEmit after *.ts. A rule can also just tell you when one has run: git with the text push.",
        },
      }),
    );
  }

  async function refresh(): Promise<void> {
    try {
      const { rules } = await ctx.api.get<{ rules: RuleView[] }>(PATH, scope.signal);
      if (scope.disposed) return;
      const next = JSON.stringify(rules);
      if (next === signature) return;
      signature = next;
      keepPlace(box, () => render(rules));
    } catch (error) {
      if (!scope.disposed && !signature) replace(box, card({ flush: true }, errorState("Couldn't load tripwires", error, () => void refresh())));
    }
  }

  async function remove(r: RuleView): Promise<void> {
    const ok = await confirmAction({ title: `Remove ${r.name}?`, body: "No command is held to it any more, on any node.", confirmLabel: "Remove rule" });
    if (!ok) return;
    try {
      await ctx.api.post(`${PATH}/remove`, { name: r.name });
      toast(`${r.name} removed`, { tone: "ok" });
      signature = "";
      void refresh();
    } catch (error) {
      toast("Couldn't remove it", { tone: "error", description: errorMessage(error) });
    }
  }

  function openAdd(): void {
    const input = (placeholder: string, maxlength: number) => h("input", { class: "input mono", type: "text", autocomplete: "off", autocorrect: "off", spellcheck: "false", autocapitalize: "off", maxlength, placeholder });
    const name = input("e.g. no-lockfiles", 40);
    const globs = input("*.lock .env* migrations/** rm", 900);
    const contains = input("e.g. git push", 200);
    const run = input("e.g. bunx tsc --noEmit", 1000);
    const runField = field("Check to run", run, { hint: "One line, run where his work runs after a command that matches has succeeded. If it fails, he is told at once, with what it printed." });
    let does: RuleDoes = "refuse";
    const doesControl = segmented<RuleDoes>(
      [
        { value: "refuse", label: "Refuse" },
        { value: "halt", label: "Halt" },
        { value: "check", label: "Check after" },
        { value: "tell", label: "Tell me" },
      ],
      does,
      (value) => {
        does = value;
        runField.hidden = value !== "check";
      },
      { label: "What it does" },
    );
    runField.hidden = true;
    const status = h("div");
    const save = button("Add rule", { variant: "primary", type: "submit", icon: "check" });
    const form = h(
      "form",
      {
        class: "stack loose",
        onsubmit: (event: Event) => {
          event.preventDefault();
          const made = ruleFromForm({ name: name.value, does, globs: globs.value, contains: contains.value, run: run.value });
          if ("problem" in made) return void replace(status, callout("warn", made.problem));
          const secret = [...made.rule.words, made.rule.contains ?? "", made.rule.run ?? ""].map((text) => findSecrets(text)[0]).find(Boolean);
          if (secret) return void replace(status, callout("warn", `That looks like a ${secret.kind}: a rule's words reach the ledger and his conversation, so it wasn't set. A key belongs in the vault.`));
          void busy(save, async () => {
            try {
              await ctx.api.post(PATH, made.rule);
              sheet.close();
              toast(`${made.rule.name} set`, { tone: "ok", description: `${capital(ruleWhen(made.rule))}.` });
              signature = "";
              void refresh();
            } catch (error) {
              replace(status, callout("danger", errorMessage(error), { title: "Not set" }));
            }
          });
        },
      },
      field("Name", name, { hint: "Lowercase: letters, digits, . _ - (a rule with the same name is replaced)." }),
      field("Words that match", globs, {
        hint: "Globs, separated by spaces, matched against each word of a command, quoted or not: * is any run of characters but /, ** any run, ? one character. *.lock is a lockfile in any folder; migrations/** is that folder and everything in it.",
      }),
      field("Text it holds (optional)", contains, { hint: "The command must hold this as well, here-documents included: git push, --force." }),
      h(
        "div",
        { class: "stack tight" },
        h("div", { class: "label" }, "What it does"),
        doesControl.el,
        note("Refuse: that command isn't run, he is told which rule and why, and the work goes on. Halt: the quest or task stops, saying which rule. Check after: once the command has succeeded, yours runs, and he is told if it fails. Tell me: once it has run, however it ended, a notice in your Inbox and a notification, once for each task."),
      ),
      runField,
      status,
      formActions(button("Cancel", { onClick: () => sheet.close() }), save),
    );
    const sheet = openSheet({ title: "Add a rule", description: "A rule of yours on the commands his work runs.", body: form, initialFocus: () => name });
  }

  const el = section(
    "Tripwires and checks",
    {
      actions: yours ? button("Add rule", { size: "sm", icon: "plus", onClick: () => openAdd() }) : null,
      note: `Tripwires are checked before every command of his quests and of a knight's task on his own runner, and every gate; checks run after those commands. A coding tool (OpenCode, Claude Code, Codex, Hermes) runs its own commands inside its VM, where they aren't seen.${yours ? "" : " This device can see them, not change them (no fleet:admin)."}`,
    },
    box,
  );

  // What this page showed last time, at once (api.peek); the fresh answer replaces it only if something changed.
  const last = ctx.api.peek<{ rules: RuleView[] }>(PATH);
  if (last) {
    signature = JSON.stringify(last.rules);
    render(last.rules);
  }
  void refresh();
  return { el, refresh };
}
