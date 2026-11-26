# invincible.sh

The project's site: what Invincible is, the one line that installs it, and the apps. Astro's static pages and one small
Cloudflare Worker. It is its own project with its own lockfile, so an install of Invincible never brings its tools.

```sh
bun install
bun run check        # built (dist/), what it would serve checked (scripts/check.ts), then its tests
bun run preview      # built, and served by wrangler dev at http://127.0.0.1:8787, as Cloudflare would serve it
bun scripts/measure.ts --shots <dir>   # against the preview: first load, weight, and screenshots at 390 and 1440 px
```

## What it serves

| Path | What |
|---|---|
| `/` | The page, to a browser. To `curl` and `wget` (`curl -fsSL https://invincible.sh \| bash`), the installer: `src/worker.ts`, the one path besides `/install` that runs the Worker |
| `/install`, `/install.sh` | `scripts/install.sh`, exactly as the repository has it (the page shows its SHA-256, and the check fails if they differ) |
| `/mac/appcast.xml` | The Mac app's update feed, written by `apps/apple/scripts/mac-release.sh` with each release: an empty channel until the first |
| `/android/latest.json` | The Android app's newest build, written by `apps/android/scripts/publish.sh`, read by the app for updates: `{}` until the first |
| `/orbs/*.svg` | The agents' orbs, named by their content |
| `/favicon.svg`, `/icon-64.png`, `/apple-touch-icon.png`, `/og.png` | The mark, as a tab, a Home Screen and a link's preview show it |

## Where what it says comes from

Every fact on the page is read from this repository when the site is built (`src/lib/facts.ts`, through the readers in
`src/lib/read.ts`), never typed out again: the install line, the installer's steps (its own section headings; the page's
line for each is in `src/lib/install-steps.ts`, and a section added or renamed fails the build until it has one), its
options, where it puts things and its SHA-256, the Bun it pins, the apps' versions and requirements (`apps/apple/project.yml`,
Android's `build.gradle.kts`, the feeds), the plan's phases (`docs/PLAN.md`), the README's own line, the licence and the
commit. A file that doesn't say what the page needs fails the build, rather than a page that says something else.

The iPhone and iPad app is in TestFlight by invitation. When Apple has reviewed a build for testers outside the team, its
public link (`https://testflight.apple.com/join/…`) goes in `IPHONE.testflight` in `src/lib/facts.ts`, and the card
becomes a button to it.

## The look

Invincible's, by the owner's word of 26 November 2026: monochrome, black, white and greys, bold type, calm. Your agent is
the I-beam in one ink; the agents' orbs are the only colour, each its own, so they are told apart at a glance; red is
kept for a real failure. Nothing moves.

- **The mark** is in one place, `src/lib/mark.ts`: `Mark.astro` draws it in the ink of the words around it, and the
  icons are rasterized from it when the site is built (`src/lib/icons.ts`). A test holds it there. When the mark comes to
  `scripts/brand.ts`, `mark.ts` reads it from there, and nothing else changes.
- **The agents' orbs** are the app's own drawing: `apps/web/src/ui/orb.ts`' `paintField`, run when the site is built
  onto a 2D context that writes SVG (`src/lib/field-svg.ts`), as light for a dark page and as ink for a light one. A page
  fetches only its theme's (`<picture>`).
- **Type** is Geist, the app's own file (`apps/web/src/fonts/geist.woff2`), `font-display: optional`, preloaded.
- **Its weight** is held to a budget by the check: what a first visit fetches, as brotli (`BUDGET` in
  `scripts/check.ts`).

## Safety

A strict Content-Security-Policy (`public/_headers`): no inline script or style, nothing from elsewhere. The orbs are
the one exception, and a narrow one: a dark page's orb adds its light with one inline style (`mix-blend-mode`, which SVG
has no attribute for), so `/orbs/*` is served with a policy that allows inline style and nothing else; the check fails
on an orb that could run or fetch anything. It also fails on anything private in what the site serves (a tailnet's name
or address, a private address, an email address, a path on the machine that built it); the owner's own list is the
forge's secret sweep, in CI.

## Deploying

Nothing deploys from a checkout. CI's `deploy-site` job does, on GitHub alone, on a push to main, after every job that
runs there has passed, and only with the `CLOUDFLARE_API_TOKEN` secret set (scoped to this Worker; its account in
`CLOUDFLARE_ACCOUNT_ID` beside it). Without the token it says so and does nothing. Until that secret is set, a release
of the site is deployed by hand from a clean checkout of main (`bun run deploy` here, with the owner's `wrangler` login),
as it first was on 26 November 2026, on the owner's word ("Also update the webpage invincible.sh", then "Yes deploy").
The Worker is `invincible-site`, on `invincible.sh` alone: `www.invincible.sh` belongs to the account's www-redirect
Worker, which sends it on here (301). Cloudflare keeps each version, so `wrangler rollback` puts the last one back.
