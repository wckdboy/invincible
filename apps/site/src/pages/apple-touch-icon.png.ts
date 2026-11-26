/* /apple-touch-icon.png: the icon iOS takes for a page put on the Home Screen (src/lib/icons.ts). */
import { touchIcon } from "../lib/icons.ts";

export const prerender = true;

export function GET(): Response {
  return new Response(touchIcon(), { headers: { "content-type": "image/png" } });
}
