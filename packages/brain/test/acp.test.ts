import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACP_BRIDGE, ACP_PROBE, acpDriver, driverFor, OWN_SIGN_IN } from "../src/agents.ts";
import { HERMES } from "../src/hermes.ts";

/*
 * Any agent that speaks the Agent Client Protocol, as a knight's harness (PLAN #30): the bridge run in its VM against a
 * stand-in agent, a real subprocess speaking ACP protocol 1's wire shapes. It proves what the bridge does with what an
 * agent says and asks, not what any agent's model would do.
 */

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const STAND_IN = String.raw`#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
here = Path(os.environ["HOME"])
trace = here / "trace.jsonl"
def record(item):
    with trace.open("a") as f:
        f.write(json.dumps(item) + "\n")
record({"env": dict(os.environ), "argv": sys.argv[1:]})
if (here / "silent").exists():
    sys.exit(0)
def send(message):
    print(json.dumps(dict(jsonrpc="2.0", **message)), flush=True)
def reply(ident, result):
    send({"id": ident, "result": result})
def update(item):
    send({"method": "session/update", "params": {"sessionId": "acp-session", "update": item}})
resumable = (here / "resumable").exists()
models = {"currentModelId": "its-own", "availableModels": [{"modelId": "its-own", "name": "Its own"}, {"modelId": "test-model", "name": "Test"}]}
for raw in sys.stdin:
    message = json.loads(raw)
    record(message)
    method, params, ident = message.get("method"), message.get("params", {}), message.get("id")
    if method == "initialize":
        reply(ident, {"protocolVersion": 1, "agentCapabilities": {"loadSession": resumable}, "agentInfo": {"name": "stand-in", "version": "fixture"}})
    elif method == "session/new":
        reply(ident, {"sessionId": "acp-session", "models": models})
    elif method == "session/load":
        update({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "OLD REPLAY"}})
        reply(ident, {"models": models})
    elif method == "session/set_model":
        reply(ident, {})
    elif method == "session/prompt":
        # It asks to run a command (once or always: the bridge gives it once) and to read a file of the client's.
        send({"id": 900, "method": "session/request_permission", "params": {"sessionId": "acp-session", "toolCall": {"toolCallId": "t1"}, "options": [{"optionId": "always", "kind": "allow_always", "name": "Always"}, {"optionId": "once", "kind": "allow_once", "name": "Once"}, {"optionId": "no", "kind": "reject_once", "name": "No"}]}})
        send({"id": 901, "method": "fs/read_text_file", "params": {"path": "/owner/secret"}})
        waiting = {900, 901}
        while waiting:
            answer = json.loads(sys.stdin.readline())
            record(answer)
            waiting.discard(answer.get("id"))
        # More tools than Hermes' budget: a knight's ACP agent has none.
        for n in range(200):
            update({"sessionUpdate": "tool_call", "toolCallId": str(n), "title": "terminal", "kind": "execute", "rawInput": {"command": "true"}, "status": "pending"})
            update({"sessionUpdate": "tool_call_update", "toolCallId": str(n), "status": "completed", "rawOutput": "ok"})
        update({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Done, "}})
        update({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "and checked."}})
        reply(ident, {"stopReason": "end_turn"})
`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "galahad-acp-"));
  dirs.push(dir);
  writeFileSync(join(dir, "bridge.py"), ACP_BRIDGE);
  writeFileSync(join(dir, "probe.py"), ACP_PROBE);
  writeFileSync(join(dir, "standin"), STAND_IN);
  chmodSync(join(dir, "standin"), 0o700);
  const gateway = join(dir, "gateway.json");
  writeFileSync(gateway, JSON.stringify({ OPENAI_API_KEY: "fake-workspace-token", GALAHAD_GATEWAY: "http://192.0.2.1:7777/gw" }), { mode: 0o600 });
  const env = { PATH: `${dir}:${process.env.PATH}`, HOME: dir, OPENAI_API_KEY: "fake-stale-token", ANTHROPIC_API_KEY: "fake-owner-key", SSH_AUTH_SOCK: "/fake/owner-sock" };
  const run = async (extra: string[], command = "standin acp --flag") => {
    writeFileSync(join(dir, "prompt.md"), "Do the work.");
    const proc = Bun.spawn(["python3", join(dir, "bridge.py"), "--command", command, "--name", "Stand-in", "--prompt", join(dir, "prompt.md"), "--gateway-env", gateway, ...extra], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { exit, stdout, stderr, events: stdout.trim().split("\n").flatMap((line) => acpDriver("standin acp").read(line)) };
  };
  const probe = async (command: string) => {
    const proc = Bun.spawn(["python3", "-c", ACP_PROBE, command], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { exit, stdout: stdout.trim(), stderr: stderr.trim() };
  };
  const trace = () => readFileSync(join(dir, "trace.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return { dir, run, probe, trace };
}

describe("any ACP agent as a knight's harness", () => {
  test("it runs the command you named, gives what it asks once, answers nothing of the client's, and follows it to its end: every tool it ran, its last words", async () => {
    const box = fixture();
    const result = await box.run(["--provider", "gateway-provider", "--model", "test-model"]);
    expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
    expect(result.events.filter((e) => e.type === "tool")).toHaveLength(200);
    expect(result.events.filter((e) => e.type !== "tool")).toEqual([{ type: "text", text: "Done, and checked." }, { type: "tokens", input: 0, output: 0 }]);
    const trace = box.trace();
    // Started as you named it, with its arguments.
    expect(trace.find((m) => m.argv)?.argv).toEqual(["acp", "--flag"]);
    // Once, where it offers that: never always.
    expect(trace.find((m) => m.id === 900 && m.result)?.result).toEqual({ outcome: { outcome: "selected", optionId: "once" } });
    expect(trace.find((m) => m.id === 901 && m.error)?.error.code).toBe(-32601);
    // The model it is offered: by name where it lists it, and through the gateway in the variables agents read.
    expect(trace.some((m) => m.method === "session/set_model" && m.params.modelId === "test-model")).toBe(true);
    const child = trace.find((m) => m.env)!.env;
    expect({ base: child.OPENAI_BASE_URL, key: child.OPENAI_API_KEY, model: child.OPENAI_MODEL, home: child.HOME }).toEqual({ base: "http://192.0.2.1:7777/gw/gateway-provider", key: "fake-workspace-token", model: "test-model", home: box.dir });
    // Nothing of the owner's: no other key, no SSH agent.
    expect(child.ANTHROPIC_API_KEY).toBeUndefined();
    expect(child.SSH_AUTH_SOCK).toBeUndefined();
    // An agent that can't load a session again is not given one to keep: the next run starts anew.
    expect(result.events.some((e) => e.type === "session")).toBe(false);
  });

  test("on its own setup (no gateway model), nothing of the gateway is put in its way; a session it can load again is kept and loaded, its history not counted again", async () => {
    const box = fixture();
    writeFileSync(join(box.dir, "resumable"), "");
    const first = await box.run([]);
    expect(first.exit).toBe(0);
    expect(first.events[0]).toEqual({ type: "session", id: "acp-session" });
    const child = box.trace().find((m) => m.env)!.env;
    expect(child.OPENAI_BASE_URL).toBeUndefined();
    expect(child.OPENAI_API_KEY).toBeUndefined();
    // (And on its own setup, the model it already chose is left as it is.)
    expect(box.trace().some((m) => m.method === "session/set_model")).toBe(false);
    const second = await box.run(["--session", "acp-session"]);
    expect(second.exit).toBe(0);
    expect(box.trace().some((m) => m.method === "session/load" && m.params.sessionId === "acp-session")).toBe(true);
    expect(second.events.find((e) => e.type === "text")).toEqual({ type: "text", text: "Done, and checked." });
  });

  test("whether the command starts an ACP agent is asked of it: one that answers, one that ends without answering, one that isn't there", async () => {
    const box = fixture();
    expect(await box.probe("standin acp")).toEqual({ exit: 0, stdout: "standin speaks ACP (protocol 1)", stderr: "" });
    writeFileSync(join(box.dir, "silent"), "");
    expect(await box.probe("standin")).toMatchObject({ exit: 1, stderr: "standin gave no ACP answer in 20 seconds: is this the command that starts it in its ACP mode?" });
    expect(await box.probe("not-installed acp")).toMatchObject({ exit: 1, stderr: "not-installed isn't installed in this VM" });
    // The bridge says the same of a missing agent in its own words.
    const missing = await box.run([], "not-installed acp");
    expect(missing.exit).toBe(1);
    expect(missing.events).toEqual([{ type: "error", message: "Stand-in isn't installed in this VM (not-installed was not found)" }]);
  });

  test("the driver: a command of plain words only, quoted safely in every command it makes; known agents by their names; its own setup when no model is offered", () => {
    expect(() => acpDriver("goose acp; rm -rf /")).toThrow("plain words");
    expect(() => acpDriver("goose $(id)")).toThrow("plain words");
    expect(() => acpDriver("")).toThrow("plain words");
    const goose = acpDriver("goose acp");
    expect({ title: goose.title, kind: goose.kind, ownSetup: goose.ownSetup }).toEqual({ title: "Goose", kind: "openai", ownSetup: true });
    expect(acpDriver("/usr/local/bin/gemini --acp").title).toBe("Gemini CLI");
    expect(acpDriver("my-agent serve --acp").title).toBe("my-agent");
    for (const command of [goose.command({ provider: "p'; $(danger)", model: "a/b' model" }, "session'; x"), goose.command(OWN_SIGN_IN, null), goose.check]) {
      expect(Bun.spawnSync(["bash", "-n", "-c", command]).exitCode).toBe(0);
    }
    expect(goose.command(OWN_SIGN_IN, null)).not.toContain("--provider");
    expect(Object.keys(goose.files([]))).toEqual(["/work/.agent/acp-bridge.py"]);
    // With the VM's notes store: its server is offered when a session is opened, as Hermes is.
    const noted = goose.files([], "you-project")["/work/.agent/acp-bridge.py"]!;
    expect(noted).toContain("you-project");
    expect(noted).toContain("mcpServers=NOTES");
    // A harness is its driver; an ACP one with no command has none.
    expect(driverFor("hermes")).toBe(HERMES);
    expect(driverFor("acp", "goose acp")?.title).toBe("Goose");
    expect(driverFor("acp")).toBeUndefined();
  });
});
