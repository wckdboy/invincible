import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonical, decodeHlc, type NodeIdentity, screenSessionView } from "@galahad/core";
import { type BrainContext, CATALOG, GatewayTokens, installedConnectors, type OAuthEndpoints, pinLegacyKeys, refusedKeysOf, windowsOf } from "@galahad/brain";
import { indexUrl, McpIndex } from "./mcp-index.ts";
import { UsageStore } from "./usage.ts";
import { cloudflareNatives } from "./cloudflare.ts";
import { gmailNatives, outlookNatives } from "./mail.ts";
import { PairingHost, SyncEngine } from "@galahad/link";
import { adoptChains, MindStore, Vault } from "@galahad/mind";
import { type DockerRunner, type LedgerEntryInput, type MacFirewallState, microVMsAvailable, NETWORKS, SANDBOX_GATEWAY_PORT, type SpawnTerminal, startContainerService, vmResolvConf, WorkspaceHelper } from "@galahad/sandbox";
import type { ArgValue, HostLoad } from "@galahad/core";
import { calibrate, spawnBench } from "./compute/calibrate.ts";
import { GovernedSandboxHost } from "./compute/governed-host.ts";
import { Governor } from "./compute/governor.ts";
import { modelSpeed, sandboxStart } from "./compute/measure.ts";
import { ComputeService, liveHost, type Measure } from "./compute/service.ts";
import { ArmTokens, GALAHAD_ARM } from "./arms.ts";
import { QampGrants, type QampRunner, qampRunner } from "./qamp-grants.ts";
import { ArtifactStore } from "./artifacts.ts";
import { artifactsAdapter, chatsAdapter, investigationsAdapter, memoriesAdapter, skillsAdapter, trialsAdapter } from "./archive/adapters.ts";
import { LocalDiskBackend } from "./archive/blobs.ts";
import { ArchiveService } from "./archive/service.ts";
import { backupDirFor, BackupRunner } from "./backups.ts";
import { ArchiveStore } from "./archive/store.ts";
import { BankService } from "./bank/service.ts";
import { ChatStore } from "./chats.ts";
import { TeamStore } from "./team-store.ts";
import type { TeamService } from "./team.ts";
import { type HubLimits, TurnHub } from "./turns.ts";
import { LookRunner } from "./looks.ts";
import { Uploads } from "./uploads.ts";
import { QuestBoard } from "./quests.ts";
import { skillAsker, SkillsService } from "./skills.ts";
import { buildAssets } from "./assets.ts";
import { type Capabilities, isAlwaysOn, presence, probeCapabilities } from "./capabilities.ts";
import { keepAwake } from "./keep-awake.ts";
import { ConnectorService } from "./connectors.ts";
import { loopNotice, tellNotice } from "./heartbeat.ts";
import { cheapestRole, computeUpkeep, type LoopTaskDeps, lookAround, loopExecutor } from "./loop-tasks.ts";
import { LoopRunner, loopRecords } from "./loops.ts";
import { LoopDrafts } from "./loop-drafts.ts";
import { ConnectorRequests } from "./connector-requests.ts";
import { giveBack, reviewBack, wantsReviews } from "./ci-back.ts";
import { BilagService } from "./bilag.ts";
import { attachBilag, type BooksAttach, uploadBilag } from "./books.ts";
import { CiWatch, shippedPulls } from "./ci-watch.ts";
import { WakeWatcher } from "./wakes.ts";
import { Questions } from "./questions.ts";
import { SlackGateway } from "./slack.ts";
import { TelegramGateway } from "./telegram.ts";
import type { OutcomeRunner } from "./outcomes.ts";
import type { BacklogRunner } from "./backlog.ts";
import { loadEnv } from "./env.ts";
import type { Home } from "./home.ts";
import { createApp } from "./server.ts";
import { shipNative } from "./ship.ts";
import { type DoctorDeps, type DoctorOptions, type DoctorRun, type DoctorSystem, heartbeatFromDoctor, noSystem, realSystem, runDoctor, TroubleLog } from "./doctor-facts.ts";
import { NotifyService } from "./notify.ts";
import { Terminals } from "./terminals.ts";
import { NotifyStore } from "./notify-store.ts";
import { APPLE_PUSH, APPLE_PUSH_SECRET, ApplePushSender, appleTarget, readApplePushKey } from "./apns-send.ts";
import { CollectSender, collectTarget } from "./collect-send.ts";
import { MacScreen, screenHelper, spawnHelper } from "./mac-screen.ts";
import { DEFAULT_PUSH_CONTACT, PushSender } from "./push-send.ts";

