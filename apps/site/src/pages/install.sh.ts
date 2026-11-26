/*
 * /install.sh: scripts/install.sh exactly as the repository has it, written into the site when it is built. The Worker
 * hands it to `curl -fsSL https://invincible.sh | bash` (src/worker.ts); the page shows its SHA-256.
 */
import { INSTALLER } from "../lib/facts.ts";

export const prerender = true;

export function GET(): Response {
  return new Response(INSTALLER, { headers: { "content-type": "text/plain; charset=utf-8" } });
}
