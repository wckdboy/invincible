/*
 * What only root may do on a Mac (installing Apple's container, putting the sandbox firewall in root's places), asked
 * for as a Mac asks: by sudo on a terminal, and by macOS's own password prompt where there is no terminal (the app runs
 * the CLI with none). Either way the password goes to macOS, never to Galahad. The script runs as root through /bin/sh;
 * what it prints comes back, to be said after.
 */

export type AsRoot = (script: string, why: string) => Promise<{ code: number; output: string; cancelled: boolean }>;

/** A word for /bin/sh, quoted so the shell takes it as it is. */
export const shellQuote = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`;

/**
 * macOS's prompt, through AppleScript's `do shell script … with administrator privileges`. The script and the reason
 * are the arguments of the AppleScript, never spliced into its source; its line endings are left as the script printed them.
 */
export const promptArgs = (script: string, why: string): string[] => [
  "/usr/bin/osascript",
  "-e",
  "on run argv",
  "-e",
  "do shell script (item 1 of argv) with prompt (item 2 of argv) with administrator privileges without altering line endings",
  "-e",
  "end run",
  script,
  why,
];

/** osascript's words for a prompt that was cancelled ("User canceled.", -128). */
export const cancelledPrompt = (stderr: string): boolean => /\(-128\)\s*$/.test(stderr.trim());

/** Root, as this process can ask for it: sudo when it runs on a terminal, macOS's prompt when it doesn't. */
export function systemAsRoot(terminal = !!process.stdin.isTTY): AsRoot {
  return async (script, why) => {
    // sudo asks on the terminal itself (its prompt and your typing never pass through this process); why is said first.
    if (terminal) process.stderr.write(`${why}\n`);
    const argv = terminal ? ["/usr/bin/sudo", "/bin/sh", "-c", script] : promptArgs(script, why);
    const proc = Bun.spawn(argv, { stdin: terminal ? "inherit" : "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, output: `${stdout}${stderr}`.trim(), cancelled: !terminal && code !== 0 && cancelledPrompt(stderr) };
  };
}
