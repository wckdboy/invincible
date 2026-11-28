/*
 * A command run for a test, a bench or a script, as Bun.spawnSync ran one (its output as bytes, its exit, whether it
 * succeeded), but by an async spawn with a time limit. A synchronous spawn holds its process's thread until it sees its
 * child end, and on the Mac mini (bun 1.4.2, 28 November 2026) Bun.spawnSync lost children's ends and held test workers
 * for good, past every test's own limit: held-git and project-git, layout's 19 tests, the evals before them. Past its
 * limit (60 s, or the `timeout` it's given) the command is killed and answered as killed, whatever is or isn't seen of
 * its end. bench/no-spawn-sync.test.ts keeps synchronous spawns out.
 */

/** What a command said and how it ended, as Bun.spawnSync's answer says it. */
export interface Spawned {
  /** Null when it was killed (past its limit, or by a signal). */
  exitCode: number | null;
  signalCode: string | null;
  success: boolean;
  stdout: Buffer;
  stderr: Buffer;
  /** Killed for running past its limit. */
  timedOut: boolean;
}

/** As Bun.spawnSync takes them (what the tests here give it), `input` what it reads, and `timeout` its limit in milliseconds. */
export interface SpawnedOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Bytes are written to it and it's ended, as `input` is; a file (Bun.file) is read into it; a pipe ends at once. */
  stdin?: "ignore" | "inherit" | "pipe" | Uint8Array | Blob;
  /** What it reads on its stdin: written to it, then ended. */
  input?: string | Uint8Array;
  stdout?: "pipe" | "ignore" | "inherit";
  stderr?: "pipe" | "ignore" | "inherit";
  timeout?: number;
}

const DEFAULT_LIMIT_MS = 60_000;

/** A stream read to its end as bytes, kept as it comes (so a command killed at its limit says what it had printed). */
function collect(stream: ReadableStream<Uint8Array> | null | undefined): { bytes: () => Buffer; done: Promise<void> } {
  const chunks: Uint8Array[] = [];
  const done = stream
    ? (async () => {
        for await (const chunk of stream) chunks.push(chunk);
      })().catch(() => {})
    : Promise.resolve();
  return { bytes: () => Buffer.concat(chunks), done };
}

/** `cmd` run, its answer as Bun.spawnSync's; `{ cmd, ...options }` as one argument too, as Bun.spawnSync takes it. */
export async function spawned(cmd: string[] | ({ cmd: string[] } & SpawnedOptions), options: SpawnedOptions = {}): Promise<Spawned> {
  const o = Array.isArray(cmd) ? { ...options, cmd } : { ...cmd, ...options };
  // (A pipe it's given nothing for ends at once, as a synchronous spawn's does: never held open for a read to wait on.)
  const given = o.input ?? (o.stdin instanceof Uint8Array ? o.stdin : o.stdin === "pipe" ? "" : null);
  const proc = Bun.spawn(o.cmd, {
    ...(o.cwd ? { cwd: o.cwd } : {}),
    ...(o.env ? { env: o.env } : {}),
    stdin: given !== null ? "pipe" : o.stdin instanceof Blob ? o.stdin : o.stdin === "inherit" ? "inherit" : "ignore",
    stdout: o.stdout === "inherit" ? "inherit" : o.stdout === "ignore" ? "ignore" : "pipe",
    stderr: o.stderr === "inherit" ? "inherit" : o.stderr === "ignore" ? "ignore" : "pipe",
  });
  if (given !== null) {
    const stdin = proc.stdin as import("bun").FileSink;
    stdin.write(given);
    void stdin.end();
  }
  const out = collect(proc.stdout as ReadableStream<Uint8Array> | null);
  const err = collect(proc.stderr as ReadableStream<Uint8Array> | null);
  let late: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<true>((resolve) => {
    late = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve(true);
    }, o.timeout ?? DEFAULT_LIMIT_MS);
  });
  // (Its streams read to their ends with its exit: what it started may hold them open after, and the limit covers that too.)
  const ended = Promise.all([proc.exited, out.done, err.done]).then(() => false as const);
  try {
    const killed = await Promise.race([ended, timedOut]);
    const exitCode = killed ? null : proc.exitCode;
    const signal = killed ? "SIGKILL" : proc.signalCode === null || proc.signalCode === undefined ? null : String(proc.signalCode);
    return { exitCode, signalCode: signal, success: exitCode === 0, stdout: out.bytes(), stderr: err.bytes(), timedOut: killed };
  } finally {
    clearTimeout(late);
  }
}

/** What node's spawnSync answers when it's given an encoding: `status` its exit (null when killed), its output as text. */
export interface SpawnedText {
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Why it couldn't be started: node's spawnSync answers so (its status null), where Bun's throws. */
  error?: Error;
}

/** `cmd` with `args` and the options node's spawnSync takes for them, by spawned (with its limit), answered as node's spawnSync answers in text. */
export async function spawnText(cmd: string, args: string[], options: SpawnedOptions & { encoding?: "utf8"; stdio?: "ignore" | "inherit" | "pipe" } = {}): Promise<SpawnedText> {
  const { encoding: _, stdio, ...rest } = options;
  let r: Spawned;
  try {
    r = await spawned([cmd, ...args], { ...(stdio ? { stdin: stdio, stdout: stdio, stderr: stdio } : {}), ...rest });
  } catch (error) {
    return { status: null, signal: null, stdout: "", stderr: "", timedOut: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
  return { status: r.exitCode, signal: r.signalCode, stdout: r.stdout.toString(), stderr: r.stderr.toString(), timedOut: r.timedOut };
}
