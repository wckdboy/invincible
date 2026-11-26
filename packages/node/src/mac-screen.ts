import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { ExecResult, ScreenAction, ScreenStatus, ScreenView } from "@galahad/core";

/*
 * A Mac's own screen, for Galahad (docs/MAC.md, the Mac itself): the app's own binary takes its pictures and moves its
 * pointer and keys (`Galahad --desktop`, apps/apple/Galahad/Mac/MacScreen.swift), so it is the app macOS asks you to
 * allow, once, in System Settings (Screen & System Audio Recording, and Accessibility). Only a node the app runs (its
 * Bun inside the app's bundle) has one; any other has none.
 */

/** How the helper's run went: its exit (0, 1 failed, 2 refused or asked wrongly) and what it printed. */
export interface HelperRan {
  code: number;
  stdout: string;
  stderr: string;
}
export type HelperRun = (args: string[], timeoutMs: number) => Promise<HelperRan>;

/** The app's own binary, beside the Bun this node runs on (`<App>/Contents/Helpers/bun`): null off a Mac, or outside the app. */
export function screenHelper(execPath = process.execPath, platform: string = process.platform, exists: (path: string) => boolean = existsSync): string | null {
  if (platform !== "darwin") return null;
  const helpers = dirname(execPath);
  if (!helpers.endsWith("/Contents/Helpers")) return null;
  const binary = join(dirname(helpers), "MacOS", "Galahad");
  return exists(binary) ? binary : null;
}

/** The helper, run as a process of this node's (so what macOS allows the app, it allows here), killed at its deadline. */
export function spawnHelper(binary: string): HelperRun {
  return async (args, timeoutMs) => {
    const proc = Bun.spawn([binary, "--desktop", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const timer = setTimeout(() => proc.kill(9), timeoutMs);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { code, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** A shell command on this Mac, as its user, in its home. */
export type ShellRun = (command: string, timeoutSec: number) => Promise<ExecResult>;

/** The most of each of a command's outputs kept: past it, cut, and said to be. */
const SHELL_OUTPUT_MAX = 1024 * 1024;

/**
 * zsh as a login shell (so the PATH is the user's own, as Terminal's is), in the user's home, with an environment of
 * its own: never the node's. At its deadline the command and everything it started are killed together.
 */
export function zshRunner(): ShellRun {
  return (command, timeoutSec) =>
    new Promise((resolve) => {
      const started = Date.now();
      const me = userInfo();
      const env = {
        HOME: homedir(),
        USER: me.username,
        LOGNAME: me.username,
        SHELL: "/bin/zsh",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      };
      const child = spawn("/bin/zsh", ["-lc", command], { cwd: homedir(), env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      const out = { stdout: "", stderr: "", truncated: false };
      const take = (which: "stdout" | "stderr") => (chunk: Buffer) => {
        if (out[which].length >= SHELL_OUTPUT_MAX) return void (out.truncated = true);
        out[which] += chunk.toString("utf8");
        if (out[which].length > SHELL_OUTPUT_MAX) [out[which], out.truncated] = [out[which].slice(0, SHELL_OUTPUT_MAX), true];
      };
      child.stdout!.on("data", take("stdout"));
      child.stderr!.on("data", take("stderr"));
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          /* gone already */
        }
      }, timeoutSec * 1000);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ exitCode: killed ? 137 : (code ?? 1), stdout: out.stdout, stderr: out.stderr, durationMs: Date.now() - started, truncated: out.truncated });
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ exitCode: 127, stdout: "", stderr: `the shell couldn't start: ${error.message}`, durationMs: Date.now() - started, truncated: false });
      });
    });
}

export class ScreenError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The helper's arguments for one thing done on the screen (`look`: none). Typed text goes as base64, as one argument. */
export function screenArgs(action: ScreenAction): string[] | null {
  switch (action.do) {
    case "look":
      return null;
    case "click":
      return ["click", String(action.x), String(action.y), action.button ?? "left"];
    case "move":
      return ["move", String(action.x), String(action.y)];
    case "scroll":
      return ["scroll", action.direction, String(action.times ?? 3)];
    case "type":
      return ["type", Buffer.from(action.text, "utf8").toString("base64")];
    case "key":
      return ["key", ...action.keys];
    case "open":
      return ["open", action.address];
    case "app":
      return ["open", action.name];
  }
}

