import { clockUtc, refusalWords, refusesKey, regionalBaseUrls, spanWords } from "@galahad/brain";
import { type DoctorArea, type DoctorCheck, type DoctorReport, type DoctorState, doctorSorted, doctorTally, redact } from "@galahad/core";

/*
 * The doctor: is everything well on this node? One look at the whole installation,
 * answered in plain lines, each ok / needs you / broken, with what to do for anything
 * that isn't ok.
 *
 * Like the heartbeat, it's split in two. `diagnose` is pure: facts in, lines out, so
 * every rule is tested exactly (a healthy node, and each kind of fault giving its own
 * line and advice). Gathering the facts is the node's (doctor-facts.ts), and reads
 * only: it changes nothing, and never puts a secret in a fact.
 *
 * A few lines are also the heartbeat's findings (`finding`), for what the heartbeat
 * didn't already look at: their words there are stable (no "3 minutes ago"), so an
 * unchanged problem writes nothing.
 */

export interface FileFact {
  exists: boolean;
  /** Its permission bits (null: this system has none to read, as on Windows). */
  mode: number | null;
}

export interface RoleFact {
  role: string;
  /** A role you made: a knight's, whose conversations and tasks are all coding work. */
  custom?: boolean;
  /** Roles that answer in words are asked a word; the decider and the embedder aren't. */
  chats: boolean;
  /**
   * In the roster's order. `problem`: why this node can't use it (null: it can). `plan`: it is on a coding plan,
   * so it does his coding and the knights' coding tools use it, and it answers nothing else. `spent`: its provider's
   * allowance is spent now (its window ends by itself, so it is passed over, never a finding).
   */
  models: { ref: string; problem: string | null; plan?: boolean; spent?: boolean }[];
  /** On its defaults, none of whose providers is set up here (roster.ts): what it lacks is a key for one of them. */
  unset?: boolean;
  /** The one-word call to the first model that can be used (null: nobody was asked). */
  probe: { ref: string; ok: boolean; ms: number; error: string | null } | null;
}

export interface DoctorFacts {
  now: number;
  quick: boolean;
  offline: boolean;
  self: { id: string; name: string; fleetName: string; active: boolean; role: string | null; alwaysOn: boolean; startedAt: number };
  keys: { keystore: "os" | "file"; keyFile: FileFact | null; home: FileFact | null; adminToken: FileFact | null; /** The notification key's file, once there is one (file keystore). */ pushKeyFile?: FileFact | null };
  mind: {
    events: number;
    /** SQLite's own check: "ok", what it found, or null when it wasn't run. */
    integrity: string | null;
    /** This node's newest event in its own hash chain (null: it has written none). */
    head: string | null;
    forks: { id: string; name: string }[];
    /** The time of the newest event held, by its own clock stamp. */
    newestEventAt: number | null;
    /** Whether the system says its clock is synchronised (null: it can't be asked here). */
    timeSynced: boolean | null;
    peers: { name: string; alwaysOn: boolean; online: boolean; lastSeen: number | null; error: string | null; /** Its clock minus this node's, in ms (null: not known). */ clockOffsetMs: number | null }[];
    /** Where backups of the mind are looked for, and the newest file there (null: not looked for here). */
    backup: { dir: string; exists: boolean; newestAt: number | null; files: number } | null;
  };
  vault: { unlocked: boolean; secrets: number; requests: string[] };
  /** The providers this fleet has set up (a key added, or one added by hand), and those his roles' defaults name, whose key alone is enough. */
  providers?: { setUp: number; byDefault: string[] };
  /** Providers whose allowance is spent now (absent: gathered before this was known): each window, and when it resets. */
  spent?: { provider: string; until: number }[];
  /** Providers whose key a call got refused, still unproven by a later call or a newer key (absent: gathered before this was known). */
  refused?: { provider: string; at: number; said: string }[];
  roles: RoleFact[];
  /** null: this node keeps no archive. */
  archive: {
    off: boolean;
    entries: number;
    chunks: number;
    backlog: number;
    embedder: { model: string | null; state: "ready" | "none" | "failing"; error: string | null; local: boolean | null; /** One word embedded just now (null: not asked: a remote embedder is only asked by a full check that isn't offline). */ probe: { ok: boolean; ms: number; error: string | null } | null };
    integrity: { lastAt: number | null; ok: boolean | null; problems: number };
    sourceErrors: { name: string; error: string }[];
  } | null;
  sandbox: {
    /** null: this node hosts no sandboxes. */
    host: {
      /** Its engine answers (Docker's, or on a Mac Apple's container's: `engine`). */
      docker: boolean;
      /** "container": a Mac's, through Apple's container, every sandbox a VM. Absent: Docker's. */
      engine?: "container";
      image: boolean;
      networks: boolean;
      diskLimited: boolean;
      kvm: boolean;
      microVMs: boolean;
      /** The firewall unit that keeps sandboxes to the one gateway port (null: can't be asked here). */
      firewall: "active" | "inactive" | "missing" | null;
      /** A Mac's sandbox firewall (pf, from a helper of root's: galahad firewall), as the node reads it; absent on Linux. */
      macFirewall?: { on: boolean; installed: boolean; soon: boolean; why: string | null; release?: "current" | "other" | "none" };
      /** A sandbox started, ran one command and was removed: each kind tried. "busy": no slot was free. null: not tried. */
      start: { kind: "container" | "vm"; ok: boolean; ms: number; error: string | null }[] | "busy" | null;
    } | null;
    /** The fleet's other sandbox hosts, as they last published themselves. */
    others: { name: string; online: boolean; image: boolean }[];
    /** Apple's container, where this Mac has it: its version, whether its service answers, and whether it has a kernel for its VMs. */
    container?: { version: string | null; running: boolean; kernel?: boolean } | null;
  };
  /** null: compute isn't known here. */
  compute: { canMeasure: boolean; lastAt: number | null; due: "joined" | "changed" | null; slots: number | null; inUse: number; waiting: number } | null;
  loops: { name: string; enabled: boolean; /** null: its node was revoked. */ runner: string | null; runnerOnline: boolean; problem: string | null; /** Its latest runs' statuses, newest first. */ recent: string[]; lastAt: number | null; next: number | null }[];
  connectors: { id: string; label: string; host: string | null; key: string; problem: string | null; /** Whether its service answered a request that carried nothing (null: not asked). */ reach: { ok: boolean; ms: number; error: string | null } | null }[];
  app: {
    /** Files the app can't do without that the node isn't serving. */
    missing: string[];
    /** Where `tailscale serve` publishes it (null: nowhere). undefined: can't tell here. */
    published: string | null | undefined;
    local: string;
  };
  disk: { freeGb: number; totalGb: number } | null;
  service: {
    /** systemd's count of automatic restarts (null: not under systemd, or it can't be asked). */
    restarts: number | null;
    /** Lines of the node's own log that read like trouble, newest first, already redacted. */
    warnings: { at: number; text: string }[];
  };
  /**
   * Push notifications on this node (absent: a node from before them): the devices subscribed, those whose sends keep
   * failing, and (absent: gathered before these were known) how many devices' subscriptions their push service dropped,
   * and how many things wait for your answer (approvals, questions, keys and connectors he needs).
   */
  notify?: { devices: number; failing: { device: string; error: string }[]; keyProblem: string | null; lost?: number; asks?: number };
  /**
   * The knights whose own setup can stop their work here (absent: a node with no Roundtable): one in sensitive mode,
   * each of its models and why this node can't use it (null: it can); each key of yours it was given, and why it can't
   * go anywhere now (null: it can).
   */
  knights?: { id: string; name: string; sensitive: { ref: string; problem: string | null }[] | null; keys: { secret: string; problem: string | null }[] }[];
}

