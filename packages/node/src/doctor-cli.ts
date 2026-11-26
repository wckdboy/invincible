import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { type DoctorCheck, type DoctorReport, doctorExit, doctorLines, doctorSorted, type DoctorStyle, doctorTally, doctorTook, type RouteName } from "@galahad/core";
import { realSystem } from "./doctor-facts.ts";
import type { Home } from "./home.ts";

/*
 * `galahad doctor`: is everything well? One command; the node does the looking, this
 * prints. Exit code 0 when all is well, 1 when something needs you, 2 when something
 * is broken; `--json` for machines.
 *
 *   galahad doctor              the whole check (asks each role's model one word, starts and removes a sandbox)
 *   galahad doctor --offline    the same without asking any model or probing any connector's service
 *   galahad doctor --quick      only what costs nothing to look at (what the app's Overview shows)
 *
 * With no node running there's nobody to ask, so it says so, and looks at what a
 * stopped node leaves on disk: its key file's mode, the mind's database, the disk.
 */

interface Api {
  call<T = any>(name: RouteName, input?: unknown): Promise<T>;
}

type Flags = Record<string, string | boolean | (string | boolean)[] | undefined>;

const COLOURS: Record<DoctorCheck["state"], string> = { ok: "32", "needs-you": "33", broken: "31;1", skipped: "2" };

/** The report as a terminal shows it (coloured on a terminal, plain in a pipe): who was looked at, the lines, how long it took. */
export function reportLines(report: DoctorReport, tty = !!process.stdout.isTTY): string[] {
  const paint = (code: string, s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
  const style: DoctorStyle = { head: (s) => paint("1", s), state: (state, s) => paint(COLOURS[state], s), dim: (s) => paint("2", s) };
  const how = report.quick ? " · quick: only what costs nothing to look at" : report.offline ? " · offline: no model asked, no service probed" : "";
  return [style.head(`Galahad's doctor on ${report.node}`) + style.dim(how), ...doctorLines(report, style), style.dim(`Took ${doctorTook(report.tookMs)}.`)];
}

/** What can be told with no node running: that it isn't, and what it left on disk. Opens the mind read-only. */
export function stoppedReport(home: Home, base: string, started = performance.now()): DoctorReport {
  const checks: DoctorCheck[] = [
    {
      id: "service.running",
      area: "service",
      state: "broken",
      line: `the node isn't running: nothing answers on ${base}`,
      fix: "Start it: galahad serve (as a service: systemctl start galahad; journalctl -u galahad -n 100 says why it stopped).",
    },
  ];
  let name = "this machine";
  try {
    const config = home.readConfig();
    name = config.name;
    checks.push({ id: "node.identity", area: "node", state: config.fleet ? "ok" : "needs-you", line: config.fleet ? `${name} is set up as a node (its config reads well)` : `${name} hasn't joined a fleet`, ...(config.fleet ? {} : { fix: "galahad init founds one; galahad join <invite> joins one." }) });
    if (config.keystore === "file") {
      const file = realSystem.file(home.keyFilePath)!;
      if (!file.exists) checks.push({ id: "node.keys", area: "node", state: "broken", line: "its key file (keys.json) is gone, so it can't start", fix: "Restore keys.json from a backup of the node's home, or enrol this machine again (galahad join) and revoke the old entry." });
      else if (file.mode !== null && file.mode & 0o077) checks.push({ id: "node.keys", area: "node", state: "broken", line: `its key file can be read by other users of this machine (mode ${(file.mode & 0o777).toString(8)})`, fix: "chmod 600 keys.json in the node's home, then consider the keys read: revoke this node and enrol it again." });
      else checks.push({ id: "node.keys", area: "node", state: "ok", line: "its key file is there" });
    }
  } catch (error) {
    checks.push({ id: "node.identity", area: "node", state: "broken", line: `no usable node at ${home.dir}: ${String((error as Error).message).slice(0, 160)}`, fix: "galahad init founds a fleet here; galahad join <invite> joins one. --home (or GALAHAD_HOME) says where a node lives." });
  }
  if (existsSync(home.mindPath)) {
    try {
      const db = new Database(home.mindPath, { readonly: true });
      try {
        const rows = db.query<{ quick_check: string }, []>("PRAGMA quick_check").all();
        const ok = rows.length === 1 && rows[0]!.quick_check === "ok";
        checks.push(
          ok
            ? { id: "mind.integrity", area: "mind", state: "ok", line: "the mind's database passes SQLite's integrity check" }
            : { id: "mind.integrity", area: "mind", state: "broken", line: `the mind's database is damaged: ${rows.map((r) => r.quick_check).join("; ").slice(0, 200)}`, fix: "Keep mind.db aside. Restore it from your last backup, or enrol the node again from another one: the log syncs back." },
        );
      } finally {
        db.close();
      }
    } catch (error) {
      checks.push({ id: "mind.integrity", area: "mind", state: "broken", line: `the mind's database can't be opened: ${String((error as Error).message).slice(0, 160)}`, fix: "Keep mind.db aside. Restore it from your last backup, or enrol the node again from another one." });
    }
  }
  const disk = realSystem.disk(home.dir);
  if (disk) {
    const share = disk.totalGb ? disk.freeGb / disk.totalGb : 1;
    const words = `${Math.floor(disk.freeGb).toLocaleString("en")} GB free of ${Math.round(disk.totalGb).toLocaleString("en")} GB where the node keeps its home`;
    if (share < 0.03 || disk.freeGb < 1) checks.push({ id: "disk.home", area: "disk", state: "broken", line: `almost no disk left: ${words}`, fix: "Free space: a full disk is a likely reason the node stopped." });
    else checks.push({ id: "disk.home", area: "disk", state: "ok", line: words });
  }
  const sorted = doctorSorted(checks);
  return { node: name, at: Date.now(), quick: true, offline: true, checks: sorted, tally: doctorTally(sorted), tookMs: Math.round(performance.now() - started) };
}

/** Runs the doctor and prints its report. Returns the process's exit code: 0 well, 1 needs you, 2 broken. */
export async function doctorCommand(api: Api, flags: Flags, stopped: () => DoctorReport, print: (line: string) => void = console.log): Promise<0 | 1 | 2> {
  let report: DoctorReport;
  try {
    report = await api.call<DoctorReport>("doctor", { ...(flags.quick ? { quick: true } : {}), ...(flags.offline ? { offline: true } : {}) });
  } catch (error) {
    // Nobody to ask: say so, with what a stopped node leaves to look at.
    if (!/^no daemon on /.test(String((error as Error).message))) throw error;
    report = stopped();
  }
  if (flags.json) print(JSON.stringify(report, null, 2));
  else for (const line of reportLines(report)) print(line);
  return doctorExit(report.tally);
}
