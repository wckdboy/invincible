import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Suite } from "../lib.ts";

/*
 * What moves on the PWA's screens once they are there. apps/web/measure/first-load.ts --shifts opens every place (and
 * Galahad's, a knight's and a room's timeline) in a headless Chrome paired with a throwaway node that holds the same
 * stand-in fleet every time (knights, a room, tasks running, verified and given up, trials, a kept chat, a key he asked
 * for), as a returning visit opens it, on a laptop's screen and a phone's, and sums every layout shift from its first
 * frame until 3 s after it is usable: the place's cumulative layout shift. Nothing touches the page meanwhile.
 *
 * The same app and the same stand-in data move the same way every time: a place that holds still reads exactly 0. Each
 * place is a metric, ×10,000 and rounded, and judged to 5 (0.0005, less than anything one can see): a place that starts
 * to move fails the run. One that already moves is judged within 15 % of its score, because its text can wrap otherwise
 * on another platform's fonts. It needs Chrome (CHROME, or Chrome or Chromium where it usually is), and takes a few
 * minutes: most of it is the node's stand-in fleet getting its work done.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

interface Shifted {
  scores: number[];
  max: number;
  moved: { what: string; score: number }[];
}

export const suite: Suite = {
  name: "web",
  about: "the PWA's places on a laptop and a phone: how far what's on screen moves once it is there (layout shift)",
  headline: ["web.still"],
  async run(ctx) {
    const dir = mkdtempSync(join(tmpdir(), "galahad-bench-web-"));
    try {
      const out = join(dir, "shifts.json");
      const measure = Bun.spawn(["bun", join(ROOT, "apps/web/measure/first-load.ts"), "--runs", "0", "--shifts", "--shift-runs", "1", "--json", out], {
        cwd: ROOT,
        env: { ...process.env, GALAHAD_KEYSTORE: "file" },
        stdout: "ignore",
        stderr: "pipe",
      });
      const said = await new Response(measure.stderr).text();
      if ((await measure.exited) !== 0) throw new Error(`the measurement failed:\n${said.trim().split("\n").slice(-8).join("\n")}`);
      const { shifts } = JSON.parse(readFileSync(out, "utf8")) as { shifts: Record<string, Record<string, Shifted>> };
      let still = 0;
      let watched = 0;
      for (const [place, profiles] of Object.entries(shifts)) {
        for (const [profile, shifted] of Object.entries(profiles)) {
          const score = Math.round(shifted.max * 10_000);
          watched++;
          if (score < 5) still++;
          const what = shifted.moved[0] ? `; what moved most: ${shifted.moved[0].what}` : "";
          ctx.quality(`web.${place}.${profile}`, score, "", "lower", {
            resolution: Math.max(5, Math.round(score * 0.15)),
            note: `${place} on a ${profile}'s screen: its cumulative layout shift ×10,000, from its first frame until 3 s after it is usable (0: nothing moved)${what}`,
          });
        }
      }
      ctx.quality("web.still", still, "places", "higher", { note: `of ${watched} (each place on a laptop's screen and a phone's): those where nothing moved once it was on screen` });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};
