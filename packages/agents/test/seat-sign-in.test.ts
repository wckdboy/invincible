import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_SIGN_IN, CODEX_SIGN_IN } from "../src/seat-sign-in.ts";

/*
 * A seat's sign-in bridges (seat-sign-in.ts), against stand-ins of the vendors' tools that sign in as each does: Claude
 * Code prints its page and asks for the code that page shows, on a terminal of its own; Codex's app server answers
 * account/login/start with its device page and code, and says when the sign-in completes. Each bridge says what the
 * tool asks of you and how it ended, gives Claude Code your code once and to its terminal alone, and ends the tool when
 * the sign-in is cancelled, or when it waits too long.
 */

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const PYTHON = Bun.which("python3")!;
// Fake, every one: a page's address with its state, Claude's one-time code, Codex's device code.
const PAGE = "https://claude.ai/oauth/authorize?code=true&client_id=FAKE-client&redirect_uri=https%3A%2F%2Fexample.test%2Fcallback&state=FAKE-state-0000";
const CODE = "FAKEcode0000#FAKE-state-0000";

const CLAUDE_STAND_IN = `#!${PYTHON}
import json, os, signal, sys, time
from pathlib import Path
here = Path(__file__).resolve().parent
def record(item):
    with (here / "trace.jsonl").open("a") as f:
        f.write(json.dumps(item) + "\\n")
def ended(*_):
    record({"ended": "SIGTERM"})
    sys.exit(143)
signal.signal(signal.SIGTERM, ended)
record({"argv": sys.argv[1:], "tty": os.isatty(0), "columns": os.get_terminal_size(0).columns if os.isatty(0) else None})
# As Claude Code says it in a terminal with no browser: its colours, its page, and the prompt for the page's code.
sys.stdout.write("\\x1b[1mWelcome to Claude Code\\x1b[0m\\r\\n")
sys.stdout.write("Browser didn't open? Use the url below to sign in (c to copy)\\r\\n\\r\\n")
sys.stdout.write("${PAGE}\\r\\n\\r\\n")
sys.stdout.write("Paste code here if prompted > ")
sys.stdout.flush()
mode = (here / "mode").read_text() if (here / "mode").exists() else "sign-in"
if mode == "hang":
    time.sleep(3600)
line = sys.stdin.readline().strip()
record({"code": line})
if line == "${CODE}":
    # A second code, if one came, would be read here: it never should.
    sys.stdout.write("\\r\\nLogin successful.\\r\\n")
    sys.stdout.flush()
    time.sleep(0.2)
    sys.exit(0)
sys.stdout.write("\\r\\nOAuth error: Invalid code\\r\\n")
sys.exit(1)
`;

const CODEX_STAND_IN = `#!${PYTHON}
import json, os, signal, sys, time
from pathlib import Path
here = Path(__file__).resolve().parent
def record(item):
    with (here / "trace.jsonl").open("a") as f:
        f.write(json.dumps(item) + "\\n")
def ended(*_):
    record({"ended": "SIGTERM"})
    sys.exit(143)
signal.signal(signal.SIGTERM, ended)
def out(message):
    sys.stdout.write(json.dumps(message) + "\\n")
    sys.stdout.flush()
record({"argv": sys.argv[1:]})
mode = (here / "mode").read_text() if (here / "mode").exists() else "sign-in"
for raw in sys.stdin:
    said = json.loads(raw)
    record({"asked": said.get("method"), "params": said.get("params")})
    if said.get("method") == "initialize":
        out({"id": said["id"], "result": {"userAgent": "invincible/0.172.0", "codexHome": str(here), "platformFamily": "unix", "platformOs": "linux"}})
    elif said.get("method") == "account/login/start":
        if mode == "refuse":
            out({"id": said["id"], "error": {"code": -32600, "message": "device code sign-in is off for this workspace"}})
            continue
        out({"id": said["id"], "result": {"type": "chatgptDeviceCode", "loginId": "login-FAKE-0001", "verificationUrl": "https://auth.openai.com/codex/device", "userCode": "FAKE-1234"}})
        if mode == "sign-in":
            # The owner signs in on the device page, and the server says so.
            time.sleep(0.5)
            out({"method": "account/login/completed", "params": {"loginId": "login-FAKE-0001", "success": True, "error": None, "onboardingEntrypoint": None}})
    elif said.get("method") == "account/login/cancel":
        out({"id": said["id"], "result": {"status": "canceled"}})
`;

