import { LIVE_BEAT_MS, type LiveEvent, type LiveTopic } from "@galahad/core/live";

/*
 * The node's live stream, kept open while the app is shown (core's live.ts): it says which of what the app shows
 * changed, and only that is read again. Two parts, neither touching the page, so both are tested with a clock in hand.
 *
 * liveLink keeps the stream open. One that ends is opened again at once if it had been open a while, otherwise a
 * second later, then twice as long each time, up to half a minute. One the node refuses (an older node without it, a
 * device that may not read it, a revoked one) is opened again only when told to: the app shown again, the network
 * back. One that says nothing at all for SILENT_MS (the node beats every LIVE_BEAT_MS) is taken for dead and opened
 * again.
 *
 * Followers are what the app reads, each for its topics. When the stream comes up, each whose last read began before
 * the stream said hello runs once (what it shows may be from before the node was telling of changes); one read since
 * can't have missed anything. Then each runs only when one of its topics changes. While the stream is down (no hello
 * within HELLO_WAIT_MS, or it can't be opened) each runs at once and then every so often, at its own interval, as the
 * app did before there was a stream. A follower runs one at a time: what comes meanwhile is merged into one more run
 * after it, and runs come no closer together than its gap.
 */

/** Runs `run` after `ms`; returns how to call it off. */
export type After = (ms: number, run: () => void) => () => void;

/** A stream that hasn't said hello this long after it was opened is down: what the app shows is asked for on a timer meanwhile. */
export const HELLO_WAIT_MS = 3_000;
/** Nothing at all on the stream for this long, its beats included: it is gone. */
export const SILENT_MS = 3 * LIVE_BEAT_MS;
/** Opening it again after a failure: first after this long, then twice as long each time, up to RETRY_MAX_MS. */
export const RETRY_FIRST_MS = 1_000;
export const RETRY_MAX_MS = 30_000;
/** A stream that was open at least this long is opened again at once when it ends (the node restarting, a device's scopes changed). */
export const STEADY_MS = 30_000;
/** Runs of one follower come no closer together than this, unless it says otherwise. */
export const GAP_MS = 500;

export interface LinkOptions {
  /** Opens the stream: its events as they come; `alive` is called on everything that arrives, its beats too. */
  open(signal: AbortSignal, alive: () => void): AsyncIterable<LiveEvent>;
  /** A failure that is the node's refusal: not tried again on a timer. */
  refused(error: unknown): boolean;
  after: After;
  now(): number;
}

/** Who hears where the stream stands. */
export interface LinkHandlers {
  /** It is open, since `at` (when it said hello), and tells of these topics: read now what was read before then. */
  up(topics: LiveTopic[], at: number): void;
  changed(topics: LiveTopic[]): void;
  /** It isn't open, and hasn't been for a while (or can't be): ask for what is shown on a timer until it is. */
  down(): void;
}

export interface LiveLink {
  /** Opens it, and keeps it open (the app is shown). */
  start(): void;
  /** Closes it, and opens it no more until started (the app hidden, or gone). */
  stop(): void;
  /** Opens it now if it isn't open, refused or not (the network is back). */
  retry(): void;
  /** Who is told from now on; they're told at once where it stands, if it is up or down. */
  attach(handlers: LinkHandlers): void;
  readonly up: boolean;
}

export function liveLink(o: LinkOptions): LiveLink {
  let handlers: LinkHandlers | null = null;
  let running = false;
  /** The stream being opened or open; null: none. */
  let current: AbortController | null = null;
  let isUp = false;
  /** When the open stream said hello. */
  let upAt = 0;
  let topics: LiveTopic[] = [];
  /** Down has been said since it was last up. */
  let saidDown = false;
  let delay = RETRY_FIRST_MS;
  let retrying: (() => void) | null = null;
  let downing: (() => void) | null = null;
  let silence: (() => void) | null = null;

  const off = (cancel: (() => void) | null): null => {
    cancel?.();
    return null;
  };
  const goUp = (told: LiveTopic[]) => {
    isUp = true;
    upAt = o.now();
    saidDown = false;
    downing = off(downing);
    topics = told;
    handlers?.up(told, upAt);
  };
  const goDown = () => {
    downing = off(downing);
    if (isUp || saidDown || !running) return;
    saidDown = true;
    handlers?.down();
  };
  const waitForHello = () => {
    downing = off(downing);
    if (!saidDown) downing = o.after(HELLO_WAIT_MS, goDown);
  };
  const watch = (controller: AbortController) => {
    silence = off(silence);
    silence = o.after(SILENT_MS, () => controller.abort());
  };

  function connect(): void {
    retrying = off(retrying);
    const controller = new AbortController();
    current = controller;
    let helloAt: number | null = null;
    watch(controller);
    waitForHello();
    void (async () => {
      let failure: unknown = null;
      try {
        const alive = () => {
          if (current === controller) watch(controller);
        };
        for await (const event of o.open(controller.signal, alive)) {
          if (current !== controller) break;
          if (event.type === "hello") {
            helloAt = o.now();
            goUp(Array.isArray(event.topics) ? event.topics : []);
          } else if (event.type === "changed") {
            if (isUp && Array.isArray(event.topics)) handlers?.changed(event.topics);
          } else if (event.type === "bye") break;
        }
      } catch (error) {
        failure = error;
      }
      // Closed on purpose (stopped), or another opened since: nothing more of this one.
      if (current !== controller) return;
      current = null;
      silence = off(silence);
      const was = isUp;
      isUp = false;
      controller.abort();
      if (failure !== null && !controller.signal.aborted) failure = null;
      if (failure !== null && o.refused(failure)) {
        goDown();
        return;
      }
      const steady = helloAt !== null && o.now() - helloAt >= STEADY_MS;
      const wait = steady ? 0 : delay;
      delay = steady ? RETRY_FIRST_MS : Math.min(delay * 2, RETRY_MAX_MS);
      // Up a moment ago: down only if it isn't up again soon. Never up: down now.
      if (was) waitForHello();
      else goDown();
      retrying = o.after(wait, connect);
    })();
  }

  return {
    start() {
      if (running) return;
      running = true;
      delay = RETRY_FIRST_MS;
      connect();
    },
    stop() {
      running = false;
      const was = current;
      current = null;
      was?.abort();
      retrying = off(retrying);
      downing = off(downing);
      silence = off(silence);
      isUp = false;
      saidDown = false;
    },
    retry() {
      if (!running || current) return;
      delay = RETRY_FIRST_MS;
      connect();
    },
    attach(next) {
      handlers = next;
      if (isUp) next.up(topics, upAt);
      else if (saidDown) next.down();
    },
    get up() {
      return isUp;
    },
  };
}

