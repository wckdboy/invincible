import type { Scope } from "@galahad/core";

/*
 * Response shapes the PWA codes against that are not (yet) in @galahad/core's
 * contract: the ledger and sandboxes are being built alongside this UI. Views
 * using them degrade gracefully when the node answers 404 or 424.
 */

/** "sandbox" joins the core scope list with the sandbox backend. */
export type AnyScope = Scope | "sandbox";

export interface WhoAmI {
  device: string;
  kind: string;
  scopes: AnyScope[];
  node: string;
  nodeName: string;
  fleet: string;
  fleetName: string | null;
}

export interface PresetView {
  id: string;
  kind: "openai" | "anthropic";
  baseUrl: string;
  keyPrefixes?: string[];
  local?: boolean;
  note?: string;
  /** A coding plan: a subscription whose key is for coding and answers nothing else; who may use it is what its vendor's terms allow. */
  plan?: { name: string; says: string; terms: string; models: string[]; allows: { native: boolean; tools: "unattended" | "interactive" } };
}

export interface RoleSpec {
  models: string[];
  configured: boolean;
  description: string;
  /** A role you made: yours to remove (absent from an older node). */
  custom?: boolean;
  /** A knight may work on it: the planner, engineer and swift roles and yours (absent from an older node). */
  forKnights?: boolean;
  /** How hard its models think: `auto`, by the step, or a level you pinned it to (absent from an older node). */
  effort?: "auto" | "low" | "medium" | "high" | "xhigh" | "max";
}

export type ActionClass = "read" | "create" | "modify" | "outward" | "delete" | "forbidden";
export type Verdict = "allow" | "ask" | "deny" | "approved";

export interface LedgerEntry {
  id: string;
  hlc: string;
  device: string;
  class: ActionClass;
  resource: string;
  target: string;
  verdict: Verdict;
  reason: string | null;
  quest: string | null;
  detail: string | null;
}

export type NetworkMode = "isolated" | "gateway" | "online";

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
}

export interface PlacementResult {
  ranked: { device: string; name: string; score: number; reasons: string[] }[];
  rejected: { device: string; name: string; reason: string }[];
}

export interface InviteResponse {
  invite: string;
  url: string | null;
  expiresAt: number;
  id: string;
}

/** The node's capability profile as published in the mind (see packages/node/src/capabilities.ts). */
export interface Caps {
  os?: string;
  arch?: string;
  hostname?: string;
  cores?: number;
  cpu?: string;
  memoryGb?: number;
  hasBattery?: boolean;
  gpu?: { name: string; memoryGb: number | null }[];
  docker?: boolean;
  vm?: { kvm: boolean; tools: string[] };
  tools?: string[];
  localModels?: { runtime: string; models: string[] }[];
  /**
   * Present when it can host sandboxes; vm: it can run them as KVM microVMs (Kata). On a Mac with Apple's container:
   * engine "container", every sandbox a VM, `cannot` what it won't make (an isolated sandbox, the desktop, the Lab,
   * Gazebo), and `grows: false` (a running VM pauses to take more).
   */
  sandbox?: { image: boolean; networks: boolean; vm?: boolean; engine?: "container"; cannot?: string[]; grows?: false } | null;
  /** Apple's container, where a Mac has it: its version, and whether its service answers. */
  container?: { version: string | null; running: boolean };
}

export const asCaps = (value: Record<string, unknown> | null): Caps | null => value as Caps | null;
