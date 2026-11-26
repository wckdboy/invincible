import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTS, HERMES } from "../src/agents.ts";
import { ENGRAM_BIN, engramArgv } from "../src/engram.ts";
import { HERMES_ACP_BRIDGE } from "../src/hermes.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// A real subprocess speaking the installed Hermes v0.21.1 ACP wire shapes. This
// proves the bridge's protocol behavior, not Hermes' model-backed task quality.
const STAND_IN = String.raw`#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
if "--check" in sys.argv:
    sys.exit(0)
home = Path(os.environ["HERMES_HOME"])
trace = home / "trace.jsonl"
def record(item):
    with trace.open("a") as f:
        f.write(json.dumps(item) + "\n")
record({"env": dict(os.environ), "config": json.loads((home / "config.yaml").read_text()) if (home / "config.yaml").exists() else None})
def send(message):
    print(json.dumps(dict(jsonrpc="2.0", **message)), flush=True)
def reply(ident, result):
    send({"id": ident, "result": result})
def update(item):
    send({"method": "session/update", "params": {"sessionId": "hermes-test-session", "update": item}})
def text(s):
    update({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": s}})
def tool(n):
    update({"sessionUpdate": "tool_call", "toolCallId": str(n), "title": "terminal: test", "kind": "execute", "content": [{"type": "content", "content": {"type": "text", "text": "python3 test.py"}}], "status": "pending"})
    update({"sessionUpdate": "tool_call_update", "toolCallId": str(n), "status": "completed", "content": [{"type": "content", "content": {"type": "text", "text": "passed"}}]})
state = {"modes": {"availableModes": [{"id": "accept_edits", "name": "Accept Edits"}]}}
prompt_id = None
for raw in sys.stdin:
    message = json.loads(raw)
    record(message)
    method, params, ident = message.get("method"), message.get("params", {}), message.get("id")
    if method == "initialize":
        reply(ident, {"protocolVersion": 1, "agentCapabilities": {"loadSession": True}, "agentInfo": {"name": "stand-in", "version": "fixture"}})
    elif method in ("session/new", "session/load") and params["mcpServers"] and (home / "no-mcp").exists():
        send({"id": ident, "error": {"code": -32602, "message": "Invalid params: mcpServers are not supported"}})
    elif method == "session/new":
        (home / "session").write_text("hermes-test-session")
        reply(ident, dict(state, sessionId="hermes-test-session"))
    elif method == "session/load":
        if not (home / "session").exists() or params["sessionId"] != (home / "session").read_text():
            reply(ident, None)
        else:
            text("OLD REPLAY MUST NOT BE NEW OUTPUT")
            tool("old")
            reply(ident, state)
    elif method in ("session/set_model", "session/set_mode"):
        reply(ident, {})
    elif method == "session/prompt":
        prompt_id = ident
        prompt = params["prompt"][0]["text"]
        (home / "started").write_text("started")
        if prompt == "wait":
            continue
        if prompt == "budget":
            for n in range(3):
                tool(n)
            continue
        if prompt == "many":
            for n in range(200):
                tool("m" + str(n))
            text("Many done.")
            reply(ident, {"stopReason": "end_turn", "usage": {"inputTokens": 1, "outputTokens": 1}})
            continue
        if prompt == "rpc-error":
            send({"id": ident, "error": {"code": -32000, "message": "DO-NOT-LEAK-REQUEST-HEADERS"}})
            continue
        send({"id": 800, "method": "session/request_permission", "params": {"sessionId": "hermes-test-session", "options": [{"optionId": "yes", "kind": "allow_always"}]}})
        send({"id": 801, "method": "fs/read_text_file", "params": {"path": "/owner/secret"}})
        # As an agent does, it waits for both answers before it goes on. (Going on at once, its turn could end and the
        # bridge stop it before it had read them: the trace then lacked one, on a busy machine.)
        waiting = {800, 801}
        while waiting:
            raw = sys.stdin.readline()
            if not raw:
                break
            answer = json.loads(raw)
            record(answer)
            waiting.discard(answer.get("id"))
        text("New ")
        tool("new")
        # A duplicate completion must not count twice.
        update({"sessionUpdate": "tool_call_update", "toolCallId": "new", "status": "completed"})
        text("answer.")
        reply(ident, {"stopReason": "end_turn", "usage": {"inputTokens": 10, "outputTokens": 4}})
    elif method == "session/cancel":
        (home / "cancelled").write_text("yes")
        reply(prompt_id, {"stopReason": "cancelled"})
`;

