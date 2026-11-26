import { describe, expect, test } from "bun:test";
import { containerName, LABEL, SandboxHost, type DockerRunner, type LedgerEntryInput } from "../src/index.ts";

/*
 * Watching a knight's desktop and taking it over, from outside its VM: the host does one thing there with the
 * `desktop` command (a click, some typing, a key, an address) and brings back a picture of the screen. No port is
 * opened into the VM for it. What is typed (a password, when you sign in for the knight) is never written down.
 */

const ID = "0123456789";
const QUEST = "arm.team.abcdef0123.builder";
const PICTURE = "/9j/4AAQSkZJRgABAQ"; // (the beginning of a JPEG, in base64)

function desk(options: { status?: string; labels?: Record<string, string>; missing?: boolean; fail?: string } = {}) {
  const ledger: LedgerEntryInput[] = [];
  const execs: string[][] = [];
  const labels = { [LABEL]: "1", [`${LABEL}.id`]: ID, [`${LABEL}.node`]: "test", [`${LABEL}.quest`]: QUEST, [`${LABEL}.network`]: "online", [`${LABEL}.ephemeral`]: "false", [`${LABEL}.isolation`]: "vm", ...options.labels };
  const runner: DockerRunner = async (args) => {
    if (args[0] === "info") return { code: 0, stdout: "29.0.0", stderr: "" };
    if (args[0] === "ps") return { code: 0, stdout: ID, stderr: "" };
    if (args[0] === "inspect") return { code: 0, stdout: JSON.stringify([{ Config: { Labels: labels, Image: "galahad/desktop:1" }, State: { Status: options.status ?? "running" } }]), stderr: "" };
    if (args[0] === "exec") {
      // After the container: timeout --signal=KILL <n>s <cmd…>
      const cmd = args.slice(args.indexOf(containerName(ID)) + 4);
      execs.push(cmd);
      if (options.missing) return { code: 127, stdout: "", stderr: "sh: 1: desktop: not found" };
      if (options.fail && cmd.includes(options.fail)) return { code: 1, stdout: "", stderr: "desktop: the browser did not start (see /tmp/galahad-desktop/browser.log)" };
      return { code: 0, stdout: cmd.join(" ").includes("base64 -w0") ? PICTURE : "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const host = new SandboxHost({ node: "test", maxCpus: 8, maxMemoryGb: 16, tokens: { mint: () => ({ token: "t", info: { hash: "h" } }), revoke: () => true }, ledger: (entry) => { ledger.push(entry); }, runner });
  return { host, ledger, execs };
}

describe("a knight's desktop, from outside its VM", () => {
  test("looking brings back a picture of the screen and writes nothing down", async () => {
    const d = desk();
    const seen = await d.host.desktop(ID, QUEST, { do: "look" });
    expect(seen).toEqual({ shot: { mediaType: "image/jpeg", data: PICTURE }, width: 1280, height: 800 });
    expect(d.execs).toHaveLength(1);
    expect(d.execs[0]!.join(" ")).toContain("desktop shot");
    // (Watching asks again every second or two: a line for each would bury the ledger.)
    expect(d.ledger).toEqual([]);
  });

  test("each thing done is one `desktop` command with its arguments as arguments, then a fresh picture, and a line in the ledger", async () => {
    const d = desk();
    const done = async (action: Parameters<SandboxHost["desktop"]>[2]) => { d.execs.length = 0; await d.host.desktop(ID, QUEST, action); return d.execs[0]!; };
    expect(await done({ do: "click", x: 640, y: 330 })).toEqual(["desktop", "click", "640", "330", "left"]);
    expect(await done({ do: "click", x: 5, y: 6, button: "double" })).toEqual(["desktop", "click", "5", "6", "double"]);
    expect(await done({ do: "move", x: 1, y: 2 })).toEqual(["desktop", "move", "1", "2"]);
    expect(await done({ do: "scroll", direction: "down", times: 3 })).toEqual(["desktop", "scroll", "down", "3"]);
    expect(await done({ do: "key", keys: ["ctrl+l", "Return"] })).toEqual(["desktop", "key", "ctrl+l", "Return"]);
    expect(await done({ do: "open", address: "https://example.com/a?b=c" })).toEqual(["desktop", "open", "https://example.com/a?b=c"]);
    // Each was followed by a picture.
    expect(d.execs).toHaveLength(2);
    expect(d.ledger.map((e) => [e.resource, e.detail])).toEqual([
      ["sandbox.desktop", "click 640 330 left"], ["sandbox.desktop", "click 5 6 double"], ["sandbox.desktop", "move 1 2"],
      ["sandbox.desktop", "scroll down 3"], ["sandbox.desktop", "key ctrl+l Return"], ["sandbox.desktop", "open https://example.com/a?b=c"],
    ]);
    expect(d.ledger.every((e) => e.class === "modify" && e.target === containerName(ID) && e.quest === QUEST)).toBe(true);
  });

  test("what is typed reaches the VM whole, as one argument, and is never written down: the ledger says only how much", async () => {
    const d = desk();
    const password = "correct horse; $(reboot) `id` 'battery' \"staple\"";
    await d.host.desktop(ID, QUEST, { do: "type", text: password });
    const typed = d.execs[0]!;
    // Carried as base64 to a line of Python in the VM that hands it to `desktop type` as one argument: no shell reads it.
    expect(typed.slice(0, 2)).toEqual(["python3", "-c"]);
    expect(typed[2]).toContain("'desktop','type'");
    expect(Buffer.from(typed[3]!, "base64").toString()).toBe(password);
    expect(typed.join(" ")).not.toContain("horse");
    expect(d.ledger).toEqual([expect.objectContaining({ resource: "sandbox.desktop", detail: `type (${password.length} characters, not recorded)` })]);
    expect(JSON.stringify(d.ledger)).not.toContain("horse");
  });

  test("what isn't a place, a key or an address is refused before the VM is asked anything", async () => {
    const d = desk();
    const bad: Parameters<SandboxHost["desktop"]>[2][] = [
      { do: "click", x: -1, y: 5 }, { do: "click", x: 1.5, y: 5 }, { do: "click", x: 5, y: 99_999 }, { do: "key", keys: ["ctrl+l; reboot"] }, { do: "key", keys: [] },
      { do: "scroll", direction: "down", times: 500 }, { do: "open", address: "javascript:alert(1)" }, { do: "open", address: "--proxy-server=evil" }, { do: "type", text: "" }, { do: "type", text: "x".repeat(5000) },
    ];
    for (const action of bad) await expect(d.host.desktop(ID, QUEST, action)).rejects.toMatchObject({ status: 400 });
    expect(d.execs).toEqual([]);
    expect(d.ledger).toEqual([]);
  });

  test("only a knight's own running VM, and only one that has a desktop", async () => {
    await expect(desk().host.desktop(ID, "arm.team.abcdef0123.other", { do: "look" })).rejects.toMatchObject({ status: 403 });
    await expect(desk({ labels: { [`${LABEL}.ephemeral`]: "true" } }).host.desktop(ID, QUEST, { do: "look" })).rejects.toMatchObject({ status: 403 });
    await expect(desk().host.desktop("9876543210", QUEST, { do: "look" })).rejects.toMatchObject({ status: 404 });
    await expect(desk({ status: "exited" }).host.desktop(ID, QUEST, { do: "look" })).rejects.toMatchObject({ status: 409 });
    const none = desk({ missing: true });
    await expect(none.host.desktop(ID, QUEST, { do: "look" })).rejects.toMatchObject({ status: 424, message: expect.stringContaining("has no desktop") });
    // A desktop that will not come up says why, in its own words, and nothing is called done.
    const broken = desk({ fail: "click" });
    await expect(broken.host.desktop(ID, QUEST, { do: "click", x: 1, y: 1 })).rejects.toMatchObject({ status: 424, message: expect.stringContaining("the browser did not start") });
    expect(broken.ledger).toEqual([]);
  });
});
