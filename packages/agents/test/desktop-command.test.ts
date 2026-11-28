import { expect, test } from "bun:test";
import { actsOnDesktop, desktopArgv, desktopBriefing, plainWords } from "../src/desktop-command.ts";

/*
 * Which of an agent's commands its VM's held desktop session runs (no login shell, a few milliseconds) and which stay
 * shell commands: the session never runs what a shell would have read differently.
 */

test("a plain desktop command is its words, quoted as a shell quotes them", () => {
  expect(desktopArgv("desktop click 640 450")).toEqual(["click", "640", "450"]);
  expect(desktopArgv("  desktop key ctrl+l Return ")).toEqual(["key", "ctrl+l", "Return"]);
  expect(desktopArgv("desktop type 'Søren Ærø – 25 °C'")).toEqual(["type", "Søren Ærø – 25 °C"]);
  expect(desktopArgv(`desktop type "it's here"`)).toEqual(["type", "it's here"]);
  expect(desktopArgv("desktop open https://example.test/a?b=c")).toBeNull(); // `?` is a glob to a shell
  expect(desktopArgv("desktop open 'https://example.test/a?b=c'")).toEqual(["open", "https://example.test/a?b=c"]);
  expect(desktopArgv("desktop left_click 10 20")).toEqual(["left_click", "10", "20"]);
  expect(desktopArgv("desktop shot /tmp/agent.jpg")).toEqual(["shot", "/tmp/agent.jpg"]);
  expect(desktopArgv("desktop screenshot")).toEqual(["screenshot"]);
  expect(desktopArgv("desktop zoom 0 0 100 100 /work/z.png")).toEqual(["zoom", "0", "0", "100", "100", "/work/z.png"]);
  expect(desktopArgv("desktop dialog accept")).toEqual(["dialog", "accept"]);
  expect(desktopArgv("desktop dialog accept 'Søren Ærø'")).toEqual(["dialog", "accept", "Søren Ærø"]);
  expect(desktopArgv("desktop find 'check box' 'I accept the terms'")).toEqual(["find", "check box", "I accept the terms"]);
  expect(desktopArgv("desktop tree")).toEqual(["tree"]);
  expect(desktopArgv("desktop click ref=12")).toEqual(["click", "ref=12"]);
  // A form in one command (C1, fewer model calls an action).
  expect(desktopArgv(`desktop fill "Full name" 'Søren Ærø' ref=13 soren@example.test Plan Team`)).toEqual(["fill", "Full name", "Søren Ærø", "ref=13", "soren@example.test", "Plan", "Team"]);
});

test("filling a form acts on the desktop, as typing into it does: its batch is pictured before and after, and a gate proves it", () => {
  expect(actsOnDesktop("desktop fill ref=12 'Søren Ærø'")).toBe(true);
  expect(actsOnDesktop("desktop tree && desktop fill Email soren@example.test")).toBe(true);
  expect(actsOnDesktop("desktop tree")).toBe(false);
});

test("whatever a shell would read differently stays a shell command", () => {
  for (const command of [
    "desktop click 1 2 && desktop key Return",
    "desktop click 1 2; rm -rf /",
    "desktop type $HOME",
    'desktop type "$(id)"',
    "desktop type `id`",
    "desktop type 'a' > out.txt",
    "desktop text | head",
    "desktop key a\\ b",
    "desktop type 'unterminated",
    "DISPLAY=:2 desktop click 1 2",
    "cd /tmp && desktop click 1 2",
    "desktop type ~",
    "desktop type #comment",
  ]) expect([command, desktopArgv(command)]).toEqual([command, null]);
});

test("a look needs its command's own environment (its eyes and their gateway), and a picture saved relative to the task's directory needs that directory: both stay shell commands", () => {
  expect(desktopArgv('desktop look "Where is Send?"')).toBeNull();
  expect(desktopArgv("desktop shot mine.png")).toBeNull();
  expect(desktopArgv("desktop zoom 0 0 10 10 z.png")).toBeNull();
  expect(desktopArgv("desktop help")).toBeNull();
  expect(desktopArgv("desktop dance")).toBeNull();
  expect(desktopArgv("desktop")).toBeNull();
  expect(desktopArgv("desktopx click 1 2")).toBeNull();
  expect(plainWords("a 'b c' \"d\"")).toEqual(["a", "b c", "d"]);
});