export interface Daemon {
  port: number;
  endpoint: string;
  identity: NodeIdentity;
  store: MindStore;
  sync: SyncEngine;
  loops: LoopRunner;
  connectors: ConnectorService;
  artifacts: ArtifactStore;
  bank: BankService;
  /** The archive: everything kept for good, and searched by words and meaning. */
  archive: ArchiveService;
  /** Compute: the census, this node's calibration and slots, the plan, effort. */
  compute: ComputeService;
  /** The chat turns this node runs for you, and what you queued behind your chats. */
  turns: TurnHub;
  /** His own looks, taken when they come (looks.ts). */
  looks: LookRunner;
  /** Your chats, on this node. */
  chats: ChatStore;
  /** The doctor: one look at this node's whole installation (doctor.ts). */
  doctor(opts?: DoctorOptions): Promise<DoctorRun>;
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
  /** How often his looks that came are looked for (ms; false: never, for tests that take them by hand). */
  lookIntervalMs?: number | false;
  /** How often the pull requests this node shipped have their checks read (false: never, for tests). */
  ciWatchMs?: number | false;
  /** How often what wakes its loops (mail, GitHub) is read (false: never, for tests). */
  wakeWatchMs?: number | false;
  /** Where Telegram's Bot API is (tests: a stand-in). */
  telegramBase?: string;
  /** Where Slack's Web API is (tests: a stand-in). */
  slackBase?: string;
  /** Let the fleet's founding node create its default loop, the heartbeat (default true; GALAHAD_HEARTBEAT=off disables). */
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
  /**
   * How this node measures itself. Default: the real benchmark, a few seconds at low priority (and never in
   * tests that pass their own capabilities, unless they give one here). false: it doesn't.
   */
  measure?: Measure | false;
  /** The machine's live load, for admitting sandboxes (default: the real one; null with test capabilities, where only the ceiling counts). */
  hostLoad?: () => Omit<HostLoad, "oursRecently"> | null;
  /** The longest a sandbox waits for a slot (default 30 minutes). */
  slotWaitMs?: number;
  /** The node's limits on chat turns (default: 4 at once, 30 minutes each, 20 queued a chat; GALAHAD_TURNS_MAX and GALAHAD_TURN_MINUTES set the first two). */
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
   * origin), how often he looks (false: only when the test says), his clock, and how a pause before a retry passes.
   */
  push?: { allow?: string[]; tickMs?: number | false; now?: () => number; sleep?: (ms: number) => Promise<void>; apple?: { development?: string; production?: string } };
  /** How Q-AMP's binary is run for grants (tests: a stand-in). Default: <home>/bin/qamp, or GALAHAD_QAMP_BIN. */
  qamp?: QampRunner;
  /** The UDP ports grants' bridges listen on (tests: others; default 7781–7789), and how often expiry is looked for. */
  qampPorts?: { first: number; last: number };
  qampSweepMs?: number;
}

/**
 * The fleet's founder gives Galahad a heartbeat once: every 30 minutes on an
 * always-on node. Never again after that, so a heartbeat you removed stays removed.
 */
function ensureHeartbeat(store: MindStore, identity: NodeIdentity, caps: Capabilities): void {
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
    label: "Galahad's regular look around",
  });
}

/** No request may make a node buffer more than this (Bun's default is about 128 MB). */
const MAX_REQUEST_BODY = 8 * 1024 * 1024;
/** How long a stopping node lets requests under way finish (a chat being answered) before it closes them. */
const SHUTDOWN_GRACE_MS = 10_000;