/** Apps that are your liege's alone: their settings, their keys and their passwords. Galahad's input never reaches them. */
export const OWNERS_APPS = new Set(["com.apple.systempreferences", "com.apple.keychainaccess", "com.apple.Passwords"]);

/**
 * Why Galahad's own input (a click, a key, typing, the pointer, scrolling) may not reach the screen as it stands: a
 * question of macOS's is on it (a consent, a password: yours to answer, at the Mac), or an app of yours alone is in
 * front. Null: it may. Your own taking over is never stopped by this.
 */
export function inputRefused(action: ScreenAction, status: Pick<ScreenStatus, "asking" | "frontId" | "front">, mac: string): string | null {
  if (!["click", "move", "scroll", "type", "key"].includes(action.do)) return null;
  if (status.asking) return `macOS is asking a question on ${mac}'s screen (${status.asking}): it is your liege's to answer, at the Mac, never yours. Look again later, or tell them it waits.`;
  if (status.frontId && OWNERS_APPS.has(status.frontId)) return `${status.front || "That app"} is in front on ${mac}: your liege's settings, keys and passwords are theirs alone. Open another app first.`;
  return null;
}

/** What a thing done on the screen says in the ledger: what was done, and of typing only how much. */
export function screenDid(action: ScreenAction): string | null {
  switch (action.do) {
    case "look":
      return null;
    case "type":
      return `type (${[...action.text].length} characters, not recorded)`;
    case "app":
      return `open the app ${action.name}`;
    default:
      return screenArgs(action)!.join(" ");
  }
}

export class MacScreen {
  /** How long the screen is given to show what was done before its picture is taken. */
  private readonly settleMs: number;

  /** Its shell (tests: a stand-in). */
  private readonly shell: ShellRun;

  constructor(
    private readonly run: HelperRun,
    opts: { settleMs?: number; shell?: ShellRun } = {},
  ) {
    this.settleMs = opts.settleMs ?? 350;
    this.shell = opts.shell ?? zshRunner();
  }

  /** A shell command as this Mac's user, in its home (two minutes unless asked for longer, fifteen at most). */
  command(command: string, timeoutSec = 120): Promise<ExecResult> {
    return this.shell(command, Math.min(Math.max(1, timeoutSec), 900));
  }

  private async helper(args: string[], timeoutMs = 20_000): Promise<string> {
    const ran = await this.run(args, timeoutMs);
    if (ran.code === 0) return ran.stdout;
    const said = ran.stderr.trim().split("\n")[0] || `the screen's helper ended with ${ran.code}`;
    throw new ScreenError(ran.code === 2 ? 424 : 502, said);
  }

  /** Its size in points, what macOS lets Galahad do with it, and what is in front. */
  async status(): Promise<Omit<ScreenStatus, "node">> {
    const said = JSON.parse(await this.helper(["status"])) as Partial<Omit<ScreenStatus, "node">>;
    if (typeof said.width !== "number" || typeof said.height !== "number") throw new ScreenError(502, "the screen's helper didn't say its size");
    return {
      width: said.width,
      height: said.height,
      record: said.record === true,
      control: said.control === true,
      front: typeof said.front === "string" ? said.front.slice(0, 200) : "",
      frontId: typeof said.frontId === "string" ? said.frontId.slice(0, 200) : "",
      asking: typeof said.asking === "string" ? said.asking.slice(0, 100) : null,
    };
  }

  /** Shows macOS's own prompts on this Mac's screen (or lists the app in System Settings), for you to answer there. */
  async allow(): Promise<Omit<ScreenStatus, "node">> {
    await this.helper(["allow"]);
    return this.status();
  }

  /** What was in front at the last picture (`look`), for saying where things stand. */
  front = "";

  /** A picture of the screen, at its size in points. */
  async look(): Promise<ScreenView> {
    const status = await this.status();
    this.front = status.front;
    const data = (await this.helper(["shot"], 30_000)).trim();
    if (!data) throw new ScreenError(502, "the screen's helper gave no picture");
    return { shot: { mediaType: "image/jpeg", data }, width: status.width, height: status.height };
  }

  /** One thing done there, then a picture of what it did. */
  async act(action: ScreenAction): Promise<ScreenView> {
    const args = screenArgs(action);
    if (args) {
      await this.helper(args);
      await Bun.sleep(this.settleMs);
    }
    return this.look();
  }
}
