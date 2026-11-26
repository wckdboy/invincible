import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adminClient, signedClient } from "../../src/inv/client.ts";
import { CliHome, keystoreFor } from "../../src/inv/config.ts";
import { CliError, EXIT } from "../../src/inv/exit.ts";
import { run } from "../../src/inv/run.ts";
import { freePort } from "../ports.ts";
import { testIo } from "./fixtures.ts";

/*
 * inv's exit codes are a promise (docs/CLI.md, "Exit codes"): the table in the code is the table in the document, and
 * each way a command can go wrong has its code. 31 when nothing (or not the node) answers; 30 when the node refuses
 * this device; 2 for bad usage; 1 for anything else it refused.
 */

const root = mkdtempSync(join(tmpdir(), "inv-exit-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** An environment of its own: a CLI home and a node home, both temporary and empty, and the key in a file. */
const fresh = (name: string) => ({ INVINCIBLE_CLI_HOME: join(root, name, "cli"), INVINCIBLE_HOME: join(root, name, "node"), INVINCIBLE_KEYSTORE: "file" });

describe("the codes are the contract's", () => {
  test("every code docs/CLI.md promises is in the code, and no other", () => {
    const doc = readFileSync(join(import.meta.dir, "../../../../docs/CLI.md"), "utf8");
    const table = doc.slice(doc.indexOf("## Exit codes"), doc.indexOf("## The proof"));
    const promised = [...table.matchAll(/^\| (\d+) \| \*\*/gm)].map((match) => Number(match[1]));
    expect(promised).toEqual([0, 1, 2, 10, 11, 12, 13, 20, 21, 30, 31]);
    expect(([...Object.values(EXIT)] as number[]).sort((a, b) => a - b)).toEqual(promised);
  });
});

describe("what went wrong, as its code", () => {
  const port = freePort();
  const said: Record<string, { status: number; body: string; type?: string }> = {
    "/api/team": { status: 401, body: JSON.stringify({ error: "sign the request with an enrolled device key" }) },
    "/api/fleet": { status: 403, body: JSON.stringify({ error: "requires scope mind:read" }) },
    "/api/projects": { status: 409, body: JSON.stringify({ error: "a refusal of its own" }) },
    "/api/actions": { status: 502, body: "<html>Bad gateway</html>", type: "text/html" },
    "/api/whoami": { status: 200, body: JSON.stringify({ error: "it broke halfway", status: 500 }) },
  };
  const server = Bun.serve({ port, hostname: "127.0.0.1", fetch: (req) => {
    const answer = said[new URL(req.url).pathname] ?? { status: 404, body: "{}" };
    return new Response(answer.body, { status: answer.status, headers: { "content-type": answer.type ?? "application/json" } });
  } });
  afterAll(() => server.stop(true));
  const node = signedClient(`http://127.0.0.1:${port}`, "c_test", () => new Uint8Array(64), { label: "the test node" });
  const codeOf = (promise: Promise<unknown>) => promise.then(() => null, (error: CliError) => [error.exit, error.message]);

  test("refused this device (401, 403): 30; another refusal: 1; a proxy whose node is down, or an error that came late: as they are", async () => {
    expect(await codeOf(node.call("team"))).toEqual([EXIT.refused, "the test node doesn't know this device now (revoked, or never approved): pair it again with inv pair <invite>"]);
    expect(await codeOf(node.call("fleet"))).toEqual([EXIT.refused, "the test node refused: requires scope mind:read (this device was paired without it: invincible grant <device> <scope> on the node gives it)"]);
    expect(await codeOf(node.call("projects"))).toEqual([EXIT.error, "a refusal of its own"]);
    expect((await codeOf(node.call("actions")))?.[0]).toBe(EXIT.unreachable);
    expect(await codeOf(node.call("whoami"))).toEqual([EXIT.error, "it broke halfway"]);
    // The local node's admin token, refused: said as what it is.
    expect((await codeOf(adminClient(`http://127.0.0.1:${port}`, "adm_test").call("team")))?.[0]).toBe(EXIT.refused);
  });

  test("nothing answers at its address: 31", async () => {
    const nobody = signedClient(`http://127.0.0.1:${freePort()}`, "c_test", () => new Uint8Array(64));
    expect((await codeOf(nobody.call("team")))?.[0]).toBe(EXIT.unreachable);
    const stream = nobody.events("live");
    expect((await codeOf(stream.next()))?.[0]).toBe(EXIT.unreachable);
  });
});

describe("usage", () => {
  test("a flag no command has, one a command doesn't take, a typo, a malformed value, both machine layers: 2, saying what is right", async () => {
    for (const argv of [["tasks", "--bogus"], ["tasks", "--wait"], ["proof", "x", "--for-task"], ["taks"], ["give"], ["give", "x", "--budget", "500"], ["give", "x", "--timeout", "soon"], ["tasks", "--json", "--stream"], ["--node", "remote"], ["again", "x", "--from", "zero"], ["--timeout"]]) {
      const io = testIo(fresh("usage"));
      expect([argv.join(" "), await run(argv, io)]).toEqual([argv.join(" "), EXIT.usage]);
      expect(io.stderr()).toMatch(/^inv: /);
    }
  });

  test("help is the commands, with the exit codes, and exits 0", async () => {
    const io = testIo(fresh("help"));
    expect(await run(["help"], io)).toBe(EXIT.ok);
    expect(io.stdout()).toContain("0 verified · 1 error · 2 bad usage · 10 a gate failed");
    expect(await run(["--help"], testIo(fresh("help")))).toBe(EXIT.ok);
  });

  test("no node to talk to: 31; with --json, stdout is one object that says so", async () => {
    const io = testIo(fresh("nowhere"));
    expect(await run(["tasks", "--json"], io)).toBe(EXIT.unreachable);
    expect(JSON.parse(io.stdout())).toEqual({ error: expect.stringContaining("no node to talk to"), exit: 31 });
  });
});

describe("where the pairing and the key are kept", () => {
  test("the key is in a file only this user may read where there is no keychain, or when asked; on a Mac, the login keychain", async () => {
    expect(keystoreFor({}, "linux")).toBe("file");
    expect(keystoreFor({}, "darwin")).toBe("keychain");
    expect(keystoreFor({ INVINCIBLE_KEYSTORE: "file" }, "darwin")).toBe("file");
    const home = CliHome.resolve(fresh("keys"));
    const key = await home.newKey("file");
    expect(statSync(home.keyPath).mode & 0o777).toBe(0o600);
    expect(key.id).toMatch(/^c_[A-Za-z0-9_-]{87}$/);
    expect((await home.key({ keystore: "file", device: key.id })).id).toBe(key.id);
    // Another device's id with this key, or no key at all, is refused (30), never signed with.
    expect(await home.key({ keystore: "file", device: `c_${"x".repeat(87)}` }).then(() => 0, (error: CliError) => error.exit)).toBe(EXIT.refused);
    await home.forget("file");
    expect(await home.key({ keystore: "file", device: key.id }).then(() => 0, (error: CliError) => error.exit)).toBe(EXIT.refused);
  });

  test("its home is its own, never the node's: INVINCIBLE_CLI_HOME, else XDG_CONFIG_HOME/invincible, else ~/.config/invincible", () => {
    expect(CliHome.resolve({ INVINCIBLE_CLI_HOME: "/tmp/one" }).dir).toBe("/tmp/one");
    expect(CliHome.resolve({ XDG_CONFIG_HOME: "/tmp/config" }).dir).toBe("/tmp/config/invincible");
    expect(CliHome.resolve({}).dir).toMatch(/\.config\/invincible$/);
  });
});
