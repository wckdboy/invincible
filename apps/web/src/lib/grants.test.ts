import { describe, expect, test } from "bun:test";
import { QAMP_ARM_PREFIX, qampArm } from "@invincible/core";
import { grantEnds, handoffTerms, handoffTitle, isGrantArm, shortDid } from "./grants.ts";

describe("a Q-AMP grant in the app", () => {
  test("its arm is known by the prefix the node gives it, and no other", () => {
    expect(isGrantArm(qampArm("0a1b2c3d4e"))).toBe(true);
    expect(isGrantArm(`${QAMP_ARM_PREFIX}x`)).toBe(true);
    for (const label of ["claude-code", "opencode", "qampy", "loop.heartbeat", "team.ivo"]) expect([label, isGrantArm(label)]).toEqual([label, false]);
  });

  test("its agent's key, short in a row", () => {
    expect(shortDid("did:key:z6Mkg6rJ6LnB4z2LqAFGGMCgLaJDq6KuLLSRXwwCV5RpjyBW")).toBe("did:key:z6Mk…RpjyBW");
    expect(shortDid("did:key:z6Mk")).toBe("did:key:z6Mk");
  });

  test("when it ends", () => {
    const now = Date.UTC(2026, 10, 25, 12, 0);
    expect(grantEnds(now + 52 * 60_000, now)).toBe("ends in 52 min");
    expect(grantEnds(now + 23 * 3_600_000, now)).toBe("ends in 23 h");
    expect(grantEnds(now + 24 * 3_600_000, now)).toBe("ends in 1 d");
    expect(grantEnds(now + 10_000, now)).toBe("ends in a moment");
    expect(grantEnds(now, now)).toBe("ending now");
  });
});

describe("a hand-off grant, as Settings' Permissions says it", () => {
  test("from which node to which, and its terms: whose agents, and what its tasks may spend a day", () => {
    expect(handoffTitle({ from: { name: "laptop" }, to: { name: "homelab" } })).toBe("laptop → homelab");
    expect(handoffTerms({ agents: ["ada", "bea"], budgetUsdPerDay: 5 })).toBe("To ada, bea · up to $5.00 a day");
    expect(handoffTerms({ budgetUsdPerDay: 0.5 })).toBe("To any of its agents · up to $0.50 a day");
    expect(handoffTerms(null)).toBe("Written by a newer node: not understood here.");
    // The coding tool it names for its hand-offs; with none they run on the native tools loop, which goes unsaid.
    expect(handoffTerms({ agents: ["ada"], budgetUsdPerDay: 5, harness: "claude" })).toBe("To ada · up to $5.00 a day · on Claude Code");
    expect(handoffTerms({ budgetUsdPerDay: 2, harness: "hermes" })).toBe("To any of its agents · up to $2.00 a day · on Hermes Agent");
  });
});
