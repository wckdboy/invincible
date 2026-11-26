import { describe, expect, test } from "bun:test";
import type { DoctorCheck, DoctorReport } from "@galahad/core/doctor";
import { doctorTally } from "@galahad/core/doctor";
import { checkLine, doctorCard, readDoctorReport, stateTone } from "./doctor.ts";

/* The doctor's card: what needs you first, everything else grouped; and the report read at the page's boundary. */

const check = (id: string, area: DoctorCheck["area"], state: DoctorCheck["state"], line: string, fix?: string, ms?: number): DoctorCheck => ({ id, area, state, line, ...(fix ? { fix } : {}), ...(ms !== undefined ? { ms } : {}) });
const report = (checks: DoctorCheck[], over: Partial<DoctorReport> = {}): DoctorReport => ({ node: "ultra", at: 1, quick: true, offline: true, checks, tally: doctorTally(checks), tookMs: 420, ...over });

describe("the doctor's card", () => {
  test("a healthy node: one calm line, nothing to attend to, every check one click away by area", () => {
    const view = doctorCard(report([check("disk.home", "disk", "ok", "412 GB free"), check("mind.chain", "mind", "ok", "no forks"), check("mind.integrity", "mind", "skipped", "not scanned")]));
    expect(view.tone).toBe("ok");
    expect(view.headline).toBe("All is well: 2 checks passed (1 not looked at).");
    expect(view.how).toBe("A quick look at ultra, in 420 ms");
    expect(view.attention).toEqual([]);
    expect(view.groups.map((g) => `${g.title}: ${g.checks.map((c) => c.id).join(",")}`)).toEqual(["The mind: mind.chain,mind.integrity", "Disk: disk.home"]);
  });

  test("faults come first, broken before what needs you, each with what to do", () => {
    const view = doctorCard(
      report(
        [
          check("app.published", "app", "needs-you", "Tailscale isn't publishing the app", "galahad expose"),
          check("vault.open", "vault", "broken", "can't open the vault", "Re-grant it"),
          check("role.planner", "models", "ok", "planner: x/y answered", undefined, 840),
        ],
        { quick: false, offline: false, tookMs: 2400 },
      ),
    );
    expect(view.tone).toBe("danger");
    expect(view.headline).toBe("1 broken, 1 needs you; 1 well.");
    expect(view.how).toBe("A full check at ultra, in 2.4 s");
    expect(view.attention.map((c) => c.id)).toEqual(["vault.open", "app.published"]);
    expect(view.attention[0]!.fix).toBe("Re-grant it");
    expect(checkLine(view.groups.find((g) => g.area === "models")!.checks[0]!)).toBe("planner: x/y answered (840 ms)");
    expect(doctorCard(report([check("a", "app", "needs-you", "x", "y")])).tone).toBe("warn");
    expect(doctorCard(report([], { quick: false, offline: true })).how).toStartWith("A full check, offline");
    expect([stateTone("ok"), stateTone("needs-you"), stateTone("broken"), stateTone("skipped")]).toEqual(["ok", "warn", "danger", "neutral"]);
  });
});

describe("read at the boundary", () => {
  test("a report is taken as it is; anything else is no report, and a check that isn't one is left out", () => {
    const good = report([check("disk.home", "disk", "ok", "fine")]);
    expect(readDoctorReport(JSON.parse(JSON.stringify(good)))).toEqual(good);
    expect(readDoctorReport(null)).toBeNull();
    expect(readDoctorReport({ error: "no" })).toBeNull();
    expect(readDoctorReport({ node: "ultra", at: 1, checks: "many", tally: {} })).toBeNull();
    const odd = readDoctorReport({ node: "ultra", at: 1, checks: [{ id: "x", area: "disk", state: "ok", line: "fine" }, { id: "y", area: "moon", state: "ok", line: "?" }, { id: "z", area: "disk", state: "great", line: "?" }, "junk"], tally: { ok: "many" } });
    expect(odd!.checks.map((c) => c.id)).toEqual(["x"]);
    expect(odd!.tally).toEqual({ ok: 0, needsYou: 0, broken: 0, skipped: 0 });
  });
});
