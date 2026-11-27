import { describe, expect, test } from "bun:test";
import { containerName, desktopVerbIn, LABEL, SandboxHost, type DockerRunner, type LedgerEntryInput } from "../src/index.ts";

/*
 * Watching an agent's desktop and taking it over, from outside its VM: the host does one thing there with the
 * `desktop` command (a click, some typing, a key, an address) and brings back a picture of the screen. No port is
 * opened into the VM for it. What is typed (a password, when you sign in for the agent) is never written down.
 */

const ID = "0123456789";
const RUN = "arm.team.abcdef0123.builder";
const PICTURE = "/9j/4AAQSkZJRgABAQ"; // (the beginning of a JPEG, in base64)

function desk(options: { status?: string; labels?: Record<string, string>; missing?: boolean; fail?: string; image?: string; memoryGb?: number; updateFails?: boolean } = {}) {
  const ledger: LedgerEntryInput[] = [];
  const execs: string[][] = [];
  // Every docker call, and its updates; and the VM's memory as Docker says it (none: no limit of its own).
  const calls: string[][] = [];
  const updates: string[][] = [];
  let memoryGb = options.memoryGb;
  const labels = { [LABEL]: "1", [`${LABEL}.id`]: ID, [`${LABEL}.node`]: "test", [`${LABEL}.run`]: RUN, [`${LABEL}.network`]: "online", [`${LABEL}.ephemeral`]: "false", [`${LABEL}.isolation`]: "vm", ...options.labels };
  const runner: DockerRunner = async (args) => {
    calls.push(args);
    if (args[0] === "info") return { code: 0, stdout: "29.0.0", stderr: "" };
    if (args[0] === "ps") return { code: 0, stdout: ID, stderr: "" };
    if (args[0] === "inspect") return { code: 0, stdout: JSON.stringify([{ Config: { Labels: labels, Image: options.image ?? "invincible/desktop:1" }, State: { Status: options.status ?? "running" }, ...(memoryGb ? { HostConfig: { NanoCpus: 1e9, Memory: memoryGb * 2 ** 30 } } : {}) }]), stderr: "" };
    if (args[0] === "update") {
      updates.push(args);
      if (options.updateFails) return { code: 1, stdout: "", stderr: "kata: could not hot-add memory" };
      memoryGb = Number(args[args.indexOf("--memory") + 1]!.replace(/m$/, "")) / 1024;
      return { code: 0, stdout: containerName(ID), stderr: "" };
    }
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
  return { host, ledger, execs, calls, updates };
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
function held(options: { neverAnswers?: number; ownerEnds?: number; ownerEndsAt?: number } = {}) {
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
    let told = 0;
    return {
      write: (text: string) => {
        if (endsAt !== undefined) return;
        for (const line of text.trim().split("\n")) {
          const q = JSON.parse(line) as Record<string, unknown>;
          (owner ? owned : asked).push(q);
          // (Yours ending at its nth request, unanswered: deskd gone from under it, and not back.)
          if (owner && ++told === options.ownerEndsAt) {
            queueMicrotask(() => ended!(1));
            return;
          }
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

  test("your session ending later, deskd gone from under it, is a 503 too: what you do never goes the agent's way unheld", async () => {
    const s = held({ ownerEndsAt: 2 });
    const d = sessioned(s);
    await d.host.desktop(ID, RUN, { do: "look" });
    await expect(d.host.desktop(ID, RUN, { do: "type", text: "hunter2" })).rejects.toMatchObject({ status: 503 });
    await expect(d.host.desktopHold(ID, RUN, true)).resolves.toMatchObject({ idleSec: 120 });
    expect(s.asked).toEqual([{ id: 1, argv: ["status"] }]);
    expect(d.execs).toEqual([]);
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

/** The encoder's stand-in for the host: what it was started as and told, and the frames a test gives it. */
function frames() {
  const made: { args: string[]; said: string[]; closed: boolean; push(bytes: Uint8Array): void; end(code: number): void }[] = [];
  const spawnFrames = (args: string[]) => {
    const queue: Uint8Array[] = [];
    let wake: (() => void) | null = null;
    let done = false;
    let exit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => (exit = resolve));
    const one = { args, said: [] as string[], closed: false, push: (bytes: Uint8Array) => { queue.push(bytes); wake?.(); }, end: (code: number) => { done = true; wake?.(); exit(code); } };
    made.push(one);
    async function* chunks(): AsyncIterable<Uint8Array> {
      for (;;) {
        if (queue.length) yield queue.shift()!;
        else if (done) return;
        else await new Promise<void>((resolve) => (wake = resolve));
      }
    }
    return { chunks: chunks(), write: (text: string) => void one.said.push(text), close: () => { one.closed = true; one.end(0); }, kill: () => one.end(137), exited };
  };
  return { spawnFrames, made };
}

/** A keyframe as the encoder writes one (its payload a byte), and another frame. */
const KEYFRAME = new Uint8Array([0, 0, 0, 10, 1, 0, 0, 1, 0x9a, 0x7e, 0x4c, 0x40, 0x00, 7]);
const DELTA = new Uint8Array([0, 0, 0, 10, 2, 0, 0, 1, 0x9a, 0x7e, 0x4c, 0x40, 0x64, 8]);

describe("the stream of an agent's desktop you watch", () => {
  const watched = (options: Parameters<typeof desk>[0] = {}) => {
    const s = held();
    const f = frames();
    const d = desk(options);
    const runner = (d.host as unknown as { opts: { runner: DockerRunner } }).opts.runner;
    const host = new SandboxHost({ node: "test", maxCpus: 8, maxMemoryGb: 16, tokens: { mint: () => ({ token: "t", info: { hash: "h" } }), revoke: () => true }, ledger: (entry) => { d.ledger.push(entry); }, runner, spawnSession: s.spawnSession, spawnFrames: f.spawnFrames });
    return { ...d, host, s, f };
  };
  const until = async (ready: () => boolean) => {
    for (let i = 0; i < 500 && !ready(); i++) await Bun.sleep(2);
    if (!ready()) throw new Error("never got there");
  };

  test("one `desktop stream` in its VM however many of your devices watch, each sent its frames from a keyframe; your input asks it for fast frames; watching writes nothing down", async () => {
    const d = watched();
    const first = d.host.desktopWatch(ID, RUN);
    await until(() => d.f.made.length === 1);
    expect(d.f.made[0]!.args).toEqual(["exec", "--interactive", containerName(ID), "desktop", "stream"]);
    d.f.made[0]!.push(KEYFRAME);
    const a = (await first).getReader();
    expect((await a.read()).value).toEqual(KEYFRAME);
    const second = d.host.desktopWatch(ID, RUN);
    await until(() => d.f.made[0]!.said.length === 1);
    expect(d.f.made[0]!.said).toEqual(["key\n"]);
    d.f.made[0]!.push(KEYFRAME);
    const b = (await second).getReader();
    expect((await b.read()).value).toEqual(KEYFRAME);
    expect((await a.read()).value).toEqual(KEYFRAME);
    // Your click: the encoder is asked for fast frames as it is done.
    await d.host.desktop(ID, RUN, { do: "click", x: 3, y: 4 }, false);
    expect(d.f.made[0]!.said).toEqual(["key\n", "fast\n"]);
    d.f.made[0]!.push(DELTA);
    expect((await a.read()).value).toEqual(DELTA);
    expect(d.f.made).toHaveLength(1);
    expect(d.ledger.map((e) => e.detail)).toEqual([TOOK, "click 3 4 left"]);
    await a.cancel();
    await b.cancel();
    expect(d.f.made[0]!.closed).toBe(true);
  });

  test("an encoder that ends before it shows anything is refused with how it ended, and an image older than the stream says so", async () => {
    const d = watched();
    const watching = d.host.desktopWatch(ID, RUN);
    await until(() => d.f.made.length === 1);
    d.f.made[0]!.end(2);
    await expect(watching).rejects.toMatchObject({ status: 424, message: expect.stringContaining("older than its stream") });
  });

  test("only an agent's own running VM with a desktop is watched, and removing it ends its stream", async () => {
    await expect(watched().host.desktopWatch(ID, "arm.team.abcdef0123.other")).rejects.toMatchObject({ status: 403 });
    await expect(watched({ status: "exited" }).host.desktopWatch(ID, RUN)).rejects.toMatchObject({ status: 409 });
    const plain = watched({ image: "invincible/sandbox:1" });
    await expect(plain.host.desktopWatch(ID, RUN)).rejects.toMatchObject({ status: 424, message: expect.stringContaining("has no desktop") });
    expect(plain.f.made).toEqual([]);
    const d = watched();
    const first = d.host.desktopWatch(ID, RUN);
    await until(() => d.f.made.length === 1);
    d.f.made[0]!.push(KEYFRAME);
    const a = (await first).getReader();
    await a.read();
    await d.host.destroy(ID, { approvedBy: "owner" });
    expect(await a.read()).toEqual({ done: true, value: undefined });
    expect(d.f.made[0]!.closed).toBe(true);
  });
});

describe("room for its desktop (C1 step 10): an agent's VM made with 2 GB grows to 4 the first time its desktop is used", () => {
  test("the owner's first look grows it, live, before the look, and the ledger says why; once", async () => {
    const d = desk({ memoryGb: 2 });
    expect(await d.host.desktop(ID, RUN, { do: "look" })).toMatchObject({ width: 1280, height: 800 });
    expect(d.updates).toEqual([["update", "--cpus", "1", "--memory", "4096m", "--memory-swap", "4096m", containerName(ID)]]);
    expect(d.calls.findIndex((a) => a[0] === "update")).toBeLessThan(d.calls.findIndex((a) => a[0] === "exec"));
    expect(d.ledger).toEqual([expect.objectContaining({ resource: "docker.container", verdict: "allow", run: RUN, detail: "grown while it runs: 1 cpu · 4 GB", reason: expect.stringContaining("its desktop's first use") })]);
    await d.host.desktop(ID, RUN, { do: "look" });
    expect(d.updates).toHaveLength(1);
  });

  test("asking whether it is up, how to use it, or stopping it grows nothing; the agent's first command that does something does", async () => {
    const d = desk({ memoryGb: 2 });
    for (const verb of ["status", "help", "stop"]) await d.host.exec(ID, ["desktop", verb]);
    expect(d.updates).toHaveLength(0);
    await d.host.exec(ID, ["desktop", "click", "10", "20"]);
    expect(d.updates).toHaveLength(1);
  });

  test("a look grows it first, though it runs in the agent's shell (its eyes' environment), and so does any desktop verb inside a longer command; one that only asks, or the word in a text, doesn't", async () => {
    const d = desk({ memoryGb: 2 });
    // (How the node runs an agent's command, its primary's computer's included: in a login shell.)
    await d.host.exec(ID, ["bash", "-lc", `cd /work && echo "desktop look is how you ask its eyes" && desktop status && desktop help`]);
    expect(d.updates).toHaveLength(0);
    await d.host.exec(ID, ["bash", "-lc", `echo "eyes: $INVINCIBLE_EYES"; desktop look "What is on the screen right now?"`]);
    expect(d.updates).toEqual([["update", "--cpus", "1", "--memory", "4096m", "--memory-swap", "4096m", containerName(ID)]]);
    const looked = d.calls.findIndex((a) => a[0] === "exec" && a.join(" ").includes('desktop look "What is on the screen'));
    expect(d.calls.findIndex((a) => a[0] === "update")).toBeLessThan(looked);
    expect(d.ledger.find((e) => e.resource === "docker.container")).toMatchObject({ verdict: "allow", reason: expect.stringContaining("its desktop's first use") });
    // Grown once: the next command with a desktop verb in it finds as much already.
    await d.host.exec(ID, ["bash", "-lc", "cd /work && desktop type 'Søren Ærø'"]);
    expect(d.updates).toHaveLength(1);
  });

  test("the desktop verb in a shell command: where a command may begin in it, in a login shell or a plain one; none in a text, or in a command not run by a shell", () => {
    const sh = (script: string, shell = "bash", flag = "-lc") => desktopVerbIn([shell, flag, script]);
    expect(sh('desktop look "Where is Save?"')).toBe("look");
    expect(sh("cd /work && desktop status; desktop shot /tmp/a.png")).toBe("shot");
    expect(sh('x=$(desktop text) && echo "$x"')).toBe("text");
    expect(sh("echo `desktop windows`", "/bin/sh", "-c")).toBe("windows");
    expect(sh("ls\ndesktop click 10 20")).toBe("click");
    expect(sh('echo "use desktop look to ask"; desktop help; desktop stop')).toBeNull();
    expect(sh("my-desktop look")).toBeNull();
    expect(desktopVerbIn(["python3", "-c", "desktop look"])).toBeNull();
    expect(desktopVerbIn(["desktop", "look", "q"])).toBeNull();
  });

  test("a VM without a desktop, with no limit of its own, with as much already, or not an agent's own, is left as it is", async () => {
    for (const d of [desk({ memoryGb: 2, image: "invincible/sandbox:1" }), desk(), desk({ memoryGb: 4 }), desk({ memoryGb: 2, labels: { [`${LABEL}.ephemeral`]: "true" } })]) {
      await d.host.desktop(ID, RUN, { do: "look" }).catch(() => null);
      await d.host.exec(ID, ["desktop", "click", "1", "2"]).catch(() => null);
      expect(d.updates).toHaveLength(0);
    }
  });

  test("one that can't grow is never made again: its desktop runs with what it has, the ledger says why, and it isn't tried again within a minute", async () => {
    const d = desk({ memoryGb: 2, updateFails: true });
    expect(await d.host.desktop(ID, RUN, { do: "look" })).toMatchObject({ width: 1280, height: 800 });
    expect(d.updates).toHaveLength(1);
    expect(d.ledger.find((e) => e.verdict === "deny")).toMatchObject({ resource: "docker.container", reason: expect.stringContaining("its desktop starts with 2 GB, not grown to 4"), detail: "kept as it is, 1 cpu · 2 GB, its work as it was" });
    expect(d.calls.filter((a) => ["run", "rm", "stop", "create", "start"].includes(a[0]!))).toEqual([]);
    await d.host.desktop(ID, RUN, { do: "look" });
    expect(d.updates).toHaveLength(1);
  });
});
