import { describe, expect, test } from "bun:test";
import { decide, retriedRuns, SELF_ACTION_KINDS, SELF_ACTION_QUEST, SELF_ACTION_RESOURCE, SELF_ACTIONS, SelfAction, selfActionTarget } from "@galahad/core";
import { OFFLINE_AFTER_MS } from "../src/heartbeat.ts";
import { type LedgerWrite, MAX_SELF_ACTIONS, planSelfActions, RETRY_WITHIN_MS, runSelfAction, selfAct, SelfActionRefused, type SelfActionHands, type SelfSnapshot } from "../src/self-action.ts";

/*
 * Self-action: after each heartbeat Galahad fixes what's on the allowlist himself, and
 * nothing else. Each kind is tested for when it's called for and when it isn't; the
 * allowlist refuses everything outside it; each fix is harmless or reversible and goes
 * through the node's own gate; and every one is in the ledger as his own.
 */

const NOW = Date.parse("2026-11-11T12:00:00Z");
const MIN = 60_000;

const calm = (over: Partial<SelfSnapshot> = {}): SelfSnapshot => ({ now: NOW, sandboxes: [], loops: [], retried: [], ...over });
const overdue = (id: string, extra: Partial<{ ephemeral: boolean; expiresAt: number; quest: string }> = {}) => ({ id, expiresAt: NOW - OFFLINE_AFTER_MS - MIN, ephemeral: true, quest: "q-abc", ...extra });
const failedOnce = (name = "site", extra: Partial<SelfSnapshot["loops"][number]> = {}) => ({
  name,
  readOnly: true,
  running: false,
  recent: [
    { run: "s1", status: "failed", finished: NOW - 10 * MIN },
    { run: "s0", status: "ok", finished: NOW - 40 * MIN },
  ],
  ...extra,
});

/** Hands that only record what they were asked to do; the reaper goes through the real oath gate. */
function hands() {
  const did: string[] = [];
  const h: SelfActionHands = {
    reap: async (sandbox, quest) => {
      did.push(`reap ${sandbox} for ${quest}`);
      return decide({ class: "delete", resource: "docker.container", target: sandbox, createdBy: { quest, ephemeral: true }, quest });
    },
    retry: (loop) => void did.push(`retry ${loop}`),
  };
  return { did, h };
}

describe("what the plan calls for", () => {
  test("nothing, when all is well", () => {
    expect(planSelfActions(calm())).toEqual([]);
  });

  test("a sandbox the reaper missed: ephemeral and past its expiry by the heartbeat's grace; never a persistent one", () => {
    const plan = planSelfActions(
      calm({
        sandboxes: [
          overdue("a000000001"),
          overdue("a000000002", { ephemeral: false }),
          overdue("a000000003", { expiresAt: NOW - OFFLINE_AFTER_MS + MIN }),
          overdue("a000000004", { expiresAt: NOW + 60 * MIN }),
        ],
      }),
    );
    expect(plan).toEqual([{ kind: "reap-sandbox", sandbox: "a000000001" }]);
  });

  test("a loop that went wrong once runs again once: only one that only reads, isn't running, and went wrong lately", () => {
    expect(planSelfActions(calm({ loops: [failedOnce()] }))).toEqual([{ kind: "retry-loop", loop: "site", after: "s1" }]);
    // Not three times, not even twice: two failures in a row are yours.
    expect(planSelfActions(calm({ loops: [failedOnce("site", { recent: [{ run: "m2", status: "failed", finished: NOW - MIN }, { run: "s1", status: "failed", finished: NOW - 10 * MIN }] })] }))).toEqual([]);
    // A loop that does more than read (a quest, an outward call) is never run again on his own.
    expect(planSelfActions(calm({ loops: [failedOnce("quest", { readOnly: false })] }))).toEqual([]);
    expect(planSelfActions(calm({ loops: [failedOnce("site", { running: true })] }))).toEqual([]);
    // The same failed run is never retried twice.
    expect(planSelfActions(calm({ loops: [failedOnce()], retried: ["s1"] }))).toEqual([]);
    // Old news waits for its next scheduled run.
    expect(planSelfActions(calm({ loops: [failedOnce("site", { recent: [{ run: "s1", status: "failed", finished: NOW - RETRY_WITHIN_MS - 1 }] })] }))).toEqual([]);
    // A first run that failed counts as failing once.
    expect(planSelfActions(calm({ loops: [failedOnce("new", { recent: [{ run: "s9", status: "failed", finished: NOW - MIN }] })] }))).toEqual([{ kind: "retry-loop", loop: "new", after: "s9" }]);
    // An error answer from its service counts as a bad run; an interrupted one doesn't (it's never rerun).
    expect(planSelfActions(calm({ loops: [failedOnce("site", { recent: [{ run: "s1", status: "attention", finished: NOW - MIN }] })] }))).toEqual([{ kind: "retry-loop", loop: "site", after: "s1" }]);
    expect(planSelfActions(calm({ loops: [failedOnce("site", { recent: [{ run: "s2", status: "attention", finished: NOW - MIN }, { run: "s1", status: "failed", finished: NOW - 9 * MIN }] })] }))).toEqual([]);
    expect(planSelfActions(calm({ loops: [failedOnce("site", { recent: [{ run: "s1", status: "interrupted", finished: NOW - MIN }] })] }))).toEqual([]);
  });

  test("at most a handful after one heartbeat", () => {
    const many = Array.from({ length: 20 }, (_, i) => overdue(`b${String(i).padStart(9, "0")}`));
    expect(planSelfActions(calm({ sandboxes: many }))).toHaveLength(MAX_SELF_ACTIONS);
  });
});

