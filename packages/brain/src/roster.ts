import { TeammateRole, type ThinkingEffort } from "@galahad/core";
import type { MindStore } from "@galahad/mind";
import { providerRecord } from "./providers.ts";

/*
 * Models are hired by role, not by vendor. Each role is an ordered list of
 * `<provider>/<model>` refs; the first one that answers wins, the rest are
 * fallbacks. `<provider>/*` means "whatever that provider serves first"
 * (handy for local runtimes whose installed models vary per node).
 */

export type Effort = ThinkingEffort;

/**
 * How hard a model thinks at each step of the work, where you haven't pinned its role (your word, 19 November 2026:
 * "never fixed, always adaptable, and smart/clever routing for optimized performance and low cost"). A loop's turn
 * thinks most after a failure, after work sent back or an audit's steer (`hard`), and less after a command that ran
 * clean (`routine`); its first turn, a plan and a review think as a careful person would; a look at running work, which
 * only asks whether it is on its task, little. A role's `effort` below is for a call that names no step: a talk with
 * you, a chore. On Claude each level is said inside the conversation, so its cached beginning stays (adapters.ts).
 */
export const STEP_EFFORT = { start: "high", routine: "medium", hard: "xhigh", plan: "high", review: "high", audit: "low" } as const satisfies Record<string, Effort>;

/**
 * Whether two model refs name one model: the part after the last "/", lowercased, with "." and "_" read as "-".
 * So `deepseek/deepseek-v4-pro`, `opencode-go/deepseek-v4-pro` and `cloudflare-ai/deepseek/deepseek-v4-pro` are
 * one model, and so are `anthropic/claude-opus-5-5` and `orcarouter/anthropic/claude-opus-5.5`;
 * `anthropic/claude-opus-5-5` and `anthropic/claude-sonnet-5-5` are not.
 */
export function sameModel(a: string, b: string): boolean {
  const modelOf = (ref: string): string => {
    const slash = ref.lastIndexOf("/");
    return ref.slice(slash + 1).toLowerCase().replace(/[._]/g, "-");
  };
  return modelOf(a) === modelOf(b);
}

export interface RoleSpec {
  description: string;
  defaults: string[];
  effort: Effort;
}

/*
 * The work's defaults, the cheaper open models first (your word, 23 November 2026: "Galahad should mainly use the
 * coding plans and the cheaper but still near frontier open models from china/or hosted in europe"): DeepSeek's and
 * Z.ai's from China, Mistral's from Europe; then the frontier closed ones, as fallbacks: Anthropic's, Claude through
 * the two routers, OpenAI's and xAI's, each as its own pages name it (read 21 November 2026: OpenAI's guide calls
 * gpt-6.2-astra "a strong default", xAI's examples use grok-4.7, Mistral's its -latest aliases). Whichever of these
 * providers your first key is for answers at once, with no roster to set (roleModels leaves out the defaults on a
 * provider you haven't set up); a name a vendor retires is a line here. Any other provider's key: `key add` says how
 * to hire one of its models.
 */
const WORK = ["deepseek/deepseek-v4-pro", "zai/glm-5.3", "mistral/mistral-large-latest", "anthropic/claude-opus-5-5", "openrouter/anthropic/claude-opus-5.5", "orcarouter/anthropic/claude-opus-5.5", "openai/gpt-6.2-astra", "xai/grok-4.7"];

/**
 * The coding plans' models, first for the engineer's work once you add a plan's key: its allowance is paid for already.
 * Each is asked only what its vendor's terms allow (providers.ts CodingPlan.allows): OpenCode Go his own coding and the
 * coding tools', Z.ai's and MiMo's the coding tools' alone, and never his talk with you.
 */
const PLANS = ["opencode-go/deepseek-v4-pro", "opencode-go/glm-5.3", "zai-coding/glm-5.3", "mimo-token/mimo-v2.6-pro"];

export const ROLES: Record<string, RoleSpec> = {
  planner: {
    description: "decomposes quests, makes judgment calls, talks to you",
    defaults: WORK,
    effort: "high",
  },
  engineer: { description: "writes and changes code", defaults: [...PLANS, ...WORK], effort: "xhigh" },
  reviewer: {
    description: "independent check, ideally a different model family than the author",
    defaults: WORK,
    effort: "high",
  },
  swift: {
    description: "cheap and fast: routing, classification, summaries; local first",
    defaults: ["ollama/*", "llamacpp/*", "deepseek/deepseek-flash", "zai/glm-5.3-flash", "mistral/mistral-small-latest", "anthropic/claude-haiku-5-5", "openai/gpt-6.1-terra"],
    effort: "low",
  },
  decider: {
    description: "typed decisions (yes/no, a choice, a score) with calibrated probabilities, from a decision model such as TypeSafe's Jev",
    defaults: [],
    effort: "low",
  },
  // A knight's eyes (Computer Use): the model its desktop's `look` puts a screenshot and a question to, through the
  // gateway, from the knight's own VM. None until you name one: it must take images, and to be clicked on it must
  // answer a place in the screenshot's own pixels (measured, not assumed: TRIALS.md).
  eyes: {
    description: "looks at a knight's screen: says what is on it, and where, in pixels (Computer Use)",
    defaults: [],
    effort: "low",
  },
  // The archive's search by meaning. None until you hire one: a local model (deploy --embedder) keeps
  // the archive on your machines. Its first model is the archive's model (vectors can't be mixed).
  embedder: {
    description: "turns text into vectors for the archive's search by meaning; local first, so the archive never leaves your machines",
    defaults: [],
    effort: "low",
  },
};

