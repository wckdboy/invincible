# Working on Invincible

## Every change that ships updates four places

When the project changes (a release, a feature, a status, a limit, the brand), update in the
same pass:

1. **The website.** invincible.sh, and autobot.sh where the Autobot CLI or the node features
   change. Source: [wckdboy/autobot-www](https://github.com/wckdboy/autobot-www) (`src/views/`,
   `src/data/`); refresh release data with `GITHUB_TOKEN=$(gh auth token) pnpm data && pnpm
   sync:install`, then `pnpm build:all` and `npx wrangler deploy --config deploy/<site>.wrangler.jsonc`.
2. **The GitHub README** of this repo (status, install, commands, limits).
3. **Plane.** The matching work items and their states in the Invincible project.
4. **The brand kit** if colors, symbols or wordmarks change: `brand/kit.json` in autobot-www is
   the source; copy the generated files into `assets/brand/` and update `BRAND.md`.

A release is not done until the site shows it, the README says it and Plane has it.

## Local services

The maintainer's own node runs as launchd services `sh.invincible.*` on ports 7777 and 7792,
with binaries in `~/.local/bin`. Test stacks use other ports and an isolated home; never stop or
overwrite those. When test-running `install.sh`, isolate `CARGO_HOME` and `RUSTUP_HOME`.
