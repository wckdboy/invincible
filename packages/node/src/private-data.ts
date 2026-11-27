import { installedConnector, privateConnector } from "@invincible/models";
import type { LedgerStore } from "@invincible/ledger";

/*
 * Your private data where it isn't a private connector's own call (PRIVATE_CONNECTORS; the re-review of 27 November,
 * B1, B2, B4, and the side doors after it): a connector is private if it ever was, as the log says it was installed,
 * not only as it stands now; and so is a loop, when what it runs on is or was: one that new mail wakes, or one whose task
 * calls a private connector. What such a loop's runs record, and the lines its runs' commands write, are yours alone.
 */

/** Whether a connector's answers are your private data: its id, its manifest now, or any manifest it was ever installed with. */
export function connectorIsPrivate(store: LedgerStore, id: string): boolean {
  return privateConnector(id, installedConnector(store, id)) || store.connectorWasPrivate(id);
}

/** Whether a run's id is a loop's run's at all (so its loops are read only for one that may be). */
export const loopRun = (run: unknown): run is string => typeof run === "string" && /^(?:arm\.)?loop\./.test(run);

/**
 * Whether a run is one of these loops' runs, by its id: as the loop calls it (`loop.<name>`), as its arm runs it
 * (`arm.loop.<name>`), or as its arm names a run of its own (`arm.loop.<name>.<id>`, server.ts runRef). A loop's name
 * may hold a dot, so each of the loops is tried.
 */
export function runOfLoops(run: unknown, loops: ReadonlySet<string>): boolean {
  const name = loopRun(run) ? run.replace(/^(?:arm\.)?loop\./, "") : null;
  return name !== null && [...loops].some((loop) => name === loop || name.startsWith(`${loop}.`));
}

/**
 * The loops whose runs hold your private data, by name: each one new mail ever woke, and each one whose task ever
 * called a private connector, as the log says. So every replica decides alike, and a loop removed, or set again without
 * them, still was (B4's way, for loops).
 */
export function privateLoops(store: LedgerStore): Set<string> {
  const loops = new Set(store.loopsMailWoke());
  for (const { name, connector } of store.loopCalls()) if (!loops.has(name) && connectorIsPrivate(store, connector)) loops.add(name);
  return loops;
}

/** What a run your private data woke writes in place of its command's words: that it ran one, and how that ended. */
export function withheldRunDetail(resource: string, detail: string | undefined): string {
  const exit = /→ exit (-?\d+)$/.exec(detail ?? "")?.[1];
  return resource === "sandbox.exec" ? `a command of a run your private data woke${exit === undefined ? "" : ` → exit ${exit}`}` : "a line of a run your private data woke";
}
