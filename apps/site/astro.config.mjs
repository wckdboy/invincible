import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";

// invincible.sh: static pages only. The CSP allows no inline script or style, so nothing is inlined: every script and
// stylesheet is its own file. The pages read what they say from the repository when they are built (src/lib/facts.ts)
// and draw the agents with the app's own code (apps/web, and core's colours under the name the app imports them by), so
// nothing on them is a copy that drifts.
export default defineConfig({
  site: "https://invincible.sh",
  output: "static",
  trailingSlash: "ignore",
  build: { format: "directory", inlineStylesheets: "never" },
  devToolbar: { enabled: false },
  vite: {
    resolve: { alias: { "@invincible/core/avatar": fileURLToPath(new URL("../../packages/core/src/avatar.ts", import.meta.url)) } },
    build: { assetsInlineLimit: 0 },
    server: { fs: { allow: ["../.."] } },
  },
});
