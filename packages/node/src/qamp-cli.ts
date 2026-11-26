import { QAMP_TOOLS, QAMP_TTL, QampGrantInput, type QampGrantMade, type QampGrantView } from "@galahad/core";
import type { Api } from "./loop-cli.ts";

/*
 * `galahad qamp`: Galahad's tools for an agent on another of your machines, over Q-AMP (qamp-grants.ts). Thin: the node
 * makes, keeps and ends each grant; this shapes what you type and prints what the agent's machine runs, as
 * `galahad mcp install` prints a client's config.
 */

type Flags = Record<string, string | boolean | (string | boolean)[] | undefined>;

const tty = process.stdout.isTTY;
const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s);

const GRANT = `galahad qamp grant <did:key:z6Mk…> [--tools ${QAMP_TOOLS.join(",")}] [--ttl 1h]`;
const USAGE = `usage: ${GRANT} | galahad qamp grants | galahad qamp revoke <id>|--all`;

/** `--ttl 90m`, `1h`, `24h`, `1d`, `45s`, or plain seconds: in seconds. Anything else: null. */
export function ttlSeconds(text: string): number | null {
  const m = /^(\d{1,6})\s*([smhd]?)$/.exec(text.trim());
  if (!m) return null;
  return Number(m[1]) * ({ "": 1, s: 1, m: 60, h: 3600, d: 86_400 } as Record<string, number>)[m[2]!]!;
}

/** "14:05" today, else its day too; and how far off it is. */
function when(ms: number, now: number): string {
  const at = new Date(ms);
  const sameDay = at.toDateString() === new Date(now).toDateString();
  const clock = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const left = Math.max(0, ms - now);
  const inWords = left < 90_000 ? `${Math.round(left / 1000)} s` : left < 90 * 60_000 ? `${Math.round(left / 60_000)} min` : `${(left / 3_600_000).toFixed(left < 10 * 3_600_000 ? 1 : 0)} h`;
  return `${sameDay ? clock : `${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${clock}`} (in ${inWords})`;
}

/** What the agent's machine runs: Q-AMP's own MCP gateway, to this grant's bridge, with the agent's key and its chain. */
export function agentCommand(made: QampGrantMade, key = "<the agent's key file>"): string[] {
  return ["qamp", "mcp", made.grant.url, "--key", key, "--proof", made.proof];
}

export async function qampCommand(api: Api, sub: string | undefined, rest: string[], flags: Flags, now: () => number = Date.now): Promise<void> {
  switch (sub) {
    case "grant": {
      const agent = rest[0];
      if (!agent || rest.length > 1) throw new Error(`usage: ${GRANT}`);
      const tools = typeof flags.tools === "string" ? flags.tools.split(",").map((t) => t.trim()).filter(Boolean) : [...QAMP_TOOLS];
      const ttl = flags.ttl === undefined ? QAMP_TTL.default : typeof flags.ttl === "string" ? ttlSeconds(flags.ttl) : null;
      if (ttl === null) throw new Error("--ttl takes how long, such as 30m, 1h or 24h (seconds if it says no unit)");
      // Checked here as the node checks it, so what's wrong is said in words, not as the API's issues.
      const checked = QampGrantInput.safeParse({ agent, tools, ttlSeconds: ttl });
      if (!checked.success) throw new Error(checked.error.issues.map((i) => i.message).join("; "));
      const made = await api.call<QampGrantMade>("qampGrant", checked.data);
      const { grant } = made;
      const command = agentCommand(made);
      console.log(`${bold(`Granted ${grant.tools.join(", ")}`)} to ${grant.agent}, until ${when(grant.endsAt, now())}.`);
      console.log(`  grant   ${grant.id} · its arm ${grant.label} holds ${grant.scopes.join(", ")}`);
      console.log(`  bridge  ${grant.url} · that key alone may connect\n`);
      console.log(`On the agent's machine, with qamp ${dim("0.1.0")} and the key you named (the file qamp keygen wrote):\n\n  ${command.join(" ")}\n`);
      console.log(`As an MCP server (Claude Code, OpenCode, Codex…), the same command:\n\n${JSON.stringify({ mcpServers: { galahad: { command: "qamp", args: command.slice(1) } } }, null, 2)}\n`);
      console.log(dim(`The chain (qdt1.…) is useless without the agent's private key; keep it out of chats all the same. The grant ends by itself; galahad qamp revoke ${grant.id} ends it now.`));
      if (/@(127\.|\[::1\])/.test(grant.url)) console.log(dim("This node listens on loopback only (it advertises no tailnet address): only an agent on this machine can reach it."));
      return;
    }
    case undefined:
    case "grants":
    case "ls":
    case "list": {
      const { grants } = await api.call<{ grants: QampGrantView[] }>("qampGrants");
      if (!grants.length) {
        console.log(`No grants. An agent on another of your machines gets some of Galahad's tools with ${GRANT}`);
        return;
      }
      for (const g of grants) {
        console.log(`  ${bold(g.id)}  ${g.tools.join(", ")}  ${g.agent}`);
        console.log(`  ${" ".repeat(g.id.length)}  ${dim(`ends ${when(g.endsAt, now())} · bridge ${g.bridge.state}${g.bridge.why ? ` (${g.bridge.why})` : ""} · ${g.url}`)}`);
      }
      return;
    }
    case "revoke":
    case "rm": {
      if (flags.all) {
        const { revoked } = await api.call<{ revoked: number }>("qampRevoke", { all: true });
        console.log(revoked ? `Ended ${revoked === 1 ? "1 grant" : `${revoked} grants`}: their arms are deleted (each agent's next call is refused) and their bridges stopped.` : "There were no grants.");
        return;
      }
      const id = rest[0];
      if (!id || rest.length > 1) throw new Error("usage: galahad qamp revoke <id>|--all   (galahad qamp grants lists them)");
      await api.call("qampRevoke", { id });
      console.log(`Ended ${id}: its arm is deleted (the agent's next call is refused) and its bridge stopped.`);
      return;
    }
    default:
      throw new Error(USAGE);
  }
}
