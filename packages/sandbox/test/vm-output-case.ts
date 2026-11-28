import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectCommand, collectFrom, probeContainer, SandboxHost, spawnSession, spawnStream } from "../src/index.ts";

/*
 * One case of vm-output.test.ts, in a process of its own so that its peak memory is its own: a stand-in for a VM's process
 * that writes 100 MB, and how far this process, reading it as the node does, grew. It prints one JSON line.
 */

const HUNDRED_MB = 100 * 1024 * 1024;
/**
 * A shell's words for 100 MB on stdout (`>&2`: on stderr), with no newline in them (NUL bytes): a megabyte at a time, 2 ms
 * apart, as a VM's process writes through its exec's pipe rather than at the speed of memory, so that the reader here
 * collects its garbage between them as it would.
 */
const flood = (to = "") => `python3 -I -c 'import os, sys, time\nchunk = bytes(1 << 20)\nfor _ in range(${HUNDRED_MB >> 20}):\n    os.write(1, chunk); time.sleep(0.002)' ${to}`;

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "invincible-vm-output-")));
const dest = join(scratch, "dest");
mkdirSync(dest);
/** A stand-in for the engine's binary (docker, container): whatever it is asked, 100 MB on stdout and on stderr. */
function engine(): string {
  const path = join(scratch, "engine");
  writeFileSync(path, `#!/bin/sh\n${flood()}\n${flood(">&2")}\n`);
  chmodSync(path, 0o755);
  return path;
}
// Its probe of the engine is given 10 minutes, not the node's 8 s (availableMs). This case's subject is the memory bound
// of reading 100 MB, not the probe's deadline: on a starved machine (2 % of a core, what each of ~585 runnable tasks gets
// of 12 cores) reading the flood took longer than 8 s, and the probe said the engine was down (28 November 2026). The
// node's own deadline is unchanged, and the assertion that the engine answers stands: no gate is loosened here.
const host = (docker: string) =>
  new SandboxHost({ node: "test", maxCpus: 8, maxMemoryGb: 16, docker, availableMs: 600_000, tokens: { mint: () => ({ token: "t", info: { hash: "h" } }), revoke: () => true }, ledger: () => {} } as never);

const cases: Record<string, () => Promise<Record<string, unknown>>> = {
  // A collect whose VM says 100 MB on its stderr before it writes its tar (a real one, of a small folder).
  "collect-stderr": async () => {
    const work = join(scratch, "work");
    mkdirSync(join(work, "out"), { recursive: true });
    writeFileSync(join(work, "out", "report.md"), "# r\n");
    const proc = Bun.spawn(["sh", "-c", `${flood(">&2")}; exec "$@"`, "sh", ...collectCommand(join(work, "out"), work)], { env: { ...process.env, HOME: scratch }, stdout: "pipe", stderr: "pipe" });
    const kept = await collectFrom(proc, "/work/out", dest, { maxBytes: 1 << 20, maxFiles: 100, maxEntries: 400 });
    return { files: kept?.files.map((f) => f.path) ?? null };
  },
  // A collect whose VM writes a tar of 100 MB (one file, past the limit), and 100 MB on its stderr, and fails.
  "collect-stdout": async () => {
    const tar = `import sys, tarfile\nt = tarfile.open(fileobj=sys.stdout.buffer, mode="w|")\ni = tarfile.TarInfo("out/big")\ni.size = ${HUNDRED_MB}\nt.addfile(i, open("/dev/zero", "rb"))\nt.close()`;
    const proc = Bun.spawn(["sh", "-c", `${flood(">&2")}; python3 -I -c '${tar}'; exit 1`], { stdout: "pipe", stderr: "pipe" });
    const said = await collectFrom(proc, "/work/out", dest, { maxBytes: 1 << 20, maxFiles: 100, maxEntries: 400 }).then(
      () => "kept",
      (error: Error) => error.message,
    );
    return { said: said.slice(0, 120) };
  },
  // deskd's session, as its VM writes it: one line of 100 MB.
  session: async () => {
    const lines: number[] = [];
    const proc = spawnSession("sh")(["-c", flood()]);
    proc.onLine((line) => void lines.push(line.length));
    const code = await proc.exited;
    await Bun.sleep(300);
    return { code, lines, why: (proc as { why?: string | null }).why ?? null };
  },
  // Apple's container CLI, asked its version (runnerOf), saying 100 MB on each.
  probe: async () => ({ running: (await probeContainer(undefined, engine()))?.container.running ?? null }),
  // The engine's commands as the host runs them (exec's way too), saying 100 MB on each.
  docker: async () => ({ available: await host(engine()).available() }),
  // A held exec's lines (a follow, a sign-in), 100 MB with no newline.
  stream: async () => {
    let lines = 0;
    for await (const _ of spawnStream(["sh", "-c", flood()]).lines) lines++;
    return { lines };
  },
};

const name = process.argv[2] ?? "";
const run = cases[name];
if (!run) throw new Error(`no case ${name}`);
// What it keeps, not what it has yet to collect: garbage collected as it reads, so its peak is what it holds.
Bun.gc(true);
const collecting = setInterval(() => Bun.gc(true), 10);
const before = process.resourceUsage().maxRSS;
try {
  const said = await run();
  clearInterval(collecting);
  // (maxRSS is in KB, on Linux and on macOS alike.)
  console.log(JSON.stringify({ case: name, grewMB: Math.round((process.resourceUsage().maxRSS - before) / 1024), ...said }));
} finally {
  clearInterval(collecting);
  rmSync(scratch, { recursive: true, force: true });
}
