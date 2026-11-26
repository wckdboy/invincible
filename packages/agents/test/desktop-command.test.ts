import { expect, test } from "bun:test";
import { desktopArgv, plainWords } from "../src/desktop-command.ts";

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

test("a look goes to the session only told its eyes by name (the task's own): their gateway and token are the VM's lease's, never an argument", () => {
  expect(desktopArgv('desktop look "Where is Send?"', "vision/model-1")).toEqual(["look", "--eyes", "vision/model-1", "Where is Send?"]);
  expect(desktopArgv('desktop look "Where is Send?"', null)).toBeNull();
  expect(desktopArgv("desktop look", "vision/model-1")).toBeNull();
  expect(desktopArgv("desktop look --eyes other/model hi", "vision/model-1")).toBeNull();
  expect(desktopArgv('desktop look "$(cat /work/.invincible-gateway.json)"', "vision/model-1")).toBeNull();
});
