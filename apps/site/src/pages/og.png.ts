/* /og.png: the picture a link to invincible.sh shows in a preview (src/lib/icons.ts). */
import { ogImage } from "../lib/icons.ts";

export const prerender = true;

export function GET(): Response {
  return new Response(ogImage(), { headers: { "content-type": "image/png" } });
}
