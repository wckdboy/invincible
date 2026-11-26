import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { foundFleet, LedgerStore } from "@invincible/ledger";
import { Home } from "../../src/home.ts";
import { importCommand } from "../../src/import/index.ts";
import { freePort } from "../ports.ts";

/*
 * The homes the importer's tests use: the fixture's Galahad home (fixture/, made by Galahad's own code: make-fixture.ts),
 * copied into a temp folder of the test's own; and a new Invincible node, founded as `invincible init` founds one, its
 * keys in a file. Never ~/.invincible, never ~/.galahad.
 */

const FIXTURE = join(import.meta.dir, "fixture");

/** The fixture's Galahad home, in `dir`: its databases ungzipped, the rest as it is. */
export function oldHome(dir: string): string {
  const walk = (at: string): string[] => readdirSync(at).flatMap((name) => (statSync(join(at, name)).isDirectory() ? walk(join(at, name)) : [join(at, name)]));
  for (const file of walk(FIXTURE)) {
    const path = relative(FIXTURE, file);
    const gz = path.endsWith(".db.gz");
    const target = join(dir, gz ? path.slice(0, -3) : path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, gz ? Bun.gunzipSync(readFileSync(file)) : readFileSync(file), { mode: 0o600 });
  }
  return dir;
}

/** A new node's home in `dir`, founded as `invincible init` founds one, on a port nothing answers on. */
export async function newHome(dir: string, name = "test-node"): Promise<Home> {
  const home = new Home(dir);
  const { identity } = await home.createIdentity("file");
  const store = new LedgerStore(home.ledgerPath);
  const fleet = foundFleet(store, identity, { fleetName: "test-fleet", nodeName: name });
  store.close();
  home.writeConfig({ v: 1, name, fleet, port: freePort(), keystore: "file", advertise: null });
  return home;
}

/** Every file under `dir`, by its path: its bytes' SHA-256 and its mode. What "nothing changed" is measured by. */
export function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string) => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        out[`${relative(dir, path)}/`] = (stat.mode & 0o777).toString(8);
        walk(path);
      } else out[relative(dir, path)] = `${createHash("sha256").update(readFileSync(path)).digest("hex")} ${(stat.mode & 0o777).toString(8)}`;
    }
  };
  walk(dir);
  return out;
}

/** The import as the CLI runs it: what it said, and its exit code. */
export async function runImport(old: string, home: Home, opts: { dryRun?: boolean; chats?: string; uid?: number } = {}): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const code = await importCommand("galahad", [old], { home, dryRun: opts.dryRun ?? false, chats: opts.chats, ...(opts.uid !== undefined ? { uid: opts.uid } : {}) }, (line) => lines.push(line));
  return { code, out: lines.join("\n") };
}
