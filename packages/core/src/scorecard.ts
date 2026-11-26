import { z } from "zod";

/*
 * The scorecard: what one benchmark suite measured in one run (`bun run bench`,
 * docs/BENCHMARKS.md). It is the contract between whatever measures (the suites
 * under bench/) and whatever reads (the report, CI's gate, and later Galahad
 * himself).
 *
 * Two kinds of metric, kept apart:
 *
 *  - "quality": exact and deterministic for a seed (whether replicas converged,
 *    how many events a replica wrongly refused, a search's recall). The same
 *    commit and seed give the same value, so any change is a real change, and
 *    one for the worse fails the run.
 *  - "speed": a timing or a rate, as measured on this machine: the median of `n`
 *    samples, with their spread. It is compared across machines by scaling with
 *    `machine.calibration` (the calibration kernel's score on one thread), never
 *    stored scaled: the file says what was measured.
 *
 * Read leniently (unknown fields are dropped), so a newer producer never makes
 * an older reader refuse a scorecard.
 */

export const ScoreMetric = z.object({
  /** Stable name, dotted: "fleet.n8.rounds". An id starting "full." is only measured by a `--full` run. */
  id: z.string().min(1).max(120).regex(/^[a-z0-9][a-z0-9._-]*$/),
  /**
   * As measured on this machine. A speed value is at the pace `machine.calibration` states: where the machine was
   * slower or faster than that while a sample was taken (other work, in bursts), the sample is brought to it.
   */
  value: z.number().refine(Number.isFinite, "a metric's value is a finite number"),
  unit: z.string().max(24),
  kind: z.enum(["quality", "speed"]),
  better: z.enum(["higher", "lower"]),
  /**
   * How much this number moves when nothing changed, in its own unit. Speed: the interquartile range of its
   * samples (for samples taken in one stretch, never less than the machine's own unsteadiness over it). Quality:
   * its resolution, when it has one (absent: exact); a difference within it isn't a change.
   */
  spread: z.number().min(0).refine(Number.isFinite).optional(),
  /** How many samples the value summarises. */
  n: z.number().int().min(1).optional(),
  note: z.string().max(300).optional(),
});
export type ScoreMetric = z.infer<typeof ScoreMetric>;

export const Scorecard = z
  .object({
    suite: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/),
    /** The revision measured (`git describe --always --dirty`). */
    commit: z.string().min(1).max(64),
    /** When the run ended (ms). */
    at: z.number().int().min(0),
    /** Every input was drawn from this: the same seed and commit give the same quality values. */
    seed: z.number().int().min(0).max(0xffff_ffff),
    machine: z.object({
      name: z.string().max(120),
      /**
       * The calibration kernel's score on one thread (packages/node/src/compute/bench.ts) while the suite ran: the
       * median of short windows taken all through it. Speed is compared between runs and machines by it.
       */
      calibration: z.number().positive().refine(Number.isFinite),
      cores: z.number().int().min(1),
    }),
    metrics: z.array(ScoreMetric).max(2000),
  })
  .refine((card) => new Set(card.metrics.map((m) => m.id)).size === card.metrics.length, "metric ids are unique within a scorecard");
export type Scorecard = z.infer<typeof Scorecard>;
