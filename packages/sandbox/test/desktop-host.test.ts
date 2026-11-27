import { describe, expect, test } from "bun:test";
import { containerName, LABEL, SandboxHost, type DockerRunner, type LedgerEntryInput } from "../src/index.ts";

/*
 * Watching an agent's desktop and taking it over, from outside its VM: the host does one thing there with the
 * `desktop` command (a click, some typing, a key, an address) and brings back a picture of the screen. No port is
 * opened into the VM for it. What is typed (a password, when you sign in for the agent) is never written down.
 */

const ID = "0123456789";
const RUN = "arm.team.abcdef0123.builder";
const PICTURE = "/9j/4AAQSkZJRgABAQ"; // (the beginning of a JPEG, in base64)

function desk(options: { status?: string; labels?: Record<string, string>; missing?: boolean; fail?: string } = {}) {
  const ledger: LedgerEntryInput[] = [];
  const execs: string[][] = [];
  const labels = { [LABEL]: "1", [`${LABEL}.id`]: ID, [`${LABEL}.node`]: "test", [`${LABEL}.run`]: RUN, [`${LABEL}.network`]: "online", [`${LABEL}.ephemeral`]: "false", [`${LABEL}.isolation`]: "vm", ...options.labels };
  const runner: DockerRunner = async (args) => {
    if (args[0] === "info") return { code: 0, stdout: "29.0.0", stderr: "" };
    if (args[0] === "ps") return { code: 0, stdout: ID, stderr: "" };
    if (args[0] === "inspect") return { code: 0, stdout: JSON.stringify([{ Config: { Labels: labels, Image: "invincible/desktop:1" }, State: { Status: options.status ?? "running" } }]), stderr: "" };
    if (args[0] === "exec") {
      // After the container: timeout --signal=KILL <n>s <cmd…>
      const cmd = args.slice(args.indexOf(containerName(ID)) + 4);
      execs.push(cmd);
      if (options.missing) return { code: 127, stdout: "", stderr: "sh: 1: desktop: not found" };
      if (options.fail && cmd.includes(options.fail)) return { code: 1, stdout: "", stderr: "desktop: the browser did not start (see /tmp/invincible-desktop/browser.log)" };
      return { code: 0, stdout: cmd.join(" ").includes("base64 -w0") ? PICTURE : "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const host = new SandboxHost({ node: "test", maxCpus: 8, maxMemoryGb: 16, tokens: { mint: () => ({ token: "t", info: { hash: "h" } }), revoke: () => true }, ledger: (entry) => { ledger.push(entry); }, runner });
  return { host, ledger, execs };
}

describe("an agent's desktop, from outside its VM", () => {
  test("looking brings back a picture of the screen and writes nothing down", async () => {
    const d = desk();
    const seen = await d.host.desktop(ID, RUN, { do: "look" });
    expect(seen).toEqual({ shot: { mediaType: "image/jpeg", data: PICTURE }, width: 1280, height: 800 });
    expect(d.execs).toHaveLength(1);
    expect(d.execs[0]!.join(" ")).toContain("desktop shot");
    // (Watching asks again every second or two: a line for each would bury the ledger.)
    expect(d.ledger).toEqual([]);
  });

  test("each thing done is one `desktop` command with its arguments as arguments, then a fresh picture, and a line in the ledger", async () => {
    const d = desk();
    const done = async (action: Parameters<SandboxHost["desktop"]>[2]) => { d.execs.length = 0; await d.host.desktop(ID, RUN, action); return d.execs[0]!; };
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
    expect(d.ledger.every((e) => e.class === "modify" && e.target === containerName(ID) && e.run === RUN)).toBe(true);
  });

  test("what is typed reaches the VM whole, as one argument, and is never written down: the ledger says only how much", async () => {
    const d = desk();
    const password = "correct horse; $(reboot) `id` 'battery' \"staple\"";
    await d.host.desktop(ID, RUN, { do: "type", text: password });
    const typed = d.execs[0]!;
    // Carried as base64 to a line of Python in the VM that hands it to `desktop type` as one argument: no shell reads it.
    expect(typed.slice(0, 3)).toEqual(["python3", "-I", "-c"]);
    expect(typed[3]).toContain("'desktop','type'");
    expect(Buffer.from(typed[4]!, "base64").toString()).toBe(password);
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
    for (const action of bad) await expect(d.host.desktop(ID, RUN, action)).rejects.toMatchObject({ status: 400 });
    expect(d.execs).toEqual([]);
    expect(d.ledger).toEqual([]);
  });

  test("only an agent's own running VM, and only one that has a desktop", async () => {
    await expect(desk().host.desktop(ID, "arm.team.abcdef0123.other", { do: "look" })).rejects.toMatchObject({ status: 403 });
    await expect(desk({ labels: { [`${LABEL}.ephemeral`]: "true" } }).host.desktop(ID, RUN, { do: "look" })).rejects.toMatchObject({ status: 403 });
    await expect(desk().host.desktop("9876543210", RUN, { do: "look" })).rejects.toMatchObject({ status: 404 });
    await expect(desk({ status: "exited" }).host.desktop(ID, RUN, { do: "look" })).rejects.toMatchObject({ status: 409 });
    const none = desk({ missing: true });
    await expect(none.host.desktop(ID, RUN, { do: "look" })).rejects.toMatchObject({ status: 424, message: expect.stringContaining("has no desktop") });
    // A desktop that will not come up says why, in its own words, and nothing is called done.
    const broken = desk({ fail: "click" });
    await expect(broken.host.desktop(ID, RUN, { do: "click", x: 1, y: 1 })).rejects.toMatchObject({ status: 424, message: expect.stringContaining("the browser did not start") });
    expect(broken.ledger).toEqual([]);
  });
});

/**
 * The held sessions' stand-in: answers each JSON line as deskd would, and writes down what it was asked. The agent's
 * session (`desktop --session`) and yours (`desktop --owner-session`, as the owner's uid) are told apart as deskd tells
 * them apart, and yours keep deskd's hold: your input takes it if it is free, and each answer of yours says it.
 */
function held(options: { neverAnswers?: number; ownerEnds?: number } = {}) {
  const asked: Record<string, unknown>[] = [];
  const owned: Record<string, unknown>[] = [];
  const started: string[][] = [];
  let hold: { since: number; idle: number; most: number; ends_in: number } | null = null;
  const looks = new Set(["status", "screenshot", "hold"]);
  const spawnSession = (args: string[]) => {
    started.push(args);
    const owner = args.includes("--owner-session");
    let take: ((line: string) => void) | null = null;
    let ended: ((code: number) => void) | null = null;
    const exited = new Promise<number>((resolve) => (ended = resolve));
    // (An image older than deskd: its `desktop` takes no --session and ends at once; one older than take-over, no --owner-session.)
    const endsAt = owner && options.ownerEnds !== undefined ? options.ownerEnds : options.neverAnswers;
    if (endsAt !== undefined) queueMicrotask(() => ended!(endsAt));
    return {
      write: (text: string) => {
        if (endsAt !== undefined) return;
        for (const line of text.trim().split("\n")) {
          const q = JSON.parse(line) as Record<string, unknown>;
          (owner ? owned : asked).push(q);
          const verb = q.argv ? (q.argv as string[])[0]! : String(q.name);
          let took = false;
          let answer: Record<string, unknown>;
          if (owner && (q.name === "take" || q.name === "release")) {
            const had = hold !== null;
            hold = q.name === "take" ? { since: 1_764_000_000.25, idle: 120, most: 900, ends_in: 120 } : null;
            answer = q.name === "take" ? { id: q.id, ok: true, took: true } : { id: q.id, ok: true, released: had };
          } else {
            if (owner && !looks.has(verb) && !hold) {
              hold = { since: 1_764_000_000.25, idle: 120, most: 900, ends_in: 120 };
              took = true;
            }
            answer = q.argv
              ? { id: q.id, ok: true, code: 0, stdout: `did ${(q.argv as string[]).join(" ")}\n`, stderr: "" }
              : q.name === "hold" ? { id: q.id, ok: true } : { id: q.id, ok: true, action: q.name, image: { media_type: "image/jpeg", data: PICTURE, width: 1280, height: 800, settled: null } };
          }
          if (owner) Object.assign(answer, took ? { took: true } : {}, { hold });
          queueMicrotask(() => take?.(JSON.stringify(answer)));
        }
      },
      onLine: (fn: (line: string) => void) => void (take = fn),
      kill: () => ended?.(-15),
      exited,
    };
  };
  return { spawnSession, asked, owned, started };
}

const AGENTS = ["exec", "--interactive", "--workdir", "/work", containerName(ID), "desktop", "--session"];
const YOURS = ["exec", "--interactive", "--user", "1001:1001", "--workdir", "/", containerName(ID), "desktop", "--owner-session"];
const TOOK = "took over its desktop by your input: yours until you give it back, or 120 s pass with no input from you (15 min at most)";

describe("an agent's desktop through its held session (deskd)", () => {
  const sessioned = (s: ReturnType<typeof held>, options: Parameters<typeof desk>[0] = {}) => {
    const d = desk(options);
    const docker: string[][] = [];
    // The same host as desk()'s, with the session's stand-in, every engine call written down.
    const runner = (d.host as unknown as { opts: { runner: DockerRunner } }).opts.runner;
    const host = new SandboxHost({ node: "test", maxCpus: 8, maxMemoryGb: 16, tokens: { mint: () => ({ token: "t", info: { hash: "h" } }), revoke: () => true }, ledger: (entry) => { d.ledger.push(entry); }, runner: (args, ms) => { docker.push(args); return runner(args, ms); }, spawnSession: s.spawnSession });
    return { ...d, host, docker };
  };

  test("your look is one request on your own held session, the picture as it is now; while it is open, no listing comes first", async () => {
    const s = held();
    const d = sessioned(s);
    expect(await d.host.desktop(ID, RUN, { do: "look" })).toEqual({ shot: { mediaType: "image/jpeg", data: PICTURE }, width: 1280, height: 800, held: null });
    // Yours is an exec of its own as the owner's uid, never the agent's; the agent's own is opened beside it, with a
    // word that never waits (`status`), since it is the agent's that starts deskd.
    expect(s.started).toEqual([AGENTS, YOURS]);
    expect(s.asked).toEqual([{ id: 1, argv: ["status"] }]);
    expect(s.owned).toEqual([{ id: 1, name: "screenshot", input: { format: "jpeg", settle: false } }]);
    const listed = d.docker.length;
    await d.host.desktop(ID, RUN, { do: "look" });
    expect(d.docker.length).toBe(listed);
    expect(s.started).toHaveLength(2);
    expect(s.asked).toHaveLength(1);
    expect(s.owned).toHaveLength(2);
    expect(d.ledger).toEqual([]);
  });

  test("a thing you do is the command's own words on your session, then a picture of the settled screen, and a line in the ledger; your first input takes the desktop over, and typed text is never written down", async () => {
    const s = held();
    const d = sessioned(s);
    const clicked = await d.host.desktop(ID, RUN, { do: "click", x: 640, y: 330, button: "double" });
    expect(clicked).toMatchObject({ held: { since: 1_764_000_000_250, idleSec: 120, mostSec: 900, endsInSec: 120 } });
    await d.host.desktop(ID, RUN, { do: "type", text: "a secret you typed" });
    expect(s.owned).toEqual([
      { id: 1, argv: ["click", "640", "330", "double"] },
      { id: 2, name: "screenshot", input: { format: "jpeg", settle: true } },
      { id: 3, argv: ["type", "a secret you typed"] },
      { id: 4, name: "screenshot", input: { format: "jpeg", settle: true } },
    ]);
    // Nothing of yours on the agent's session.
    expect(s.asked).toEqual([{ id: 1, argv: ["status"] }]);
    expect(d.ledger.map((e) => e.detail)).toEqual([TOOK, "click 640 330 double", "type (18 characters, not recorded)"]);
    expect(JSON.stringify(d.ledger)).not.toContain("secret");
  });

  test("with no picture asked back, a thing done answers as soon as it is done, and a look only says whether you have the desktop", async () => {
    const s = held();
    const d = sessioned(s);
    expect(await d.host.desktop(ID, RUN, { do: "look" }, false)).toEqual({ done: true, held: null });
    expect(await d.host.desktop(ID, RUN, { do: "key", keys: ["Return"] }, false)).toEqual({ done: true, held: { since: 1_764_000_000_250, idleSec: 120, mostSec: 900, endsInSec: 120 } });
    expect(s.owned).toEqual([{ id: 1, name: "hold" }, { id: 2, argv: ["key", "Return"] }]);
    expect(d.ledger.map((e) => e.detail)).toEqual([TOOK, "key Return"]);
  });

  test("you take its desktop over and give it back through your session, and the ledger says each", async () => {
    const s = held();
    const d = sessioned(s);
    expect(await d.host.desktopHold(ID, RUN, true)).toEqual({ since: 1_764_000_000_250, idleSec: 120, mostSec: 900, endsInSec: 120 });
    // Your input while you have it is done under that hold: no second take.
    await d.host.desktop(ID, RUN, { do: "click", x: 1, y: 2 }, false);
    expect(await d.host.desktopHold(ID, RUN, false)).toBeNull();
    // Giving back what you don't have is nothing, and says nothing.
    expect(await d.host.desktopHold(ID, RUN, false)).toBeNull();
    expect(s.owned.map((q) => q.name ?? (q.argv as string[])[0])).toEqual(["take", "click", "release", "release"]);
    expect(d.ledger.map((e) => e.detail)).toEqual([
      "took over its desktop: yours until you give it back, or 120 s pass with no input from you (15 min at most)",
      "click 1 2 left",
      "gave its desktop back",
    ]);
    expect(d.ledger.every((e) => e.resource === "sandbox.desktop" && e.target === containerName(ID) && e.run === RUN)).toBe(true);
    // Only the agent's own running VM with a desktop.
    await expect(d.host.desktopHold(ID, "arm.team.abcdef0123.other", true)).rejects.toMatchObject({ status: 403 });
    await expect(d.host.desktopHold("9876543210", RUN, true)).rejects.toMatchObject({ status: 404 });
  });

  test("a VM whose image is older than take-over: your looks and input go the agent's way, as before, and taking over is refused, saying why", async () => {
    const s = held({ ownerEnds: 2 });
    const d = sessioned(s);
    expect(await d.host.desktop(ID, RUN, { do: "look" })).toEqual({ shot: { mediaType: "image/jpeg", data: PICTURE }, width: 1280, height: 800 });
    expect(s.asked).toEqual([{ id: 1, argv: ["status"] }, { id: 2, name: "screenshot", input: { format: "jpeg", settle: false } }]);
    await expect(d.host.desktopHold(ID, RUN, true)).rejects.toMatchObject({ status: 424, message: expect.stringContaining("older than take-over") });
    // Yours isn't asked again until the VM is made again.
    expect(s.started).toEqual([AGENTS, YOURS]);
  });

  test("your session ending before it answers, on an image that has take-over, is an error: what you do never goes the agent's way unheld", async () => {
    const s = held({ ownerEnds: 1 });
    const d = sessioned(s);
    await expect(d.host.desktop(ID, RUN, { do: "type", text: "hunter2" })).rejects.toMatchObject({ status: 503 });
    expect(s.asked).toEqual([{ id: 1, argv: ["status"] }]);
    expect(d.execs).toEqual([]);
    expect(d.ledger).toEqual([]);
  });

  test("the VM's own desktop command alone goes to the agent's session, its answer as an exec's; anything else is an exec as ever", async () => {
    const s = held();
    const d = sessioned(s);
    expect(await d.host.exec(ID, ["desktop", "click", "1", "2"], 30)).toMatchObject({ exitCode: 0, stdout: "did click 1 2\n", stderr: "" });
    expect(s.asked).toEqual([{ id: 1, argv: ["click", "1", "2"] }]);
    expect(s.owned).toEqual([]);
    expect(d.execs).toEqual([]);
    await d.host.exec(ID, ["bash", "-lc", "desktop click 1 2"], 30);
    expect(d.execs).toEqual([["bash", "-lc", "desktop click 1 2"]]);
    expect(d.ledger.filter((e) => e.resource === "sandbox.exec").map((e) => e.detail)).toEqual(["desktop click 1 2 → exit 0", "bash -lc desktop click 1 2 → exit 0"]);
  });

  test("a VM whose image is older than deskd ends the sessions before they answer: it is asked the old way, and not asked again", async () => {
    const s = held({ neverAnswers: 2 });
    const d = sessioned(s);
    expect(await d.host.desktop(ID, RUN, { do: "look" })).toEqual({ shot: { mediaType: "image/jpeg", data: PICTURE }, width: 1280, height: 800 });
    expect(d.execs.at(-1)!.join(" ")).toContain("desktop shot");
    await d.host.desktop(ID, RUN, { do: "look" });
    expect(s.started).toEqual([AGENTS, YOURS]);
  });

  test("removing the VM ends its sessions, yours too", async () => {
    const s = held();
    const d = sessioned(s);
    await d.host.desktop(ID, RUN, { do: "look" });
    await d.host.destroy(ID, { approvedBy: "owner" });
    await d.host.desktop(ID, RUN, { do: "look" });
    expect(s.started).toEqual([AGENTS, YOURS, AGENTS, YOURS]);
  });
});