test("a picture printed as a data address (--base64) and an action with keys held (--hold) are the session's: no file, no shell", () => {
  expect(desktopArgv("desktop screenshot --base64")).toEqual(["screenshot", "--base64"]);
  expect(desktopArgv("desktop zoom 0 0 640 400 --base64")).toEqual(["zoom", "0", "0", "640", "400", "--base64"]);
  expect(desktopArgv("desktop shot --now --base64")).toEqual(["shot", "--now", "--base64"]);
  expect(desktopArgv("desktop left_click 10 20 --hold ctrl+shift")).toEqual(["left_click", "10", "20", "--hold", "ctrl+shift"]);
  // A file named beside it is still a file, relative or not; a folder it is kept in too (--keep, C1 step 8).
  expect(desktopArgv("desktop shot --base64 mine.png")).toBeNull();
  expect(desktopArgv("desktop screenshot --base64 --keep /work/.evidence/desktop")).toEqual(["screenshot", "--base64", "--keep", "/work/.evidence/desktop"]);
  expect(desktopArgv("desktop screenshot --base64 --keep evidence")).toBeNull();
});

test("a look goes to the session only told its eyes by name (the task's own): their gateway and token are the VM's lease's, never an argument", () => {
  expect(desktopArgv('desktop look "Where is Send?"', "vision/model-1")).toEqual(["look", "--eyes", "vision/model-1", "Where is Send?"]);
  expect(desktopArgv('desktop look "Where is Send?"', null)).toBeNull();
  expect(desktopArgv("desktop look", "vision/model-1")).toBeNull();
  expect(desktopArgv("desktop look --eyes other/model hi", "vision/model-1")).toBeNull();
  expect(desktopArgv('desktop look "$(cat /work/.invincible-gateway.json)"', "vision/model-1")).toBeNull();
});

test("eyes that answer places in a space of their own are told it beside their name (--space), so their places come back in the screen's pixels", () => {
  expect(desktopArgv('desktop look "Where is Send?"', "vision/model-1", "per-mille")).toEqual(["look", "--eyes", "vision/model-1", "--space", "per-mille", "Where is Send?"]);
  expect(desktopArgv('desktop look "Where is Send?"', "vision/model-1", "scaled:1.3333")).toEqual(["look", "--eyes", "vision/model-1", "--space", "scaled:1.3333", "Where is Send?"]);
  expect(desktopArgv('desktop look "Where is Send?"', "vision/model-1", null)).toEqual(["look", "--eyes", "vision/model-1", "Where is Send?"]);
  // A space that isn't one is never handed on: the look goes as it would without one.
  expect(desktopArgv('desktop look "Where is Send?"', "vision/model-1", "inches; reboot")).toEqual(["look", "--eyes", "vision/model-1", "Where is Send?"]);
});

test("an agent with a desktop is told the owner can take it over: its desktop commands then wait, and one that waits too long exits 75 and says so (C1 step 9)", () => {
  expect(desktopBriefing()).toContain("The owner can take this desktop over: while they have it, your desktop commands wait, and one that waits too long does nothing, exits 75 and says so.");
});

test("an agent with a desktop is told to do several actions in one command where that is safe, a form in one fill, and to check it by the tree (C1, fewer model calls an action)", () => {
  const told = desktopBriefing();
  expect(told).toContain("`desktop tree` says what each field holds: check a form by it.");
  expect(told).toContain("Do several actions in one command, chained with &&, where each one's target is known before it starts: a ref from one tree stays that node's, and every desktop verb fails when it can't do its part, so the chain stops there.");
  expect(told).toContain('A form is one command: `desktop fill "Full name" "Kim Example" Email kim@example.test Plan Pro "I accept the terms" on` fills each field and reads it back, and never sends it.');
  expect(told).toContain("Whatever sends a form or opens a page ends a chain.");
  // (No angle brackets in what an agent is told: a model copied them onto its own command fence, and nothing ran.)
  expect(told).not.toMatch(/[<>]/);
});

test("an agent with a desktop is told how a file dialog takes a typed path: Return in the same command, or its Save clicked", () => {
  // (Ultra, 28 November 2026: in GTK's Save As, Return pressed a command after the path was typed saved nothing, 3 of
  // 3; Return in the same command saved, 3 of 3, as the suite's editor task does, and so did a click on Save.)
  expect(desktopBriefing()).toContain("In a file dialog, press Return in the same command as the path you type into it (`desktop type /work/notes.txt && desktop key Return`), or click its Save: a Return that comes in a later command may save nothing.");
  expect(desktopBriefing()).not.toMatch(/[<>]/);
});

test("an agent with a desktop is told that what is below or above the screen is reached by desktop find and desktop fill, the page scrolled its own way: no scroll of its own", () => {
  // (Every settings run of the models, 28 November 2026, 6 of 6: a find that said nothing was there, then a blind scroll.)
  expect(desktopBriefing()).toContain("What is below or above the screen `desktop find` and `desktop fill` reach, the page scrolled to it its own way: no scroll of yours is needed.");
});