function fixture(bridge = HERMES_ACP_BRIDGE) {
  const dir = mkdtempSync(join(tmpdir(), "galahad-hermes-"));
  dirs.push(dir);
  writeFileSync(join(dir, "bridge.py"), bridge);
  writeFileSync(join(dir, "hermes"), STAND_IN);
  chmodSync(join(dir, "hermes"), 0o700);
  const home = join(dir, "profile");
  const gateway = join(dir, "gateway.json");
  writeFileSync(gateway, JSON.stringify({ OPENAI_API_KEY: "fake-workspace-token", GALAHAD_GATEWAY: "http://192.0.2.1:7777/gw", ANTHROPIC_API_KEY: "ignored" }), { mode: 0o600 });
  const spawn = (prompt: string, extra: string[] = []) => {
    writeFileSync(join(dir, "prompt.md"), prompt);
    return Bun.spawn(["python3", join(dir, "bridge.py"), "--provider", "gateway-provider", "--model", "test-model", "--home", home, "--prompt", join(dir, "prompt.md"), "--gateway-env", gateway, ...extra], {
      cwd: dir,
      env: { PATH: `${dir}:${process.env.PATH}`, OPENAI_API_KEY: "fake-stale-token", GALAHAD_GATEWAY: "http://192.0.2.2/old", ANTHROPIC_API_KEY: "fake-owner-key", SSH_AUTH_SOCK: "/fake/owner-sock" },
      stdout: "pipe", stderr: "pipe",
    });
  };
  const run = async (prompt: string, extra: string[] = []) => {
    const proc = spawn(prompt, extra);
    const [exit, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { exit, stdout, stderr, events: stdout.trim().split("\n").flatMap((l) => HERMES.read(l)) };
  };
  const trace = () => readFileSync(join(home, "trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { dir, home, gateway, spawn, run, trace };
}

describe("Hermes ACP driver", () => {
  test("the registry offers Hermes without requiring a newer CLI JSONL interface", () => {
    expect(AGENTS.hermes).toBe(HERMES);
    expect(HERMES.files([])["/work/.agent/hermes-acp.py"]).toContain("session/load");
    const command = HERMES.command({ provider: "p'; $(danger)", model: "a/b' model" }, "session'; x");
    expect(Bun.spawnSync(["bash", "-n", "-c", command]).exitCode).toBe(0);
    expect(command).not.toContain("--format");
    expect(HERMES.read('{"type":"tokens","input":-1,"output":1}')).toEqual([]);
    expect(HERMES.read("not json")).toEqual([]);
  });

  test("runs, reports tools and usage, and resumes without recounting history", async () => {
    const box = fixture();
    const first = await box.run("do work");
    expect({ exit: first.exit, stderr: first.stderr }).toEqual({ exit: 0, stderr: "" });
    expect(first.events).toEqual([
      { type: "session", id: "hermes-test-session" },
      { type: "tool", tool: "terminal: test", input: "python3 test.py", output: "passed", ok: true },
      { type: "text", text: "New answer." },
      { type: "tokens", input: 10, output: 4 },
    ]);
    const second = await box.run("continue", ["--session", "hermes-test-session"]);
    expect(second.exit).toBe(0);
    expect(second.events).toEqual(first.events);
    const trace = box.trace();
    expect(trace.some((m) => m.method === "session/load")).toBe(true);
    expect(trace.some((m) => m.method === "session/set_model" && m.params.modelId === "custom:galahad:test-model")).toBe(true);
    expect(trace.some((m) => m.method === "session/set_mode" && m.params.modeId === "accept_edits")).toBe(true);
    expect(trace.find((m) => m.id === 800 && m.result)?.result).toEqual({ outcome: { outcome: "cancelled" } });
    expect(trace.find((m) => m.id === 801 && m.error)?.error.code).toBe(-32601);
    const child = trace.find((m) => m.env);
    expect(child.env.OPENAI_API_KEY).toBe("fake-workspace-token");
    expect(child.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(child.env.SSH_AUTH_SOCK).toBeUndefined();
    expect(child.env.HOME).toBe(realpathSync(box.dir));
    expect(child.config.providers.galahad).toMatchObject({ base_url: "http://192.0.2.1:7777/gw/gateway-provider", key_env: "OPENAI_API_KEY", discover_models: false });
    expect(JSON.stringify(child.config)).not.toContain("fake-workspace-token");
  });

  test("a missing saved session fails without silently creating a different one", async () => {
    const box = fixture();
    const result = await box.run("continue", ["--session", "missing"]);
    expect(result.exit).toBe(1);
    expect(result.stdout).toContain("could not be loaded");
    expect(box.trace().some((m) => m.method === "session/new" || m.method === "session/prompt")).toBe(false);
  });

  test("malformed refresh data never falls back to an old workspace token", async () => {
    const box = fixture();
    writeFileSync(box.gateway, '{"OPENAI_API_KEY":"fake-incomplete"}');
    const result = await box.run("work");
    expect(result.exit).toBe(1);
    expect(result.stdout).toContain("environment file is incomplete");
    expect(existsSync(join(box.home, "trace.jsonl"))).toBe(false);
  });

  test("tool budget sends ACP cancellation and reports failure", async () => {
    const box = fixture();
    const result = await box.run("budget", ["--max-tools", "3"]);
    expect(result.exit).toBe(1);
    expect(result.stdout).toContain("tool budget");
    expect(existsSync(join(box.home, "cancelled"))).toBe(true);
  });

  test("a knight's run has no tool budget of the bridge's own: two hundred tools, and it ends as it ends (one asked for still holds, above)", async () => {
    const result = await fixture().run("many");
    expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
    expect(result.events.filter((e) => e.type === "tool")).toHaveLength(200);
    expect(result.events.find((e) => e.type === "text")).toEqual({ type: "text", text: "Many done." });
  });

  test("a stop signal cancels the live ACP prompt before the subprocess ends", async () => {
    const box = fixture();
    const proc = box.spawn("wait");
    try {
      const deadline = Date.now() + 3000;
      while (!existsSync(join(box.home, "started")) && Date.now() < deadline) await Bun.sleep(10);
      expect(existsSync(join(box.home, "started"))).toBe(true);
      proc.kill("SIGTERM");
      expect(await proc.exited).toBe(1);
      expect(existsSync(join(box.home, "cancelled"))).toBe(true);
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 6000);

  test("RPC failures do not expose raw provider error payloads", async () => {
    const result = await fixture().run("rpc-error");
    expect(result.exit).toBe(1);
    expect(result.stdout).toContain("rejected session/prompt");
    expect(result.stdout).not.toContain("DO-NOT-LEAK");
  });
});

/* The VM's notes store (engram.ts): Hermes is handed its server when a session is opened, and starts it itself. */
describe("Hermes and the notes store", () => {
  const withNotes = () => fixture(HERMES.files([], "you-project")["/work/.agent/hermes-acp.py"]!);
  /** The one stdio server, as ACP names one: its environment inside the entry (the bridge's own is an allowlist). */
  const server = { name: "engram", command: ENGRAM_BIN, args: engramArgv("you-project").slice(1), env: [{ name: "ENGRAM_DATA_DIR", value: "/work/.memory/engram" }, { name: "ENGRAM_NO_UPDATE_CHECK", value: "1" }] };
  const opened = (trace: any[], method: string) => trace.filter((m) => m.method === method).map((m) => m.params.mcpServers);

  test("without the store a session is opened with no MCP server, as ever", async () => {
    const box = fixture();
    expect((await box.run("do work")).exit).toBe(0);
    expect((await box.run("continue", ["--session", "hermes-test-session"])).exit).toBe(0);
    expect(opened(box.trace(), "session/new")).toEqual([[]]);
    expect(opened(box.trace(), "session/load")).toEqual([[]]);
  });

  test("with it, a new session and a resumed one are opened with exactly that one server, and the run is otherwise the same", async () => {
    const plain = await fixture().run("do work");
    const box = withNotes();
    const first = await box.run("do work");
    expect({ exit: first.exit, stderr: first.stderr }).toEqual({ exit: 0, stderr: "" });
    expect(first.events).toEqual(plain.events);
    const second = await box.run("continue", ["--session", "hermes-test-session"]);
    expect(second.exit).toBe(0);
    expect(second.events).toEqual(plain.events);
    expect(opened(box.trace(), "session/new")).toEqual([[server]]);
    expect(opened(box.trace(), "session/load")).toEqual([[server]]);
    // Hermes itself is started with the same allowlisted environment: nothing of the store is put in it.
    const child = box.trace().find((m) => m.env);
    expect(Object.keys(child.env).filter((name) => name.startsWith("ENGRAM"))).toEqual([]);
    expect(child.env.SSH_AUTH_SOCK).toBeUndefined();
    // Asking whether Hermes is there opens no session, with the store or without.
    const check = await box.run("unused", ["--check"]);
    expect(check.exit).toBe(0);
    expect(check.stdout).toContain("Hermes ACP is ready");
  });

  test("an agent that takes no MCP server refuses the session: it is asked again without, and the run says it has no notes store", async () => {
    const box = withNotes();
    mkdirSync(box.home, { recursive: true });
    writeFileSync(join(box.home, "no-mcp"), "");
    const first = await box.run("do work");
    expect({ exit: first.exit, stderr: first.stderr }).toEqual({ exit: 0, stderr: "" });
    expect(first.events).toEqual([
      { type: "text", text: "Hermes refused a session with the notes store's MCP server: this run has no notes store" },
      { type: "session", id: "hermes-test-session" },
      { type: "tool", tool: "terminal: test", input: "python3 test.py", output: "passed", ok: true },
      { type: "text", text: "New answer." },
      { type: "tokens", input: 10, output: 4 },
    ]);
    expect(opened(box.trace(), "session/new")).toEqual([[server], []]);
    // A resumed session is asked the same way, and the session it continues is the same one.
    const second = await box.run("continue", ["--session", "hermes-test-session"]);
    expect(second.exit).toBe(0);
    expect(second.events[0]).toEqual({ type: "text", text: "Hermes refused a session with the notes store's MCP server: this run has no notes store" });
    expect(second.events[1]).toEqual({ type: "session", id: "hermes-test-session" });
    expect(opened(box.trace(), "session/load")).toEqual([[server], []]);
  });

  test("a session that fails for another reason is not opened a second way: a missing one still fails, and is not replaced", async () => {
    const box = withNotes();
    const result = await box.run("continue", ["--session", "missing"]);
    expect(result.exit).toBe(1);
    expect(result.stdout).toContain("could not be loaded");
    expect(result.stdout).not.toContain("notes store");
    expect(opened(box.trace(), "session/load")).toEqual([[server]]);
    expect(box.trace().some((m) => m.method === "session/new" || m.method === "session/prompt")).toBe(false);
  });

  test("the bridge with the store still speaks to nobody itself, and runs nothing of the store's own", () => {
    const bridge = HERMES.files([], "you-project")["/work/.agent/hermes-acp.py"]!;
    expect(bridge.startsWith(HERMES_ACP_BRIDGE.slice(0, HERMES_ACP_BRIDGE.lastIndexOf("\nif __name__"))) ).toBe(true);
    expect(bridge).not.toMatch(/user.agent|urllib\.request|http\.client|\bsocket\b|\bcurl\b|\bwget\b/i);
    expect(Object.keys(HERMES.files([], "you-project"))).toEqual(["/work/.agent/hermes-acp.py"]);
    expect(HERMES.command({ provider: "p", model: "m" }, null)).not.toContain("engram");
  });
});

test("the native Hermes memory provider enforces its local credential and write boundaries", async () => {
  const proc = Bun.spawn(["python3", "-B", new URL("../../../integrations/hermes/test_memory_provider.py", import.meta.url).pathname], { stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  expect({ exit, stdout, stderr: exit ? stderr : "" }).toEqual({ exit: 0, stdout: "", stderr: "" });
});
