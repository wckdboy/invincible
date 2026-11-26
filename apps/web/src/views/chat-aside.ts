import { findSecrets } from "@galahad/core/secret-scan";
import { type Api, isAbort } from "../api.ts";
import { errorMessage } from "../context.ts";
import { button, callout, spinner } from "../ui/controls.ts";
import { openSheet } from "../ui/dialog.ts";
import { h, replace } from "../ui/dom.ts";
import { renderMarkdown } from "../ui/markdown.ts";
import { toast } from "../ui/toast.ts";

/*
 * A side question: something you ask about the work in hand without changing its
 * course. It's answered in this sheet, apart from the chat, from what the chat holds
 * and what he's said and done so far in this turn, without his tools. The working
 * turn never sees it, and it joins nothing, unless you choose Bring back.
 */

export function openAside(api: Api, about: { conversation: string } | { turn: string }, opts: { question?: string; working: boolean; onBroughtBack(): void }): void {
  const input = h("textarea", { class: "textarea", rows: 2, maxlength: 4000, placeholder: opts.working ? "e.g. What is he waiting on?" : "e.g. Which file was that in?", "aria-label": "Your side question" }) as HTMLTextAreaElement;
  input.value = opts.question ?? "";
  const answerBox = h("div", { class: "aside-answer", "aria-live": "polite" });
  const note = h("div", { role: "alert" });
  const ask = button("Ask", { variant: "primary", onClick: () => void run() });
  const bring = button("Bring back", {
    icon: "arrow-up",
    title: opts.working ? "Hand the question and its answer to him: it reaches him at his next safe point" : "Add the question and its answer to the chat",
    onClick: () => void bringBack(),
  });
  bring.hidden = true;
  let watching: AbortController | null = null;
  let aside: string | null = null;

  const sheet = openSheet({
    title: "Ask on the side",
    description: opts.working
      ? "Answered apart, from this chat and what he's said and done so far in this turn. It doesn't change what he's doing, and he never sees it unless you bring it back."
      : "Answered apart, from what this chat holds. It isn't added to the chat unless you bring it back.",
    body: [input, note, answerBox],
    footer: [button("Close", { variant: "ghost", onClick: () => sheet.close() }), bring, ask],
    initialFocus: () => input,
  });
  sheet.scope.add(() => watching?.abort());

  async function run(): Promise<void> {
    const question = input.value.trim();
    if (!question || watching) return;
    // Checked like any message: nothing credential-shaped goes to a model.
    const finding = findSecrets(question)[0];
    if (finding) return replace(note, callout("warn", `That looks like a ${finding.kind}. It won't be sent: the models you talk to would see it. Keys belong in the vault.`));
    replace(note);
    aside = null;
    bring.hidden = true;
    ask.disabled = true;
    let text = "";
    let failed: string | null = null;
    const draw = (writing: boolean): void => {
      const body = h("div", { class: "md" });
      body.append(renderMarkdown(text));
      replace(answerBox, writing && !text ? h("div", { class: "row tiny subtle" }, spinner("sm"), "Answering on the side…") : body);
    };
    draw(true);
    watching = new AbortController();
    try {
      for await (const event of api.events("/api/turns/aside", { ...about, question }, watching.signal)) {
        if (event.type === "aside") aside = event.id;
        else if (event.type === "text") {
          text += event.text;
          draw(true);
        } else if (event.type === "error") failed = event.error;
      }
    } catch (error) {
      if (isAbort(error)) return;
      failed = errorMessage(error);
    } finally {
      watching = null;
      ask.disabled = false;
    }
    if (failed) {
      aside = null;
      return replace(note, callout("danger", failed, { title: "He couldn't answer on the side" }));
    }
    draw(false);
    replace(ask, "Ask again");
    bring.hidden = !aside || !text.trim();
  }

  async function bringBack(): Promise<void> {
    if (!aside) return;
    bring.disabled = true;
    try {
      const { how } = await api.post<{ how: "steered" | "kept" }>("/api/turns/aside/bring", { aside });
      sheet.close();
      toast(how === "steered" ? "Brought back: it reaches him at his next safe point" : "Brought back: it's in the chat now");
      opts.onBroughtBack();
    } catch (error) {
      bring.disabled = false;
      replace(note, callout("danger", errorMessage(error), { title: "Couldn't bring it back" }));
    }
  }

  input.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void run();
    }
  });
  if (input.value.trim()) void run();
}
