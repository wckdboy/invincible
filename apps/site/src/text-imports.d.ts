/** The files the site reads as text when it is built (Vite's `?raw`, src/lib/facts.ts), for the repository's typecheck.
 * (Each by its own pattern, so Astro's own `*?raw` stands beside them in the site's.) */
declare module "*.sh?raw" {
  const text: string;
  export default text;
}
declare module "*.md?raw" {
  const text: string;
  export default text;
}
declare module "*.json?raw" {
  const text: string;
  export default text;
}
declare module "*.yml?raw" {
  const text: string;
  export default text;
}
declare module "*.kts?raw" {
  const text: string;
  export default text;
}
declare module "*.xml?raw" {
  const text: string;
  export default text;
}
