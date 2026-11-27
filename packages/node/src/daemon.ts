import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonical, decodeHlc, type FabricSettingView, fitLedger, moneyPrices, type SandboxLayoutView, type NodeIdentity, pricesOf, QAMP_SIDECAR_PORT, type QampEndpoint, REQUESTS_READ, screenSessionView } from "@invincible/core";
import { type ModelsContext, CATALOG, GatewayTokens, installedConnectors, type OAuthEndpoints, PLAN_PROVIDERS, pinLegacyKeys, refusedKeysOf, signInWindowsOf, windowsOf } from "@invincible/models";
// The apps' own words for a task's verdict, cost and what can be done with it (the CLI reads them too).
import { activityOf } from "../../../apps/web/src/lib/live-activity.ts";
import { costWords, factsOfRecord, verdictOf } from "../../../apps/web/src/lib/steps.ts";
import { taskActions } from "../../../apps/web/src/lib/task-card.ts";
import { UsageStore } from "./usage.ts";
import { cloudflareNatives } from "./cloudflare.ts";
import { gmailNatives, outlookNatives } from "./mail.ts";
import { PairingHost, SyncEngine } from "@invincible/link";
import { adoptChains, LedgerStore, Vault } from "@invincible/ledger";
import { type DockerRunner, imagesAtStart, type LayoutEntry, type LayoutMove, type LayoutMoves, type LedgerEntryInput, type MacFirewallState, microVMsAvailable, NETWORKS, SANDBOX_GATEWAY_PORT, type SpawnFrames, type SpawnSession, type SpawnStream, type SpawnTerminal, startContainerService, vmResolvConf, WorkspaceHelper } from "@invincible/sandbox";
import type { ArgValue, HostLoad, TeamTrailEntry } from "@invincible/core";
import { calibrate, spawnBench } from "./compute/calibrate.ts";
import { GovernedSandboxHost } from "./compute/governed-host.ts";
import { Governor } from "./compute/governor.ts";
import { modelSpeed, sandboxStart } from "./compute/measure.ts";
import { ComputeService, liveHost, type Measure } from "./compute/service.ts";
import { ArmTokens, PRIMARY_ARM } from "./arms.ts";
import { QampGrants, type QampRunner, qampRunner, unspecified } from "./qamp-grants.ts";
import { Fabric, fabricRequest, type FabricPrincipal } from "./fabric/service.ts";
import { FABRIC_OFF, Sidecar, sidecarListen, type SpawnSidecar } from "./fabric/sidecar.ts";
import { Handoffs } from "./fabric/handoff.ts";
import { ArtifactStore } from "./artifacts.ts";
import { artifactsAdapter, chatsAdapter, investigationsAdapter, memoriesAdapter, skillsAdapter, evalsAdapter } from "./archive/adapters.ts";
import { LocalDiskBackend } from "./archive/blobs.ts";
import { ArchiveService } from "./archive/service.ts";
import { backupDirFor, BackupRunner } from "./backups.ts";
import { ArchiveStore } from "./archive/store.ts";
import { ChatStore } from "./chats.ts";
import { TeamStore } from "./team-store.ts";
import type { TeamService } from "./team.ts";
import { type HubLimits, TurnHub } from "./turns.ts";
import { LookRunner } from "./looks.ts";
import { Uploads } from "./uploads.ts";
import { RunBoard } from "./runs.ts";
import { skillAsker, SkillsService } from "./skills.ts";
import { buildAssets } from "./assets.ts";
import { type Capabilities, isAlwaysOn, presence, probeCapabilities } from "./capabilities.ts";
import { keepAwake } from "./keep-awake.ts";
import { ConnectorService } from "./connectors.ts";
import { loopNotice, tellNotice } from "./heartbeat.ts";
import { cheapestRole, computeUpkeep, type LoopTaskDeps, lookAround, loopExecutor } from "./loop-tasks.ts";
import { LoopRunner, loopRecords } from "./loops.ts";
import { loopRun, privateLoops, runOfLoops, withheldRunLine } from "./private-data.ts";
import { LoopDrafts } from "./loop-drafts.ts";
import { ConnectorRequests } from "./connector-requests.ts";
import { declinedPush, giveBack, reviewBack, wantsReviews } from "./ci-back.ts";
import { CiWatch, type ShippedPull, shippedPulls } from "./ci-watch.ts";
import { WakeWatcher } from "./wakes.ts";
import { Questions } from "./questions.ts";
import { SlackGateway } from "./slack.ts";
import { TelegramGateway } from "./telegram.ts";
import type { OutcomeRunner } from "./outcomes.ts";
import type { BacklogRunner } from "./backlog.ts";
import { loadEnv } from "./env.ts";
import type { Home } from "./home.ts";
import { createApp, listening } from "./server.ts";
import { shipmentFiles, shipNative } from "./ship.ts";
import { mergeNative } from "./merge.ts";
import { type DoctorDeps, type DoctorOptions, type DoctorRun, type DoctorSystem, heartbeatFromDoctor, noSystem, realSystem, runDoctor, TroubleLog } from "./doctor-facts.ts";
import { NotifyService } from "./notify.ts";
import { Terminals } from "./terminals.ts";
import { NotifyStore } from "./notify-store.ts";
import { APPLE_PUSH, APPLE_PUSH_SECRET, ApplePushSender, appleTarget, readApplePushKey } from "./apns-send.ts";
import { CollectSender, collectTarget } from "./collect-send.ts";
import { MacScreen, screenHelper, spawnHelper } from "./mac-screen.ts";
import { DEFAULT_PUSH_CONTACT, PushSender } from "./push-send.ts";
import { primaryRevision } from "./revision.ts";

export interface Daemon {
  port: number;
  endpoint: string;
  identity: NodeIdentity;
  store: LedgerStore;
  sync: SyncEngine;
  /** Its peers over Q-AMP, through its sidecar (fabric/service.ts). */
  fabric: Fabric;
  /** Tasks it handed to other nodes' agents, and runs it runs for others (fabric/handoff.ts). */
  handoffs: Handoffs;
  loops: LoopRunner;
  connectors: ConnectorService;
  artifacts: ArtifactStore;
  /** The archive: everything kept for good, and searched by words and meaning. */
  archive: ArchiveService;
  /** Compute: the census, this node's calibration and slots, the plan, effort. */
  compute: ComputeService;
  /** The chat turns this node runs for you, and what you queued behind your chats. */
  turns: TurnHub;
  /** Its own looks, taken when they come (looks.ts). */
  looks: LookRunner;
  /** Your chats, on this node. */
  chats: ChatStore;
  /** The doctor: one look at this node's whole installation (doctor.ts). */
  doctor(opts?: DoctorOptions): Promise<DoctorRun>;
  /** Its own switch for the fabric (`invincible fabric on|off`): set and applied now (`on`), or only read (none). */
  fabricSetting(on?: boolean): Promise<FabricSettingView>;
  /** A new transport key for its sidecar (`invincible fabric rotate`): the old one is refused by its peers from then on. */
  rotateTransport(): Promise<FabricSettingView>;
  /** Notifications to your paired devices (notify.ts). */
  notify: NotifyService;
  stop(): Promise<void>;
}