/** What a follower runs: `changed` names its topics that changed, or is null when everything is to be read. */
export type FollowerRun = (changed: readonly LiveTopic[] | null) => unknown;

/**
 * `run`, one at a time: what is asked for meanwhile is merged into one more run after it, never closer than `gapMs` to
 * the last (`last`: when it last ran before this, if it did).
 */
export function paced(run: FollowerRun, gapMs: number, after: After, now: () => number, last = -Infinity): { want(topics: readonly LiveTopic[] | null): void; cancel(): void } {
  let running = false;
  /** null: nothing; "all": everything; otherwise these. */
  let wanted: Set<LiveTopic> | "all" | null = null;
  let waiting: (() => void) | null = null;
  const go = (): void => {
    if (running || wanted === null || waiting) return;
    const wait = last + gapMs - now();
    if (wait > 0) {
      waiting = after(wait, () => {
        waiting = null;
        go();
      });
      return;
    }
    const changed = wanted === "all" ? null : [...wanted];
    wanted = null;
    running = true;
    last = now();
    void Promise.resolve()
      .then(() => run(changed))
      .catch(() => {})
      .finally(() => {
        running = false;
        go();
      });
  };
  return {
    want(topics) {
      wanted = topics === null || wanted === "all" ? "all" : new Set([...(wanted ?? []), ...topics]);
      go();
    },
    cancel() {
      wanted = null;
      waiting?.();
      waiting = null;
    },
  };
}

interface Follower {
  topics: ReadonlySet<LiveTopic>;
  pace: ReturnType<typeof paced>;
  /** null: it keeps its own time while the stream is down. */
  everyMs: number | null;
  timer: (() => void) | null;
  /** When what it shows was last read (its owner's read, then each run's start); -Infinity: never. */
  since: number;
}

/**
 * Who reads first: "owner", whoever follows has just read what it shows (the way of the views); "later", nothing is
 * read yet, and the stream's coming up (or down) reads it.
 */
export type FirstRead = "owner" | "later";

/** What the app reads, each for its topics, as the stream stands (above). */
export class Followers {
  private readonly all = new Set<Follower>();
  private mode: "off" | "up" | "down" = "off";

  constructor(
    private readonly after: After,
    private readonly now: () => number,
  ) {}

  /**
   * `run` when one of these topics changes while the stream is up (and once when it comes up, if what it shows was
   * read before); at once and then every `everyMs` while it is down (null: once, and it keeps its own time from there);
   * never while the app is hidden. Not now: whoever follows has read what it shows itself (`first`), or it is read when
   * the stream comes up or goes down. Returns how to stop following.
   */
  follow(topics: readonly LiveTopic[], run: FollowerRun, everyMs: number | null, gapMs = GAP_MS, first: FirstRead = "owner"): () => void {
    const read = first === "owner" ? this.now() : -Infinity;
    const follower: Follower = {
      topics: new Set(topics),
      pace: paced(
        (changed) => {
          follower.since = this.now();
          return run(changed);
        },
        gapMs,
        this.after,
        this.now,
        read,
      ),
      everyMs,
      timer: null,
      since: read,
    };
    this.all.add(follower);
    if (this.mode === "down") this.poll(follower);
    return () => {
      this.all.delete(follower);
      follower.timer?.();
      follower.timer = null;
      follower.pace.cancel();
    };
  }

  /** The stream is up, since `at`: each that last read before then runs once now; then each runs when its topics change. */
  up(at: number): void {
    this.mode = "up";
    for (const follower of this.all) {
      follower.timer?.();
      follower.timer = null;
      if (follower.since < at) follower.pace.want(null);
    }
  }

  changed(topics: readonly LiveTopic[]): void {
    if (this.mode !== "up") return;
    for (const follower of this.all) {
      const mine = topics.filter((topic) => follower.topics.has(topic));
      if (mine.length) follower.pace.want(mine);
    }
  }

  /** The stream is down: each runs now, then every so often. */
  down(): void {
    this.mode = "down";
    for (const follower of this.all) {
      follower.pace.want(null);
      this.poll(follower);
    }
  }

  /** Nothing runs: the app is hidden. */
  off(): void {
    this.mode = "off";
    for (const follower of this.all) {
      follower.timer?.();
      follower.timer = null;
      follower.pace.cancel();
    }
  }

  private poll(follower: Follower): void {
    follower.timer?.();
    follower.timer = null;
    const every = follower.everyMs;
    if (every === null) return;
    const tick = () => {
      follower.pace.want(null);
      follower.timer = this.after(every, tick);
    };
    follower.timer = this.after(every, tick);
  }
}