describe("the allowlist", () => {
  test("is exactly four kinds, none outward, none needing you", () => {
    expect(SELF_ACTION_KINDS.sort()).toEqual(["adapt-compute", "calibrate", "reap-sandbox", "retry-loop"]);
    for (const kind of SELF_ACTION_KINDS) expect(["read", "create", "modify", "delete"]).toContain(SELF_ACTIONS[kind].class);
    // The only delete is the oath's own exception: an ephemeral sandbox, on behalf of its quest.
    expect(SELF_ACTION_KINDS.filter((k) => SELF_ACTIONS[k].class === "delete")).toEqual(["reap-sandbox"]);
  });

  test("refuses everything else: other kinds, extra fields, other targets", async () => {
    const { did, h } = hands();
    const ledger: LedgerWrite[] = [];
    const fresh = calm({ sandboxes: [overdue("a000000001")], loops: [failedOnce()] });
    const outside = [
      { kind: "dismiss-notice", key: "node-offline:n_x" },
      { kind: "revoke-device", device: "n_x" },
      { kind: "set-secret", name: "github", value: "x" },
      { kind: "call-connector", connector: "github", tool: "issue.create" },
      { kind: "approve-action", id: "a_x" },
      { kind: "set-roster", role: "planner" },
      { kind: "destroy-sandbox", sandbox: "a000000001", persistent: true },
      { kind: "reap-sandbox", sandbox: "a000000001", approvedBy: "owner" },
      { kind: "reap-sandbox", sandbox: "../../etc" },
      { kind: "retry-loop", loop: "site", after: "s1", task: { kind: "quest" } },
      // A kind the allowlist once had (the removed world's weather) is refused like any other.
      { kind: "refresh-weather" },
      // Compute: he measures and re-derives; he never acquires, installs, downloads, hires or raises his own ceiling.
      { kind: "rent-gpu", provider: "anywhere", hours: 1 },
      { kind: "provision-node", cloud: "any" },
      { kind: "pull-model", runtime: "ollama", model: "qwen3:8b" },
      { kind: "install-runtime", node: "n_x" },
      { kind: "set-compute-limit", node: "n_x", cores: 32 },
      { kind: "calibrate", why: "joined", node: "n_other" },
      { kind: "calibrate", why: "because" },
      { kind: "adapt-compute", plan: { effort: 3 } },
      "reap-sandbox",
      null,
    ];
    for (const raw of outside) {
      expect(SelfAction.safeParse(raw).success).toBe(false);
      await expect(runSelfAction(raw, fresh, h, (e) => void ledger.push(e))).rejects.toBeInstanceOf(SelfActionRefused);
    }
    expect(did).toEqual([]);
    expect(ledger).toEqual([]);
  });

  test("an allowlisted kind runs only when the fresh state calls for exactly it", async () => {
    const { did, h } = hands();
    const ledger: LedgerWrite[] = [];
    const fresh = calm({ sandboxes: [overdue("a000000001"), overdue("a000000002", { ephemeral: false })], loops: [failedOnce("site"), failedOnce("quest", { readOnly: false })] });
    // A persistent sandbox, a sandbox that isn't there, a loop that does more than read, a run that isn't its latest.
    for (const action of [
      { kind: "reap-sandbox", sandbox: "a000000002" },
      { kind: "reap-sandbox", sandbox: "a00000000f" },
      { kind: "retry-loop", loop: "quest", after: "s1" },
      { kind: "retry-loop", loop: "site", after: "s0" },
    ]) {
      await expect(runSelfAction(action, fresh, h, (e) => void ledger.push(e))).rejects.toBeInstanceOf(SelfActionRefused);
    }
    expect(did).toEqual([]);
    expect(ledger).toEqual([]);
  });
});