/** A seat's VM in miniature: the stand-in tool on PATH, its trace, and the bridge run as the node runs it. */
function seatVm(tool: "claude" | "codex", mode = "sign-in") {
  const dir = mkdtempSync(join(tmpdir(), `seat-sign-in-${tool}-`));
  dirs.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, tool), tool === "claude" ? CLAUDE_STAND_IN : CODEX_STAND_IN);
  chmodSync(join(bin, tool), 0o700);
  writeFileSync(join(bin, "mode"), mode);
  const proc = Bun.spawn([PYTHON, "-c", tool === "claude" ? CLAUDE_SIGN_IN : CODEX_SIGN_IN], {
    cwd: dir,
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, LANG: "C.UTF-8" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const said: Record<string, unknown>[] = [];
  const reading = (async () => {
    const decoder = new TextDecoder();
    let held = "";
    for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
      held += decoder.decode(chunk, { stream: true });
      let at: number;
      while ((at = held.indexOf("\n")) >= 0) {
        said.push(JSON.parse(held.slice(0, at)));
        held = held.slice(at + 1);
      }
    }
  })();
  const tell = (line: unknown) => {
    proc.stdin.write(`${JSON.stringify(line)}\n`);
    proc.stdin.flush();
  };
  const until = async (type: string, ms = 10_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const found = said.find((line) => line.type === type);
      if (found) return found;
      await Bun.sleep(20);
    }
    throw new Error(`no ${type} in ${JSON.stringify(said)}`);
  };
  const trace = (): Record<string, unknown>[] => (existsSync(join(bin, "trace.jsonl")) ? readFileSync(join(bin, "trace.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);
  return { proc, said, tell, until, trace, done: async () => (await proc.exited, await reading, said.at(-1)) };
}

describe("Claude Code's sign-in", () => {
  test("its page on the card, the code your page showed to its terminal, and signed in", async () => {
    const vm = seatVm("claude");
    vm.tell({ email: "owner@example.test" });
    expect(await vm.until("card")).toEqual({ type: "card", url: PAGE });
    expect(await vm.until("asks")).toEqual({ type: "asks" });
    vm.tell({ code: CODE });
    expect(await vm.done()).toEqual({ type: "done", ok: true });
    const [started, answered] = vm.trace();
    // The vendor's own sign-in, on a terminal of its own wide enough for its address, for the seat's account.
    expect(started).toEqual({ argv: ["auth", "login", "--claudeai", "--email", "owner@example.test"], tty: true, columns: 4000 });
    expect(answered).toEqual({ code: CODE });
    // What it prints is the card, that its tool took the code, and how it ended: never the code, and the page only on
    // its card.
    expect(vm.said.map((line) => line.type)).toEqual(["card", "asks", "took", "done"]);
    expect(JSON.stringify(vm.said)).not.toContain(CODE);
  });

  test("the code reaches it exactly once, however often it is sent", async () => {
    const vm = seatVm("claude");
    vm.tell({});
    await vm.until("asks");
    vm.tell({ code: CODE });
    vm.tell({ code: CODE });
    vm.tell({ code: "FAKEother000#FAKE-state-0000" });
    expect(await vm.done()).toEqual({ type: "done", ok: true });
    expect(vm.trace().filter((item) => "code" in item)).toEqual([{ code: CODE }]);
    // Each one after the first is said to be refused, as one already given: the node tells you so.
    expect(vm.said.filter((line) => line.type === "took" || line.type === "refused")).toEqual([{ type: "took" }, { type: "refused", why: "answered" }, { type: "refused", why: "answered" }]);
    // With no email it starts on no account: the page asks.
    expect(vm.trace()[0]!.argv).toEqual(["auth", "login", "--claudeai"]);
  });

  test("a code that isn't one, or an email that isn't one, never reaches it", async () => {
    const vm = seatVm("claude");
    vm.tell({ email: "owner@example.test --sso; rm -rf /" });
    await vm.until("asks");
    vm.tell({ code: "two words" });
    vm.tell({ code: CODE });
    expect(await vm.done()).toEqual({ type: "done", ok: true });
    expect(vm.trace()[0]!.argv).toEqual(["auth", "login", "--claudeai"]);
    expect(vm.trace().filter((item) => "code" in item)).toEqual([{ code: CODE }]);
  });

  test("cancelled, or its input ended, it is ended, and says why", async () => {
    const vm = seatVm("claude", "hang");
    vm.tell({});
    await vm.until("asks");
    vm.tell({ cancel: true });
    expect(await vm.done()).toEqual({ type: "done", ok: false, why: "cancelled" });
    expect(vm.trace().at(-1)).toEqual({ ended: "SIGTERM" });
    const closed = seatVm("claude", "hang");
    closed.tell({});
    await closed.until("asks");
    closed.proc.stdin.end();
    expect(await closed.done()).toEqual({ type: "done", ok: false, why: "cancelled" });
  }, 20_000);

  test("a code its page didn't give: it says it isn't signed in", async () => {
    const vm = seatVm("claude");
    vm.tell({});
    await vm.until("asks");
    vm.tell({ code: "FAKEwrong000#FAKE-state-0000" });
    expect(await vm.done()).toEqual({ type: "done", ok: false, why: "it ended without saying it was signed in" });
  });
});

describe("Codex's sign-in, by ChatGPT's device code", () => {
  test("its device page and code on the card, and signed in when its server says so", async () => {
    const vm = seatVm("codex");
    vm.tell({});
    expect(await vm.until("card")).toEqual({ type: "card", url: "https://auth.openai.com/codex/device", code: "FAKE-1234" });
    expect(await vm.done()).toEqual({ type: "done", ok: true });
    const asked = vm.trace();
    // Its own app server, its sign-in kept in a file in its home, and asked for a device code alone.
    expect(asked[0]).toEqual({ argv: ["app-server", "-c", 'cli_auth_credentials_store="file"'] });
    expect(asked.slice(1).map((item) => item.asked)).toEqual(["initialize", "initialized", "account/login/start"]);
    expect(asked[3]!.params).toEqual({ type: "chatgptDeviceCode" });
  });

  test("cancelled, its server is told to cancel the sign-in it began", async () => {
    const vm = seatVm("codex", "wait");
    vm.tell({});
    await vm.until("card");
    vm.tell({ cancel: true });
    expect(await vm.done()).toEqual({ type: "done", ok: false, why: "cancelled" });
    expect(vm.trace().find((item) => item.asked === "account/login/cancel")?.params).toEqual({ loginId: "login-FAKE-0001" });
  });

  test("a server that won't start a sign-in says why, and there is no card", async () => {
    const vm = seatVm("codex", "refuse");
    vm.tell({});
    expect(await vm.done()).toEqual({ type: "done", ok: false, why: "device code sign-in is off for this workspace" });
    expect(vm.said.some((line) => line.type === "card")).toBe(false);
  });
});