export interface DaemonOptions {
  /** The daily backups of its databases (backups.ts); false: none (tests). */
  backups?: boolean;
  log?: (message: string) => void;
  syncIntervalMs?: number;
  /** Loopback port that `tailscale serve` proxies to (default: port + 1). */
  proxyPort?: number;
  /** Skip the (slow) hardware probe; used by tests. */
  capabilities?: Capabilities;
  /** How often the loop runner wakes (default 15 s). */
  loopIntervalMs?: number;
  /** How often its looks that came are looked for (ms; false: never, for tests that take them by hand). */
  lookIntervalMs?: number | false;
  /** How often the pull requests this node shipped have their checks read (false: never, for tests). */
  ciWatchMs?: number | false;
  /** How often what wakes its loops (mail, GitHub) is read (false: never, for tests). */
  wakeWatchMs?: number | false;
  /** Where Telegram's Bot API is (tests: a stand-in). */
  telegramBase?: string;
  /** Where Slack's Web API is (tests: a stand-in). */
  slackBase?: string;
  /** Let the fleet's founding node create its default loop, the heartbeat (default true; INVINCIBLE_HEARTBEAT=off disables). */
  defaultHeartbeat?: boolean;
  /** Outbound fetch for connectors (tests). */
  fetch?: typeof fetch;
  /** Where Google's and Microsoft's sign-ins are reached (tests: a stand-in). */
  oauthEndpoints?: Partial<OAuthEndpoints>;
  /** How often the archive's background work runs (default 20 s); false: never by itself (tests drive it). */
  archiveIntervalMs?: number | false;
  /** A stand-in for Docker (tests): the sandbox host runs its commands through it instead of spawning any. */
  docker?: DockerRunner;
  /** This Mac's own screen (tests: one over a stand-in helper; null: none). Absent: the app's own, where the node runs from it. */
  screen?: MacScreen | null;
  /** The disk a Mac's workspaces come out of, for their budget (default: the one its home is on; tests beside a stand-in pass one). */
  sandboxDisk?: () => { totalBytes: number; freeBytes: number };
  /** How launchctl is run on a Mac (tests: a stand-in; beside a stand-in for the engine, nothing, unless one is given). */
  launchctl?: DockerRunner;
  /** Whether a Mac's sandbox firewall is on (default: as its helper and the bridges say: mac-firewall.ts; tests pass their own). */
  macFirewall?: () => Promise<MacFirewallState>;
  /** How a terminal's process is started beside that stand-in (tests: a local shell instead of `docker exec`). */
  spawnTerminal?: SpawnTerminal;
  /** How a process that runs while it's wanted is started in a sandbox (tests: a stand-in, beside one for Docker). */
  spawnStream?: SpawnStream;
  /** How a VM's held desktop sessions are started, the agent's and yours (tests: a stand-in for deskd, beside one for Docker). */
  spawnSession?: SpawnSession;
  /** How a VM's desktop stream is started while you watch it (tests: a stand-in for its encoder, beside one for Docker). */
  spawnFrames?: SpawnFrames;
  /**
   * Whether this node's sandboxes have networks of their own (default: they do). False is a scratch node beside a live
   * one on the same host (the desktop bench's glass harness): the sandbox networks, their image keepers and the sandbox
   * gateway's address are the live node's there, so it makes none of them and listens on no gateway. Its sandboxes are
   * made isolated.
   */
  sandboxNetworks?: boolean;
  /**
   * How this node measures itself. Default: the real benchmark, a few seconds at low priority (and never in
   * tests that pass their own capabilities, unless they give one here). false: it doesn't.
   */
  measure?: Measure | false;
  /** The machine's live load, for admitting sandboxes (default: the real one; null with test capabilities, where only the ceiling counts). */
  hostLoad?: () => Omit<HostLoad, "oursRecently"> | null;
  /** The longest a sandbox waits for a slot (default 30 minutes). */
  slotWaitMs?: number;
  /** The node's limits on chat turns (default: 4 at once, 30 minutes each, 20 queued a chat; INVINCIBLE_TURNS_MAX and INVINCIBLE_TURN_MINUTES set the first two). */
  turnLimits?: Partial<HubLimits>;
  /** How long requests and turns under way get to finish when the node stops (default 10 s; tests pass less). */
  shutdownGraceMs?: number;
  /**
   * What the doctor asks of the machine itself (file modes, systemd, Tailscale, the disk, peers' clocks). Default: the
   * real machine; with test capabilities, nothing is asked unless a stand-in is given here.
   */
  system?: DoctorSystem;
  /**
   * Notifications (tests): push services to allow beyond the known ones (a stand-in on this machine, by its whole
   * origin), how often it looks (false: only when the test says), its clock, and how a pause before a retry passes.
   */
  push?: { allow?: string[]; tickMs?: number | false; now?: () => number; sleep?: (ms: number) => Promise<void>; apple?: { development?: string; production?: string } };
  /** How Q-AMP's binary is run for grants (tests: a stand-in). Default: <home>/bin/qamp, or INVINCIBLE_QAMP_BIN. */
  qamp?: QampRunner;
  /**
   * The node's sidecar (fabric/sidecar.ts). Default: <home>/bin/qamp (or INVINCIBLE_QAMP_BIN) on the advertised address,
   * UDP 7410 (INVINCIBLE_QAMP_PORT). Tests: another binary, port or socket, or a stand-in spawner; false: none (every
   * link over HTTP with signed requests).
   */
  sidecar?: { binary?: string | null; port?: number; socket?: string; spawn?: SpawnSidecar } | false;
  /** How long a run's grant lasts before it is renewed at half of it (tests: a few seconds; default 300). */
  fabricGrantTtlSecs?: number;
  /** The UDP ports grants' bridges listen on (tests: others; default 7411–7419), and how often expiry is looked for. */
  qampPorts?: { first: number; last: number };
  qampSweepMs?: number;
}

/**
 * The fleet's founder gives the primary a heartbeat once: every 30 minutes on an
 * always-on node. Never again after that, so a heartbeat you removed stays removed.
 */
function ensureHeartbeat(store: LedgerStore, identity: NodeIdentity, caps: Capabilities): void {
  if (store.genesis?.device !== identity.id || store.lww("loop:heartbeat")) return;
  const server = isAlwaysOn(caps)
    ? undefined
    : store.devices().find((d) => d.kind === "node" && d.role === "full" && isAlwaysOn(d.profile?.caps as Partial<Capabilities> | undefined));
  store.emit(identity, "loop.set", {
    name: "heartbeat",
    schedule: "every 30m",
    tz: "UTC",
    on: server?.id ?? identity.id,
    enabled: true,
    task: { kind: "heartbeat" },
    label: "Your agent's regular look around",
  });
}

/** No request may make a node buffer more than this (Bun's default is about 128 MB). */
const MAX_REQUEST_BODY = 8 * 1024 * 1024;
/** How long a stopping node lets requests under way finish (a chat being answered) before it closes them. */
const SHUTDOWN_GRACE_MS = 10_000;

/** Publish this node's endpoint + capabilities, only when they changed (idempotent). */
function publishProfile(store: LedgerStore, identity: NodeIdentity, endpoint: string, caps: Capabilities): void {
  // (And that it reads requests that name it, so its peers name it: core's REQUESTS_READ.)
  const body = { endpoint, caps: { ...(caps as unknown as Record<string, unknown>), requests: REQUESTS_READ } };
  const current = store.device(identity.id)?.profile;
  if (current && canonical(current) === canonical(body)) return;
  store.emit(identity, "node.profile", body);
}

/**
 * What you are told once when an agent's VM is moved to layout 2 (the owner's decision of 27 November 2026): the agent by
 * name, and what of its store went where, by names and sizes alone (layout.ts's list: never a byte of a file). Within a
 * notice's limits, and well-formed text whatever the names hold, so that no reader refuses the answers that carry it
 * (R4-5: a lone surrogate there made the Apple apps' JSONDecoder refuse every notice): each one, from a name or from
 * a cut, is said as U+FFFD.
 */
export function layoutNotice(name: string, entries: readonly LayoutEntry[]): { title: string; body: string } {
  const said = layoutWords(name, entries);
  return { title: wellFormed(said.title.slice(0, 200)), body: wellFormed(said.body.slice(0, 2000)) };
}

/** Text with each lone UTF-16 surrogate (one that isn't half of a pair) said as U+FFFD, as String#toWellFormed does. */
function wellFormed(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
}

function layoutWords(name: string, entries: readonly LayoutEntry[]): { title: string; body: string } {
  const size = (bytes: number) => (bytes >= 2 ** 30 ? `${(bytes / 2 ** 30).toFixed(1)} GB` : bytes >= 2 ** 20 ? `${Math.round(bytes / 2 ** 20)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
  const home = entries.filter((e) => e.to === "home");
  const notes = entries.find((e) => e.to === "notes");
  return {
    title: `${name}'s VM has a HOME of its own`,
    body: [
      `${name}'s VM was made again with a HOME of its own, apart from its workspace: what its tools keep for themselves (their sign-ins and config), its notes and its lease are no longer in /work, so no VM that shares its workspace (a run on a seat, another node's task) reaches them.`,
      `Moved to its HOME: ${home.map((e) => `${e.name} (${size(e.bytes)})`).join(", ") || "nothing"}. ${notes ? `Its notes (${size(notes.bytes)}) were moved to a place of their own.` : "It had no notes yet: they'll be kept in a place of their own."} Its workspace is as it was. Whatever was running in its VM ended as it was made again.`,
    ].join("\n"),
  };
}

