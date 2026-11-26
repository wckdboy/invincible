import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ConversationId, redact } from "@invincible/core";
import { LedgerStore, Vault } from "@invincible/ledger";
import { ChatStore } from "../chats.ts";
import { loadEnv } from "../env.ts";
import type { Home } from "../home.ts";
import { TeamStore } from "../team-store.ts";
import { Uploads } from "../uploads.ts";
import { type ChatChoice, type Into, type Kind, KINDS, leaveBehind, makePlan, type Plan } from "./plan.ts";
import { report } from "./report.ts";
import { GalahadHome } from "./source.ts";
import { ImportError } from "./sqlite.ts";
import { TargetView } from "./target.ts";

/*
 * `invincible import galahad <its home> [--dry-run] [--chats all|none|<id>,<id>]` (docs/ARCHITECTURE.md §10): the
 * owner's world, brought across once from the system Invincible succeeds, read from its home without a byte of it
 * written, and written here as Invincible's own: new events on this node's ledger, signed by it, and its node-local
 * stores (agents, chats). Never Galahad's identity, devices or fleet.
 */

export const IMPORT_HELP = `  import galahad <its home> [--dry-run] [--chats all|none|<id>,<id>] [--skip <kind|name>,…]
                                                           your world from Galahad, once, read from its home and never
                                                           written there: providers and plans, the roster and prices,
                                                           the vault's keys (sealed anew here, never shown), memory and
                                                           what it learned of you, projects, connectors, and its agents
                                                           as profiles (their looks stay behind); chats only as --chats
                                                           says; --skip leaves a kind (agents, chats…) or anything by
                                                           its name behind. Never its identity, devices or fleet. --dry-run says
                                                           what would come and writes nothing; a run writes with this
                                                           node stopped, and again brings only what isn't here yet.
                                                           Exit code 0: done; 2: done, but something couldn't come`;

const USAGE = "usage: invincible import galahad <its home> [--dry-run] [--chats all|none|<id>,<id>] [--skip <kind|name>,…]";

/** Which chats: none (the default), all, or those named, each by its id there. */
export function chatChoice(said: string | undefined): ChatChoice {
  if (said === undefined || said === "none") return "none";
  if (said === "all") return "all";
  const ids = [...new Set(said.split(",").map((id) => id.trim()).filter(Boolean))];
  const wrong = ids.find((id) => !ConversationId.safeParse(id).success);
  if (wrong || !ids.length) throw new ImportError(`--chats takes all, none, or chats' ids (cv_…) joined by commas${wrong ? `: ${wrong} isn't one` : ""}`);
  return ids;
}

/** Whether something answers on this node's port: the node running, which a second writer must never write beside. */
async function answering(port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {}, error() {}, close() {} } });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

/** Whether `dir` is `other`, or inside it. */
const within = (dir: string, other: string) => {
  const path = relative(other, dir);
  return path === "" || !(path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path));
};

export interface ImportOptions {
  home: Home;
  dryRun: boolean;
  chats: string | undefined;
  /** What to leave behind, by kind or by name, joined by commas (--skip). */
  skip?: string | undefined;
  /** Whether this node is running (tests say so; otherwise its port is asked). */
  running?: () => Promise<boolean>;
  /** The user it runs as (tests say another; otherwise this process's). */
  uid?: number;
}

