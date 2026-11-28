/* /favicon.svg: the bare mark, its ink following the mode (src/lib/icons.ts). */
import { FAVICON_SVG } from "../lib/icons.ts";

export const prerender = true;

export function GET(): Response {
  return new Response(FAVICON_SVG, { headers: { "content-type": "image/svg+xml; charset=utf-8" } });
}
