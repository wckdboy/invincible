/*
 * What the node asks of short commands: a binary's version, a process's command line, a setting of the kernel's. They
 * are run so they never hold the process. Bun.spawnSync holds the JS thread until it sees its child end, and on the Mac
 * mini (bun 1.4.2, 28 November 2026) one lost its child's end and went round its wait for good: a test worker spun at
 * 91 % of a core for 58 minutes, and no timeout could fire. A node held like that answers nothing. These end by their
 * time limit whatever the child does, or whatever is or isn't seen of its end.
 */

/** What a short command printed to its stdout and how it ended; null if it couldn't be run or ran past `timeoutMs`. */
export async function outputOf(cmd: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<{ code: number | null; stdout: string } | null> {
  let proc: Bun.Subprocess<"ignore", "pipe", "ignore">;
  try {
    proc = Bun.spawn(cmd, { ...(opts.cwd ? { cwd: opts.cwd } : {}), stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  } catch {
    return null;
  }
  let late: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    late = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve(null);
    }, opts.timeoutMs ?? 5_000);
  });
  const ended = Promise.all([new Response(proc.stdout).text(), proc.exited]).then(([stdout, code]) => ({ code, stdout }));
  try {
    return await Promise.race([ended, timedOut]);
  } catch {
    return null;
  } finally {
    clearTimeout(late);
  }
}

/** A process's whole command line, or null if there's none by that id. */
export async function commandOf(pid: number): Promise<string | null> {
  const ps = await outputOf(["ps", "-ww", "-p", String(pid), "-o", "command="]);
  return ps?.code === 0 ? ps.stdout.trim() || null : null;
}
