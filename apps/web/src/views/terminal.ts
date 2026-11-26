import type { TerminalEvent, TerminalView } from "@galahad/core";
import { type InputQueue, inputQueue } from "@galahad/core/terminal-input";
import { ApiError, isAbort } from "../api.ts";
import { type Ctx, errorMessage } from "../context.ts";
import type { Emulator } from "../term.ts";
import { openSheet } from "../ui/dialog.ts";
import { h } from "../ui/dom.ts";

/*
 * A terminal in a sandbox on this node (a knight's VM, one of yours): a login shell on a real terminal, drawn by the
 * emulator (/term.js, fetched when the first one opens). One already open in that sandbox is taken up again (the page
 * was reloaded, a phone came back from its browser); closing the sheet closes it. While the sheet is open a watching
 * that drops (the phone slept, the network went) is taken up again, the screen drawn afresh from what the node kept.
 */

const TERM_MODULE = "/term.js";

/** Keys a phone's keyboard lacks, as a terminal takes them. */
const KEYS: { label: string; keys: string; name: string }[] = [
  { label: "esc", keys: "\x1b", name: "Escape" },
  { label: "tab", keys: "\t", name: "Tab" },
  { label: "^C", keys: "\x03", name: "Control C" },
  { label: "^D", keys: "\x04", name: "Control D" },
  { label: "←", keys: "\x1b[D", name: "Left" },
  { label: "↑", keys: "\x1b[A", name: "Up" },
  { label: "↓", keys: "\x1b[B", name: "Down" },
  { label: "→", keys: "\x1b[C", name: "Right" },
];

const bytesOf = (base64: string): Uint8Array => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

export async function openTerminal(ctx: Ctx, sandbox: { id: string; name: string }): Promise<void> {
  let emulator: Emulator | null = null;
  let queue: InputQueue | null = null;
  let terminal: TerminalView | null = null;
  let ended = false;
  const screen = h("div", { class: "term-screen" });
  const status = h("p", { class: "term-status", role: "status" }, "Opening…");
  const keys = h(
    "div",
    { class: "term-keys", role: "toolbar", "aria-label": "Keys" },
    ...KEYS.map((key) =>
      h(
        "button",
        {
          class: "btn sm",
          type: "button",
          "aria-label": key.name,
          // (The emulator keeps the focus, so a phone's keyboard stays up.)
          onpointerdown: (event: PointerEvent) => event.preventDefault(),
          onclick: () => {
            if (!ended) queue?.type(key.keys);
            emulator?.focus();
          },
        },
        key.label,
      ),
    ),
  );
  const say = (text: string) => void (status.textContent = text);
  const sheet = openSheet({
    title: sandbox.name,
    description: "A terminal, yours alone. Closing it ends its shell.",
    size: "wide",
    body: h("div", { class: "term" }, screen, keys, status),
    initialFocus: () => screen,
    onClose: () => {
      emulator?.dispose();
      if (terminal && !ended) void ctx.api.post("/api/terminals/close", { terminal: terminal.id }).catch(() => {});
    },
  });
  sheet.el.classList.add("terminal-sheet");
  const { scope } = sheet;

  // On a phone the keyboard covers the bottom of the screen: the sheet keeps to what is visible.
  const viewport = window.visualViewport;
  if (viewport) {
    const keepVisible = () => {
      sheet.el.style.setProperty("--visible", `${Math.round(viewport.height)}px`);
      sheet.el.style.setProperty("--keyboard", `${Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop))}px`);
    };
    keepVisible();
    viewport.addEventListener("resize", keepVisible);
    scope.add(() => viewport.removeEventListener("resize", keepVisible));
  }

  try {
    const { mountEmulator } = (await import(TERM_MODULE)) as typeof import("../term.ts");
    if (scope.disposed) return;
    emulator = mountEmulator(screen);
  } catch {
    // A cached app may point at an emulator the node has since replaced.
    say("Galahad was just updated. Reload the app to open a terminal.");
    return;
  }
  const shown = emulator;
  try {
    const open = (await ctx.api.get<{ terminals: TerminalView[] }>("/api/terminals", scope.signal)).terminals.find((t) => t.sandbox === sandbox.id && t.exitCode === null);
    terminal = open ?? (await ctx.api.post<{ terminal: TerminalView }>("/api/terminals", { sandbox: sandbox.id, size: shown.fit() }, scope.signal)).terminal;
  } catch (error) {
    if (!isAbort(error)) say(errorMessage(error));
    return;
  }
  const id = terminal.id;
  // Closed while it was opening: it is closed at once.
  if (scope.disposed) {
    void ctx.api.post("/api/terminals/close", { terminal: id }).catch(() => {});
    return;
  }
  const keysTo = inputQueue(
    (input) => ctx.api.post("/api/terminals/input", { terminal: id, ...input }),
    (error) => !ended && say(errorMessage(error)),
  );
  queue = keysTo;
  // An ended terminal takes no more keys (its shell is gone; the screen stays to read).
  shown.onKeys((data) => !ended && keysTo.type(data));
  // Its box changes size (a phone turned, the keyboard shown or hidden): so does the terminal.
  const observer = new ResizeObserver(() => keysTo.resize(shown.fit()));
  observer.observe(screen);
  scope.add(() => observer.disconnect());
  shown.focus();

  let tries = 0;
  while (!ended && !scope.disposed) {
    try {
      let first = true;
      for await (const event of ctx.api.stream<TerminalEvent>("/api/terminals/watch", { terminal: id }, scope.signal)) {
        // Taken up (again): what the node kept is drawn on a clean screen, and the shell is told its size.
        if (first) {
          first = false;
          tries = 0;
          shown.reset();
          keysTo.resize(shown.fit());
          say("");
        }
        if (event.type === "output") shown.write(bytesOf(event.data));
        else {
          ended = true;
          say(`Its shell ended (exit ${event.code}). Close this to finish.`);
        }
      }
    } catch (error) {
      if (isAbort(error) || scope.disposed) return;
      if (error instanceof ApiError && error.status === 404) {
        ended = true;
        say("This terminal is gone: it was closed, or nobody watched it for 15 minutes.");
        return;
      }
    }
    if (ended || scope.disposed) return;
    // The watching dropped: take it up again, sooner at first.
    say("Reconnecting…");
    await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, 500 * 2 ** Math.min(tries++, 5))));
  }
}
