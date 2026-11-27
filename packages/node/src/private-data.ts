import { installedConnector, privateConnector } from "@invincible/models";
import type { LedgerStore } from "@invincible/ledger";
import { loopRecords } from "./loops.ts";

/*
 * Your private data where it isn't a private connector's own call (PRIVATE_CONNECTORS; the re-review of 27 November,
 * B1): a loop is private when what it runs on is: one that new mail wakes, or one that calls a private connector. The
 * lines its runs' commands write are yours alone.
 */

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

/** The loops whose runs hold your private data, by name: each one new mail wakes, and each one that calls a private connector. */
export function privateLoops(store: LedgerStore): Set<string> {
  const isPrivate = (id: string) => privateConnector(id, installedConnector(store, id));
  return new Set(loopRecords(store).filter((loop) => loop.wakes.some((wake) => wake.kind === "mail") || (loop.task?.kind === "call" && isPrivate(loop.task.connector))).map((loop) => loop.name));
}

/** What a run your private data woke writes in place of its command's words: that it ran one, and how that ended. */
export function withheldRunDetail(resource: string, detail: string | undefined): string {
  const exit = /→ exit (-?\d+)$/.exec(detail ?? "")?.[1];
  return resource === "sandbox.exec" ? `a command of a run your private data woke${exit === undefined ? "" : ` → exit ${exit}`}` : "a line of a run your private data woke";
}
