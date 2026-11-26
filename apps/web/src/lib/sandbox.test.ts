import { describe, expect, test } from "bun:test";
import { autoIsolation, diskUse, gatewayUse, growWords, isLab, isolationPlan, makesSandboxes } from "./sandbox.ts";
import { gb } from "./text.ts";

const ultra = { name: "ultra", vm: true };
const laptop = { name: "laptop", vm: false };

describe("sandbox isolation", () => {
  test("Automatic picks as the node does: a microVM for online code where the host has them", () => {
    expect(autoIsolation("online", true)).toBe("vm");
    expect(autoIsolation("online", false)).toBe("container");
    expect(autoIsolation("gateway", true)).toBe("container");
    expect(autoIsolation("isolated", true)).toBe("container");
  });

  test("Automatic sends nothing, so the host decides; and says what it picks", () => {
    expect(isolationPlan("auto", "online", ultra)).toEqual({
      isolation: "vm",
      vmAvailable: true,
      vmReason: null,
      note: "Automatic: it's online, so it gets its own microVM on ultra.",
    });
    expect(isolationPlan("auto", "gateway", ultra)).toMatchObject({ isolation: "container", note: "Automatic: a hardened container on ultra's kernel. Online sandboxes get their own microVM." });
    expect(isolationPlan("auto", "online", laptop)).toMatchObject({ isolation: "container", note: expect.stringContaining("online code shares its kernel") });
    expect(isolationPlan("auto", "gateway", laptop).note).toBe("Automatic: a hardened container on laptop's kernel.");
    expect(isolationPlan("auto", "online", ultra).send).toBeUndefined();
  });

  test("a choice is sent as made; MicroVM is only available where the host has microVMs", () => {
    expect(isolationPlan("container", "online", ultra)).toMatchObject({ isolation: "container", send: "container" });
    expect(isolationPlan("vm", "gateway", ultra)).toMatchObject({ isolation: "vm", send: "vm", vmAvailable: true });
    const refused = isolationPlan("vm", "online", laptop);
    expect(refused).toMatchObject({ isolation: "container", vmAvailable: false, vmReason: "laptop can't run microVMs (it needs KVM and Kata)." });
    // Falls back to Automatic rather than asking for what the node would refuse (424).
    expect(refused.send).toBeUndefined();
  });
});

describe("a Mac's sandboxes (Apple's container)", () => {
  const mini = { name: "mini", vm: true, mac: true };

  test("every sandbox there is a VM of its own, whatever is chosen, and the note says so", () => {
    for (const choice of ["auto", "container", "vm"] as const) {
      expect(isolationPlan(choice, "online", mini)).toMatchObject({ isolation: "vm", vmAvailable: true, vmReason: null, note: "On mini, a Mac, every sandbox is a VM of its own (Apple's container)." });
    }
    expect(isolationPlan("auto", "gateway", mini).send).toBeUndefined();
  });

  test("an isolated one isn't made on a Mac: placed by Galahad it goes to a Linux host, and on the Mac itself it is refused", () => {
    expect(isolationPlan("auto", "isolated", mini).note).toBe("mini is a Mac, which makes no sandbox with no network at all: placed by Galahad, it goes to a Linux host with Docker; asked of mini, it is refused.");
  });

  test("a Mac with container makes sandboxes; one without, as before, only with Docker", () => {
    expect(makesSandboxes({ docker: false, vm: { kvm: false, tools: [] }, sandbox: { image: true, networks: true, vm: true, engine: "container" } })).toBe(true);
    expect(makesSandboxes({ docker: false, vm: { kvm: false, tools: [] }, sandbox: null })).toBe(false);
    expect(makesSandboxes({ docker: true })).toBe(true);
    expect(makesSandboxes({ vm: { kvm: true, tools: [] } })).toBe(true);
  });

  test("giving a VM more is said as it will be: while it runs, or on a Mac a pause, what runs in it stopping, its disk as it is", () => {
    expect(growWords(false)).toEqual({ intro: "More threads, memory or disk while it runs: nothing in it stops, and its work is kept.", done: "and nothing in it stopped.", disk: true });
    expect(growWords(true)).toEqual({
      intro: "More threads or memory. Its Mac can't grow a running VM: it stops for a moment and starts again with more, its /work kept, and whatever is running in it stops. Its disk keeps the size it was made with.",
      done: "after a pause: what was running in it stopped.",
      disk: false,
    });
  });
});

describe("the Lab", () => {
  test("a Lab sandbox is told by its image", () => {
    expect(isLab("galahad/lab:1")).toBe(true);
    expect(isLab("galahad/lab:2")).toBe(true);
    expect(isLab("galahad/sandbox:latest")).toBe(false);
    expect(isLab("someone/galahad/lab:1")).toBe(false);
    expect(isLab("galahad/laboratory:1")).toBe(false);
  });
});

describe("sandbox disks", () => {
  test("used of limit, how full, or no limit at all", () => {
    expect(diskUse(null)).toEqual({ text: "no disk limit", fraction: null, nearlyFull: false });
    expect(diskUse({ limitGb: 20, usedGb: null })).toEqual({ text: "20 GB limit", fraction: null, nearlyFull: false });
    expect(diskUse({ limitGb: 20, usedGb: 3.2 })).toEqual({ text: "3.2 GB of 20 GB", fraction: 0.16, nearlyFull: false });
    expect(diskUse({ limitGb: 20, usedGb: 18 })).toMatchObject({ text: "18 GB of 20 GB", nearlyFull: true });
    expect(diskUse({ limitGb: 2048, usedGb: 0.25 })).toMatchObject({ text: "256 MB of 2 TB" });
    // Over the limit (a filesystem's own overhead) never reads past full.
    expect(diskUse({ limitGb: 10, usedGb: 10.4 }).fraction).toBe(1);
    expect(gb(0)).toBe("0 MB");
  });
});

describe("what a sandbox may reach through its gateway", () => {
  test("web search is named for what it is, not shown as models", () => {
    expect(gatewayUse("search")).toEqual({ kind: "search", label: "web search", title: "May search the web through Galahad's own search engine" });
    expect(gatewayUse("anthropic")).toEqual({ kind: "models", label: "anthropic", title: "May use anthropic's models (your key stays in the vault)" });
  });
});