/** Runs the import; its exit code: 0 done, 2 done with something skipped. A refusal throws (ImportError). */
export async function importCommand(system: string | undefined, args: readonly string[], opts: ImportOptions, write: (line: string) => void): Promise<number> {
  if (system !== "galahad" || !args[0] || args.length > 1) throw new ImportError(USAGE);
  const chats = chatChoice(opts.chats);
  const home = opts.home;
  if (!home.exists()) throw new ImportError(`no node at ${home.dir} to bring it into: found one with \`invincible init\` first (or say where with --home)`);
  const old = GalahadHome.locate(resolve(args[0]));
  const here = realpathSync(home.dir);
  if (within(here, old) || within(old, here)) throw new ImportError(`this node's home (${here}) and Galahad's (${old}) must be apart: neither may be the other, nor inside it`);
  const config = home.readConfig();
  if (!config.fleet) throw new ImportError(`the node at ${home.dir} belongs to no fleet yet`);
  const identity = await home.loadIdentity(config.keystore);
  if (!opts.dryRun) {
    // What it writes must stay the node's: a file root made in its home is one its service can't open.
    const owner = statSync(here).uid;
    const uid = opts.uid ?? process.getuid?.();
    if (uid !== undefined && uid !== owner) throw new ImportError(`this node's home belongs to another user (uid ${owner}): run the import as that user (on a server, the invincible command does), so what it writes stays the node's`);
    const port = loadEnv().INVINCIBLE_PORT ?? config.port;
    const running = opts.running ? await opts.running() : await answering(port);
    if (running) throw new ImportError(`this node is running (it answers on 127.0.0.1:${port}): stop it first (systemctl stop invincible, or Ctrl-C its serve), import, then start it again. A dry run may run beside it.`);
  }

  const source = GalahadHome.open(old);
  try {
    let plan: Plan;
    const target = new TargetView(home.dir, home.ledgerPath);
    try {
      plan = makePlan(source, target, { node: identity.id, chats });
    } finally {
      target.close();
    }
    const skip = [...new Set((opts.skip ?? "").split(",").map((name) => name.trim()).filter(Boolean))];
    const unknown = leaveBehind(plan, skip);
    if (unknown.length) throw new ImportError(`--skip names nothing in that home called ${unknown.join(", ")}: a kind (${KINDS.join(", ")}) or the name of something it would bring`);
    // With nothing to bring, nothing here is opened to be written either: a run again leaves this home as it was.
    if (!opts.dryRun && plan.items.some((i) => i.state === "bring")) bring(plan, home, config.fleet, identity);
    const said = report(plan, { dryRun: opts.dryRun, from: old, into: here, node: source.name });
    for (const line of said.lines) write(line);
    return said.skipped ? 2 : 0;
  } finally {
    source.close();
  }
}

/** What goes on the ledger is written in one transaction: an import cut short leaves the ledger as it was. */
const LEDGER: ReadonlySet<Kind> = new Set(["secrets", "providers", "roster", "thinking", "prices", "about-you", "memory", "projects", "connectors"]);

function bring(plan: Plan, home: Home, fleet: string, identity: Into["identity"]): void {
  const store = new LedgerStore(home.ledgerPath);
  const opened: { team?: TeamStore; chats?: ChatStore; uploads?: Uploads } = {};
  try {
    store.expectFleet(fleet);
    const into: Into = {
      store,
      identity,
      vault: new Vault(store, identity),
      team: () => (opened.team ??= new TeamStore(join(home.dir, "team.db"))),
      chats: () => (opened.chats ??= new ChatStore(join(home.dir, "chats.db"))),
      uploads: () => (opened.uploads ??= new Uploads(join(home.dir, "uploads"))),
    };
    const run = (item: Plan["items"][number]) => {
      try {
        const said = item.write!(into);
        item.state = "brought";
        if (said) item.note = item.note ? `${item.note} · ${said}` : said;
      } catch (error) {
        item.state = "skip";
        // What failed, in the words of what refused it: none of them holds a value (a secret is only ever named).
        item.note = `it couldn't be written: ${redact(String((error as Error).message ?? error)).slice(0, 300)}`;
      }
    };
    const coming = plan.items.filter((i) => i.state === "bring");
    store.db.transaction(() => {
      for (const item of coming) if (LEDGER.has(item.kind)) run(item);
    })();
    for (const item of coming) if (!LEDGER.has(item.kind)) run(item);
  } finally {
    opened.team?.close();
    opened.chats?.close();
    store.close();
  }
}
