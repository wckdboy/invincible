/*
 * The installer's steps as the page tells them: each of scripts/install.sh's sections, by its own heading, with a line
 * of what it does in plain words. The headings are read from the script (read.ts); the lines are the page's, and each is
 * held to its heading: a section added, renamed or dropped in the script fails the build until the page says it too.
 * `code` in a line is set as code.
 */
import type { Installer } from "./read.ts";

const at = (installer: Installer, variable: string): string => {
  const place = installer.places.find((p) => p.variable === variable);
  if (!place) throw new Error(`the installer's header doesn't say where ${variable} is`);
  return place.path;
};

/** What each section does, by its heading. */
const LINES: Record<string, (installer: Installer, bun: string) => string> = {
  "Which Invincible: a commit, so a release is exactly one": (i) =>
    `The newest commit on \`${i.ref}\` of ${i.repo}, or the branch, tag or commit you name with \`--ref\`: what it installs is exactly one commit.`,
  "The release": (i) => `That commit's source, in \`${at(i, "INVINCIBLE_INSTALL_DIR")}/releases\`. The one before it stays, to go back to.`,
  "Bun, Invincible's own: pinned, checksum-verified, never over a Bun of yours": (i, bun) =>
    `Bun ${bun}, checked against its SHA-256, in Invincible's own folder; then its dependencies, from the lockfile. A Bun of yours is left alone.`,
  "The invincible command": (i) => `\`invincible\`, and \`inv\` for short, in \`${at(i, "INVINCIBLE_BIN_DIR")}\`.`,
  "This node: founded, or joined to your fleet (once; an update keeps it)": (i) =>
    `\`invincible init\` makes this machine your fleet's first node, its home in \`${at(i, "INVINCIBLE_HOME")}\`; with \`--join\` and an invite it joins your fleet instead. A machine that is a node already is kept as it is.`,
  "Kept running": () => "A service of yours keeps the node running, and serving the web app: launchd on a Mac, systemd on Linux.",
  "Reachable from your phone, and paired": () => "Where Tailscale runs, `invincible expose` puts the app on your tailnet; then a code on screen pairs your phone.",
};

/** The installer's steps, in its order, each with its heading and its line. */
export function installSteps(installer: Installer, bun: string): { heading: string; line: string }[] {
  const unsaid = installer.steps.filter((heading) => !(heading in LINES));
  const gone = Object.keys(LINES).filter((heading) => !installer.steps.includes(heading));
  if (unsaid.length || gone.length) {
    throw new Error(`the page's steps no longer match scripts/install.sh's sections (src/lib/install-steps.ts): ${[...unsaid.map((h) => `new: "${h}"`), ...gone.map((h) => `gone: "${h}"`)].join("; ")}`);
  }
  return installer.steps.map((heading) => ({ heading, line: LINES[heading]!(installer, bun) }));
}

/** A line's parts, its `code` apart, for the page to set. */
export function parts(line: string): { text: string; code: boolean }[] {
  return line.split(/(`[^`]+`)/).filter(Boolean).map((part) => (part.startsWith("`") ? { text: part.slice(1, -1), code: true } : { text: part, code: false }));
}
