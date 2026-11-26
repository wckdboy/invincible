import { describe, expect, test } from "bun:test";
import { LABEL, SandboxHost, type DockerRunner, type LedgerEntryInput } from "../src/index.ts";

const ID = "0123456789";
const EXIT_SUFFIX = " → exit 0";

/** A SandboxHost whose Docker runner answers just enough for list()/get()/exec() to work, with no real containers. */
function hostWithLedger() {
  const ledger: LedgerEntryInput[] = [];
  const labels: Record<string, string> = {
    [LABEL]: "1",
    [`${LABEL}.id`]: ID,
    [`${LABEL}.node`]: "test",
    [`${LABEL}.quest`]: "test.quest",
    [`${LABEL}.network`]: "isolated",
    [`${LABEL}.ephemeral`]: "true",
    [`${LABEL}.isolation`]: "container",
  };
  const runner: DockerRunner = async (args) => {
    if (args[0] === "info") return { code: 0, stdout: "26.0.0", stderr: "" };
    if (args[0] === "ps") return { code: 0, stdout: ID, stderr: "" };
    if (args[0] === "inspect") {
      return { code: 0, stdout: JSON.stringify([{ Config: { Labels: labels, Image: "galahad/sandbox:1" }, State: { Status: "running" } }]), stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const host = new SandboxHost({
    node: "test",
    tokens: { mint: () => ({ token: "test-token", info: { hash: "test-hash" } }), revoke: () => true },
    ledger: (entry) => { ledger.push(entry); },
    maxCpus: 4,
    maxMemoryGb: 4,
    runner,
  });
  return { host, ledger };
}

describe("SandboxHost.exec ledger detail", () => {
  test("a command within the limit is written whole, exactly as today", async () => {
    const { host, ledger } = hostWithLedger();
    await host.exec(ID, ["echo", "hello", "knight"]);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.detail).toBe(`echo hello knight${EXIT_SUFFIX}`);
  });

  test("a command longer than the limit keeps its beginning and end, and says how many characters were left out", async () => {
    const { host, ledger } = hostWithLedger();
    const original = "HEAD-" + "m".repeat(500) + "-TAIL";
    await host.exec(ID, [original]);
    expect(ledger).toHaveLength(1);
    const detail = ledger[0]!.detail!;

    expect(detail.endsWith(EXIT_SUFFIX)).toBe(true);
    // The command's ending itself (not the exit code) must still be present.
    expect(detail).toContain("-TAIL");

    const commandPart = detail.slice(0, -EXIT_SUFFIX.length);
    expect(commandPart.length).toBeLessThanOrEqual(400);

    const m = commandPart.match(/^(.*?)…\[(\d+) characters omitted\]…(.*)$/);
    expect(m).not.toBeNull();
    const [, head = "", omitted = "0", tail = ""] = m!;
    expect(original.startsWith(head)).toBe(true);
    expect(original.endsWith(tail)).toBe(true);
    expect(tail).toContain("-TAIL");
    expect(Number(omitted)).toBe(original.length - head.length - tail.length);
    expect(Number(omitted)).toBeGreaterThan(0);
  });
});
