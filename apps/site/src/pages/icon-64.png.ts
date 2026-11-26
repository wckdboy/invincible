/* /icon-64.png: the favicon for a browser that takes no SVG icon (src/lib/icons.ts). */
import { icon64 } from "../lib/icons.ts";

export const prerender = true;

export function GET(): Response {
  return new Response(icon64(), { headers: { "content-type": "image/png" } });
}
