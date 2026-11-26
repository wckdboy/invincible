import { describe, expect, test } from "bun:test";
import type { ScreenAction } from "@galahad/core";
import { type HelperRun, inputRefused, MacScreen, ScreenError, screenArgs, screenDid, screenHelper } from "../src/mac-screen.ts";

/*
 * A Mac's own screen, for Galahad (mac-screen.ts): the app's own binary does the looking and the pointer and keys, so
 * the node finds it beside its own Bun, says each thing in a knight's desktop's words, and never writes down what is
 * typed. A stand-in plays the helper.
 */

describe("the helper", () => {
  test("is the app's own binary, beside the Bun the node runs on: only on a Mac, and only inside the app", () => {
    const app = "/Applications/Galahad.app/Contents";
    expect(screenHelper(`${app}/Helpers/bun`, "darwin", (path) => path === `${app}/MacOS/Galahad`)).toBe(`${app}/MacOS/Galahad`);
    expect(screenHelper(`${app}/Helpers/bun`, "linux", () => true)).toBeNull();
    expect(screenHelper("/opt/homebrew/bin/bun", "darwin", () => true)).toBeNull();
    expect(screenHelper(`${app}/Helpers/bun`, "darwin", () => false)).toBeNull();
  });

  test("each thing done in a knight's desktop's words, typed text as base64 in one argument; looking, nothing", () => {
    expect(screenArgs({ do: "look" })).toBeNull();
    expect(screenArgs({ do: "click", x: 10, y: 20 })).toEqual(["click", "10", "20", "left"]);
    expect(screenArgs({ do: "click", x: 10, y: 20, button: "double" })).toEqual(["click", "10", "20", "double"]);
    expect(screenArgs({ do: "scroll", direction: "down" })).toEqual(["scroll", "down", "3"]);
    expect(screenArgs({ do: "type", text: "héllo; rm -rf ~" })).toEqual(["type", Buffer.from("héllo; rm -rf ~", "utf8").toString("base64")]);
    expect(screenArgs({ do: "key", keys: ["super+space", "Return"] })).toEqual(["key", "super+space", "Return"]);
    expect(screenArgs({ do: "open", address: "https://galahad.sh" })).toEqual(["open", "https://galahad.sh"]);
    expect(screenArgs({ do: "app", name: "Safari" })).toEqual(["open", "Safari"]);
  });

  test("the ledger says what was done, and of typing only how much", () => {
    expect(screenDid({ do: "look" })).toBeNull();
    expect(screenDid({ do: "click", x: 10, y: 20 })).toBe("click 10 20 left");
    expect(screenDid({ do: "type", text: "my secret pässword" })).toBe("type (18 characters, not recorded)");
    expect(screenDid({ do: "app", name: "Xcode" })).toBe("open the app Xcode");
  });
});

/** A stand-in helper: what it was asked, in order, and what it answers. */
function standIn(answers: Partial<Record<string, { code: number; stdout?: string; stderr?: string }>> = {}): { run: HelperRun; asked: string[][] } {
  const asked: string[][] = [];
  const run: HelperRun = async (args) => {
    asked.push(args);
    const answer = answers[args[0]!];
    if (answer) return { code: answer.code, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" };
    if (args[0] === "status") return { code: 0, stdout: '{"width":1512,"height":948,"record":true,"control":true,"front":"Safari: Galahad"}\n', stderr: "" };
    if (args[0] === "shot") return { code: 0, stdout: "SlBFRw==", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, asked };
}

describe("the screen", () => {
  test("says its size in points, what macOS allows, and what is in front", async () => {
    const { run } = standIn();
    expect(await new MacScreen(run).status()).toEqual({ width: 1512, height: 948, record: true, control: true, front: "Safari: Galahad", frontId: "", asking: null });
  });

  test("one thing done, then a picture of what it did, at the screen's own size", async () => {
    const { run, asked } = standIn();
    const view = await new MacScreen(run, { settleMs: 0 }).act({ do: "click", x: 700, y: 400 });
    expect(asked).toEqual([["click", "700", "400", "left"], ["status"], ["shot"]]);
    expect(view).toEqual({ shot: { mediaType: "image/jpeg", data: "SlBFRw==" }, width: 1512, height: 948 });
  });

  test("his input never answers macOS's questions, nor reaches your settings, keys or passwords; looking and opening still may", () => {
    const calm = { asking: null, frontId: "com.apple.Safari", front: "Safari" };
    expect(inputRefused({ do: "click", x: 1, y: 1 }, calm, "mini")).toBeNull();
    const asked = { ...calm, asking: "UserNotificationCenter" };
    const input: ScreenAction[] = [{ do: "click", x: 1, y: 1 }, { do: "type", text: "y" }, { do: "key", keys: ["Return"] }, { do: "scroll", direction: "down" }, { do: "move", x: 2, y: 2 }];
    for (const action of input) {
      expect(inputRefused(action, asked, "mini")).toStartWith("macOS is asking a question on mini's screen (UserNotificationCenter): it is your liege's to answer");
    }
    expect(inputRefused({ do: "look" }, asked, "mini")).toBeNull();
    expect(inputRefused({ do: "app", name: "Safari" }, asked, "mini")).toBeNull();
    for (const frontId of ["com.apple.systempreferences", "com.apple.keychainaccess", "com.apple.Passwords"]) {
      expect(inputRefused({ do: "click", x: 1, y: 1 }, { asking: null, frontId, front: "Systemindstillinger" }, "mini")).toStartWith("Systemindstillinger is in front on mini: your liege's settings, keys and passwords are theirs alone");
    }
  });

  test("what macOS doesn't allow yet is refused with its words (424); a helper that failed, 502", async () => {
    const refused = standIn({ click: { code: 2, stderr: "macOS doesn't let Galahad control this Mac yet: turn it on in System Settings → Privacy & Security → Accessibility.\n" } });
    const error = await new MacScreen(refused.run, { settleMs: 0 }).act({ do: "click", x: 1, y: 1 }).catch((e) => e);
    expect(error).toBeInstanceOf(ScreenError);
    expect(error).toMatchObject({ status: 424, message: expect.stringContaining("Accessibility") });
    const failed = standIn({ shot: { code: 1, stderr: "" } });
    expect(await new MacScreen(failed.run).look().catch((e) => e)).toMatchObject({ status: 502, message: "the screen's helper ended with 1" });
    const empty = standIn({ shot: { code: 0, stdout: "  \n" } });
    expect(await new MacScreen(empty.run).look().catch((e) => e)).toMatchObject({ status: 502 });
  });
});