/** A finding for the heartbeat, in words that don't change while the problem stands. */
export interface DoctorFinding {
  key: string;
  severity: "info" | "warn" | "alert";
  title: string;
  body: string;
}

export interface Diagnosis extends DoctorCheck {
  finding?: DoctorFinding;
}

const CORE_ROLES = new Set(["planner", "engineer", "reviewer"]);
/** The roles whose own work is all coding (a quest's engineering and its review): a coding plan alone can play them. */
export const CODING_ROLES = new Set(["engineer", "reviewer"]);
/**
 * The roles a VM's own tools play, through the gateway, and never he himself (a VM's eyes): a coding plan its tools may
 * use (one whose terms allow unattended tools) plays them alone.
 */
export const TOOL_ROLES = new Set(["eyes"]);
/** Why a plan can't play a role a VM's tools play: its terms keep it to a tool you run yourself. */
export const VM_TOOLS_CANT = "its plan is for a tool you run yourself, and a VM's tools are not that";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Any clock may lead another by this much; past it no event is accepted (the mind's rule). */
export const CLOCK_GUARD_MS = 5 * MINUTE;
/** Signed requests are accepted within a minute; well inside it, a difference is worth saying. */
export const CLOCK_STEP_MS = 30_000;
export const BACKUP_OLD_MS = 7 * DAY;
/** A node's first backup comes ten minutes after it starts (backups.ts): before this, none yet is no fault. */
export const FIRST_BACKUP_MS = 15 * MINUTE;
export const CALIBRATION_OLD_MS = 30 * DAY;
export const INTEGRITY_OLD_MS = 3 * DAY;
export const OFFLINE_AFTER_MS = 10 * MINUTE;
/** Trouble in the node's log this recently is worth a look; older lines are only counted. */
export const WARNINGS_RECENT_MS = HOUR;

const plural = (n: number, word: string, many = `${word}s`) => `${n.toLocaleString("en")} ${n === 1 ? word : many}`;

/** "12 minutes", "3 days". */
export function span(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < 90_000) return plural(Math.max(1, Math.round(abs / 1000)), "second");
  if (abs < 90 * MINUTE) return plural(Math.round(abs / MINUTE), "minute");
  if (abs < 36 * HOUR) return plural(Math.round(abs / HOUR), "hour");
  return plural(Math.round(abs / DAY), "day");
}

const octal = (mode: number) => (mode & 0o777).toString(8).padStart(3, "0");
const openToOthers = (file: FileFact | null): boolean => !!file?.exists && file.mode !== null && (file.mode & 0o077) !== 0;

// (A provider's refusal in its own words: brain's refusalWords, which the doctor's tests read from here too.)
export { refusalWords };

/** Why a model didn't answer, and what that calls for. */
function probeAdvice(error: string): string {
  if (/content.?filter|refus|declin/i.test(error)) return "The provider's filter ended the reply. Filters aren't steady: run the doctor again, and if it keeps happening put another model first (galahad roster set).";
  // (A refused key by the rule the node remembers one by: brain's refusesKey. A 403 of what was asked isn't the key's.)
  if (refusesKey(error) || /unauthor|invalid.*key/i.test(error)) return "The provider refused the key. Replace it: galahad key add (or the app's Vault).";
  if (/\b403\b|forbidden/i.test(error)) return "The provider refused what was asked, not its key (a model its plan doesn't include, a region it doesn't serve, a moderation flag): read its words, or put another model first (galahad roster set).";
  if (/\b429\b|rate.?limit|quota|credit|billing/i.test(error)) return "The provider is limiting or out of credit. Check the account, or put another model first (galahad roster set).";
  if (/time|abort/i.test(error)) return "No answer in time. Check the provider's status and this node's network, or put another model first (galahad roster set).";
  return "Check the provider's status and its base URL (galahad provider list), or put another model first (galahad roster set).";
}

