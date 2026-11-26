import { z } from "zod";

/**
 * Environment, validated once at startup (the t3-env idea): a typo'd or
 * malformed variable fails loudly here instead of misbehaving later.
 */
const Env = z.object({
  INVINCIBLE_HOME: z.string().min(1).optional(),
  INVINCIBLE_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  /** Loopback port for `tailscale serve` (the HTTPS PWA); defaults to INVINCIBLE_PORT + 1. */
  INVINCIBLE_PROXY_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  /** "os" = OS keychain via Bun.secrets (default), "file" = 0600 key file (headless servers). */
  INVINCIBLE_KEYSTORE: z.enum(["os", "file"]).optional(),
  /** Override the tailnet address this node advertises and binds, e.g. 100.64.0.1 (Tailscale gives each machine one in 100.64.0.0/10). */
  INVINCIBLE_ADVERTISE: z.string().min(1).optional(),
  /** The sandbox workspace helper's socket (default /run/invincible-workspace.sock). */
  INVINCIBLE_WORKSPACE_SOCKET: z.string().startsWith("/").optional(),
  /** Where the archive keeps its files (default <home>/archive); an absolute path the node's user may write. */
  INVINCIBLE_ARCHIVE_DIR: z
    .string()
    .refine((p) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p), "an absolute path")
    .optional(),
  /** Where the node keeps its daily backups, and the doctor looks at their age (default: `backups` beside the node's home where one is, else in it). */
  INVINCIBLE_BACKUP_DIR: z
    .string()
    .refine((p) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p), "an absolute path")
    .optional(),
  /** "off": the node keeps no daily backups of its databases (backups.ts). */
  INVINCIBLE_BACKUPS: z.enum(["on", "off"]).optional(),
  /**
   * Notifications. Who operates this node, as push services are told (RFC 8292's contact: a mailto: or https: address;
   * default: one that names nobody). And push services to allow beyond Apple, Google, Mozilla, Microsoft and ntfy.sh: host
   * names, comma-separated ("push.example.org,*.push.example.org"); always https.
   */
  INVINCIBLE_PUSH_CONTACT: z
    .string()
    .max(200)
    .regex(/^(mailto:[^\s@<>]+@[^\s@<>]+|https:\/\/[^\s<>]+)$/, "a mailto: or https: address")
    .optional(),
  INVINCIBLE_PUSH_HOSTS: z
    .string()
    .max(1000)
    .regex(/^(\*\.)?[A-Za-z0-9.-]+(,(\*\.)?[A-Za-z0-9.-]+)*$/, "host names, comma-separated")
    .optional(),
  /** off: the archive keeps what it has and serves it, but pulls, embeds and summarises nothing new. */
  INVINCIBLE_ARCHIVE: z.enum(["on", "off"]).optional(),
  /** Q-AMP's binary, where it isn't the node's own copy (<home>/bin/qamp, scripts/qamp-pin.sh): an absolute path. Tests use it. */
  INVINCIBLE_QAMP_BIN: z
    .string()
    .refine((p) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p), "an absolute path")
    .optional(),
  /**
   * off: this node runs no Q-AMP sidecar, whatever its own setting says (`invincible fabric`, off by default), and every
   * link to another node goes over HTTPS with signed requests (docs/FABRIC.md). on: as its setting says.
   */
  INVINCIBLE_QAMP: z.enum(["on", "off"]).optional(),
  /** The UDP port its sidecar listens on, on its advertised address (default 7410: docs/ARCHITECTURE.md §9). */
  INVINCIBLE_QAMP_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  /** Its sidecar's socket, where <home>/run/qamp.sock is too long a path for a Unix socket: an absolute path. */
  INVINCIBLE_QAMP_SOCKET: z.string().startsWith("/").max(103).optional(),
  /** Chat turns this node runs at once (default 4), and how long one may run, in minutes (default 30). */
  INVINCIBLE_TURNS_MAX: z.coerce.number().int().min(1).max(64).optional(),
  INVINCIBLE_TURN_MINUTES: z.coerce.number().min(1).max(720).optional(),
});

export type Env = z.infer<typeof Env>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = Env.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`invalid Invincible environment:\n${issues}`);
  }
  return parsed.data;
}