/** Publish this node's endpoint + capabilities, only when they changed (idempotent). */
function publishProfile(store: MindStore, identity: NodeIdentity, endpoint: string, caps: Capabilities): void {
  const body = { endpoint, caps: caps as unknown as Record<string, unknown> };
  const current = store.device(identity.id)?.profile;
  if (current && canonical(current) === canonical(body)) return;
  store.emit(identity, "node.profile", body);
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
  const say = opts.log ?? ((message: string) => console.log(`[galahad] ${message}`));
  const log = (message: string): void => {
    trouble.note(message);
    say(message);
  };
  const env = loadEnv();
  const config = home.readConfig();
  if (!config.fleet) throw new Error("this node has not joined a fleet");
  const identity = await home.loadIdentity(config.keystore);
  const store = new MindStore(home.mindPath);
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
  // A provider whose key a call got refused stays said through a restart, too: the doctor and the Inbox say it until a
  // later call gets through (which forgets it) or the key is set again (which the doctor reads as the refusal being moot).
  const refusedKeys = refusedKeysOf(store);
  refusedKeys.restore(usage.refusedKeys());
  refusedKeys.kept = (refusal) => usage.keepRefusedKey(refusal);
  refusedKeys.forgot = (provider) => usage.forgetRefusedKey(provider);
  /** His own upkeep's calls (the heartbeat's words, his skills, the archive), counted as his. */
  const upkeepSpent: NonNullable<BrainContext["spent"]> = (call) => usage.note("galahad", call.role, call.ref, call.usage);

  const port = env.GALAHAD_PORT ?? config.port;
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
  const advertise = env.GALAHAD_ADVERTISE ?? config.advertise ?? caps.tailscale?.ip ?? "127.0.0.1";
  const endpoint = `http://${advertise}:${port}`;

  const sync = new SyncEngine(store, identity, { intervalMs: opts.syncIntervalMs, log });
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

  // Every gated action lands in the signed, replicated ledger.
  const ledger = (entry: LedgerEntryInput) => {
    const body = Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined)) as LedgerEntryInput;
    try {
      store.emit(identity, "ledger.recorded", body);
    } catch (error) {
      log(`ledger write failed: ${(error as Error).message}`);
    }
  };

  // Grants to agents on your other machines, over Q-AMP (qamp-grants.ts): each its arm, its chain and its bridge, which
  // serves `galahad mcp --arm qamp.<id> --tools …` on this node's own address. Its binary is the node's own copy.
  const qampBin = env.GALAHAD_QAMP_BIN ?? join(home.dir, "bin", "qamp");
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
  let sandbox: GovernedSandboxHost | null = null;
  const sandboxContext = resolve(dirname(fileURLToPath(import.meta.url)), "../../../sandbox");
  if (caps.sandbox !== undefined && caps.sandbox !== null) {
    // On a Mac with container: every sandbox a VM of its own, its /work container's own volume, its resolver container's.
    const apple = caps.sandbox.engine === "container";
    // Online microVMs can't use Docker's DNS (it lives on the host side): they get the host's resolvers.
    const resolvConf = join(home.dir, "sandbox-resolv.conf");
    const readIf = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);
    if (!apple) writeFileSync(resolvConf, vmResolvConf(readIf("/run/systemd/resolve/resolv.conf"), readIf("/etc/resolv.conf")), { mode: 0o644 });
    const microVMs = caps.sandbox.vm ?? microVMsAvailable();
    sandbox = new GovernedSandboxHost(
      {
      node: identity.id,
      tokens,
      tokenStore: sandboxTokens,
      ledger,
      ...(apple ? { engine: "container" as const, ...(opts.sandboxDisk ? { disk: opts.sandboxDisk } : {}) } : {}),
      ...(opts.docker ? { runner: opts.docker } : {}),
      // (Never the real launchd beside a stand-in for the engine: restarting a network's helper there would be the Mac's.)
      ...(opts.launchctl ? { launchctl: opts.launchctl } : opts.docker ? { launchctl: async () => ({ code: 0, stdout: "", stderr: "" }) } : {}),
      ...(opts.macFirewall ? { firewall: opts.macFirewall } : {}),
      ...(opts.spawnTerminal ? { spawnTerminal: opts.spawnTerminal } : {}),
      maxCpus: caps.cores,
      maxMemoryGb: Math.max(1, Math.floor(caps.memoryGb * 0.75)),
      // Size-limited workspaces when the root helper is installed (scripts/remote-setup.sh); otherwise
      // unlimited Docker volumes, and the heartbeat says so. Never beside a stand-in for Docker: the
      // helper is root on its host, and would make real images there for containers that don't exist.
      // (On a Mac the host makes container's own volumes, each of a fixed size, and needs no helper.)
      ...(opts.docker || apple ? {} : { workspaces: new WorkspaceHelper(env.GALAHAD_WORKSPACE_SOCKET) }),
      imageContext: sandboxContext,
      // Online sandboxes run in KVM microVMs where Kata is installed (scripts/remote-setup.sh).
      microVMs,
      ...(apple ? {} : { resolvConf }),
      },
      { governor, capacity: () => computeService!.selfCapacity() },
    );
    try {
      await sandbox.ensureNetworks();
      // Sandboxes from before this start hold their slots before anything new is admitted.
      await sandbox.reconcile();
      // Keep the image in use, so pruning (Coolify's nightly cleanup) doesn't take it.
      void sandbox.keepImages().catch((error) => log(`sandbox image keepers: ${(error as Error).message}`));
    } catch (error) {
      log(`sandbox networks unavailable: ${(error as Error).message}`);
      sandbox = null;
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
  const bank = new BankService({ dir: join(home.dir, "bank") });
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
      ...(env.GALAHAD_TURNS_MAX ? { maxTurns: env.GALAHAD_TURNS_MAX } : {}),
      ...(env.GALAHAD_TURN_MINUTES ? { maxMinutes: env.GALAHAD_TURN_MINUTES } : {}),
      ...opts.turnLimits,
    },
  });
  // His own looks: set as he answers in a chat of yours, each a turn of his there when it comes (looks.ts).
  const looks = new LookRunner({ chats, turns, log });
  // ---- The archive: node-local, its own database and blob store in the home, never the mind's log.
  const archiveStore = new ArchiveStore(join(home.dir, "archive.db"), new LocalDiskBackend(env.GALAHAD_ARCHIVE_DIR ?? join(home.dir, "archive")));
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
      trialsAdapter(store),
      // A knight's work in sensitive mode stays out of it: its summaries and its passages' vectors are other models' (heldModels).
      artifactsAdapter(artifacts, (a) => !team.store.sensitiveWork(a)),
      chatsAdapter(chats, { has: (s, id) => archiveStore.has(s, id), sourceIds: (s, prefix) => archiveStore.sourceIds(s, prefix) }),
      // His skills (skills.ts): each version, once it's his to use.
      skillsAdapter(store),
    ],
  });
  if (env.GALAHAD_ARCHIVE !== "off" && opts.archiveIntervalMs !== false) archive.start();
  // The node backs itself up once a day (backups.ts), where the doctor looks for its backups.
  const backups = new BackupRunner({ home: home.dir, dir: backupDirFor(home.dir, env.GALAHAD_BACKUP_DIR), log });
  if (env.GALAHAD_BACKUPS !== "off" && opts.backups !== false) backups.start();

  // Checked at start (and before every bank call): a key or session readable by others keeps bank access off.
  if (bank.status().configured && bank.problem()) log(`bank access is off: ${bank.problem()}`);
  // MCP servers' questions mid-call (questions.ts): each waits in your Inbox for you, and its call with it.
  const questions = new Questions({ log });
  const connectors = new ConnectorService({ store, vault, identity, local, ledger, log, fetch: opts.fetch, ask: (connector, params, signal) => questions.ask(connector, params, signal), ...(opts.oauthEndpoints ? { oauthEndpoints: opts.oauthEndpoints } : {}), natives: { "github.ship": shipNative(artifacts), "github.ship.update": shipNative(artifacts, true), ...gmailNatives, ...outlookNatives, ...cloudflareNatives }, repositories: () => team.store.teammates().flatMap((k) => (k.repository ? [k.repository] : [])) });
  const taskDeps: LoopTaskDeps = {
    bank,
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
    local,
  };
  // This node's own upkeep of its compute, one look at a time: it measures itself when that's due.
  let upkeeping: Promise<unknown> | null = null;
  let lookAgain = false;
  let stopping = false;
  const upkeep = (): void => {
    if (stopping) return;
    if (upkeeping) {
      // Something changed while he was looking: one more look when this one ends.
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
  const telegram = new TelegramGateway({ local, vault, apiBase: `http://127.0.0.1:${port}`, ...(opts.telegramBase ? { telegramBase: opts.telegramBase } : {}), log });
  // Slack (slack.ts): an app of yours, its Socket Mode connection opened from here once connected on this node; the same.
  const slack = new SlackGateway({ local, vault, apiBase: `http://127.0.0.1:${port}`, ...(opts.slackBase ? { slackBase: opts.slackBase } : {}), log });
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
  // The quests in hand on this node, as whoever runs each reports them (quests.ts).
  const quests = new QuestBoard();
  // His skills (skills.ts): learned from quests that passed review, offered as data, tidied with the heartbeat.
  const skills = new SkillsService({ store, identity, log, ledger, role: () => cheapestRole(taskDeps), ask: skillAsker({ store, vault, governor, fetch: opts.fetch, spent: upkeepSpent }) });
  taskDeps.skills = skills;

  // ---- Notifications: he comes to you, on your own paired devices. Node-local: its own private database in the
  // home; this node's VAPID key where its device keys are (made at its first use, never logged or put in the mind).
  const notifyDb = new NotifyStore(join(home.dir, "push.db"), opts.push?.now);
  let pushKey: ReturnType<Home["pushKey"]> | null = null;
  const webPush = new PushSender({
    // One key for this node's lifetime; a failure to read it is tried again at the next use.
    key: () => (pushKey ??= home.pushKey(config.keystore).catch((error) => ((pushKey = null), Promise.reject(error)))),
    contact: env.GALAHAD_PUSH_CONTACT ?? DEFAULT_PUSH_CONTACT,
    allowed: [...(env.GALAHAD_PUSH_HOSTS?.split(",") ?? []), ...(opts.push?.allow ?? [])],
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
      send: (target, payload, delivery, signal) => (collectTarget(target.endpoint) ? collected : appleTarget(target.endpoint) ? applePush : webPush).send(target, payload, delivery, signal),
      close: () => applePush.close(),
    },
    allowed: [...(env.GALAHAD_PUSH_HOSTS?.split(",") ?? []), ...(opts.push?.allow ?? [])],
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
      // What the day's digest counts first: knights' tasks that ended since the last one, verified and not.
      tasksEnded: (since) => {
        const ended = team.store.tasks().filter((t) => (t.status === "done" || t.status === "failed" || t.status === "stopped") && t.updatedAt > since);
        const verified = ended.filter((t) => t.status === "done" && t.verified).length;
        return { verified, unverified: ended.length - verified };
      },
      turns,
      chats,
      quests,
    },
    ledger,
    log,
    ...(opts.push?.now ? { now: opts.push.now } : {}),
    ...(opts.push?.tickMs !== undefined ? { tickMs: opts.push.tickMs } : {}),
  });

  // Bundled once: the app this node serves, and what the doctor checks is there.
  const assets = await buildAssets();
  const proxyPort = opts.proxyPort ?? env.GALAHAD_PROXY_PORT ?? port + 1;
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
    archiveOff: env.GALAHAD_ARCHIVE === "off",
    assets,
    port,
    proxyPort,
    startedAt,
    trouble,
    system: opts.system ?? (opts.capabilities ? noSystem : realSystem),
    ...(env.GALAHAD_BACKUP_DIR ? { backupDir: env.GALAHAD_BACKUP_DIR } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    notify: () => notify.doctorFacts(),
    knights: () => team.store.teammates(),
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
    mcpIndex: new McpIndex({ file: join(home.dir, "mcp-index.json"), url: indexUrl(process.env.GALAHAD_MCP_INDEX), ...(opts.fetch ? { fetch: opts.fetch } : {}), reserved: Object.keys(CATALOG), log }),
    artifacts,
    loops,
    loopDrafts,
    telegram,
    slack,
    questions,
    connectorRequests,
    // Bilag from your mail to Google Drive, copied by the node itself (bilag.ts), read in this node's time zone.
    bilag: new BilagService({ transfer: (connector, step) => connectors.transfer(connector, step), local, tz: () => Intl.DateTimeFormat().resolvedOptions().timeZone }),
    // A bilag into Dinero by the node's own hands; attaching it to a payment's card is Galahad's to ask you.
    books: (() => {
      const deps = {
        transfer: (connector: string, step: Parameters<typeof connectors.transfer>[1]) => connectors.transfer(connector, step),
        handFile: (connector: string, tool: string, args: Record<string, ArgValue>, why: string) => connectors.handFile(connector, tool, args, why),
        ask: (call: { connector: string; tool: string; args: Record<string, ArgValue>; why: string }) => connectors.call(call, { kind: "agent", by: GALAHAD_ARM }),
      };
      return { attach: (input: BooksAttach) => attachBilag(deps, input), upload: (input: { organizationId: number; file: string }) => uploadBilag(deps, input) };
    })(),
    heartbeatCheck: () => lookAround(taskDeps),
    bank,
    chats,
    uploads,
    turns,
    looks,
    team,
    quests,
    archive,
    skills,
    usage,
    ledger,
    shutdown: shutdown.signal,
    ...(opts.oauthEndpoints ? { oauthEndpoints: opts.oauthEndpoints } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });

  // Loopback: the CLI and the local model gateway (local processes only).
  // Proxied: what `tailscale serve` forwards to (the HTTPS PWA) — remote traffic, so no
  //   admin token and no gateway, even though it arrives from 127.0.0.1.
  // Tailnet: node-to-node link traffic. Never 0.0.0.0.
  const servers = [
    Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 255, maxRequestBodySize: MAX_REQUEST_BODY, fetch: (req) => app(req, "loopback") }),
    Bun.serve({ hostname: "127.0.0.1", port: proxyPort, idleTimeout: 255, maxRequestBodySize: MAX_REQUEST_BODY, fetch: (req) => app(req, "proxied") }),
  ];
  if (advertise !== "127.0.0.1") {
    servers.push(Bun.serve({ hostname: advertise, port, idleTimeout: 255, maxRequestBodySize: MAX_REQUEST_BODY, fetch: (req) => app(req, "tailnet") }));
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
          Bun.serve({ hostname: NETWORKS.gateway.gateway, port: SANDBOX_GATEWAY_PORT, idleTimeout: 255, maxRequestBodySize: MAX_REQUEST_BODY, fetch: (req) => app(req, "sandbox") }),
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
    if (!bindGateway() && apple) {
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

  // Advertise the endpoint only once we are actually listening on it.
  publishProfile(store, identity, endpoint, caps);
  sync.start();
  // Grants still in force get their bridges back (each one's MCP server calls this node's API, now listening); those whose
  // time ran out while it was down end now.
  void qamp.resume(opts.qampSweepMs).catch((error: Error) => log(`qamp: ${error.message}`));

  // Loops and the outbox start once the API they call is listening.
  if ((opts.defaultHeartbeat ?? true) && process.env.GALAHAD_HEARTBEAT !== "off") {
    try {
      ensureHeartbeat(store, identity, caps);
    } catch (error) {
      log(`default heartbeat not created: ${(error as Error).message}`);
    }
  }
  loops.start(opts.loopIntervalMs);
  // His own looks (looks.ts): each a turn of his in the chat he set it in, when it comes.
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
  const ciBack = { store: team.store, service: () => team.service, outcomes: () => team.outcomes };
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
    // A knight's work that fails its checks, or that a review asks changes of, may go back to that knight (ci-back.ts).
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
        void refreshCapabilities(async () => withScreen(withAwake(await probeCapabilities())), (fresh) => publishProfile(store, identity, endpoint, fresh), log).then((fresh) => {
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
    loops,
    connectors,
    artifacts,
    bank,
    archive,
    compute,
    turns,
    looks,
    chats,
    doctor: (options) => runDoctor(doctorDeps, options),
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
      // He tells nobody anything more; a send under way is cut off.
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
      await Promise.all(servers.map((s) => s.stop(true)));
      bank.close();
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
