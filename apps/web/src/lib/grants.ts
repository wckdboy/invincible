import { relativeTime } from "./time.ts";

/*
 * Q-AMP grants as the app shows them (packages/node/src/qamp-grants.ts): an agent on another of your machines, its key,
 * its tools, and when it ends. Pure, so it's unit-tested; the app makes no grant itself (that stays at a terminal).
 */

/** A grant's arm, by its label: core's QAMP_ARM_PREFIX (grants.test.ts holds the two the same). */
export const isGrantArm = (label: string): boolean => label.startsWith("qamp.");

/** An agent's key, short enough for a row: its kind and the last of it ("did:key:z6Mk…pjyBW"); the whole of it goes in a title. */
export const shortDid = (did: string): string => (did.length > 26 ? `${did.slice(0, 12)}…${did.slice(-6)}` : did);

/** When a grant ends, as its row says it: "ends in 52 min"; one whose time is up, which the node ends within seconds: "ending now". */
export const grantEnds = (endsAt: number, now = Date.now()): string => (endsAt <= now ? "ending now" : `ends ${relativeTime(endsAt, now)}`);
