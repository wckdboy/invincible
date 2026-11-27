import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foundFleet, LedgerStore } from "@invincible/ledger";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { fakeCaps } from "./fabric-pair.ts";
import { freePort } from "./ports.ts";

/*
 * A node whose clock went back after it wrote (it ran fast, and was set right since), as the doctor sees it on a running
 * node: its own last write leads its clock by more than its peers take, so they won't take its writes until their clocks
 * are within the ledger's 5 minutes of that stamp. The facts are gathered from its own ledger, as `invincible doctor` does.
 */

let daemon: Daemon | null = null;
let root: string | null = null;
afterEach(async () => {
  setSystemTime();
  await daemon?.stop();
  daemon = null;
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

test("its own last write leads its clock: said by its doctor, with how long its peers won't take its writes", async () => {
  root = mkdtempSync(join(tmpdir(), "doctor-clock-"));
  const home = new Home(join(root, "n"));
  const { identity, keystore } = await home.createIdentity("file");
  const store = new LedgerStore(home.ledgerPath);
  const fleet = foundFleet(store, identity, { fleetName: "one", nodeName: "solo" });
  store.close();
  home.writeConfig({ v: 1, name: "solo", fleet, port: freePort(), keystore, advertise: "127.0.0.1" });
  daemon = await startDaemon(home, { capabilities: fakeCaps("solo"), proxyPort: freePort(), log: () => {}, sidecar: false, defaultHeartbeat: false, archiveIntervalMs: false, backups: false });
  // It writes, and then its clock is set back 20 minutes.
  daemon.store.emit(daemon.identity, "notice.raised", { key: "doctor-clock-test", severity: "info", title: "a write of its own", body: "", source: "test", at: Date.now() });
  setSystemTime(new Date(Date.now() - 20 * 60_000));
  const clock = (await daemon.doctor({ quick: true, offline: true })).diagnoses.find((d) => d.id === "mind.clock")!;
  expect(clock.state).toBe("broken");
  expect(clock.line).toStartWith("its own last write is stamped 20 minutes after its clock, which went back after it wrote: its peers won't take its writes for about 15 minutes");
  // And it still writes: stamped by its own clock, after its last.
  expect(() => daemon!.store.emit(daemon!.identity, "notice.raised", { key: "doctor-clock-test-2", severity: "info", title: "another", body: "", source: "test", at: Date.now() })).not.toThrow();
});
