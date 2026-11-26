import { describe, expect, spyOn, test } from "bun:test";
import { type Api, statusLine } from "../src/loop-cli.ts";

/*
 * `galahad status`'s last line says what needs you, as the apps' Inbox counts it: every kind of thing in it, never
 * "nothing needs you" while one waits.
 */

/** A node that answers each route as given; one it doesn't answer is an older node's, and counts as none. */
const node = (answers: Record<string, unknown>): Api => ({
  async call<T>(name: string): Promise<T> {
    if (name in answers) return answers[name] as T;
    throw new Error(`no route ${name}`);
  },
});

async function said(answers: Record<string, unknown>): Promise<string> {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await statusLine(node(answers));
    return log.mock.calls.map((call) => String(call[0])).join("\n");
  } finally {
    log.mockRestore();
  }
}

const quiet = { loops: { loops: [] }, notices: { notices: [] }, actions: { actions: [] } };

describe("galahad status: what needs you", () => {
  test("a key he asked for needs you: the line never says nothing does", async () => {
    const line = await said({ ...quiet, secretRequests: { requests: [{ name: "stack-overflow", purpose: "its MCP server" }] } });
    expect(line).not.toContain("nothing needs you");
    expect(line).toContain("1 key asked for (galahad secret list)");
  });

  test("each kind that waits is said once, with where to answer it", async () => {
    const line = await said({
      ...quiet,
      notices: { notices: [{ key: "a", dismissed: false }, { key: "b", dismissed: true }] },
      actions: { actions: [{ state: "waiting" }, { state: "done" }] },
      secretRequests: { requests: [{ name: "a" }, { name: "b" }] },
      pairings: { pairings: [{ device: "c_x" }] },
      aboutYou: { proposed: [{ id: "m1" }] },
      loopDrafts: { drafts: [{ id: "d1" }] },
      connectorRequests: { requests: [{ id: "r1" }] },
      screenSessions: { sessions: [{ state: "waiting" }, { state: "ended" }] },
    });
    for (const words of [
      "1 notice",
      "1 waiting for your answer (galahad action ls)",
      "2 keys asked for (galahad secret list)",
      "1 device asking to join (galahad pairings)",
      "1 fact to keep (galahad about)",
      "1 loop drafted (galahad loop drafts)",
      "1 connector asked for (galahad connectors requests)",
      "1 ask to use a Mac (galahad screen sessions)",
    ])
      expect(line).toContain(words);
    expect(line).not.toContain("nothing needs you");
  });

  test("nothing waiting, or a node too old to say: nothing needs you", async () => {
    expect(await said(quiet)).toContain("nothing needs you");
    expect(await said({ loops: { loops: [] } })).toContain("nothing needs you");
  });

  test("his answers you haven't read are news, not something that needs you", async () => {
    const line = await said({ ...quiet, turns: { turns: [], unread: [{ id: "cv_a", title: "Release", answeredAt: 1 }, { id: "cv_b", title: "Plan", answeredAt: 2 }] } });
    expect(line).toContain("nothing needs you");
    expect(line).toContain("2 new answers (galahad chats)");
    expect(await said({ ...quiet, turns: { turns: [] } })).not.toContain("new answer");
  });
});