/** The chores that run on a role of their own once you hire models for one (choreRole), and what each does. */
export const CHORES: Record<string, string> = {
  fold: "sums up a long chat, or a room's conversation, into its story; the swift role does it until you hire models for this",
};

/** Built-in roles that aren't a knight's to work on: the independent check of its work, and the tools'. */
const NOT_FOR_KNIGHTS = new Set(["reviewer", "decider", "eyes", "embedder"]);

/**
 * The role a knight's work runs on (its tasks, its harness): its own, unless that is the reviewer's or a tool's, when
 * it is the engineer's. A knight may talk on the reviewer's models; the reviewer never does the work it checks.
 */
export const workRole = (role: string): string => (NOT_FOR_KNIGHTS.has(role) ? "engineer" : role);

/**
 * The role a chore runs on (`fold`: a long chat or a room's conversation summed up into its story): the role named after
 * the chore once you hire models for it (`galahad roster set fold <provider/model> …`), the swift role until then. What a
 * chore costs is yours to choose, apart from what answers you.
 */
export function choreRole(store: MindStore, chore: string): string {
  return store.lww<string[]>(`roster:${chore}`)?.value?.length ? chore : "swift";
}

export function roleModels(store: MindStore, role: string): string[] {
  const configured = store.lww<string[]>(`roster:${role}`)?.value;
  if (configured?.length) return configured;
  if (ROLES[role]) return setUp(store, ROLES[role].defaults);
  // A role nobody hired (a knight made with a role of its own, or one you since removed): the engineer's models as
  // you set them. (Its built-in default would be a model you may hold no key for.)
  return roleModels(store, "engineer");
}

/**
 * A role's defaults as it runs on them: the ones on a provider this fleet has set up, so the key you added answers and
 * the rest aren't passed over in every answer; with none set up, every one, so what can't answer says what to add.
 */
function setUp(store: MindStore, defaults: string[]): string[] {
  const usable = defaults.filter((ref) => ref.indexOf("/") > 0 && providerRecord(store, ref.slice(0, ref.indexOf("/"))) !== null);
  return usable.length ? usable : defaults;
}

export interface RosterRole {
  models: string[];
  configured: boolean;
  description: string;
  /** How hard its models think: `auto`, by the step (STEP_EFFORT), or the level you pinned it to. */
  effort: Effort | "auto";
  /** A role you made (not built in, not a chore's): yours to remove. */
  custom: boolean;
  /** A knight may work on it: the planner, engineer and swift roles, and the roles you made. */
  forKnights: boolean;
}

export function roster(store: MindStore): Record<string, RosterRole> {
  const names = new Set([...Object.keys(ROLES), ...store.lwwPrefix("roster:").map((e) => e.key.slice("roster:".length))]);
  return Object.fromEntries(
    [...names].flatMap((role) => {
      const configured = store.lww<string[]>(`roster:${role}`)?.value;
      const builtIn = Boolean(ROLES[role]);
      // A role you made and then emptied is gone; a built-in one goes back to its defaults.
      if (!builtIn && !configured?.length) return [];
      const chore = CHORES[role];
      return [
        [
          role,
          {
            models: configured?.length ? configured : ROLES[role] ? setUp(store, ROLES[role].defaults) : [],
            configured: !!configured?.length,
            description: ROLES[role]?.description ?? chore ?? "a role you made",
            effort: pinnedEffort(store, role) ?? "auto",
            custom: !builtIn && !chore,
            forKnights: !chore && !NOT_FOR_KNIGHTS.has(role) && TeammateRole.safeParse(role).success,
          },
        ],
      ];
    }),
  );
}

export function parseRef(ref: string): { provider: string; model: string } {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) throw new Error(`model ref must be <provider>/<model>: ${ref}`);
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}

export const effortFor = (role: string | undefined): Effort => ROLES[role ?? "planner"]?.effort ?? "high";

/** The level you pinned a role's models to think at (roster.effort), whatever the step; null: by the step (`auto`). */
export function pinnedEffort(store: MindStore, role: string): Effort | null {
  const pinned = store.lww<string>(`effort:${role}`)?.value;
  return pinned && pinned !== "auto" ? (pinned as Effort) : null;
}
