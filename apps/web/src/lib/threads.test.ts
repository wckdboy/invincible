import { describe, expect, test } from "bun:test";
import type { ConversationSummary, ProjectView } from "@invincible/core";
import { age, chatState, threadsOf } from "./threads.ts";
import type { Work, WorkProject, WorkTask } from "./work.ts";

/*
 * A wide screen's sidebar, as T3 Code's: projects, each with its threads (its agents' tasks and your agent's chats in it),
 * newest first; your agent's other chats its own. Projects keep your node's order, so none jumps as work moves.
 */

const task = (id: string, at: number, state: WorkTask["state"] = "working", agent = "ada"): WorkTask => ({
  id,
  room: `r_${agent}`,
  title: `Task ${id}`,
  agent: { id: agent, name: agent[0]!.toUpperCase() + agent.slice(1), avatar: null },
  state,
  line: "",
  at,
});

const group = (key: string, name: string, tasks: WorkTask[]): WorkProject => ({ key, name, repo: `https://${key}`, host: key.split("/")[0]!, agents: [], tasks, running: 0, needs: 0 });

const chat = (id: string, at: number, project: string | null, state: ConversationSummary["state"] = "done", unread = false): ConversationSummary => ({
  id,
  title: `Chat ${id}`,
  project,
  role: "planner",
  pinned: false,
  createdAt: at,
  updatedAt: at,
  count: 2,
  state,
  queued: 0,
  held: null,
  needs: null,
  unread,
});

const project = (id: string, name: string, repo: string | null): ProjectView => ({ id, name, repo, instructions: null } as unknown as ProjectView);

describe("threadsOf", () => {
  test("each project holds its agents' tasks and your agent's chats in it, newest first", () => {
    const work: Pick<Work, "projects" | "other"> = { projects: [group("github.com/wckdboy/invincible", "invincible", [task("t2", 200), task("t1", 100, "verified")])], other: null };
    const threads = threadsOf({ work, projects: [project("inv", "Invincible", "https://github.com/wckdboy/invincible.git")], conversations: [chat("c1", 150, "inv"), chat("c2", 300, null)] });
    expect(threads.projects.map((p) => [p.name, p.project, p.threads.map((t) => t.id)])).toEqual([["Invincible", "inv", ["t2", "c1", "t1"]]]);
    expect(threads.projects[0]!.threads[1]).toMatchObject({ kind: "chat", href: "#/chat?c=c1", agent: null });
    expect(threads.projects[0]!.threads[0]).toMatchObject({ kind: "task", href: "#/task/t2", agent: { id: "ada", name: "Ada" } });
    // A chat in no project is your agent's own.
    expect(threads.own.map((t) => t.id)).toEqual(["c2"]);
  });

  test("projects keep your node's order, then repositories no project names, then other work: none jumps as work moves", () => {
    const work: Pick<Work, "projects" | "other"> = {
      // (lib/work.ts orders by what is busy: the sidebar doesn't follow it.)
      projects: [group("github.com/x/zeta", "zeta", [task("z", 900)]), group("github.com/x/beta", "beta", [task("b", 100)]), group("github.com/x/alpha", "alpha", [task("a", 50)])],
      other: { key: "other", name: "Other work", repo: null, host: null, agents: [], tasks: [task("o", 10)], running: 0, needs: 0 },
    };
    const threads = threadsOf({ work, projects: [project("b", "Beta", "https://github.com/x/beta"), project("q", "Quiet", null)], conversations: [] });
    expect(threads.projects.map((p) => p.name)).toEqual(["Beta", "Quiet", "alpha", "zeta"]);
    expect(threads.projects.find((p) => p.name === "Quiet")).toMatchObject({ key: "project:q", project: "q", threads: [] });
    expect(threads.other?.threads.map((t) => t.id)).toEqual(["o"]);
  });

  test("a chat in a project you removed is your agent's own; other work only when there is some", () => {
    const threads = threadsOf({ work: { projects: [], other: { key: "other", name: "Other work", repo: null, host: null, agents: [], tasks: [], running: 0, needs: 0 } }, projects: [], conversations: [chat("c", 1, "gone")] });
    expect(threads.own.map((t) => t.id)).toEqual(["c"]);
    expect(threads.other).toBeNull();
  });

  test("an id is a part of its address, never more", () => {
    const threads = threadsOf({ work: { projects: [], other: null }, projects: [], conversations: [chat("a&b=c", 1, null)] });
    expect(threads.own[0]!.href).toBe("#/chat?c=a%26b%3Dc");
  });
});

describe("chatState", () => {
  test("says a chat as an agent's dot says it, unread as new", () => {
    expect(chatState({ state: "working" })).toBe("working");
    expect(chatState({ state: "waiting" })).toBe("needs");
    expect(chatState({ state: "queued" })).toBe("queued");
    expect(chatState({ state: "stopped" })).toBe("paused");
    expect(chatState({ state: "failed" })).toBe("failed");
    expect(chatState({ state: "done" })).toBe("resting");
    expect(chatState({ state: "done", unread: true })).toBe("unread");
    // (Working is said over unread: what it does now comes first.)
    expect(chatState({ state: "working", unread: true })).toBe("working");
  });
});

describe("age", () => {
  test("is a few characters, as T3 Code's rows say it", () => {
    const now = 10_000_000_000;
    expect(age(now - 20_000, now)).toBe("now");
    expect(age(now - 4 * 60_000, now)).toBe("4m");
    expect(age(now - 3 * 3_600_000, now)).toBe("3h");
    expect(age(now - 2 * 86_400_000, now)).toBe("2d");
    expect(age(now - 15 * 86_400_000, now)).toBe("2w");
    // (A clock a little behind the node's never says a time to come.)
    expect(age(now + 60_000, now)).toBe("now");
  });
});