/**
 * One look at this node's own body: probe, then publish. It runs on a timer, and Bun ends
 * the process on an unhandled rejection, so a failure here is a line in the log (the last
 * capabilities stand), never the end of the node. Returns what the probe found, or null.
 */
export async function refreshCapabilities(
  probe: () => Promise<Capabilities>,
  publish: (caps: Capabilities) => void,
  log: (message: string) => void,
): Promise<Capabilities | null> {
  let fresh: Capabilities;
  try {
    fresh = await probe();
  } catch (error) {
    log(`capabilities not refreshed: ${(error as Error).message}`);
    return null;
  }
  try {
    publish(fresh);
  } catch (error) {
    log(`profile not published: ${(error as Error).message}`);
  }
  return fresh;
}

export async function startDaemon(home: Home, opts: DaemonOptions = {}): Promise<Daemon> {
  // The doctor reads the lines of this log that read like trouble (in memory, redacted when kept).
  const trouble = new TroubleLog();
  const say = opts.log ?? ((message: string) => console.log(`[invincible] ${message}`));
  const log = (message: string): void => {
    trouble.note(message);
    say(message);
  };
  const env = loadEnv();
  const config = home.readConfig();
  if (!config.fleet) throw new Error("this node has not joined a fleet");
  const identity = await home.loadIdentity(config.keystore);
  const store = new LedgerStore(home.ledgerPath);
  store.expectFleet(config.fleet);
  if (!store.activeDevice(identity.id)) throw new Error("this node is not an active member of its fleet (revoked?)");
  const vault = new Vault(store, identity);
  const local = new Database(home.localPath, { create: true, strict: true });
  local.exec("PRAGMA journal_mode = WAL");
  const tokens = new GatewayTokens(local);
  const arms = new ArmTokens(local);
  // This node's own count of its model calls (usage.ts): node-local, counts only, never the mind's log.
  const usage = new UsageStore(local);
  // A plan whose allowance a provider said is spent stays so through a restart: its models passed over, the meter saying
  // it, until it resets.
  const spentWindows = windowsOf(store);
  spentWindows.restore(usage.spentWindows());
  spentWindows.kept = (window) => usage.keepSpentWindow(window);
  // So does a vendor's tool's own sign-in whose plan its tool said is spent: it goes last on its agent's tasks until then.
  const spentSignIns = signInWindowsOf(store);
  spentSignIns.restore(usage.spentSignIns());
  spentSignIns.kept = (window) => usage.keepSpentSignIn(window);
  // A provider whose key a call got refused stays said through a restart, too: the doctor and the Inbox say it until a
  // later call gets through (which forgets it) or the key is set again (which the doctor reads as the refusal being moot).
  const refusedKeys = refusedKeysOf(store);
  refusedKeys.restore(usage.refusedKeys());
  refusedKeys.kept = (refusal) => usage.keepRefusedKey(refusal);
  refusedKeys.forgot = (provider) => usage.forgetRefusedKey(provider);
  /** Its own upkeep's calls (the heartbeat's words, its skills, the archive), counted as its. */
  const upkeepSpent: NonNullable<ModelsContext["spent"]> = (call) => usage.note("primary", call.role, call.ref, call.usage);

  const port = env.INVINCIBLE_PORT ?? config.port;
  // A Mac set to stay on is kept from sleeping while the node runs, and says so in its capabilities (isAlwaysOn).
  const awake = config.keepAwake ? keepAwake() : null;
  if (config.keepAwake && !awake) log("keep-awake is on, but only a Mac with caffeinate can be kept awake: this machine isn't");
  const withAwake = (c: Capabilities): Capabilities => (awake ? { ...c, awake: true } : c);
  // A Mac's container doesn't start its service at boot: the node starts it as it starts, as the doctor would have you.
  if (!opts.capabilities && process.platform === "darwin") {
    const service = await startContainerService().catch(() => "failed" as const);
    if (service === "started") log("started Apple's container: its service doesn't start by itself at boot");
    else if (service === "failed") log("Apple's container is installed, but its service wouldn't start: container system start says why");
  }
  // This Mac's own screen, where the node runs from the app (mac-screen.ts): what macOS lets the app do, it may.
  const screenBinary = opts.screen === undefined ? screenHelper() : null;
  const screen = opts.screen !== undefined ? opts.screen : screenBinary ? new MacScreen(spawnHelper(screenBinary)) : null;
  const withScreen = (c: Capabilities): Capabilities => (screen ? { ...c, screen: true } : c);
  let caps = withScreen(opts.capabilities ?? withAwake(await probeCapabilities()));
  const advertise = env.INVINCIBLE_ADVERTISE ?? config.advertise ?? caps.tailscale?.ip ?? "127.0.0.1";
  const endpoint = `http://${advertise}:${port}`;

  // The fabric (docs/ARCHITECTURE.md §3): its peers over Q-AMP, through its sidecar, which holds no secret but the node's
  // transport key; HTTP with signed requests to any peer it can't be had for, as before it.
  const qampBin = env.INVINCIBLE_QAMP_BIN ?? join(home.dir, "bin", "qamp");
  // (With test capabilities, none unless the test asks for one: no test binds a real port by accident. INVINCIBLE_QAMP=off:
  // none at all, every link over HTTP with signed requests, the way back if Q-AMP misbehaves, whatever the node's setting says.)
  const sidecarOpts = opts.sidecar === false || env.INVINCIBLE_QAMP === "off" || (opts.sidecar === undefined && opts.capabilities) ? null : (opts.sidecar ?? {});
  // Its own setting, off by default: the binary alone switches nothing on (the grants' bridges run it either way).
  let fabricOn = config.fabric === true;
  const qampPort = sidecarOpts?.port ?? env.INVINCIBLE_QAMP_PORT ?? QAMP_SIDECAR_PORT;
  /** What the profile last said of its endpoint: kept while the sidecar is down, so its profile doesn't flap. */
  let qampEndpoint: QampEndpoint | null = null;
  let routes: ((req: Request, listener: "fabric") => Promise<Response>) | null = null;
  const sidecar = new Sidecar({
    home: home.dir,
    // Where its device keys are kept, for this node's id: read at each start, so a rotated key is the one it runs.
    key: () => home.transportKey(config.keystore, identity.id),
    binary: () => (sidecarOpts === null ? null : sidecarOpts.binary !== undefined ? sidecarOpts.binary : qampBin),
    off: () => (fabricOn ? null : FABRIC_OFF),
    // Its advertised address alone, never every interface: with no other to give it, it only dials out.
    listen: () => sidecarListen(advertise, qampPort, unspecified),
    name: config.name,
    log,
    ...(sidecarOpts?.socket ?? env.INVINCIBLE_QAMP_SOCKET ? { socket: sidecarOpts?.socket ?? env.INVINCIBLE_QAMP_SOCKET } : {}),
    ...(sidecarOpts?.spawn ? { spawn: sidecarOpts.spawn } : {}),
    up: async (client) => {
      await fabric.serve(client);
      // Its endpoint in its profile, once it listens (and again only if it moved).
      const now = fabric.endpoint();
      if (now && (now.address !== qampEndpoint?.address || now.did !== qampEndpoint?.did)) {
        qampEndpoint = now;
        if (profiled) publishProfile(store, identity, endpoint, withQamp(caps));
      }
    },
  });
  const fabric = new Fabric({
    store,
    identity,
    sidecar,
    log,
    presence: async () => ({ ...(await presence()), compute: compute.usage() }),
    // A route a node forwarded over Q-AMP: the same door as over HTTP, for the principal its key proved.
    route: async (path, body, principal: FabricPrincipal, signal) => {
      if (!routes) return { status: 503, body: { error: "this node is starting" } };
      const res = await routes(fabricRequest(path, body, principal, signal), "fabric");
      const text = await res.text();
      try {
        return { status: res.status, body: text.trim() ? JSON.parse(text) : null };
      } catch {
        return { status: res.status, body: { error: text.slice(0, 500) } };
      }
    },
  });
  // Tasks handed to other nodes' agents and handed here, each over one Q-AMP call, its proof signed by the node that ran it.
  // (A Mac takes no other node's task: MAC_TAKES_NO_TASK says why.)
  const handoffs = new Handoffs({ db: local, store, identity, fabric, log, mac: caps.os === "darwin", ...(opts.fabricGrantTtlSecs ? { grantTtlSecs: opts.fabricGrantTtlSecs } : {}) });
  fabric.attach(handoffs);
  /** Its capabilities as its profile says them: with its Q-AMP endpoint, once its sidecar has said one. */
  const withQamp = (c: Capabilities): Capabilities => (qampEndpoint ? { ...c, qamp: qampEndpoint } : c);
  let profiled = false;
  /**
   * Its own switch, kept in its config: on starts its sidecar now (its profile names its endpoint once it listens); off
   * stops it, and its profile names none from then on, so its peers reach it over HTTP alone, with signed requests.
   */
  let switching: Promise<unknown> = Promise.resolve();
  const fabricView = (): FabricSettingView => ({ on: fabricOn, state: sidecar.state, why: sidecar.why, did: sidecar.did, address: sidecar.address });
  const fabricSetting = (on?: boolean): Promise<FabricSettingView> => {
    const next = switching.then(async () => {
      if (on === undefined || on === fabricOn) return fabricView();
      home.writeConfig({ ...home.readConfig(), fabric: on });
      fabricOn = on;
      log(`fabric: switched ${on ? "on" : "off"} on this node`);
      if (on) await sidecar.start();
      else {
        await sidecar.stop(FABRIC_OFF);
        if (qampEndpoint) {
          qampEndpoint = null;
          if (profiled) publishProfile(store, identity, endpoint, withQamp(caps));
        }
      }
      return fabricView();
    });
    switching = next.catch(() => {});
    return next;
  };
  /**
   * A new transport key in place of the one kept: its profile stops naming the old one at once, its sidecar starts
   * again on the new one (when the fabric is on), and its profile names that once it listens. From then on its peers
   * refuse the old key, as no profile of an active node names it.
   */
  const rotateTransport = (): Promise<FabricSettingView> => {
    const next = switching.then(async () => {
      const made = await home.rotateTransportKey(config.keystore, identity.id);
      log(`fabric: its transport key was rotated: now ${made.did.slice(0, 22)}…`);
      if (qampEndpoint) {
        qampEndpoint = null;
        if (profiled) publishProfile(store, identity, endpoint, withQamp(caps));
      }
      if (fabricOn) {
        await sidecar.stop("its transport key was rotated");
        await sidecar.start();
      }
      return { ...fabricView(), did: made.did };
    });
    switching = next.catch(() => {});
    return next;
  };
  const sync = new SyncEngine(store, identity, { intervalMs: opts.syncIntervalMs, log, transport: fabric });
  const stopPush = store.onEmit((event) => sync.push([event]));
  const pairing = new PairingHost(store, identity, endpoint);

  // A legacy fleet's founder adopts hash chains once (no-op everywhere else).
  try {
    const adopted = adoptChains(store, identity);
    if (adopted !== null) log(`adopted hash chains; ${adopted} legacy event(s) grandfathered, no others ever`);
  } catch (error) {
    log(`chain adoption failed: ${(error as Error).message}`);
  }

  // Keys entered before origin pinning get pinned to where their provider points today.
  try {
    const pinned = pinLegacyKeys(store, vault);
    if (pinned.length) log(`pinned ${pinned.length} key(s) to their provider's origin: ${pinned.join(", ")}`);
  } catch (error) {
    log(`key pinning skipped: ${(error as Error).message}`);
  }

  // Node-local: which gateway token belongs to which sandbox (never trusted from container labels).
  local.exec("CREATE TABLE IF NOT EXISTS sandbox_tokens (id TEXT PRIMARY KEY, hash TEXT NOT NULL)");
  const sandboxTokens = {
    put: (id: string, hash: string) => void local.query("INSERT OR REPLACE INTO sandbox_tokens (id, hash) VALUES (?, ?)").run(id, hash),
    take: (id: string) => {
      const row = local.query<{ hash: string }, [string]>("SELECT hash FROM sandbox_tokens WHERE id = ?").get(id);
      local.query("DELETE FROM sandbox_tokens WHERE id = ?").run(id);
      return row?.hash ?? null;
    },
    peek: (id: string) => local.query<{ hash: string }, [string]>("SELECT hash FROM sandbox_tokens WHERE id = ?").get(id)?.hash ?? null,
  };
  // Node-local too: each move of an agent's store to layout 2 under way, its word among it (never in the store, which the
  // agent's VM writes), so that a node that stops in the middle takes it up again.
  local.exec("CREATE TABLE IF NOT EXISTS sandbox_layout_moves (id TEXT PRIMARY KEY, move TEXT NOT NULL)");
  const layoutMoves: LayoutMoves = {
    started: (id) => {
      const row = local.query<{ move: string }, [string]>("SELECT move FROM sandbox_layout_moves WHERE id = ?").get(id);
      return row ? (JSON.parse(row.move) as LayoutMove) : null;
    },
    start: (id, move) => void local.query("INSERT OR REPLACE INTO sandbox_layout_moves (id, move) VALUES (?, ?)").run(id, JSON.stringify(move)),
    end: (id) => void local.query("DELETE FROM sandbox_layout_moves WHERE id = ?").run(id),
  };

  // Every gated action lands in the signed, replicated ledger.
  // A run your private data woke is itself private (private-data.ts; the re-review of 27 November, B1): the lines it
  // writes in its own words (its commands, a tripwire's that stopped one, its web searches) say that it did so and how
  // that ended, never what it ran or searched, since the run was told who wrote and what about.
  const ledger = (entry: LedgerEntryInput) => {
    const plain = Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined)) as LedgerEntryInput;
    const withheld = loopRun(plain.run) ? withheldRunLine(plain) : null;
    // (Within the log's limits, so no line is refused for its length and left unrecorded: the re-review's A4.)
    const body = fitLedger(withheld && runOfLoops(plain.run, privateLoops(store)) ? withheld : plain);
    try {
      store.emit(identity, "ledger.recorded", body);
    } catch (error) {
      log(`ledger write failed: ${(error as Error).message}`);
    }
  };

  // Grants to agents on your other machines, over Q-AMP (qamp-grants.ts): each its arm, its chain and its bridge, which
  // serves `invincible mcp --arm qamp.<id> --tools …` on this node's own address. Its binary is the node's own copy.
  const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), "cli.ts");
  const qamp = new QampGrants({
    db: local,
    arms,
    home,
    port,
    address: () => advertise,
    runner: opts.qamp ?? qampRunner(() => qampBin),
    mcpCommand: (label, tools) => [process.execPath, cliPath, "mcp", "--arm", label, "--tools", tools.join(","), "--home", home.dir],
    ledger,
    log,
    ...(opts.qampPorts ? { ports: opts.qampPorts } : {}),
  });

  // Compute: this node's slots. Every sandbox it creates and every background model call takes one, and waits when
  // there's none; the ceiling is the owner's (or the default half), read from the mind as it is each time.
  let computeService: ComputeService | null = null;
  const governor = new Governor({
    capacity: () => computeService!.selfCapacity(),
    host: opts.hostLoad ?? (opts.capabilities ? () => null : liveHost),
    ...(opts.slotWaitMs ? { maxWaitMs: opts.slotWaitMs } : {}),
  });

  // Sandbox host: only when Docker is reachable on this machine, or on a Mac Apple's container (docs/MAC.md).
  /** An agent's VM moved to layout 2 (sandbox's layout.ts), said to you once: which agent, and what of its VM moved where. */
  const tellMoved = (run: string, entries: readonly LayoutEntry[]): void => {
    const handle = run.split(".").at(-1) ?? run;
    const said = layoutNotice(team.store.agent(handle)?.name ?? handle, entries);
    store.emit(identity, "notice.raised", { key: `layout:${handle}`.slice(0, 160), severity: "info", title: said.title, body: said.body, source: "sandbox", at: Date.now() });
  };
  let sandbox: GovernedSandboxHost | null = null;
  /**
   * Layout 2, its own setting (`invincible sandbox layout on|off`), off by default as the fabric is: off, every agent's VM
   * is made and kept in layout 1, and another node's task is refused here. Applied at once, at the next VM made or
   * prepared. Why it does nothing here, whatever it says: no sandbox host, or a Mac's (its VMs stay in layout 1).
   */
  let layout2On = config.layout2 === true;
  let layoutIdle: string | null = "this node has no sandbox host";
  const sandboxLayout = (on?: boolean): SandboxLayoutView => {
    if (on !== undefined && on !== layout2On) {
      home.writeConfig({ ...home.readConfig(), layout2: on });
      layout2On = on;
      log(`sandbox: layout 2 switched ${on ? "on" : "off"} on this node`);
    }
    return { on: layout2On, idle: layoutIdle };
  };
  const sandboxContext = resolve(dirname(fileURLToPath(import.meta.url)), "../../../sandbox");
  if (caps.sandbox !== undefined && caps.sandbox !== null) {
    // On a Mac with container: every sandbox a VM of its own, its /work container's own volume, its resolver container's.
    const apple = caps.sandbox.engine === "container";
    // Online microVMs can't use Docker's DNS (it lives on the host side): they get the host's resolvers.
    const resolvConf = join(home.dir, "sandbox-resolv.conf");
    const readIf = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);
    if (!apple) writeFileSync(resolvConf, vmResolvConf(readIf("/run/systemd/resolve/resolv.conf"), readIf("/etc/resolv.conf")), { mode: 0o644 });
    const microVMs = caps.sandbox.vm ?? microVMsAvailable();
    layoutIdle = apple ? "a Mac's VMs stay in layout 1: no VM there shares an agent's workspace" : null;
    sandbox = new GovernedSandboxHost(
      {
      node: identity.id,
      tokens,
      tokenStore: sandboxTokens,
      layoutMoves,
      ledger,
      ...(apple ? { engine: "container" as const, ...(opts.sandboxDisk ? { disk: opts.sandboxDisk } : {}) } : {}),
      ...(opts.docker ? { runner: opts.docker } : {}),
      // (Never the real launchd beside a stand-in for the engine: restarting a network's helper there would be the Mac's.)
      ...(opts.launchctl ? { launchctl: opts.launchctl } : opts.docker ? { launchctl: async () => ({ code: 0, stdout: "", stderr: "" }) } : {}),
      ...(opts.macFirewall ? { firewall: opts.macFirewall } : {}),
      ...(opts.spawnTerminal ? { spawnTerminal: opts.spawnTerminal } : {}),
      ...(opts.spawnStream ? { spawnStream: opts.spawnStream } : {}),
      ...(opts.spawnSession ? { spawnSession: opts.spawnSession } : {}),
      ...(opts.spawnFrames ? { spawnFrames: opts.spawnFrames } : {}),
      maxCpus: caps.cores,
      maxMemoryGb: Math.max(1, Math.floor(caps.memoryGb * 0.75)),
      // Size-limited workspaces when the root helper is installed (scripts/remote-setup.sh); otherwise
      // unlimited Docker volumes, and the heartbeat says so. Never beside a stand-in for Docker: the
      // helper is root on its host, and would make real images there for containers that don't exist.
      // (On a Mac the host makes container's own volumes, each of a fixed size, and needs no helper.)
      ...(opts.docker || apple ? {} : { workspaces: new WorkspaceHelper(env.INVINCIBLE_WORKSPACE_SOCKET) }),
      imageContext: sandboxContext,
      // Online sandboxes run in KVM microVMs where Kata is installed (scripts/remote-setup.sh).
      microVMs,
      ...(apple ? {} : { resolvConf }),
      // Layout 2 (sandbox's layout.ts): an agent's HOME apart from its workspace, on a Linux host with Docker, when its own
      // setting says so (sandboxLayout). A Mac's VMs stay in layout 1: no VM there shares a workspace. An agent's VM moved to
      // it is said to you once, by name.
      ...(apple ? {} : { layout2: () => layout2On, moved: (run: string, entries: readonly LayoutEntry[]) => tellMoved(run, entries) }),
      },
      { governor, capacity: () => computeService!.selfCapacity() },
    );
    try {
      if (opts.sandboxNetworks !== false) await sandbox.ensureNetworks();
      // Sandboxes from before this start hold their slots before anything new is admitted.
      await sandbox.reconcile();
      // Keep the images in use, so pruning (Coolify's nightly cleanup) doesn't take them, and at a new release's first
      // start make them again from its contexts: in the background, a minute on, never holding a start or a stop up.
      if (opts.sandboxNetworks !== false) void imagesAtStart(sandbox, { home: home.dir, release: primaryRevision(), log }).catch((error) => log(`sandbox images: ${(error as Error).message}`));
    } catch (error) {
      log(`sandbox networks unavailable: ${(error as Error).message}`);
      sandbox = null;
      layoutIdle = "this node has no sandbox host";
    }
  }
  // Terminals in this node's sandboxes, where it runs any (terminals.ts).
  const terminalHost = sandbox;
  const terminals = terminalHost ? new Terminals({ start: (id, size, onData) => terminalHost.terminal(id, size, onData), ledger }) : null;

  const startedAt = Date.now();
  // How this node measures itself: the benchmark in its own low-priority process, a sandbox's start-up through
  // its own governed host, a local model's speed through the roster's local runtimes. Nothing leaves the machine.
  const measuring = sandbox;
  const measure: Measure | null =
    opts.measure === false
      ? null
      : (opts.measure ??
        (opts.capabilities
          ? null
          : (reason, body, limit) =>
              calibrate(reason, {
                body,
                limit,
                dir: home.dir,
                load: () => liveHost().load,
                now: Date.now,
                bench: spawnBench,
                ...(measuring ? { sandboxStart: () => sandboxStart(measuring, governor, () => computeService!.selfCapacity()) } : {}),
                modelSpeed: () => modelSpeed({ store, vault, ...(opts.fetch ? { fetch: opts.fetch } : {}) }, caps, (o, signal) => governor.enterModel(o, signal)),
              })));
  const compute = new ComputeService({ store, identity, nodeName: config.name, caps: () => caps, peers: () => sync.status(), governor, ledger, log, measure });
  computeService = compute;
  const artifacts = new ArtifactStore({ store, identity, dir: join(home.dir, "artifacts"), ledger });
  const chats = new ChatStore(join(home.dir, "chats.db"));
  // What you attach to your messages: kept while a kept chat or a room's message carries it (or a chat used it this
  // week), then removed.
  const uploads = new Uploads(join(home.dir, "uploads"));
  const team: { store: TeamStore; service?: TeamService; outcomes?: OutcomeRunner; backlog?: BacklogRunner } = { store: new TeamStore(join(home.dir, "team.db")) };
  const sweepUploads = () => {
    try {
      const removed = uploads.sweep(new Set([...chats.attachmentIds(), ...team.store.attachmentIds()]));
      if (removed.length) log(`removed ${removed.length} attachment(s) no kept message carries and no chat used for a week`);
    } catch (error) {
      log(`attachments: ${(error as Error).message}`);
    }
  };
  sweepUploads();
  const uploadSweep = setInterval(sweepUploads, 24 * 3600_000);
  // Your chat turns run here to their end, whoever is listening; what you queue behind a chat waits in chats.db.
  const turns = new TurnHub({
    chats,
    log,
    limits: {
      ...(env.INVINCIBLE_TURNS_MAX ? { maxTurns: env.INVINCIBLE_TURNS_MAX } : {}),
      ...(env.INVINCIBLE_TURN_MINUTES ? { maxMinutes: env.INVINCIBLE_TURN_MINUTES } : {}),
      ...opts.turnLimits,
    },
  });
  // Its own looks: set as it answers in a chat of yours, each a turn of its there when it comes (looks.ts).
  const looks = new LookRunner({ chats, turns, log });
  // ---- The archive: node-local, its own database and blob store in the home, never the mind's log.
  const archiveStore = new ArchiveStore(join(home.dir, "archive.db"), new LocalDiskBackend(env.INVINCIBLE_ARCHIVE_DIR ?? join(home.dir, "archive")));
  const archive = new ArchiveService({
    store: archiveStore,
    brain: { store, vault, ...(opts.fetch ? { fetch: opts.fetch } : {}), spent: upkeepSpent },
    mind: store,
    identity,
    nodeName: config.name,
    log,
    ...(opts.archiveIntervalMs ? { intervalMs: opts.archiveIntervalMs } : {}),
    adapters: [
      memoriesAdapter(store),
      investigationsAdapter(store),
      evalsAdapter(store),
      // An agent's work in sensitive mode stays out of it: its summaries and its passages' vectors are other models' (heldModels).
      artifactsAdapter(artifacts, (a) => !team.store.sensitiveWork(a)),
      chatsAdapter(chats, { has: (s, id) => archiveStore.has(s, id), sourceIds: (s, prefix) => archiveStore.sourceIds(s, prefix) }),
      // Its skills (skills.ts): each version, once it's its to use.
      skillsAdapter(store),
    ],
  });
  if (env.INVINCIBLE_ARCHIVE !== "off" && opts.archiveIntervalMs !== false) archive.start();
  // The node backs itself up once a day (backups.ts), where the doctor looks for its backups.
  const backups = new BackupRunner({ home: home.dir, dir: backupDirFor(home.dir, env.INVINCIBLE_BACKUP_DIR), log });
  if (env.INVINCIBLE_BACKUPS !== "off" && opts.backups !== false) backups.start();

  // MCP servers' questions mid-call (questions.ts): each waits in your Inbox for you, and its call with it.
  const questions = new Questions({ log });
  const connectors = new ConnectorService({ store, vault, identity, local, ledger, log, fetch: opts.fetch, ask: (connector, params, signal) => questions.ask(connector, params, signal), ...(opts.oauthEndpoints ? { oauthEndpoints: opts.oauthEndpoints } : {}), natives: { "github.ship": shipNative(artifacts), "github.ship.update": shipNative(artifacts, true), "github.merge": mergeNative(), ...gmailNatives, ...outlookNatives, ...cloudflareNatives }, repositories: () => team.store.agents().flatMap((k) => (k.repository ? [k.repository] : [])), shipment: shipmentFiles(artifacts),
    // Whose proven work kept work is: a verified task's, or a verified fix task's and where its fix goes (connectors.ts:
    // only such a fix is its own, and a merge lands only such pushes).
    proven: (artifact) => {
      const task = team.store.taskOfWork(artifact);
      if (!task || task.status !== "done" || !task.verified) return null;
      return task.fix ? { fix: { owner: task.fix.owner, repo: task.fix.repo, branch: task.fix.branch } } : {};
    } });
  const taskDeps: LoopTaskDeps = {
    store,
    vault,
    identity,
    nodeName: config.name,
    sync,
    caps: () => caps,
    sandbox,
    connectors,
    arms,
    port,
    home: home.dir,
    startedAt,
    log,
    fetch: opts.fetch,
    compute,
    spent: upkeepSpent,
  };
  // This node's own upkeep of its compute, one look at a time: it measures itself when that's due.
  let upkeeping: Promise<unknown> | null = null;
  let lookAgain = false;
  let stopping = false;
  const upkeep = (): void => {
    if (stopping) return;
    if (upkeeping) {
      // Something changed while it was looking: one more look when this one ends.
      lookAgain = true;
      return;
    }
    upkeeping = computeUpkeep(taskDeps)
      .then((done) => {
        for (const fix of done) log(`compute: ${fix.title}`);
      })
      .catch((error) => log(`compute upkeep: ${(error as Error).message}`))
      .finally(() => {
        upkeeping = null;
        if (lookAgain) {
          lookAgain = false;
          upkeep();
        }
      });
  };
  const loopDrafts = new LoopDrafts(local);
  // Telegram (telegram.ts): a bot of yours, polled from here once connected on this node; it answers as a device of its own.
  const telegram = new TelegramGateway({ local, vault, apiBase: `http://127.0.0.1:${port}`, node: identity.id, ...(opts.telegramBase ? { telegramBase: opts.telegramBase } : {}), log });
  // Slack (slack.ts): an app of yours, its Socket Mode connection opened from here once connected on this node; the same.
  const slack = new SlackGateway({ local, vault, apiBase: `http://127.0.0.1:${port}`, node: identity.id, ...(opts.slackBase ? { slackBase: opts.slackBase } : {}), log });
  const connectorRequests = new ConnectorRequests(local);
  const loops = new LoopRunner({
    store,
    identity,
    local,
    log,
    execute: loopExecutor(taskDeps),
    onFinished: (loop, result, run, { again }) => {
      // A loop that tells you leaves a notice each run; the rest leave one when a run needs a look (cleared by a good one),
      // but not for a run whose trouble is all tried again (loops.ts giveBack): only if that fails too.
      if (again) return;
      if (loop.task.kind === "tell" && result.status === "ok") tellNotice(store, identity, loop, run, result.summary, Date.now());
      else if (loop.task.kind !== "heartbeat") loopNotice(store, identity, loop.name, result.status, result.summary, Date.now());
    },
  });
  // Self-action's hands.
  taskDeps.runLoop = (name) => void loops.runNow(name);
  taskDeps.isRunning = (name) => loops.isRunning(name);
  // The runs in hand on this node, as whoever runs each reports them (runs.ts).
  const runs = new RunBoard();
  // Its skills (skills.ts): learned from runs that passed review, offered as data, tidied with the heartbeat.
  const skills = new SkillsService({ store, identity, log, ledger, role: () => cheapestRole(taskDeps), ask: skillAsker({ store, vault, governor, fetch: opts.fetch, spent: upkeepSpent }) });
  taskDeps.skills = skills;

  // ---- Notifications: it comes to you, on your own paired devices. Node-local: its own private database in the
  // home; this node's VAPID key where its device keys are (made at its first use, never logged or put in the mind).
  const notifyDb = new NotifyStore(join(home.dir, "push.db"), opts.push?.now);
  let pushKey: ReturnType<Home["pushKey"]> | null = null;
  const webPush = new PushSender({
    // One key for this node's lifetime; a failure to read it is tried again at the next use.
    key: () => (pushKey ??= home.pushKey(config.keystore).catch((error) => ((pushKey = null), Promise.reject(error)))),
    contact: env.INVINCIBLE_PUSH_CONTACT ?? DEFAULT_PUSH_CONTACT,
    allowed: [...(env.INVINCIBLE_PUSH_HOSTS?.split(",") ?? []), ...(opts.push?.allow ?? [])],
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.push?.now ? { now: opts.push.now } : {}),
    ...(opts.push?.sleep ? { sleep: opts.push.sleep } : {}),
  });
  // The iPhone app's: the owner's Apple push key from the vault, used only while it is pinned to Apple's push service.
  const applePush = new ApplePushSender({
    key: () => (vault.unlocked() && vault.info(APPLE_PUSH_SECRET)?.origin === APPLE_PUSH.production ? readApplePushKey(vault.reveal(APPLE_PUSH_SECRET)) : null),
    ...(opts.push?.now ? { now: opts.push.now } : {}),
    ...(opts.push?.sleep ? { sleep: opts.push.sleep } : {}),
    ...(opts.push?.apple ? { origins: opts.push.apple } : {}),
  });
  // The Android app's: kept on this node for the app to collect (no push service at all).
  const collected = new CollectSender({ db: notifyDb, ...(opts.push?.now ? { now: opts.push.now } : {}) });
  const notify = new NotifyService({
    mind: store,
    nodeName: config.name,
    db: notifyDb,
    sender: {
      publicKey: () => webPush.publicKey(),
      // An iPhone's can't be sent at all while the vault holds no Apple push key (looked up, never opened).
      blocked: (target) => (appleTarget(target.endpoint) && !(vault.unlocked() && vault.info(APPLE_PUSH_SECRET)?.origin === APPLE_PUSH.production) ? "this node has no Apple push key: add it with `invincible notify apple-key`" : null),
      send: (target, payload, delivery, signal) => (collectTarget(target.endpoint) ? collected : appleTarget(target.endpoint) ? applePush : webPush).send(target, payload, delivery, signal),
      // The iPhone's Live Activities: Apple's alone.
      sendActivity: (target, state, event, signal) => applePush.sendActivity(target, state, event, signal),
      close: () => applePush.close(),
    },
    allowed: [...(env.INVINCIBLE_PUSH_HOSTS?.split(",") ?? []), ...(opts.push?.allow ?? [])],
    sources: {
      notices: () => store.lwwPrefix<{ key: string; severity: string; title: string; source: string; dismissed?: boolean }>("notice:").flatMap((e) => (e.value ? [{ key: e.value.key, severity: e.value.severity, title: e.value.title, source: e.value.source, dismissed: !!e.value.dismissed }] : [])),
      actions: () => connectors.actions(),
      questions: () => questions.list(),
      screenSessions: () => store.screenSessions().map((s) => screenSessionView(s, Date.now(), (id) => store.device(id)?.name ?? id.slice(2, 10))),
      secretRequests: () => vault.requests().map((r) => r.name),
      connectorRequests: () => {
        const installed = new Set(installedConnectors(store).map((c) => c.id));
        return connectorRequests.list().filter((r) => !installed.has(r.connector)).map((r) => r.id);
      },
      // What the day's digest counts first: agents' tasks that ended since the last one, verified and not.
      tasksEnded: (since) => {
        const ended = team.store.tasks().filter((t) => (t.status === "done" || t.status === "failed" || t.status === "stopped") && t.updatedAt > since);
        const verified = ended.filter((t) => t.status === "done" && t.verified).length;
        return { verified, unverified: ended.length - verified };
      },
      turns,
      chats,
      runs,
      // A task on an iPhone's Live Activity: from its record and its whole trail (as many pages as it keeps), and how many
      // of the team's other tasks are at work or queued (the app keeps one activity for the team), as the app says it to
      // itself while it's in front.
      activity: (id) => {
        const task = team.store.task(id);
        if (!task) return null;
        const entries: TeamTrailEntry[] = [];
        for (let after = 0, more = true; more && entries.length < 5_000; ) {
          const page = team.store.trail(id, after);
          entries.push(...page.entries);
          more = page.more && page.entries.length > 0;
          after = page.entries.at(-1)?.n ?? after;
        }
        const others = team.store.tasks().filter((t) => t.id !== id && (t.status === "running" || t.status === "queued")).length;
        return activityOf(task, entries, Date.now(), others);
      },
      // Agents' tasks, each said once it ends by its verdict and cost (the apps' words), with whether it can be shipped.
      tasks: {
        version: () => team.store.version(),
        list: () => {
          const prices = moneyPrices(pricesOf(store), PLAN_PROVIDERS);
          return team.store.tasks().map((t) => {
            const ended = t.status === "done" || t.status === "failed";
            return { id: t.id, status: t.status, word: ended ? (verdictOf(t, factsOfRecord(t.record))?.word ?? "ended") : "", cost: ended ? costWords(t, prices) : "", ship: ended && taskActions(t).includes("ship"), ...(t.record ? { endedAt: t.record.endedAt } : {}) };
          });
        },
      },
    },
    ledger,
    log,
    ...(opts.push?.now ? { now: opts.push.now } : {}),
    ...(opts.push?.tickMs !== undefined ? { tickMs: opts.push.tickMs } : {}),
  });

  // Bundled once: the app this node serves, and what the doctor checks is there.
  const assets = await buildAssets();
  const proxyPort = opts.proxyPort ?? env.INVINCIBLE_PROXY_PORT ?? port + 1;
  const doctorDeps: DoctorDeps = {
    store,
    vault,
    identity,
    nodeName: config.name,
    home,
    keystore: config.keystore,
    sync,
    caps: () => caps,
    sandbox,
    governor,
    compute,
    archive,
    archiveOff: env.INVINCIBLE_ARCHIVE === "off",
    assets,
    port,
    proxyPort,
    startedAt,
    trouble,
    system: opts.system ?? (opts.capabilities ? noSystem : realSystem),
    ...(env.INVINCIBLE_BACKUP_DIR ? { backupDir: env.INVINCIBLE_BACKUP_DIR } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    notify: () => notify.doctorFacts(),
    agents: () => team.store.agents(),
    fabric: () => ({ state: sidecar.state, on: sidecar.switchedOn, why: sidecar.why, did: sidecar.did, address: sidecar.address, version: sidecar.version }),
  };
  // The heartbeat takes from a quick look what it doesn't check itself (a clock out of step, the app not published, …).
  taskDeps.doctor = () => heartbeatFromDoctor(doctorDeps);

  const shutdown = new AbortController();
  const app = createApp({
    identity,
    nodeName: config.name,
    port,
    store,
    vault,
    pairing,
    sync,
    fabric,
    handoffs,
    fabricSetting,
    rotateTransport,
    sandboxLayout,
    tokens,
    arms,
    qamp,
    adminToken: home.adminToken(),
    assets,
    doctor: (options) => runDoctor(doctorDeps, options),
    notify,
    caps: () => caps,
    // What this node's own work holds goes with its presence, so every node's census and placement know it.
    presence: async () => ({ ...(await presence()), compute: compute.usage() }),
    log,
    sandbox,
    screen,
    governor,
    compute,
    computeUpkeep: upkeep,
    sandboxContext,
    terminals,
    connectors,
    artifacts,
    loops,
    loopDrafts,
    telegram,
    slack,
    questions,
    connectorRequests,
    heartbeatCheck: () => lookAround(taskDeps),
    chats,
    uploads,
    turns,
    looks,
    team,
    runs,
    archive,
    skills,
    usage,
    ledger,
    shutdown: shutdown.signal,
    ...(opts.oauthEndpoints ? { oauthEndpoints: opts.oauthEndpoints } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });

  routes = app;

  // Loopback: the CLI and the local model gateway (local processes only).
  // Proxied: what `tailscale serve` forwards to (the HTTPS PWA) — remote traffic, so no
  //   admin token and no gateway, even though it arrives from 127.0.0.1.
  // Tailnet: node-to-node link traffic. Never 0.0.0.0.
  const servers = [
    Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 255, maxRequestBodySize: MAX_REQUEST_BODY, fetch: listening(app, "loopback") }),
    Bun.serve({ hostname: "127.0.0.1", port: proxyPort, idleTimeout: 255, maxRequestBodySize: MAX_REQUEST_BODY, fetch: listening(app, "proxied") }),
  ];
  if (advertise !== "127.0.0.1") {
    servers.push(Bun.serve({ hostname: advertise, port, idleTimeout: 255, maxRequestBodySize: MAX_REQUEST_BODY, fetch: listening(app, "tailnet") }));
  }
  // Sandboxes reach this listener (and only this one) on the gateway network's bridge IP. On a Mac that address is the
  // host's only while a VM is attached to the network (the host's keeper holds it once the image is built), so until
  // it can be bound it is tried again every few seconds.
  let reaper: ReturnType<typeof setInterval> | null = null;
  let gatewayRetry: ReturnType<typeof setInterval> | null = null;
  if (sandbox) {
    const apple = caps.sandbox?.engine === "container";
    let said = false;
    let tries = 0;
    const bindGateway = (): boolean => {
      try {
        servers.push(
          Bun.serve({ hostname: NETWORKS.gateway.gateway, port: SANDBOX_GATEWAY_PORT, idleTimeout: 255, maxRequestBodySize: MAX_REQUEST_BODY, fetch: listening(app, "sandbox") }),
        );
        if (said) log("sandbox gateway listening");
        return true;
      } catch (error) {
        // On a Mac the address comes a moment after the networks' VMs start, at every start (seen on the Mac mini, 17
        // November 2026): waiting for it is said plainly, and only a minute of it reads as trouble (the doctor's word).
        tries++;
        if (apple && tries === 1) log("sandbox gateway: waiting for its address on this Mac, which comes with the networks' VMs (tried every 5 s)");
        else if (!apple ? !said : tries === 13) log(`sandbox gateway listener unavailable: ${(error as Error).message}${apple ? " (for a minute now; still tried every 5 s, until a VM holds its address)" : ""}`);
        said = true;
        return false;
      }
    };
    // (A node whose sandboxes have no networks binds no gateway: its address is a live node's on a shared host.)
    if (opts.sandboxNetworks !== false && !bindGateway() && apple) {
      gatewayRetry = setInterval(() => {
        if (bindGateway() && gatewayRetry) {
          clearInterval(gatewayRetry);
          gatewayRetry = null;
        }
      }, 5_000);
    }
    const host = sandbox;
    reaper = setInterval(() => {
      host
        .reap()
        .then((reaped) => reaped.length && log(`reaped ${reaped.length} expired sandbox(es)`))
        .catch((error) => log(`reaper: ${(error as Error).message}`));
    }, 60_000);
  }

  // Its sidecar's first start (up, or why not: it tries again by itself), so its profile names its endpoint from the first.
  await sidecar.start();
  // Advertise the endpoint only once we are actually listening on it.
  publishProfile(store, identity, endpoint, withQamp(caps));
  profiled = true;
  sync.start();
  // Grants still in force get their bridges back (each one's MCP server calls this node's API, now listening); those whose
  // time ran out while it was down end now.
  void qamp.resume(opts.qampSweepMs).catch((error: Error) => log(`qamp: ${error.message}`));

  // Loops and the outbox start once the API they call is listening.
  if ((opts.defaultHeartbeat ?? true) && process.env.INVINCIBLE_HEARTBEAT !== "off") {
    try {
      ensureHeartbeat(store, identity, caps);
    } catch (error) {
      log(`default heartbeat not created: ${(error as Error).message}`);
    }
  }
  loops.start(opts.loopIntervalMs);
  // Its own looks (looks.ts): each a turn of its in the chat it set it in, when it comes.
  if (opts.lookIntervalMs !== false) looks.start(opts.lookIntervalMs);
  // What else wakes its loops (wakes.ts): new mail and GitHub events, read every few minutes as each loop; webhooks
  // come in through the server.
  const wakeWatcher = new WakeWatcher({
    store,
    identity,
    local,
    log,
    read: async (connector, tool, args, by) => {
      const outcome = await connectors.call({ connector, tool, args }, { kind: "agent", by });
      if (outcome.status !== "done") throw new Error(`${connector}.${tool} asked for approval, which a read never does`);
      return outcome.result;
    },
    wake: (loop, events) => loops.wake(loop, events),
  });
  if (opts.wakeWatchMs !== false) wakeWatcher.start(opts.wakeWatchMs);
  telegram.start();
  slack.start();
  notify.start();
  // After you ship: this node follows each pull request it shipped until its checks end (ci-watch.ts).
  const ciBack = {
    store: team.store,
    service: () => team.service,
    outcomes: () => team.outcomes,
    // A fix's push onto a pull request's branch that you declined (its ship.update denied): its further fixes are yours
    // (the review of 27 November, S4).
    declined: (pull: ShippedPull) => declinedPush(connectors.actions(500), pull, identity.id),
  };
  const ciWatch = new CiWatch({
    store,
    identity,
    local,
    log,
    shipped: () => shippedPulls(connectors.actions(500), identity.id, (id) => {
      const hlc = store.lww(`action-done:${id}`)?.hlc;
      return hlc ? decodeHlc(hlc).ms : null;
    }),
    call: async (tool, args, connector) => {
      const outcome = await connectors.call({ connector, tool, args }, { kind: "agent", by: "ci-watch" });
      if (outcome.status !== "done") throw new Error(`${connector}.${tool} asked for approval, which a read never does`);
      return outcome.result;
    },
    // An agent's work that fails its checks, or that a review asks changes of, may go back to that agent (ci-back.ts).
    back: (pull, failure) => giveBack(ciBack, pull, failure),
    reviews: { wanted: (pull) => wantsReviews(ciBack, pull), asked: (pull, review) => reviewBack(ciBack, pull, review) },
  });
  if (opts.ciWatchMs !== false) ciWatch.start(opts.ciWatchMs);
  // A node that just joined (or whose body, ceiling or benchmark changed while it was down) measures itself now.
  if (measure) upkeep();
  const drain = () => connectors.drain().catch((error) => log(`outbox: ${(error as Error).message}`));
  void drain();
  const outbox = setInterval(drain, 5_000);
  const refresh = opts.capabilities
    ? null
    : setInterval(() => {
        void refreshCapabilities(async () => withScreen(withAwake(await probeCapabilities())), (fresh) => publishProfile(store, identity, endpoint, withQamp(fresh)), log).then((fresh) => {
          if (fresh) caps = fresh;
          // A GPU, a local runtime, more memory, a new ceiling: it measures itself again.
          upkeep();
        });
      }, 5 * 60_000);

  log(
    `node ${config.name} up · fleet ${store.genesis?.name} · ${endpoint} · vault ${vault.unlocked() ? "unlocked" : "locked"}${sandbox ? " · sandbox host" : ""} · ${loops.mine().length} loop(s) here of ${loopRecords(store).length}`,
  );
  return {
    port,
    endpoint,
    identity,
    store,
    sync,
    fabric,
    handoffs,
    loops,
    connectors,
    artifacts,
    archive,
    compute,
    turns,
    looks,
    chats,
    doctor: (options) => runDoctor(doctorDeps, options),
    fabricSetting,
    rotateTransport,
    notify,
    /**
     * In order: take nothing new (stop listening; requests under way go on), start nothing
     * new (timers, sync, loops), let what's under way finish (the outbox, then requests, for
     * a while), and only then close what they write to.
     */
    async stop() {
      const finished = Promise.all(servers.map((s) => s.stop()));
      shutdown.abort();
      // Grants' bridges stop (each drains its calls); the grants stay, and their bridges start again with the node.
      const qampStopped = qamp.stop();
      // Its sidecar drains (GOAWAY: its peers take their calls elsewhere) while this node still answers what is under way.
      const sidecarStopped = sidecar.stop();
      // Every terminal's shell is ended, and whoever watched one is told (their streams end with it).
      terminals?.closeAll();
      const teamEnded = Promise.all([team.service?.stop(), team.outcomes?.stop(), team.backlog?.stop()]);
      clearInterval(outbox);
      clearInterval(uploadSweep);
      if (refresh) clearInterval(refresh);
      if (reaper) clearInterval(reaper);
      if (gatewayRetry) clearInterval(gatewayRetry);
      stopPush();
      sync.stop();
      stopping = true;
      // No new turns from here (nothing queued is sent); the ones under way get the same grace as requests do.
      const turnsEnded = turns.drain();
      looks.stop();
      governor.close();
      await upkeeping;
      // It tells nobody anything more; a send under way is cut off.
      await notify.stop();
      // The archive starts nothing new, and its round under way (an embedding call) is cut off.
      await archive.stop();
      backups.stop();
      await loops.stop();
      await wakeWatcher.stop();
      await telegram.stop();
      await slack.stop();
      await ciWatch.stop();
      // (A call waiting on your answer goes on without one: the node is stopping.)
      questions.drain();
      await connectors.drain();
      await Promise.race([Promise.all([finished, turnsEnded]), Bun.sleep(opts.shutdownGraceMs ?? SHUTDOWN_GRACE_MS)]);
      // A turn still going after that is stopped: its answer kept as stopped, what's queued behind it held until you resume.
      await turns.close();
      await teamEnded;
      await qampStopped;
      await sidecarStopped;
      // Nothing of a hand-off outlives the node: its timers end, and it writes nothing more (its database closes below).
      handoffs.close();
      fabric.close();
      await Promise.all(servers.map((s) => s.stop(true)));
      notifyDb.close();
      chats.close();
      team.store.close();
      archiveStore.close(); // requests may still have been searching it
      local.close();
      store.close();
      awake?.stop();
    },
  };
}
