/*
 * An agent's `desktop` command, when it is nothing but that: its arguments, so its VM's held desktop session can run
 * it (SandboxHost, deskd) in a few milliseconds instead of a login shell's hundred (C0, 26 November 2026: 111 ms of path
 * before a click). Anything a shell would read differently (an operator, an expansion, a redirect, a second command),
 * a look (it needs the command's own environment: its eyes and their gateway), or a picture saved to a path relative
 * to the task's directory stays a shell command, as it was. Pure: the same words, the same answer.
 */

/** The verbs a held session runs: every one that needs neither the shell's environment nor its directory. */
const DIRECT = new Set([
  "start", "status", "open", "text", "app", "click", "move", "drag", "scroll", "type", "key", "settle", "windows", "focus", "dialog", "tree", "find",
  "left_click", "right_click", "middle_click", "double_click", "triple_click", "left_click_drag", "mouse_move",
  "left_mouse_down", "left_mouse_up", "cursor_position", "hold_key", "wait", "screenshot", "shot", "zoom",
]);
/** Verbs whose last argument may be a file to write (with --base64 the picture is printed instead). */
const WRITES = new Set(["shot", "screenshot", "zoom"]);

/** The words of a command as a POSIX shell would split them, or null where it would do anything but split them. */
export function plainWords(command: string): string[] | null {
  const words: string[] = [];
  let word: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return null;
      word = (word ?? "") + command.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      const end = command.indexOf('"', i + 1);
      if (end < 0) return null;
      const inside = command.slice(i + 1, end);
      // Inside double quotes a shell still expands $, ` and \.
      if (/[$`\\]/.test(inside)) return null;
      word = (word ?? "") + inside;
      i = end;
    } else if (c === " " || c === "\t") {
      if (word !== null) words.push(word);
      word = null;
    } else if (/[;&|<>()$`\\*?[\]{}~#!\n\r]/.test(c)) {
      return null;
    } else {
      word = (word ?? "") + c;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

/**
 * `desktop <verb> …` alone, as its arguments (without `desktop`), when a held session may run it; else null. `eyes`:
 * the model a look asks (the task's INVINCIBLE_EYES), which a held session is told by name: its gateway and token are
 * deskd's to read from the VM's lease, as the shell's would be, never an argument. Without it a look stays a shell's.
 */
export function desktopArgv(command: string, eyes?: string | null): string[] | null {
  const words = plainWords(command.trim());
  if (words && words[0] === "desktop" && words[1] === "look" && eyes && words.length > 2 && words[2] !== "--eyes") return ["look", "--eyes", eyes, ...words.slice(2)];
  if (!words || words.length < 2 || words[0] !== "desktop" || !DIRECT.has(words[1]!)) return null;
  if (WRITES.has(words[1]!)) {
    const file = words.slice(2).filter((w) => w !== "--now" && w !== "--base64").find((w) => !/^\d+$/.test(w));
    if (file !== undefined && !file.startsWith("/")) return null;
  }
  return words.slice(1);
}