export function diagnose(f: DoctorFacts): Diagnosis[] {
  const out: Diagnosis[] = [];
  // `as`: the finding's own name, where one line says two things that are told apart (each its own notice, told once).
  const add = (area: DoctorArea, id: string, state: DoctorState, line: string, fix?: string, extra: { ms?: number; finding?: Omit<DoctorFinding, "key">; as?: string } = {}): void => {
    out.push({
      id,
      area,
      state,
      line,
      ...(fix && state !== "ok" ? { fix } : {}),
      ...(extra.ms !== undefined ? { ms: extra.ms } : {}),
      ...(extra.finding && (state === "needs-you" || state === "broken") ? { finding: { key: `doctor:${extra.as ?? id}:${f.self.id}`, ...extra.finding } } : {}),
    });
  };
  const self = f.self.name;

  /* ---------- this node: its identity and where its keys are ---------- */

  if (!f.self.active) add("node", "node.identity", "broken", `${self} isn't an active member of its fleet (revoked?)`, "Join again with a fresh invite from another node: galahad invite there, galahad join here.");
  else add("node", "node.identity", "ok", `${self} is ${f.self.role === "full" ? "a full node" : `a ${f.self.role ?? "limited"} node`} of fleet ${f.self.fleetName}`);

  if (f.keys.keystore === "os") add("node", "node.keys", "ok", "its device keys are in the operating system's keychain");
  else if (f.keys.keyFile && !f.keys.keyFile.exists) add("node", "node.keys", "broken", "its key file (keys.json) is gone, so it can't start again", "Restore keys.json from a backup of the node's home, or enrol this machine again (galahad join) and revoke the old entry.");
  else if (openToOthers(f.keys.keyFile)) add("node", "node.keys", "broken", `its key file can be read by other users of this machine (mode ${octal(f.keys.keyFile!.mode!)})`, "chmod 600 keys.json in the node's home, then consider the keys read: revoke this node and enrol it again.");
  else if (openToOthers(f.keys.pushKeyFile ?? null)) add("node", "node.keys", "broken", `its notification key can be read by other users of this machine (push-key.json, mode ${octal(f.keys.pushKeyFile!.mode!)})`, "Stop the node, delete push-key.json and start it again: it makes a new key, and each device subscribes to it the next time its app opens. Whoever read the old one could have sent notifications as this node.");
  else if (!f.keys.keyFile || f.keys.keyFile.mode === null) add("node", "node.keys", "ok", "its device keys are in a key file (keys.json); this system has no file modes to check");
  else add("node", "node.keys", "ok", "its device keys are in a file only its own user can read (keys.json)");

  if (openToOthers(f.keys.home) || openToOthers(f.keys.adminToken)) {
    const what = openToOthers(f.keys.adminToken) ? `its admin token can be read by other users (mode ${octal(f.keys.adminToken!.mode!)})` : `its home is open to other users of this machine (mode ${octal(f.keys.home!.mode!)})`;
    add("node", "node.home", "needs-you", what, "chmod 700 the node's home and chmod 600 admin.token: whoever reads that token is you at a terminal.");
  } else add("node", "node.home", "ok", "its home and admin token are its own user's alone");

  /* ---------- the mind ---------- */

  if (f.mind.integrity === null) add("mind", "mind.integrity", "skipped", "the database's integrity wasn't scanned (a full check does)");
  else if (f.mind.integrity === "ok") add("mind", "mind.integrity", "ok", `the mind's database passes SQLite's integrity check (${plural(f.mind.events, "event")})`);
  else add("mind", "mind.integrity", "broken", `the mind's database is damaged: ${f.mind.integrity.slice(0, 200)}`, "Stop the node and keep mind.db aside. Restore it from your last backup, or enrol the node again from another one: the log syncs back.");

  if (f.mind.forks.length) {
    add(
      "mind",
      "mind.chain",
      "broken",
      `${f.mind.forks.map((d) => d.name).join(", ")} signed two different histories: its key may be in someone else's hands`,
      "Revoke it (galahad revoke), then rotate the keys it could read.",
    );
  } else add("mind", "mind.chain", "ok", f.mind.head ? `its own hash chain ends at ${f.mind.head.slice(0, 10)}, and no device has signed two histories` : "no device has signed two histories");

  {
    const ahead = f.mind.newestEventAt === null ? 0 : f.mind.newestEventAt - f.now;
    const off = f.mind.peers.filter((p) => p.clockOffsetMs !== null && Math.abs(p.clockOffsetMs) > CLOCK_STEP_MS);
    const known = f.mind.peers.filter((p) => p.clockOffsetMs !== null);
    if (ahead > CLOCK_GUARD_MS) {
      add("mind", "mind.clock", "broken", `this node's clock is behind: the newest event it holds is dated ${span(ahead)} after its own time`, "Set the clock (timedatectl set-ntp true). Until it's right he sends no approval and lapses none, and other nodes refuse his requests.", {
        finding: { severity: "alert", title: `${self}'s clock is behind`, body: "It reads earlier than the newest event it holds by more than any clock may lead another. Until it's set (timedatectl set-ntp true) he sends no approval and lapses none." },
      });
    } else if (off.length) {
      const p = off[0]!;
      add(
        "mind",
        "mind.clock",
        "needs-you",
        `its clock is ${span(p.clockOffsetMs!)} ${p.clockOffsetMs! > 0 ? "behind" : "ahead of"} ${p.name}'s; signed requests are refused past a minute`,
        "Turn time synchronisation on, on whichever machine is wrong (timedatectl set-ntp true).",
        { finding: { severity: "warn", title: `${self}'s clock is out of step with ${p.name}'s`, body: "They differ by more than half a minute, and signed requests are refused past a minute. Turn time synchronisation on, on whichever machine is wrong (timedatectl set-ntp true)." } },
      );
    } else if (f.mind.timeSynced === false) {
      add("mind", "mind.clock", "needs-you", "the system clock isn't being synchronised", "timedatectl set-ntp true. A clock that drifts gets this node's requests refused, and your devices' too.", {
        finding: { severity: "warn", title: `${self}'s clock isn't being synchronised`, body: "A clock that drifts gets this node's requests refused, and your devices' too. Turn it on: timedatectl set-ntp true." },
      });
    } else {
      const basis = [f.mind.timeSynced ? "synchronised by the system" : null, known.length ? `within ${span(Math.max(1000, ...known.map((p) => Math.abs(p.clockOffsetMs!))))} of ${known.map((p) => p.name).join(", ")}` : null].filter(Boolean);
      add("mind", "mind.clock", "ok", basis.length ? `its clock is in step (${basis.join("; ")})` : "nothing in the mind is dated after its clock (no time service or peer to compare with here)");
    }
  }

  if (!f.mind.peers.length) add("mind", "mind.sync", "ok", "the only node in its fleet, so there's nothing to sync with (a second node would also be a living copy of the mind)");
  for (const peer of f.mind.peers) {
    const id = `mind.sync.${peer.name}`;
    if (peer.online) add("mind", id, "ok", `in sync with ${peer.name}`);
    else if (peer.error && /\b40[13]\b/.test(peer.error)) add("mind", id, "needs-you", `${peer.name} refuses this node's requests (${redact(peer.error).slice(0, 120)})`, "A clock out of step, or one of them was revoked: check both clocks, then galahad status on each.");
    else if (!peer.alwaysOn) add("mind", id, "ok", `${peer.name} is asleep or away (a personal machine: it syncs when it's back)`);
    else if (f.now - (peer.lastSeen ?? f.self.startedAt) < OFFLINE_AFTER_MS) add("mind", id, "ok", `${peer.name} hasn't answered in the last minutes`);
    else add("mind", id, "needs-you", `${peer.name} is offline${peer.lastSeen ? `: last reached ${span(f.now - peer.lastSeen)} ago` : ""}`, `Check that machine and its Tailscale; work placed there waits. On it: systemctl status galahad.`);
  }

  if (f.mind.backup) {
    const b = f.mind.backup;
    // (Its first is kept ten minutes after it starts: backups.ts. A node younger than that hasn't missed one.)
    if ((!b.exists || b.newestAt === null) && f.now - f.self.startedAt < FIRST_BACKUP_MS) {
      add("mind", "mind.backup", "ok", `no backup of the mind yet: the node keeps its first ten minutes after it starts, in ${b.dir}`);
    } else if (!b.exists || b.newestAt === null) {
      add("mind", "mind.backup", "needs-you", `no backup of the mind in ${b.dir}`, "The node keeps its own each day, the first a few minutes after it starts (backups.ts), unless GALAHAD_BACKUPS=off: its log says if one couldn't be kept. Set GALAHAD_BACKUP_DIR to keep them elsewhere. A second full node is a living copy too.");
    } else if (f.now - b.newestAt > BACKUP_OLD_MS) {
      add("mind", "mind.backup", "needs-you", `the newest backup of the mind is ${span(f.now - b.newestAt)} old (${b.dir})`, "The node keeps one itself each day: its log says why one wasn't kept (backups: …), unless GALAHAD_BACKUPS=off.", {
        finding: { severity: "info", title: `The mind's backups on ${self} have stopped`, body: `The newest file in ${b.dir} is more than a week old. The node's log says why its daily one wasn't kept.` },
      });
    } else add("mind", "mind.backup", "ok", `backed up ${span(f.now - b.newestAt)} ago (${plural(b.files, "file")} in ${b.dir})`);
  }

  /* ---------- the vault ---------- */

  if (!f.vault.unlocked) add("vault", "vault.open", "broken", `${self} can't open the vault, so it can use no key`, "It holds no grant for the current vault key. Re-grant it from another full node, or rotate the vault (galahad vault rotate).");
  else add("vault", "vault.open", "ok", `open: ${plural(f.vault.secrets, "key")} sealed in it, usable here`);
  if (f.vault.requests.length) {
    add("vault", "vault.requests", "needs-you", `Galahad is waiting for ${plural(f.vault.requests.length, "key")}: ${f.vault.requests.slice(0, 6).join(", ")}`, "Fill them in the app's Vault, or galahad secret set <name> (a hidden prompt). He learns only that they're there.");
  }

  /* ---------- models: each role on the roster ---------- */

  // A node with no provider set up yet has one thing to do, said once rather than once a role.
  const none = f.providers?.setUp === 0;
  if (none) {
    const named = f.providers!.byDefault;
    add("models", "models.none", "broken", "no provider is set up here yet, so no model can answer", `Add a key: galahad key add. A key for ${named.slice(0, -1).join(", ")} or ${named.at(-1)} is enough, since his roles' defaults name their models; for another provider, hire one of its models too (galahad roster set <role> <provider/model>).`);
  }
  // A provider whose allowance is spent until it resets: its models are passed over on every role until then (a coding
  // plan's every model; any other provider's, the one model told to wait: brain/windows.ts windowScope). The window
  // ends by itself, so there is nothing to do; said once in the models area, never as a role's finding or an Inbox notice.
  for (const window of f.spent ?? []) {
    add(
      "models",
      `models.spent.${window.provider}`,
      "ok",
      `${window.provider}'s allowance is spent until ${clockUtc(window.until)} UTC (${spanWords(window.until - f.now)} from now), as its provider said: ${window.provider.includes("/") ? "it is" : "its models are"} passed over on every role until then`,
    );
  }
  // A provider that refused its key: said here as needs you, with what to do, and carried to the Inbox by its finding.
  // (A refusal from before the key was last set was left out of the facts: the key has been replaced since.)
  for (const refusal of f.refused ?? []) {
    const regional = regionalBaseUrls(refusal.provider);
    const fix = `Replace the key: galahad key add --provider ${refusal.provider}.${regional ? " The key must be for the address its plan's page shows (--base-url): a key for another region is refused here." : ""}`;
    add("models", `models.key.${refusal.provider}`, "needs-you", `${refusal.provider} refused its key at ${clockUtc(refusal.at)} UTC: ${refusal.said}`, fix, {
      finding: { severity: "warn", title: `${refusal.provider} refused its key`, body: `${refusal.provider} refused its key at ${clockUtc(refusal.at)} UTC: ${refusal.said}. ${fix}` },
    });
  }
  // A refused key's models are still asked, and refused, until it is replaced: a role's lines name the model that answers
  // instead, and never make a plan or first-model line of them (the refusal is said once, above, with its notice).
  const refusedKey = new Set((f.refused ?? []).map((refusal) => refusal.provider));
  for (const role of none ? [] : f.roles) {
    if (!role.models.length) continue; // nobody hired for it: a choice, not a problem
    const id = `role.${role.role}`;
    const models = role.models.map((m) => (m.problem === null && refusedKey.has(m.ref.slice(0, m.ref.indexOf("/"))) ? { ...m, problem: "its provider refused its key", refused: true } : { ...m, refused: false }));
    // A coding plan's models do his coding, and the knights' coding tools use them (brain/providers.ts); they
    // answer nothing else, and are asked no word. What is judged for everything else a role does is the rest.
    const plans = models.filter((m) => m.plan);
    const own = models.filter((m) => !m.plan);
    const lent = plans.filter((m) => m.problem === null);
    const unlent = plans.filter((m) => m.problem !== null && !m.spent && !m.refused);
    if (unlent.length) {
      add(
        "models",
        `${id}.plan`,
        "needs-you",
        `${unlent.map((m) => `${m.ref} (${m.problem})`).join("; ")}: on ${role.role}${TOOL_ROLES.has(role.role) ? "" : " for coding"}, which can't use ${unlent.length === 1 ? "it" : "them"}`,
        unlent.every((m) => m.problem === VM_TOOLS_CANT)
          ? `Hire a model a VM's tools may use: galahad roster set ${role.role} <provider/model>.`
          : `Add the plan's key: galahad key add --provider ${unlent[0]!.ref.slice(0, unlent[0]!.ref.indexOf("/"))}.`,
      );
    }
    const tools = lent.length ? `; his coding and the knights' tools use ${lent.map((m) => m.ref).join(", ")}` : "";
    const usable = own.filter((m) => m.problem === null);
    const first = own.find((m) => !m.spent && !m.refused);
    // A VM's eyes are asked by its tools, never by him: a plan they may use plays them alone (one they may not, said above).
    if (!own.length && TOOL_ROLES.has(role.role)) {
      if (lent.length) add("models", id, "ok", `${role.role}: ${lent[0]!.ref} looks at the VMs' screens, asked by their tools through the gateway (a coding plan: it is asked nothing else, so not a word)`);
      continue;
    }
    // A role whose work is all coding is played by a plan alone: the engineer's and the reviewer's, and a role you made,
    // which only knights work on (their conversations and tasks are coding work). So it is when none of its own models
    // can be used: a refused key's or a spent one's are said above, and any other's is said here.
    if (!usable.length && lent.length && (CODING_ROLES.has(role.role) || role.custom)) {
      const lacking = own.filter((m) => m.problem !== null && !m.spent && !m.refused).map((m) => `; ${m.ref} can't be asked (${m.problem})`).join("");
      add("models", id, "ok", `${role.role}: ${lent[0]!.ref} ${role.custom ? "does the work of the knights on it" : "does his coding"} (a coding plan: it is asked nothing else, so not a word)${lacking}`);
      continue;
    }
    if (role.unset && !usable.length) {
      const named = [...new Set(role.models.map((m) => m.ref.slice(0, m.ref.indexOf("/"))))];
      add("models", id, CORE_ROLES.has(role.role) ? "broken" : "needs-you", `no model can play ${role.role}: its defaults name ${named.slice(0, -1).join(", ")}${named.length > 1 ? " and " : ""}${named.at(-1)}, none of them set up here`, `Add a key for one of them (galahad key add), or hire a model you have a key for: galahad roster set ${role.role} <provider/model>.`);
      continue;
    }
    if (!usable.length || !first) {
      // (A role whose work is all coding, with no plan that can do it, is said as its plans' problems: coding is its work.)
      const unplayable = own.length ? own : CODING_ROLES.has(role.role) || role.custom ? plans : [];
      // What to do: nothing, for a window that ends by itself; the key, for one refused; else a key or another model.
      const fix = unplayable.length && unplayable.every((m) => m.spent)
        ? `It comes back by itself when its allowance resets (said above). To have ${role.role} played before then: galahad roster set ${role.role} <provider/model>.`
        : unplayable.length && unplayable.every((m) => m.refused)
          ? `Replace its key (said above), or hire a model that works here: galahad roster set ${role.role} <provider/model>.`
          : "Add a key (galahad key add) or hire a model that works here (galahad roster set " + role.role + " <provider/model>).";
      add(
        "models",
        id,
        CORE_ROLES.has(role.role) ? "broken" : "needs-you",
        unplayable.length
          ? `no model can play ${role.role}: ${unplayable.map((m) => `${m.ref} (${m.problem})`).join("; ")}`
          : `no model can play ${role.role} outside coding: ${plans.map((m) => m.ref).join(", ")} ${plans.length === 1 ? "is" : "are"} on a coding plan, which answers coding work only`,
        fix,
      );
      continue;
    }
    if (first.problem !== null) {
      add(
        "models",
        `${id}.first`,
        "needs-you",
        `${role.role}'s first model, ${first.ref}, is skipped on every answer (${first.problem}); ${usable[0]!.ref} answers instead`,
        `Give it what it lacks (galahad key add, galahad provider add), or put a model that works first: galahad roster set ${role.role} ${usable.map((m) => m.ref).join(" ")}.`,
        { finding: { severity: "info", title: `${role.role}'s first model is skipped on every answer`, body: `${first.ref}: ${first.problem}. ${usable[0]!.ref} answers instead. Give it what it lacks (galahad key add), or put a model that works first (galahad roster set ${role.role} …).` } },
      );
    }
    const probe = role.probe;
    if (!role.chats) add("models", id, "ok", `${role.role}: ${usable[0]!.ref} has what it needs (it doesn't answer in words, so it isn't asked)${tools}`);
    else if (!probe) add("models", id, "ok", `${role.role}: ${usable[0]!.ref} has what it needs (not asked${f.offline ? ": offline" : f.quick ? ": a full check asks it one word" : ""})${tools}`);
    else if (probe.ok) add("models", id, "ok", `${role.role}: ${probe.ref} answered${tools}`, undefined, { ms: probe.ms });
    // A full check asks a refused key's model its word (a key that works again is found so): refused again, the model
    // behind it is named, as for a spent one, and the refusal stays said once, above.
    else if (refusedKey.has(probe.ref.slice(0, probe.ref.indexOf("/"))) && refusesKey(probe.error ?? "")) add("models", id, "ok", `${role.role}: ${usable[0]!.ref} has what it needs (not asked: ${probe.ref}, before it, still refuses its key)${tools}`);
    else {
      const others = usable.filter((m) => m.ref !== probe.ref);
      const error = refusalWords(redact(probe.error ?? "no answer"));
      add("models", id, others.length || !CORE_ROLES.has(role.role) ? "needs-you" : "broken", `${role.role}: ${probe.ref} didn't answer: ${error}${others.length ? ` (${others[0]!.ref} is next in line)` : ""}`, probeAdvice(error), { ms: probe.ms });
    }
  }
  if (!f.roles.some((r) => r.models.length)) add("models", "role.none", "broken", "no model is hired for any role", "Add a key and a provider: galahad key add.");

  /* ---------- the archive and its embedder ---------- */

  if (f.archive) {
    const a = f.archive;
    const e = a.embedder;
    if (e.state === "none") add("archive", "archive.embedder", "ok", "no embedder is hired, so the archive is searched by words alone");
    else if (e.state === "failing" || e.probe?.ok === false) {
      const why = redact((e.probe?.ok === false ? e.probe.error : e.error) ?? "it doesn't answer").replace(/\s+/g, " ").slice(0, 160);
      add("archive", "archive.embedder", "needs-you", `the embedder ${e.model} isn't working: ${why}. Search is by words alone until it is`, e.local ? "On this machine: systemctl status galahad-ollama (a deploy with --embedder installs it), then galahad archive." : "Check its provider and key (galahad provider list), then galahad archive.", {
        finding: { severity: "warn", title: `The archive's embedder isn't working on ${self}`, body: `${e.model} doesn't answer, so the archive is searched by words alone and nothing new gets a vector. ${e.local ? "On that machine: systemctl status galahad-ollama." : "Check its provider and key (galahad provider list)."}` },
      });
    } else add("archive", "archive.embedder", "ok", `the embedder ${e.model} ${e.probe ? "answers" : "is working"}${e.local ? " on this machine (nothing leaves it)" : " (a remote provider: passages go to it)"}`, undefined, e.probe ? { ms: e.probe.ms } : {});

    if (a.off) add("archive", "archive.index", "needs-you", `the archive's background work is off: it keeps ${plural(a.entries, "entry", "entries")} and takes in nothing new`, "Remove GALAHAD_ARCHIVE=off from the node's environment and restart it.");
    else if (a.sourceErrors.length) add("archive", "archive.index", "needs-you", `the archive couldn't read ${a.sourceErrors.map((s) => `${s.name} (${redact(s.error).slice(0, 80)})`).join("; ")}`, "See galahad archive for each source; it tries again by itself.");
    else add("archive", "archive.index", "ok", `${plural(a.entries, "entry", "entries")} in ${plural(a.chunks, "passage")}${a.backlog ? `, ${a.backlog.toLocaleString("en")} waiting for a vector (he embeds in the background)` : ""}`);

    if (a.integrity.ok === false) add("archive", "archive.integrity", "broken", `${plural(a.integrity.problems, "archived file")} damaged or missing`, "galahad archive verify names them. Restore those files from a backup of the node's home: nothing is mended by deleting.");
    else if (a.integrity.lastAt === null) add("archive", "archive.integrity", "ok", "its files haven't been re-hashed yet (it happens once a day)");
    else if (f.now - a.integrity.lastAt > INTEGRITY_OLD_MS) add("archive", "archive.integrity", "needs-you", `its files were last re-hashed ${span(f.now - a.integrity.lastAt)} ago (it should be daily)`, "Run galahad archive verify. If it stays old, the archive's background work isn't running: see the node's log.");
    else add("archive", "archive.integrity", "ok", `every archived file matched its hash ${span(f.now - a.integrity.lastAt)} ago`);
  }

  /* ---------- sandboxes ---------- */

  const host = f.sandbox.host;
  if (!host) {
    const hosts = f.sandbox.others;
    // (A Mac with Apple's container that isn't running is told how to start it: it hosts through nothing else.)
    const container = f.sandbox.container;
    const here = container && !container.running ? `run galahad sandbox setup here: it starts Apple's container${container.version ? ` (${container.version} is installed)` : ""} and restarts the node` : "install Docker on this one and restart the node";
    if (!hosts.length) add("sandbox", "sandbox.host", "needs-you", "no node in the fleet hosts sandboxes, so quests and trials can't run", `Enrol a machine with Docker (galahad join there), or ${here}.`);
    else add("sandbox", "sandbox.host", "ok", `${self} hosts no sandboxes (no Docker here); they run on ${hosts.map((h) => h.name).join(", ")}`);
  } else {
    const mac = host.engine === "container";
    if (!host.docker) add("sandbox", "sandbox.docker", "broken", mac ? "Apple's container isn't answering on this Mac" : "Docker isn't answering on this machine", mac ? "galahad sandbox setup starts its service (container system start, at a 1.x release) and restarts the node, saying what fails." : "systemctl status docker, and check that the node's user is in the docker group.");
    else add("sandbox", "sandbox.docker", "ok", mac ? "Apple's container answers: every sandbox here is a VM of its own" : "Docker answers");
    if (mac && host.docker && f.sandbox.container?.kernel === false) add("sandbox", "sandbox.kernel", "needs-you", "Apple's container has no kernel for its VMs yet, so none starts here", "galahad sandbox setup fetches Apple's recommended one (container checks its digest).");
    if (host.docker) {
      if (!host.image) add("sandbox", "sandbox.image", "needs-you", "the sandbox image is missing (another tool's cleanup may have pruned it)", "galahad sandbox build. He also rebuilds it himself when a sandbox is next needed, which makes that quest wait.");
      else add("sandbox", "sandbox.image", "ok", "the sandbox image is built and kept in use");
      if (!host.networks) add("sandbox", "sandbox.networks", "needs-you", "a sandbox network is missing", "Restart the node: it creates them at its start (systemctl restart galahad).");
      else add("sandbox", "sandbox.networks", "ok", mac ? "both sandbox networks are there, each held up by a VM of the node's own" : "both sandbox networks are there");

      if (host.start === null) add("sandbox", "sandbox.start", "skipped", f.quick ? "no sandbox was started (a full check starts one and removes it)" : "no sandbox was started: the image is missing");
      else if (host.start === "busy") add("sandbox", "sandbox.start", "skipped", "no sandbox was started: there is no room for one now, and the doctor doesn't queue behind real work");
      else {
        for (const run of host.start) {
          const what = run.kind === "vm" ? "a microVM sandbox" : "a sandbox";
          if (run.ok) add("sandbox", `sandbox.start.${run.kind}`, "ok", `${what} started, ran a command and was removed`, undefined, { ms: run.ms });
          else add("sandbox", `sandbox.start.${run.kind}`, "broken", `${what} didn't start: ${redact(run.error ?? "no reason given").replace(/\s+/g, " ").slice(0, 200)}`, mac ? "container system logs says why container couldn't start it; galahad sandbox run -- true shows the same failure." : run.kind === "vm" ? "Kata Containers isn't working: a deploy with --sudo reinstalls it; until then online sandboxes can't be microVMs." : "See docker ps -a and the node's log; galahad sandbox run -- true shows the same failure.", { ms: run.ms });
        }
      }
    }
    if (host.kvm && !host.microVMs) add("sandbox", "sandbox.microvm", "needs-you", "this machine has KVM but no microVMs, so online sandboxes share its kernel", "Deploy with --sudo to install Kata Containers; code from the internet then runs in its own VM.");
    else if (host.microVMs) add("sandbox", "sandbox.microvm", "ok", "microVMs are available for untrusted code");
    if (!host.diskLimited) add("sandbox", "sandbox.disk", "needs-you", "sandboxes here have no disk limit: a runaway job could fill this machine's disk", "Deploy with --sudo to install the workspace helper; each sandbox then gets its own fixed-size disk.");
    else add("sandbox", "sandbox.disk", "ok", "each sandbox's workspace is its own fixed-size disk");
    if (host.firewall === "active") add("sandbox", "sandbox.firewall", "ok", "the firewall unit is active: sandboxes reach one port on this host and nothing else");
    else if (host.firewall === "inactive") {
      add("sandbox", "sandbox.firewall", "broken", "the firewall unit (galahad-firewall) isn't active, so sandboxes may reach more of this host than the gateway", "sudo systemctl restart galahad-firewall, then systemctl status galahad-firewall.", {
        finding: { severity: "warn", title: `The sandbox firewall isn't active on ${self}`, body: "galahad-firewall keeps sandboxes to the one gateway port. On that machine: sudo systemctl restart galahad-firewall." },
      });
    } else if (host.firewall === "missing") {
      add("sandbox", "sandbox.firewall", "needs-you", "there's no galahad-firewall unit here: what a sandbox can reach on this host depends on its other firewall", "Deploy with --sudo to install it: only the gateway port on the sandbox bridge, whatever UFW does.", {
        finding: { severity: "info", title: `${self} has no sandbox firewall unit`, body: "What a sandbox can reach on that host depends on its other firewall. A deploy with --sudo installs galahad-firewall." },
      });
    }
    const wall = host.macFirewall;
    // (On, but installed by another release: its rules are that release's, until this one's are put in their place.)
    if (wall?.on && wall.release === "other") add("sandbox", "sandbox.firewall", "needs-you", "this Mac's sandbox firewall is on, with another release's rules", "galahad sandbox setup puts this release's in place (it asks for your password once).");
    else if (wall?.on) add("sandbox", "sandbox.firewall", "ok", "this Mac's sandbox firewall is on: a gateway sandbox reaches the gateway alone, an online one the internet, never this Mac or your networks; no sandbox reaches another");
    else if (wall && !wall.installed) {
      add("sandbox", "sandbox.firewall", "needs-you", "this Mac has no sandbox firewall, so it makes no sandboxes: its knights work on your other nodes", "galahad sandbox setup, or This Mac in the app (it asks for your password once).", {
        finding: { severity: "info", title: `${self} has no sandbox firewall`, body: "A Mac makes no sandboxes until its firewall is installed. On that Mac: galahad sandbox setup." },
      });
    } else if (wall) {
      add("sandbox", "sandbox.firewall", wall.soon ? "needs-you" : "broken", `this Mac's sandbox firewall isn't on, so it makes no sandboxes: ${wall.why ?? "no reason given"}`, wall.soon ? "Its helper puts it right within seconds of the networks coming up: galahad firewall status." : "galahad firewall status says why; galahad firewall install puts it back.", {
        finding: { severity: "warn", title: `The sandbox firewall is off on ${self}`, body: `It makes no sandboxes until it is: ${wall.why ?? "no reason given"}. On that Mac: galahad firewall status.` },
      });
    }
  }

  /* ---------- compute ---------- */

  if (f.compute) {
    const c = f.compute;
    if (c.lastAt === null) add("compute", "compute.calibration", c.canMeasure ? "needs-you" : "ok", c.canMeasure ? `${self} hasn't measured itself, so he counts one sandbox slot here` : `${self} doesn't measure itself here`, "galahad compute calibrate (a few seconds, at low priority).");
    else if (c.due === "changed") add("compute", "compute.calibration", "needs-you", `its measurement is stale: this machine, its ceiling or the benchmark changed since it measured itself ${span(f.now - c.lastAt)} ago`, "galahad compute calibrate. He does it himself after the next heartbeat unless self-action is off.");
    else if (f.now - c.lastAt > CALIBRATION_OLD_MS) add("compute", "compute.calibration", "needs-you", `it last measured itself ${span(f.now - c.lastAt)} ago`, "galahad compute calibrate, so placement and slots follow the machine as it is now.");
    else add("compute", "compute.calibration", "ok", `measured itself ${span(f.now - c.lastAt)} ago`);
    if (c.slots !== null) add("compute", "compute.slots", "ok", `${c.inUse} of ${plural(c.slots, "sandbox slot")} in use${c.waiting ? `, ${c.waiting} waiting for one` : ""}`);
  }

  /* ---------- loops ---------- */

  if (!f.loops.some((l) => l.name === "heartbeat")) add("loops", "loops.heartbeat", "needs-you", "there's no heartbeat loop, so nobody looks around between your visits", "galahad loop add heartbeat --every 30m --heartbeat.");
  for (const loop of f.loops) {
    const id = `loop.${loop.name}`;
    const last = loop.lastAt ? `last ran ${span(f.now - loop.lastAt)} ago (${loop.recent[0] ?? "?"})` : "hasn't run yet";
    const next = loop.next ? (loop.next > f.now ? `, next in ${span(loop.next - f.now)}` : ", due now") : "";
    if (loop.runner === null) add("loops", id, "broken", `${loop.name} has no runner: the node it ran on was revoked`, `Move it: galahad loop set ${loop.name} --on <node>.`);
    else if (loop.problem) add("loops", id, "needs-you", `${loop.name} can't be read here: ${loop.problem}`, `Set it again (galahad loop set ${loop.name} …), or update this node if a newer one wrote it.`);
    else if (!loop.enabled) add("loops", id, "ok", `${loop.name} is paused (${last})`);
    else if (loop.recent.length >= 3 && loop.recent.slice(0, 3).every((s) => s === "failed")) add("loops", id, "broken", `${loop.name} keeps failing: its last three runs failed`, `galahad loop runs ${loop.name} says why.`);
    else if (loop.recent[0] === "failed" || loop.recent[0] === "interrupted") add("loops", id, "needs-you", `${loop.name}'s last run ${loop.recent[0] === "failed" ? "failed" : "was interrupted"} (${span(f.now - (loop.lastAt ?? f.now))} ago)`, `galahad loop runs ${loop.name} says why; galahad loop run ${loop.name} tries again.`);
    else if (!loop.runnerOnline) add("loops", id, "needs-you", `${loop.name} runs on ${loop.runner}, which is offline (${last})`, `Bring ${loop.runner} back, or move it: galahad loop set ${loop.name} --on <node>.`);
    else add("loops", id, "ok", `${loop.name} on ${loop.runner}: ${last}${next}`);
  }

  /* ---------- connectors ---------- */

  if (!f.connectors.length) add("connectors", "connectors.none", "ok", "none installed");
  for (const c of f.connectors) {
    const id = `connector.${c.id}`;
    if (c.problem) add("connectors", id, "broken", `${c.label} doesn't validate: ${c.problem.slice(0, 200)}`, `Install it again: galahad connector add ${c.id} (or fix its manifest).`);
    else if (c.key === "missing") add("connectors", id, "needs-you", `${c.label} is waiting for its key`, `galahad secret set <name> --connector ${c.id}, or the app's Vault.`);
    else if (c.key === "wrong-origin") add("connectors", id, "needs-you", `${c.label}'s key is pinned to another address, so it's never sent`, `Set it again for this connector: galahad secret set <name> --connector ${c.id}.`);
    else if (c.reach && !c.reach.ok) add("connectors", id, "needs-you", `${c.label} can't be reached${c.host ? ` at ${c.host}` : ""}: ${redact(c.reach.error ?? "no answer").slice(0, 120)}`, "Check the address and this node's network; his calls to it fail until it answers.", { ms: c.reach.ms });
    else if (c.reach) add("connectors", id, "ok", `${c.label} answers${c.host ? ` at ${c.host}` : ""}${c.key === "ready" ? ", and its key is in the vault" : ""}`, undefined, { ms: c.reach.ms });
    else add("connectors", id, "ok", `${c.label} is installed${c.key === "ready" ? " with its key" : ""} (not probed${f.offline ? ": offline" : ""})`);
  }

  /* ---------- the app ---------- */

  if (f.app.missing.length) {
    add("app", "app.bundle", "broken", `the app didn't build: the node isn't serving ${f.app.missing.join(", ")}`, "Run bun install in the release and restart the node; its log says what failed to build.", {
      finding: { severity: "warn", title: `The app didn't build on ${self}`, body: "The node is up but isn't serving the app's files. On that machine: bun install in the release, then restart the node; its log says what failed." },
    });
  } else add("app", "app.bundle", "ok", "the app is built and served by this node");
  if (f.app.published === undefined) add("app", "app.published", "ok", `whether it's published on your tailnet can't be told here; on this machine it's at ${f.app.local}`);
  else if (f.app.published) add("app", "app.published", "ok", `published at ${f.app.published}`);
  else if (f.self.alwaysOn) {
    add("app", "app.published", "needs-you", "Tailscale isn't publishing the app, so your phone and browser can't open it", "galahad expose (it runs tailscale serve for this node's app port); tailscale serve status shows what's published.", {
      finding: { severity: "warn", title: `Tailscale isn't publishing the app on ${self}`, body: "Your devices can't open it until it is. On that machine: galahad expose, then tailscale serve status." },
    });
  } else add("app", "app.published", "ok", `not published on your tailnet (a personal machine); on this machine it's at ${f.app.local}`);

  /* ---------- notifications ---------- */

  if (f.notify) {
    const n = f.notify;
    const lost = n.lost ?? 0;
    const asks = n.asks ?? 0;
    if (n.keyProblem) add("notify", "notify.key", "broken", `this node's notification key can't be used: ${n.keyProblem.slice(0, 160)}`, "Turn notifications off and on again on each device (Settings): the node makes a new key, and each device subscribes to it.");
    else if (!n.devices && (lost || asks)) {
      // Nobody can be reached, and it matters: a device's were on until its push service dropped them, or something
      // waits for an answer only you give (unanswered, an approval lapses in a day). In your Inbox, so every app shows
      // it; never pushed (notify.ts): a notification can't say it can't reach you.
      const why = lost ? `: ${lost === 1 ? "a device's were dropped by its push service" : `${plural(lost, "device")}' were dropped by their push services`}` : `, and ${plural(asks, "thing")} ${asks === 1 ? "waits" : "wait"} for your answer`;
      add("notify", "notify.devices", "needs-you", `no device has notifications on, so he can't reach you when the app is closed${why}`, "Turn them on from a device you carry: iPhone or iPad, More → Notifications; the web app, Settings → Notifications; Android, More → Notifications. galahad notify test sends one.", {
        as: "notify.reach",
        finding: { severity: "warn", title: "Galahad can't reach you when the app is closed", body: "No device of yours has notifications on, so what needs you waits here until you look. iPhone or iPad: More → Notifications. Web app: Settings → Notifications. Android: More → Notifications." },
      });
    } else if (!n.devices) add("notify", "notify.devices", "ok", "no device has notifications turned on, so he can't reach you when the app is closed (Settings turns them on)");
    else if (n.failing.length) {
      const names = n.failing.map((d) => d.device);
      add("notify", "notify.devices", "needs-you", `notifications aren't reaching ${n.failing.map((d) => `${d.device} (${d.error.slice(0, 80)})`).join("; ")}`, "On that device: Settings, turn notifications off and on again. galahad notify test sends one now.", {
        finding: { severity: "warn", title: `Notifications aren't reaching ${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]}`, body: "The last ones didn't arrive. On that device, turn notifications off and on again; galahad notify test sends one." },
      });
    } else add("notify", "notify.devices", "ok", `${plural(n.devices, "device")} can be reached with a notification`);
  }

  /* ---------- disk ---------- */

  if (f.disk) {
    const share = f.disk.totalGb ? f.disk.freeGb / f.disk.totalGb : 1;
    const words = `${Math.floor(f.disk.freeGb).toLocaleString("en")} GB free of ${Math.round(f.disk.totalGb).toLocaleString("en")} GB where the node keeps its home`;
    if (share < 0.03 || f.disk.freeGb < 1) add("disk", "disk.home", "broken", `almost no disk left: ${words}`, "Free space now: docker system df, old backups, the archive's root (galahad archive). The mind can't write when it's full.");
    else if (share < 0.1 || f.disk.freeGb < 5) add("disk", "disk.home", "needs-you", `low on disk: ${words}`, "Free space soon: docker system df, old backups, the archive's root (galahad archive).");
    else add("disk", "disk.home", "ok", words);
  }

  /* ---------- the service itself ---------- */

  const up = `up ${span(f.now - f.self.startedAt)}`;
  if (f.service.restarts !== null && f.service.restarts > 0) {
    add("service", "service.unit", "needs-you", `${up}; systemd has restarted it ${plural(f.service.restarts, "time")} since it was last started by hand`, "journalctl -u galahad -n 200 shows what ended it each time.", {
      finding: { severity: "info", title: `${self}'s service has been restarting`, body: "systemd restarted it after it ended by itself. On that machine: journalctl -u galahad -n 200 shows why." },
    });
  } else add("service", "service.unit", "ok", f.service.restarts === null ? `${up} (not run by systemd here, or it can't be asked)` : `${up}, and systemd hasn't had to restart it`);
  {
    const recent = f.service.warnings.filter((w) => f.now - w.at <= WARNINGS_RECENT_MS);
    if (recent.length) add("service", "service.log", "needs-you", `${plural(recent.length, "line")} of trouble in its log in the last hour, the latest: ${recent[0]!.text.slice(0, 200)}`, "The node's log has the rest (journalctl -u galahad -n 200, or the terminal it runs in).");
    else add("service", "service.log", "ok", f.service.warnings.length ? `nothing in its log in the last hour (${plural(f.service.warnings.length, "line")} of trouble since it started)` : "nothing in its log reads like trouble");
  }

  // A knight's own setup (PLAN #48, #17): in sensitive mode with no model of its own that can run here, its work can't
  // run at all (it never goes elsewhere); a key of yours given to it that can go nowhere now fails its calls.
  for (const k of f.knights ?? []) {
    if (k.sensitive) {
      const usable = k.sensitive.filter((m) => m.problem === null);
      if (usable.length) add("models", `knight.${k.id}.sensitive`, "ok", `${k.name} is in sensitive mode, on ${usable.map((m) => m.ref).join(", ")}${usable.length < k.sensitive.length ? ` (${plural(k.sensitive.length - usable.length, "model")} of its own can't be used here)` : ""}`);
      else add("models", `knight.${k.id}.sensitive`, "broken", `${k.name} is in sensitive mode, and none of its models can be used here (${k.sensitive.map((m) => `${m.ref}: ${m.problem}`).join("; ").slice(0, 300)}): its work can't run, and never goes to another model`, `Add the key its models need (galahad key add --provider <id>), or choose models of its own that can run (galahad roundtable sensitive ${k.id} on <provider/model…>).`, { finding: { severity: "warn", title: `${k.name} can't work in sensitive mode`, body: "None of the models it is held to can be used on this node." } });
    }
    for (const key of k.keys) {
      if (key.problem) add("vault", `knight.${k.id}.key.${key.secret}`, "needs-you", `${k.name} was given the key ${key.secret}, which can go nowhere now: ${key.problem}`, `Pin it again (galahad secret set ${key.secret} --base-url https://…), or take it back (galahad roundtable keys ${k.id} rm ${key.secret}).`);
      else add("vault", `knight.${k.id}.key.${key.secret}`, "ok", `${k.name} may use the key ${key.secret} without seeing it`);
    }
  }

  return doctorSorted(out);
}

/** The report a route answers with: the lines, without the heartbeat's own fields. */
export function reportOf(node: string, facts: DoctorFacts, diagnoses: Diagnosis[], tookMs: number): DoctorReport {
  const checks: DoctorCheck[] = diagnoses.map(({ finding: _finding, ...check }) => check);
  return { node, at: facts.now, quick: facts.quick, offline: facts.offline, checks, tally: doctorTally(checks), tookMs };
}

/** What the heartbeat takes from a quick look: only what it doesn't already check itself. */
export const doctorFindings = (diagnoses: Diagnosis[]): DoctorFinding[] => diagnoses.flatMap((d) => (d.finding ? [d.finding] : []));