describe("each fix", () => {
  test("is carried out by one hand, through the node's own gate, and recorded in the ledger as his own", async () => {
    const { did, h } = hands();
    const ledger: LedgerWrite[] = [];
    const fresh = calm({ sandboxes: [overdue("a000000001")], loops: [failedOnce()] });
    const outcomes = await selfAct(fresh, async () => fresh, h, (e) => void ledger.push(e));
    expect(did).toEqual(["reap a000000001 for q-abc", "retry site"]);
    expect(outcomes.map((o) => o.ok)).toEqual([true, true]);
    expect(outcomes.map((o) => o.title)).toEqual(["Removed sandbox a000000001, which had outlived its time", "Ran loop site again after one bad run"]);
    expect(ledger.map((e) => [e.class, e.resource, e.target, e.verdict, e.quest])).toEqual([
      ["delete", SELF_ACTION_RESOURCE, "reap-sandbox:a000000001", "allow", SELF_ACTION_QUEST],
      ["read", SELF_ACTION_RESOURCE, "retry-loop:site:s1", "allow", SELF_ACTION_QUEST],
    ]);
    // The retried run is read back from the ledger, so the next heartbeat leaves it alone.
    expect(retriedRuns(ledger.map((e) => e.target))).toEqual(["s1"]);
    expect(planSelfActions(calm({ loops: [failedOnce()], retried: retriedRuns(ledger.map((e) => e.target)) }))).toEqual([]);
  });

  test("checked again against a fresh look: what no longer stands is left alone", async () => {
    const { did, h } = hands();
    const ledger: LedgerWrite[] = [];
    const first = calm({ sandboxes: [overdue("a000000001")], loops: [failedOnce()] });
    // By the time he gets to it, the reaper got the sandbox and the loop ran.
    const later = calm({ sandboxes: [], loops: [failedOnce("site", { running: true })] });
    expect(await selfAct(first, async () => later, h, (e) => void ledger.push(e))).toEqual([]);
    expect(did).toEqual([]);
    expect(ledger).toEqual([]);
  });

  test("the oath gate has the last word: if it says ask, nothing is removed and he says he tried", async () => {
    const ledger: LedgerWrite[] = [];
    const strict: SelfActionHands = {
      // The host's gate as if the sandbox were persistent after all.
      reap: async (sandbox, quest) => decide({ class: "delete", resource: "docker.container", target: sandbox, createdBy: { quest, ephemeral: false }, quest }),
      retry: () => {},
    };
    const fresh = calm({ sandboxes: [overdue("a000000001")] });
    const [outcome] = await selfAct(fresh, async () => fresh, strict, (e) => void ledger.push(e));
    expect(outcome!.ok).toBe(false);
    expect(outcome!.title).toStartWith("Tried: removed sandbox a000000001");
    expect(ledger[0]!.reason).toStartWith("Galahad's own fix didn't work: the oath gate said ask");
  });

  test("a hand that fails is recorded as tried, never as fixed", async () => {
    const ledger: LedgerWrite[] = [];
    const broken: SelfActionHands = {
      reap: async () => ({ verdict: "allow", reason: "" }),
      retry: () => {
        throw new Error("loop site is already running");
      },
    };
    const fresh = calm({ loops: [failedOnce()] });
    const [outcome] = await selfAct(fresh, async () => fresh, broken, (e) => void ledger.push(e));
    expect(outcome).toMatchObject({ ok: false });
    expect(ledger[0]!.reason).toContain("already running");
  });

  test("compute: he measures the node he's on when it's due, and re-derives his defaults when the fleet's compute changed", async () => {
    const compute = (over: Partial<NonNullable<SelfSnapshot["compute"]>> = {}): SelfSnapshot["compute"] => ({ canMeasure: true, due: null, lastAt: NOW - 5 * MIN, limitSetAt: null, adapts: true, planDigest: "d1", recordedDigest: "d1", ...over });
    expect(planSelfActions(calm({ compute: compute() }))).toEqual([]);
    // Never measured: now.
    expect(planSelfActions(calm({ compute: compute({ due: "joined", lastAt: null }) }))).toEqual([{ kind: "calibrate", why: "joined" }]);
    // Its body changed five minutes after the last measurement (a runtime that comes and goes): not in a loop.
    expect(planSelfActions(calm({ compute: compute({ due: "changed" }) }))).toEqual([]);
    expect(planSelfActions(calm({ compute: compute({ due: "changed", lastAt: NOW - 61 * MIN }) }))).toEqual([{ kind: "calibrate", why: "changed" }]);
    // The owner changed its ceiling since: measured again at once.
    expect(planSelfActions(calm({ compute: compute({ due: "changed", limitSetAt: NOW - MIN }) }))).toEqual([{ kind: "calibrate", why: "changed" }]);
    // A node that can't measure itself here doesn't try.
    expect(planSelfActions(calm({ compute: compute({ due: "joined", lastAt: null, canMeasure: false }) }))).toEqual([]);
    // The recorded plan isn't what the mind gives: re-derive. Only the node that keeps the plan does.
    expect(planSelfActions(calm({ compute: compute({ planDigest: "d2" }) }))).toEqual([{ kind: "adapt-compute" }]);
    expect(planSelfActions(calm({ compute: compute({ planDigest: "d2", adapts: false }) }))).toEqual([]);

    const { did, h } = hands();
    h.calibrate = async (why) => void did.push(`calibrate ${why}`);
    h.adaptCompute = () => (did.push("adapt"), ["rack joined: 4 sandbox slots, 8 model calls at once (measured 15.6 reference cores' worth).", "Default effort 1 → 3: auto may now run up to 3 attempts at a quest at once."]);
    const ledger: LedgerWrite[] = [];
    const state = calm({ compute: compute({ due: "joined", lastAt: null, planDigest: "d2" }) });
    const fixed = await selfAct(state, async () => state, h, (e) => void ledger.push(e));
    expect(did).toEqual(["calibrate joined", "adapt"]);
    expect(fixed.map((f) => f.ok)).toEqual([true, true]);
    // The line the owner reads says what changed.
    expect(fixed[1]!.title).toContain("rack joined: 4 sandbox slots");
    expect(ledger.map((e) => [e.class, e.target, e.quest, e.resource])).toEqual([
      ["create", "calibrate:joined", SELF_ACTION_QUEST, SELF_ACTION_RESOURCE],
      ["modify", "adapt-compute:plan", SELF_ACTION_QUEST, SELF_ACTION_RESOURCE],
    ]);
    expect(ledger[1]!.detail).toContain("Default effort 1 → 3");
    // Without the hands (a node that can't), it's recorded as tried, never as done.
    const bare = hands();
    const tried = await selfAct(state, async () => state, bare.h, () => {});
    expect(tried.map((f) => f.ok)).toEqual([false, false]);
  });

  test("its ledger target names what it was about, and a retry names the run", () => {
    expect(selfActionTarget({ kind: "reap-sandbox", sandbox: "0123456789" })).toBe("reap-sandbox:0123456789");
    expect(selfActionTarget({ kind: "retry-loop", loop: "site", after: "s1a2b" })).toBe("retry-loop:site:s1a2b");
    // A target an older version wrote (the removed world's weather) is in the ledger still: it's read past.
    expect(retriedRuns(["retry-loop:site:s1a2b", "reap-sandbox:0123456789", "retry-loop:x", "refresh-weather:copenhagen"])).toEqual(["s1a2b"]);
  });
});
