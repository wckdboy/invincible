/*
 * /orbs/<file>.svg: the agents' orbs (src/lib/orbs.ts), drawn by the app's own code when the site is built.
 */
import { orbFiles } from "../../lib/orbs.ts";

export const prerender = true;

export function getStaticPaths(): { params: { file: string }; props: { svg: string } }[] {
  return orbFiles().map(({ href, svg }) => ({ params: { file: href.replace(/^\/orbs\//, "") }, props: { svg } }));
}

export function GET({ props }: { props: { svg: string } }): Response {
  return new Response(props.svg, { headers: { "content-type": "image/svg+xml; charset=utf-8" } });
}
