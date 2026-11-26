import { type CodingPlan, detectProvider, planOf, preset, signIn } from "@galahad/brain";
import type { RouteName } from "@galahad/core";

interface Api { call<T>(name: RouteName, input?: unknown): Promise<T> }
type Flags = Record<string, unknown>;

/*
 * `galahad key add`: a pasted key is sealed for the provider its form (or you) names, and the
 * provider configured. A subscription's sign-in is told from a key before anything is sent
 * anywhere. A coding plan is said to be one: what its key is for, and how to put it to work.
 */

/** What is said of a coding plan just added: what it is for, where its vendor says so, and the roster that puts it first for coding. */
export function planAdvice(id: string, plan: CodingPlan, engineer: readonly string[]): string[] {
  // What it does is what its vendor's terms allow (providers.ts CodingPlan.allows), and it says so.
  const does = plan.allows.native
    ? `${plan.name} is a coding plan: its key is for coding. Galahad and the other knights code on it themselves, as Galahad (his quests, their work), and lend it to the coding tools in their VMs (OpenCode, Hermes) and under \`galahad run\`, each calling as itself.`
    : plan.allows.tools === "unattended"
      ? `${plan.name} is a coding plan whose terms allow it only inside the coding tools they name: Galahad never calls it himself; a knight's OpenCode, Claude Code, Codex or Hermes runs on it through the gateway, and so does a tool under \`galahad run\`, each calling as itself.`
      : `${plan.name} is a coding plan for interactive use only, by its terms: it is lent to a tool you run yourself (galahad run --providers ${id} -- <tool>), and never to Galahad's own calls or a knight's unattended work.`;
  const lines = [`${does} His talk with you, his loops and his heartbeat never use it.`, `What it may be used for is its vendor's to say. ${plan.says} ${plan.terms}`];
  if (plan.allows.tools === "interactive") return lines;
  const has = engineer.filter((ref) => ref.startsWith(`${id}/`));
  if (has.length) lines.push(`Coding already has it: the engineer's roster has ${has.join(", ")}.`);
  else lines.push(`To put it first for coding: galahad roster set engineer ${[`${id}/${plan.models[0]}`, ...engineer].join(" ")}`);
  return lines;
}

/** A provider pointed elsewhere since its key was added: the key goes only where it was added for (SECURITY.md, 2), and this says how to add it where the provider is now. */
export function keyElsewhereLine(p: { id: string; baseUrl: string; keyElsewhere?: string }): string | null {
  return p.keyElsewhere ? `${p.id}'s key was added for ${p.keyElsewhere}, and a key goes only where it was added for: add it again for this address with \`galahad key add --provider ${p.id} --base-url ${p.baseUrl}\`.` : null;
}

export async function keyAddCommand(api: Api, value: string, flags: Flags, write: (s: string) => void = console.log, dim: (s: string) => string = (s) => s): Promise<void> {
  const str = (key: string) => (typeof flags[key] === "string" ? (flags[key] as string) : undefined);
  if (!value) throw new Error("no key given");
  const pasted = signIn(value);
  if (pasted) throw new Error(pasted.why);
  const providerId = str("provider") ?? detectProvider(value);
  if (!providerId) throw new Error("couldn't tell which provider this key is for; pass --provider <id> (see `galahad provider presets`)");
  const secretName = str("secret") ?? providerId;
  const known = preset(providerId);
  const baseUrl = str("base-url") ?? (known?.baseUrl || undefined);
  const { secret } = await api.call<{ secret: { origin: string | null } }>("setSecret", {
    name: secretName,
    value,
    provider: providerId,
    ...(str("base-url") ? { baseUrl: str("base-url") } : {}),
  });
  if (!baseUrl) {
    write(`Key stored as "${secretName}". ${known?.note ?? "Now add the provider with --base-url."}`);
    return;
  }
  await api.call("setProvider", { id: providerId, baseUrl, kind: str("kind") ?? known?.kind, secret: secretName });
  write(`Key stored and provider "${providerId}" configured. Every full node can now use it.\n${dim(`It will only ever be sent to ${secret.origin ?? "(unpinned: re-add with --base-url)"}.`)}`);
  const plan = planOf(providerId);
  const { roster } = await api.call<{ roster: Record<string, { models: string[] }> }>("roster");
  if (plan) {
    for (const line of planAdvice(providerId, plan, roster.engineer?.models ?? [])) write(line);
    return;
  }
  // His roles' defaults name some providers' models (roster.ts), so a key for one of them is enough; another's needs a
  // model of its hired.
  const named = ["planner", "engineer", "reviewer"].some((role) => roster[role]?.models.some((ref) => ref.startsWith(`${providerId}/`)));
  if (!named) write(`None of his roles has a model of ${providerId}'s yet: hire one with galahad roster set planner ${providerId}/<model> (and the engineer and reviewer as you like; galahad provider models ${providerId} lists what it serves).`);
}
