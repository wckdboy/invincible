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
/** Verbs whose last argument may be a file to write (with --base64 the picture is printed instead; --keep, a folder it is kept in). */
const WRITES = new Set(["shot", "screenshot", "zoom"]);

/**
 * Whether a command acts on the desktop: runs a `desktop` verb that changes what is on it (opens, clicks, types, keys,
 * scrolls, moves, drags, starts an app, answers a dialog), anywhere a command may begin in it. Looking (text, tree,
 * find, a screenshot, a look) isn't acting. Work that acted on the desktop is proven by a gate (C1 step 8).
 */
export function actsOnDesktop(command: string): boolean {
  return /(^|[;&|(\n]\s*|\$\(\s*|`\s*)desktop\s+(open|click|type|key|scroll|move|drag|app|dialog|left_click|right_click|middle_click|double_click|triple_click|left_click_drag|mouse_move|left_mouse_down|left_mouse_up|hold_key)\b/.test(command);
}

/** How an agent with eyes is told it may ask them, after the tree (desktopBriefing's `looking`). */
export const LOOKING = ' Then `desktop look "your question"` asks a model that can see the screen what is on it, or where something is (it answers a place as x,y, to click).';

/**
 * What an agent is told of the desktop its VM has, for its environment: what it is and how it is operated, an app
 * scripted first, and on the screen the tree's words before pixels (C1 step 7). `looking`: how it asks its eyes, where
 * it has them, said after the tree. One text for every run that has a desktop: an agent's task, an eval's, the bench's.
 */
export function desktopBriefing(looking = ""): string {
  return " This VM has a desktop: a display (1280 by 800), a browser, a terminal and an editor, which you operate with the `desktop` command (open an address, read the page as text, start the terminal or the editor with `desktop app`, take a screenshot, click, type, press keys). `desktop help` lists it. Where an app can be scripted (its files, its command line, its API), script it: the screen is for what only the screen can do. To find something on the screen, ask `desktop find` first (`desktop find button \"Send\"` says where it is), then `desktop tree` (what can be acted on in the window with the focus)." + looking + " Computer tools of your own (screenshot, left_click, type and the rest), if you have them, work this same screen, in its pixels. The owner can take this desktop over: while they have it, your desktop commands wait, and one that waits too long does nothing, exits 75 and says so. Do something else meanwhile, and try again after. Left unused for 10 minutes with no one watching, the desktop stops, its windows closed: your next desktop command starts it again, on a fresh screen, and says so.";
}

/**
 * What an agent is told of the hardware tools its VM's desktop has (C1 step 11, the hardware image), after the desktop's
 * own briefing: each scripted first, and its output checked by its own tools; the screen only where they have no way.
 */
export function hardwareBriefing(): string {
  return " This desktop has the hardware tools: KiCad 9 for boards and schematics, and FreeCAD 1.0 for parts. Script them first. `kicad-cli` makes every output (Gerbers and drill files, STEP, PDF, a bill of materials), and its checks are gates: `kicad-cli pcb drc --format json --exit-code-violations board.kicad_pcb` and `kicad-cli sch erc --format json --exit-code-violations board.kicad_sch` fail when anything is wrong, and the JSON says what. A board is edited through KiCad's API, `kipy` in python3 (`KiCad().get_board()`), with pcbnew open on the desktop (`desktop app pcbnew /work/board.kicad_pcb`), and where the API has no way, through pcbnew's own Python module on the file. A part is made by a script that `freecadcmd` runs, FreeCAD's Python with no window, and read back (its volume, its faces) before it is called done. Their windows (`desktop app kicad`, `eeschema`, `pcbnew` or `freecad`, with a file of /work) are for what only a screen does: routing by hand, looking a board or a part over, FreeCAD's views and TechDraw.";
}

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

/** The space an agent's eyes answer places in, other than the screen's own pixels (core's eyesSpaceOf). */
const SPACE = /^(per-mille|scaled:(0\.\d*[1-9]\d*|[1-9]\d*(\.\d+)?))$/;

/**
 * `desktop <verb> …` alone, as its arguments (without `desktop`), when a held session may run it; else null. `eyes`:
 * the model a look asks (the task's INVINCIBLE_EYES), which a held session is told by name: its gateway and token are
 * deskd's to read from the VM's lease, as the shell's would be, never an argument. Without it a look stays a shell's.
 * `space`: the one its check measured it answering places in (C1 step 7), told beside its name, so they come back in
 * the screen's pixels.
 */
export function desktopArgv(command: string, eyes?: string | null, space?: string | null): string[] | null {
  const words = plainWords(command.trim());
  if (words && words[0] === "desktop" && words[1] === "look" && eyes && words.length > 2 && words[2] !== "--eyes") return ["look", "--eyes", eyes, ...(space && SPACE.test(space) ? ["--space", space] : []), ...words.slice(2)];
  if (!words || words.length < 2 || words[0] !== "desktop" || !DIRECT.has(words[1]!)) return null;
  if (WRITES.has(words[1]!)) {
    const file = words.slice(2).filter((w) => w !== "--now" && w !== "--base64" && w !== "--keep").find((w) => !/^\d+$/.test(w));
    if (file !== undefined && !file.startsWith("/")) return null;
  }
  return words.slice(1);
}
