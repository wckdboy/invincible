import { z } from "zod";

/**
 * Environment, validated once at startup (the t3-env idea): a typo'd or
 * malformed variable fails loudly here instead of misbehaving later.
 */
const Env = z.object({
  GALAHAD_HOME: z.string().min(1).optional(),
  GALAHAD_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  /** Loopback port for `tailscale serve` (the HTTPS PWA); defaults to GALAHAD_PORT + 1. */
  GALAHAD_PROXY_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  /** "os" = OS keychain via Bun.secrets (default), "file" = 0600 key file (headless servers). */
  GALAHAD_KEYSTORE: z.enum(["os", "file"]).optional(),
  /** Override the tailnet address this node advertises and binds, e.g. 100.64.0.1 (Tailscale gives each machine one in 100.64.0.0/10). */
  GALAHAD_ADVERTISE: z.string().min(1).optional(),
  /** The sandbox workspace helper's socket (default /run/galahad-workspace.sock). */
  GALAHAD_WORKSPACE_SOCKET: z.string().startsWith("/").optional(),
  /** Where the archive keeps its files (default <home>/archive); an absolute path the node's user may write. */
  GALAHAD_ARCHIVE_DIR: z
    .string()
    .refine((p) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p), "an absolute path")
    .optional(),
  /** Where the node keeps its daily backups, and the doctor looks at their age (default: `backups` beside the node's home where one is, else in it). */
  GALAHAD_BACKUP_DIR: z
    .string()
    .refine((p) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p), "an absolute path")
    .optional(),
  /** "off": the node keeps no daily backups of its databases (backups.ts). */
  GALAHAD_BACKUPS: z.enum(["on", "off"]).optional(),
  /**
   * Notifications. Who operates this node, as push services are told (RFC 8292's contact: a mailto: or https: address;
   * default: one that names nobody). And push services to allow beyond Apple, Google, Mozilla, Microsoft and ntfy.sh: host
   * names, comma-separated ("push.example.org,*.push.example.org"); always https.
   */
  GALAHAD_PUSH_CONTACT: z
    .string()
    .max(200)
    .regex(/^(mailto:[^\s@<>]+@[^\s@<>]+|https:\/\/[^\s<>]+)$/, "a mailto: or https: address")
    .optional(),
  GALAHAD_PUSH_HOSTS: z
    .string()
    .max(1000)
    .regex(/^(\*\.)?[A-Za-z0-9.-]+(,(\*\.)?[A-Za-z0-9.-]+)*$/, "host names, comma-separated")
    .optional(),
  /** off: the archive keeps what it has and serves it, but pulls, embeds and summarises nothing new. */
  GALAHAD_ARCHIVE: z.enum(["on", "off"]).optional(),
  /** Q-AMP's binary, where it isn't the node's own copy (<home>/bin/qamp, scripts/qamp-pin.sh): an absolute path. Tests use it. */
  GALAHAD_QAMP_BIN: z
    .string()
    .refine((p) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p), "an absolute path")
    .optional(),
  /** Chat turns this node runs at once (default 4), and how long one may run, in minutes (default 30). */
  GALAHAD_TURNS_MAX: z.coerce.number().int().min(1).max(64).optional(),
  GALAHAD_TURN_MINUTES: z.coerce.number().min(1).max(720).optional(),
});

export type Env = z.infer<typeof Env>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = Env.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`invalid Galahad environment:\n${issues}`);
  }
  return parsed.data;
}
