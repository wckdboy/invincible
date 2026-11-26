/*
 * The site's only script, and nothing needs it: without it the install line is selected whole with one tap. With it,
 * Copy appears beside the line.
 */

for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-copy]")) {
  const label = button.querySelector<HTMLElement>("[data-copy-label]");
  let reset = 0;
  button.hidden = false;
  button.addEventListener("click", async () => {
    let said = "Copied";
    try {
      await navigator.clipboard.writeText(button.dataset.copy ?? "");
    } catch {
      // No clipboard for this page (an old browser, a refused permission): select the line, so a keystroke copies it.
      const line = button.parentElement?.querySelector(".install-command");
      if (line) getSelection()?.selectAllChildren(line);
      said = "Selected";
    }
    if (label) label.textContent = said;
    button.setAttribute("aria-label", said === "Copied" ? "Copied the install command" : "Selected the install command");
    button.dataset.done = "";
    clearTimeout(reset);
    reset = window.setTimeout(() => {
      if (label) label.textContent = "Copy";
      button.setAttribute("aria-label", "Copy the install command");
      delete button.dataset.done;
    }, 2000);
  });
}
