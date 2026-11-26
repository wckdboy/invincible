import { describe, expect, test } from "bun:test";
import { type ChatMessage, type ExecResult, findSecrets } from "@galahad/core";
import { clip, observation, parseAction, parseVerdict, type QuestEvent, type QuestRole, runQuest } from "../src/quest.ts";

/** Obviously fake, but shaped like a real key so the scanner catches it. */
const FAKE_KEY = `sk-ant-api03-${"FAKE".repeat(8)}`;

interface Script {
  planner?: string[];
  engineer: string[];
  reviewer?: string[];
  outputs?: Partial<ExecResult>[];
}

function harness(script: Script, options: { maxSteps?: number; maxRevisions?: number; abortAfterCommands?: number; submitAtLimit?: boolean; keepReads?: boolean; gates?: string[]; escalate?: boolean; plan?: string; unreviewed?: boolean } = {}) {
  const queues: Record<QuestRole, string[]> = {
    planner: [...(script.planner ?? ["1. Do it.\nDone when: it is done."])],
    engineer: [...script.engineer],
    reviewer: [...(script.reviewer ?? ["PASS\nLooks right."])],
  };
  const outputs = [...(script.outputs ?? [])];
  const seen: { role: QuestRole; messages: ChatMessage[] }[] = [];
  const commands: string[] = [];
  const events: QuestEvent[] = [];
  const controller = new AbortController();
  const run = runQuest(
    { goal: "make it so", environment: "a test sandbox", maxSteps: options.maxSteps, maxRevisions: options.maxRevisions, ...(options.submitAtLimit ? { submitAtLimit: true } : {}), ...(options.keepReads ? { keepReads: true } : {}), ...(options.gates ? { gates: options.gates } : {}), ...(options.escalate ? { escalate: true } : {}), ...(options.plan !== undefined ? { plan: options.plan } : {}), ...(options.unreviewed ? { unreviewed: true } : {}) },
    {
      ask: async (role, messages) => {
        seen.push({ role, messages });
        const text = queues[role].shift();
        if (text === undefined) throw new Error(`the ${role} ran out of script`);
        return { text, model: `test/${role}` };
      },
      exec: async (command) => {
        commands.push(command);
        if (options.abortAfterCommands && commands.length >= options.abortAfterCommands) controller.abort();
        return { exitCode: 0, stdout: "ok\n", stderr: "", durationMs: 5, truncated: false, ...outputs.shift() };
      },
      emit: (event) => events.push(event),
      signal: controller.signal,
    },
  );
  return { run, seen, commands, events };
}

const sh = (command: string, thought = "Next step.") => `${thought}\n\`\`\`sh\n${command}\n\`\`\``;

describe("quests", () => {
  test("no plan and no reviewer: the goal is the whole brief, and the engineer's DONE past the gates is done", async () => {
    const h = harness({ engineer: [sh("echo hi > a.txt"), "DONE\nWrote a.txt."] }, { plan: "", unreviewed: true, gates: ["test -f a.txt"] });
    const outcome = await h.run;
    expect([outcome.status, outcome.review]).toEqual(["done", undefined]);
    // Neither the planner nor the reviewer was asked; the gate still ran, and was the last word.
    expect(h.seen.map((s) => s.role)).toEqual(["engineer", "engineer"]);
    expect(h.commands.some((c) => c.includes("test -f a.txt"))).toBe(true);
    const brief = h.seen[0]!.messages[0]!.content;
    expect(brief).toStartWith("Quest: make it so\n\nYou are working in: a test sandbox\n");
    expect(brief).toContain("each must exit 0 before your work is done");
    expect(brief).not.toMatch(/\bplan(ner)?\b|\breviewer\b/i);
  });

  test("plan, work, review: a clean run", async () => {
    const h = harness({ engineer: [sh("echo hi > a.txt"), sh("cat a.txt"), "DONE\nWrote a.txt; cat shows hi."] });
    const outcome = await h.run;
    expect(outcome.status).toBe("done");
    expect(outcome.steps).toBe(2);
    expect(h.commands).toEqual(["echo hi > a.txt", "cat a.txt"]);
    expect(h.seen.map((s) => s.role)).toEqual(["planner", "engineer", "engineer", "engineer", "reviewer"]);
    // The engineer gets the plan; the reviewer gets the evidence.
    expect(h.seen[1]!.messages[0]!.content).toContain("Done when: it is done.");
    const review = h.seen.at(-1)!.messages[0]!.content;
    expect(review).toContain("$ cat a.txt");
    expect(review).toContain("Wrote a.txt");
    expect(h.events.at(-1)).toEqual({ type: "finished", outcome });
  });

  test("the reviewer can send the work back, and the engineer sees why", async () => {
    const h = harness({
      engineer: [sh("touch a"), "DONE\nall good", sh("bun test"), "DONE\ntests pass"],
      reviewer: ["REVISE\nThere is no evidence the tests pass.", "PASS"],
    });
    const outcome = await h.run;
    expect(outcome.status).toBe("done");
    expect(outcome.revisions).toBe(1);
    const engineerAfterReview = h.seen.filter((s) => s.role === "engineer")[2]!.messages.at(-1)!.content;
    expect(engineerAfterReview).toContain("There is no evidence the tests pass.");
  });

  test("if the reviewer never accepts, the outcome says unverified", async () => {
    const h = harness({ engineer: ["DONE\ntrust me", "DONE\nreally"], reviewer: ["REVISE\nno evidence", "REVISE\nstill none"] }, { maxRevisions: 1 });
    const outcome = await h.run;
    expect(outcome.status).toBe("unverified");
    expect(outcome.review).toBe("still none");
  });

  test("the same command failing the same way is said to fail the same way, and a third time in a row stops the quest", async () => {
    const failing = { exitCode: 1, stdout: "", stderr: "error: cannot find module 'left-pad'", durationMs: 40 };
    const h = harness({ engineer: [sh("bun test"), sh("bun test"), sh("bun test"), sh("bun test")], outputs: [failing, { ...failing, durationMs: 55 }, { ...failing, durationMs: 61 }, failing] });
    const outcome = await h.run;
    expect(h.commands).toEqual(["bun test", "bun test", "bun test"]);
    const told = h.seen.filter((s) => s.role === "engineer").map((s) => s.messages.at(-1)!.content);
    expect(told[1]).not.toContain("the same way");
    expect(told[2]).toContain("The same command failed the same way 2 times in a row: running it again won't change that.");
    expect(outcome.status).toBe("stopped");
    expect(outcome.summary).toContain("Stopped: the same command failed the same way 3 times in a row");
    expect(outcome.summary).toContain("$ bun test");
  });

  test("a failure seen before, with other commands since, is said to be unchanged by them; another failure is just a failure", async () => {
    const failing = { exitCode: 1, stdout: "", stderr: "FAIL parser.test.ts: expected 2, got 3", durationMs: 40 };
    const h = harness({
      engineer: [sh("bun test"), sh("sed -i 's/3/2/' src/parser.ts"), sh("bun test"), sh("bun test --filter parser"), "DONE\nfixed"],
      outputs: [failing, { exitCode: 0, stdout: "" }, failing, { ...failing, stderr: "FAIL parser.test.ts: expected 2, got 4" }],
    });
    await h.run;
    const told = h.seen.filter((s) => s.role === "engineer").map((s) => s.messages.at(-1)!.content);
    expect(told[3]).toContain("This failed exactly as it did at step 1: what you changed since didn't change it.");
    expect(told[4]).not.toContain("exactly as it did");
    expect(told[4]).not.toContain("the same way");
  });

  test("a reviewer that isn't clear is not an approval", () => {
    expect(parseVerdict("Looks mostly fine, I think.").verdict).toBe("revise");
    expect(parseVerdict("**PASS**\nverified").verdict).toBe("pass");
    expect(parseVerdict("REVISE\nfix x").notes).toBe("fix x");
  });

  test("a malformed reply gets a reminder and spends a step", async () => {
    const h = harness({ engineer: ["I will now think.", `${sh("a")}\n${sh("b")}`, sh("ls"), "DONE\nok"] });
    const outcome = await h.run;
    expect(outcome.status).toBe("done");
    expect(outcome.steps).toBe(3);
    expect(h.commands).toEqual(["ls"]);
    expect(h.events.filter((e) => e.type === "format")).toHaveLength(2);
  });

  test("replies with no command to run are not commands: three in a row end the quest, and it says what the last one was", async () => {
    // Seen on ultra on 14 November 2026: a knight's engineer sent 16 such replies in a row. Sixteen model calls were
    // paid for, nothing ran, the task said "Stopped after 16 commands", and nothing of the replies was kept.
    const odd = "Listing first.\n```console\n$ ls -la\n```";
    const h = harness({ engineer: [odd, odd, odd, sh("ls"), "DONE\nok"] }, { maxSteps: 16 });
    const outcome = await h.run;
    expect(outcome.status).toBe("stopped");
    expect(h.commands).toEqual([]);
    // Three calls, not sixteen.
    expect(h.seen.filter((s) => s.role === "engineer")).toHaveLength(3);
    expect(outcome.malformed).toBe(3);
    expect(outcome.summary).toContain("3 replies in a row had no command to run");
    expect(outcome.summary).toContain("Your reply had no command block.");
    // What he sent is there to read: the quest's ending, and each reply's event as it happened.
    expect(outcome.summary).toContain("```console\n$ ls -la");
    const formats = h.events.filter((e) => e.type === "format");
    expect(formats).toHaveLength(3);
    expect(formats[0]).toMatchObject({ step: 1, problem: expect.stringContaining("no command block"), reply: odd });
  });

  test("a reply he gets right in between starts the count again, and the ending tells commands from replies without one", async () => {
    const odd = "```console\n$ ls\n```";
    const h = harness({ engineer: [odd, odd, sh("a"), odd, odd, sh("b"), sh("c")] }, { maxSteps: 7 });
    const outcome = await h.run;
    expect(outcome.status).toBe("stopped");
    expect(h.commands).toEqual(["a", "b", "c"]);
    // Each still spent one of his turns: seven in all.
    expect(outcome.steps).toBe(7);
    expect(outcome.malformed).toBe(4);
    expect(outcome.summary).toBe("Stopped after 7 turns without finishing: 3 commands ran, and 4 replies had no command to run.");
    // A quest with none says what it always said, and carries no count.
    const plain = await harness({ engineer: [sh("a"), sh("b")] }, { maxSteps: 2 }).run;
    expect(plain.summary).toBe("Stopped after 2 commands without finishing.");
    expect("malformed" in plain).toBe(false);
  });

  test("a secret in a reply with no command is not kept with it", async () => {
    const h = harness({ engineer: [`The key is ${FAKE_KEY}, I think.`, sh("ls"), "DONE\nok"] });
    await h.run;
    const format = h.events.find((e) => e.type === "format")!;
    expect(findSecrets(JSON.stringify(format))).toEqual([]);
  });

  test("he is told when his commands are running out: once at ten left, then on each of the last five", async () => {
    // Seen on ultra, 14 November 2026: a knight finished its change, went on checking, and ran out of its forty
    // commands without ever saying DONE. Nothing had told it how many were left since the briefing.
    const h = harness({ engineer: Array.from({ length: 14 }, (_, i) => sh(`echo ${i}`)) }, { maxSteps: 14 });
    await h.run;
    const told = h.seen.filter((s) => s.role === "engineer").map((s) => s.messages.at(-1)!.content);
    // (What he is told before each reply: the briefing, then each command's result.)
    const left = told.map((text) => /\((\d+) commands? left/.exec(text)?.[1] ?? null);
    expect(left).toEqual([null, null, null, null, "10", null, null, null, null, "5", "4", "3", "2", "1"]);
    expect(told[9]).toContain("(5 commands left. When the work is done and verified, reply DONE: what is never submitted is never reviewed.)");
    // A short quest is not told at every turn from its first.
    const short = harness({ engineer: [sh("a"), sh("b"), sh("c")] }, { maxSteps: 3 });
    await short.run;
    expect(short.seen.filter((s) => s.role === "engineer").map((s) => /commands? left/.test(s.messages.at(-1)!.content))).toEqual([false, true, true]);
  });

  test("out of commands with work done (submitAtLimit): what is there goes to the gates and the reviewer, and work they pass is done", async () => {
    const h = harness({ engineer: [sh("echo fixed > a.txt"), sh("cat a.txt")], reviewer: ["PASS\nThe file holds the fix and the commands show it."] }, { maxSteps: 2, submitAtLimit: true });
    const outcome = await h.run;
    expect(outcome.status).toBe("done");
    expect(outcome.steps).toBe(2);
    // The reviewer is told that nobody claimed it done: the evidence is all there is.
    expect(h.seen.at(-1)!.role).toBe("reviewer");
    expect(h.seen.at(-1)!.messages[0]!.content).toContain("He ran out of commands before he said he was done: this is the work as it stands.");
    expect(outcome.summary).toContain("ran out of commands");
    expect(outcome.review).toBe("The file holds the fix and the commands show it.");
  });

  test("out of commands and the reviewer isn't satisfied, or nothing ever ran: stopped, as it was, with what the reviewer said", async () => {
    const sentBack = harness({ engineer: [sh("echo half")], reviewer: ["REVISE\nNothing shows it works."] }, { maxSteps: 1, submitAtLimit: true });
    const outcome = await sentBack.run;
    expect(outcome.status).toBe("stopped");
    expect(outcome.summary).toBe("Stopped after 1 commands without finishing. What was there was put to the reviewer, who did not accept it.");
    expect(outcome.review).toBe("Nothing shows it works.");
    // Replies with no command are no work to submit.
    const odd = "```console\n$ ls\n```";
    const idle = harness({ engineer: [odd, odd] }, { maxSteps: 2, submitAtLimit: true });
    expect((await idle.run).status).toBe("stopped");
    expect(idle.seen.some((s) => s.role === "reviewer")).toBe(false);
    // Without the switch a quest is what it was: nobody is asked.
    const plain = harness({ engineer: [sh("a"), sh("b")] }, { maxSteps: 2 });
    expect((await plain.run).summary).toBe("Stopped after 2 commands without finishing.");
    expect(plain.seen.some((s) => s.role === "reviewer")).toBe(false);
  });

  test("a command block whose fence is wrapped in stray angle brackets is still a command", () => {
    // Seen on ultra, 14 November 2026: deepseek-v4-pro sent this three times in a row and the task ended with
    // nothing run. The command is plain to read; only the fence's decoration is off.
    expect(parseAction("I'll confirm the syntax first.\n\n<```sh>\ndesktop help\n```>")).toEqual({ kind: "command", command: "desktop help", thought: "I'll confirm the syntax first." });
    expect(parseAction("<```bash>\nls -la\n```>")).toMatchObject({ kind: "command", command: "ls -la" });
    // The ordinary forms are what they were, and two blocks are still two.
    expect(parseAction("Next.\n```sh\nls\n```")).toEqual({ kind: "command", command: "ls", thought: "Next." });
    expect(parseAction("<```sh>\na\n```>\n<```sh>\nb\n```>").kind).toBe("invalid");
    // A comparison inside a command is not a fence's decoration.
    expect(parseAction("```sh\ntest 1 -lt 2 && echo \"a > b\"\n```")).toMatchObject({ kind: "command", command: 'test 1 -lt 2 && echo "a > b"' });
  });

  test("a here-document's lines are the command's, fences and all: a note written in Markdown with a code block in it is one command", () => {
    // Seen on ultra, 19 November 2026: the outcome's last task had written its failing tests and was keeping their
    // failures in NOTES.md, a Markdown note with a code block in it. Each ``` inside the here-document was read as the
    // fence's end, the reply as two command blocks, three times running, and the task ended with nothing more run.
    const note = "cd /work/t && cat > NOTES.md <<'EOF'\n# Red run\n\nCommand:\n\n```\nbun test packages/node/test/ci-watch.test.ts\n```\n\nAll three fail for the intended reason.\nEOF\ncat NOTES.md";
    expect(parseAction(`Now the notes.\n\n\`\`\`sh\n${note}\n\`\`\``)).toEqual({ kind: "command", command: note, thought: "Now the notes." });
    // So is one whose end word isn't quoted, or is indented with <<-; a here-string (<<<) opens none.
    for (const open of ["<<EOF", "<<-EOF", '<<"EOF"']) {
      const command = `cat > a.md ${open}\n\`\`\`js\nx()\n\`\`\`\nEOF`;
      expect(parseAction(`\`\`\`sh\n${command}\n\`\`\``)).toMatchObject({ kind: "command", command });
    }
    expect(parseAction("```sh\ngrep -c x <<< \"a\"\n```\n```sh\nls\n```").kind).toBe("invalid");
    // A here-document whose end never comes is read as before: to the first fence after it.
    expect(parseAction("```sh\ncat > a <<EOF\nhello\n```")).toMatchObject({ kind: "command", command: "cat > a <<EOF\nhello" });
    // And two blocks outside any here-document are still two.
    expect(parseAction("```sh\ncat > a <<EOF\nx\nEOF\n```\n```sh\nls\n```").kind).toBe("invalid");
  });

  test("the same command sent twice in one reply is one command: a model's own made-up warning between them changes nothing", () => {
    // Seen on ultra, 19 November 2026: in the first real outcome's first task, 11 replies of deepseek-v4-pro's were its
    // command, a <system_warning> of its own making ("We have had 1 repeated console turn(s) where I have re-sent the last
    // command…"), and the same command again. Each was refused as two command blocks: a turn spent, nothing run.
    const twice = "```sh\ncat packages/node/src/ci-back.ts\n```\n\n<system_warning>We have had 1 repeated console turn(s) where I have re-sent the last command after the MCP tool gave up or lost your response.</system_warning>\n\n```sh\ncat packages/node/src/ci-back.ts\n```";
    expect(parseAction(twice)).toMatchObject({ kind: "command", command: "cat packages/node/src/ci-back.ts" });
    // Two different commands are still two.
    expect(parseAction("```sh\ncat a.ts\n```\n```sh\ncat b.ts\n```").kind).toBe("invalid");
    // And with parallel commands allowed, the same one is run once.
    expect(parseAction("```sh\nbun test\n```\n```sh\nbun test\n```\n```sh\nls\n```", 4)).toMatchObject({ kind: "commands", commands: ["bun test", "ls"] });
  });

  test("a command dressed as a tool call, or a fence closed with a tag of the model's own, is still a command", () => {
    // Seen on ultra, 17 November 2026, each three times in a row, and the trial stopped with nothing run: deepseek-v4-pro
    // put its command in a tag's attribute, and closed a fence with a tag in place of its ```.
    expect(parseAction('<sh command="cd /work/repo && pwd && git status --short && cat REFACTOR.md"></sh>')).toEqual({ kind: "command", command: "cd /work/repo && pwd && git status --short && cat REFACTOR.md", thought: "" });
    expect(parseAction("Reading it first.\n<sh command=\"bun test 2>&1 | tail -5 &amp;&amp; echo &quot;ok&quot;\"/>")).toEqual({ kind: "command", command: 'bun test 2>&1 | tail -5 && echo "ok"', thought: "Reading it first." });
    expect(parseAction("<bash>\nls -la\n</bash>")).toMatchObject({ kind: "command", command: "ls -la" });
    const closedWithATag = "```sh\ncd /work/repo && cat > src/rollup.js <<'EOF'\nexport const x = 1;\nEOF\nbun test; echo \"exit=$?\"</TURD>";
    expect(parseAction(closedWithATag)).toEqual({ kind: "command", command: "cd /work/repo && cat > src/rollup.js <<'EOF'\nexport const x = 1;\nEOF\nbun test; echo \"exit=$?\"", thought: "" });
    // A fence the output limit cut off is no command: a part of one is never run.
    expect(parseAction("```sh\ncat > a.js <<'EOF'\nexport const").kind).toBe("invalid");
    // Two are still two (one at a time, unless he may send two), and a tag named in passing is none.
    expect(parseAction('<sh command="a"></sh>\n<sh command="b"></sh>').kind).toBe("invalid");
    expect(parseAction('<sh command="a"></sh>\n<sh command="b"></sh>', 2)).toEqual({ kind: "commands", commands: ["a", "b"], thought: "" });
    expect(parseAction("I'd use the <sh> tag here, but first a thought.").kind).toBe("invalid");
    expect(parseAction('<sh command=""></sh>').kind).toBe("invalid");
    // A reply built to make reading it slow is read at once, and is no command.
    const started = performance.now();
    expect(parseAction("<sh>".repeat(30_000)).kind).toBe("invalid");
    expect(parseAction(`\`\`\`sh\n${"</a".repeat(30_000)}`).kind).toBe("invalid");
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("the step budget is a hard limit", async () => {
    const h = harness({ engineer: [sh("a"), sh("b"), sh("c"), sh("d")] }, { maxSteps: 3 });
    const outcome = await h.run;
    expect(outcome.status).toBe("stopped");
    expect(h.commands).toEqual(["a", "b", "c"]);
  });

  test("giving up is an honest outcome, not an error", async () => {
    const h = harness({ engineer: ["GIVE UP\nThe repository is private and the sandbox has no credentials."] });
    const outcome = await h.run;
    expect(outcome.status).toBe("gave-up");
    expect(outcome.summary).toContain("private");
  });

  test("stopping cancels between steps", async () => {
    const h = harness({ engineer: [sh("a"), sh("b"), sh("c")] }, { abortAfterCommands: 1 });
    const outcome = await h.run;
    expect(outcome.status).toBe("stopped");
    expect(h.commands).toEqual(["a"]);
  });

  test("secrets in command output never reach a model", async () => {
    const h = harness({
      engineer: [sh("env"), "DONE\nprinted the environment"],
      outputs: [{ stdout: `ANTHROPIC_API_KEY=${FAKE_KEY}\nPATH=/usr/bin\n` }],
    });
    await h.run;
    for (const { messages } of h.seen) for (const m of messages) expect(findSecrets(m.content)).toEqual([]);
    expect(h.seen.at(-2)!.messages.at(-1)!.content).toContain("[redacted");
  });

  test("a failing sandbox becomes an observation, not a crash", async () => {
    const replies: Record<QuestRole, string[]> = { planner: ["1. x"], engineer: [sh("ls"), "DONE\nok"], reviewer: ["PASS"] };
    const engineerSaw: ChatMessage[][] = [];
    const outcome = await runQuest(
      { goal: "g", environment: "e" },
      {
        ask: async (role, messages) => {
          if (role === "engineer") engineerSaw.push(messages);
          return { text: replies[role].shift()!, model: "t" };
        },
        exec: async () => {
          throw new Error("sandbox gone");
        },
      },
    );
    expect(outcome.status).toBe("done");
    expect(engineerSaw[1]!.at(-1)!.content).toContain("sandbox gone");
  });

  test("a model that fails mid-reply (an outage) is asked again after a pause, not the end of the quest", async () => {
    // Seen live: "The upstream provider is temporarily unavailable" after the reply had begun,
    // which the roster can't fall back from; the quest died with the work half done.
    const replies: Record<QuestRole, string[]> = { planner: ["1. x"], engineer: [sh("ls"), "DONE\nok"], reviewer: ["PASS"] };
    let failures = 2;
    const pauses: number[] = [];
    const events: QuestEvent[] = [];
    const outcome = await runQuest(
      { goal: "g", environment: "e" },
      {
        ask: async (role) => {
          if (role === "engineer" && failures > 0) {
            failures -= 1;
            throw new Error("the engineer could not answer: orcarouter: The upstream provider is temporarily unavailable.");
          }
          return { text: replies[role].shift()!, model: "t" };
        },
        exec: async () => ({ exitCode: 0, stdout: "ok", stderr: "", durationMs: 1, truncated: false }),
        emit: (event) => events.push(event),
        sleep: async (ms) => void pauses.push(ms),
      },
    );
    expect(outcome.status).toBe("done");
    expect(pauses).toHaveLength(2);
    expect(pauses[1]!).toBeGreaterThan(pauses[0]!);
    expect(events.filter((e) => e.type === "retry")).toHaveLength(2);
  });

  test("a model that keeps failing ends the quest with the error, after a few tries", async () => {
    let calls = 0;
    const run = runQuest(
      { goal: "g", environment: "e" },
      {
        ask: async () => {
          calls += 1;
          throw new Error("no model in the roster could answer");
        },
        exec: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1, truncated: false }),
        sleep: async () => {},
      },
    );
    await expect(run).rejects.toThrow(/no model in the roster could answer/);
    expect(calls).toBe(4);
  });
});

describe("the protocol", () => {
  test("one fenced block is a command, in any common shell dialect", () => {
    for (const lang of ["sh", "bash", "shell", ""]) {
      const action = parseAction(`Look around.\n\`\`\`${lang}\nls -la\n\`\`\``);
      expect(action).toEqual({ kind: "command", command: "ls -la", thought: "Look around." });
    }
  });

  test("DONE on the first line wins, even with code in the summary", () => {
    const action = parseAction("DONE\nThe test passes:\n```sh\nbun test\n```");
    expect(action.kind).toBe("done");
  });

  test("DONE elsewhere is not a submission", () => {
    expect(parseAction("Almost DONE, one more check.").kind).toBe("invalid");
  });

  test("long output keeps its head and tail", () => {
    const text = `${"a".repeat(10_000)}MIDDLE${"z".repeat(10_000)}`;
    const clipped = clip(text);
    expect(clipped.startsWith("aaaa")).toBe(true);
    expect(clipped.endsWith("zzzz")).toBe(true);
    expect(clipped).not.toContain("MIDDLE");
    expect(clipped.length).toBeLessThan(9_000);
  });

  test("observations carry the exit code and both streams", () => {
    const seen = observation({ exitCode: 2, stdout: "out", stderr: "err", durationMs: 7, truncated: false });
    expect(seen).toBe("exit 2 · 7 ms\nout\nstderr:\nerr");
    expect(observation({ exitCode: 137, stdout: "", stderr: "", durationMs: 1, truncated: false })).toContain("time limit");
  });
});

describe("a model that couldn't answer is never passed over in silence", () => {
  test("when a role's first model fails and another answers, whoever watches is told once, with why and who answered instead", async () => {
    const events: QuestEvent[] = [];
    const replies: Record<QuestRole, string[]> = { planner: ["1. Do it.\nDone when: it is done."], engineer: [sh("echo hi"), sh("cat a.txt"), "DONE\nIt is there."], reviewer: ["PASS\nFine."] };
    const outcome = await runQuest(
      { goal: "make it so", environment: "a test sandbox" },
      {
        // The engineer's first model is refused every time; the reviewer's answers at once.
        ask: async (role) => ({
          text: replies[role].shift()!,
          model: `second/${role}`,
          ...(role === "engineer" ? { skipped: [{ model: "plan/first", error: `400 MissingSessionID ${FAKE_KEY}` }] } : {}),
        }),
        exec: async () => ({ exitCode: 0, stdout: "ok\n", stderr: "", durationMs: 5, truncated: false }),
        emit: (event) => events.push(event),
      },
    );
    expect(outcome.status).toBe("done");
    const told = events.filter((e) => e.type === "skipped");
    // Three engineer turns were each answered by the second model: said once, not three times.
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ type: "skipped", role: "engineer", model: "plan/first", answered: "second/engineer" });
    // What the provider said is shown, and nothing secret it echoed.
    expect((told[0] as { error: string }).error).toContain("400 MissingSessionID");
    expect(findSecrets(JSON.stringify(told))).toEqual([]);
    // It comes before that turn's own events.
    expect(events.findIndex((e) => e.type === "skipped")).toBeLessThan(events.findIndex((e) => e.type === "command"));
  });
});

describe("a reply of the engineer's that runs away", () => {
  test("its command runs as sent, but only its beginning and end stay in the conversation, and he is told", async () => {
    // A file written inline, far longer than anything a later turn needs to read again.
    const body = Array.from({ length: 30_000 }, (_, i) => `row ${i},${i * 7}`).join("\n");
    const huge = sh(`cat > data.csv <<'EOF'\n${body}\nEOF`, "Writing the data inline.");
    expect(huge.length).toBeGreaterThan(400_000);
    const h = harness({ engineer: [huge, sh("wc -l data.csv"), "DONE\nWrote data.csv."] });
    const outcome = await h.run;
    expect(outcome.status).toBe("done");
    // The sandbox was sent the command whole.
    expect(h.commands[0]!.length).toBeGreaterThan(400_000);
    expect(h.commands[0]).toContain("row 29999,209993");
    // Every later turn carries a short form of that reply: its start, its end, and how much was left out.
    const later = h.seen.filter((s) => s.role === "engineer").slice(1);
    expect(later).toHaveLength(2);
    for (const turn of later) {
      const reply = turn.messages[1]!;
      expect(reply.role).toBe("assistant");
      expect(reply.content.length).toBeLessThan(30_000);
      expect(reply.content).toContain("Writing the data inline.");
      expect(reply.content).toMatch(/… \[\d+ characters cut\] …/);
      expect(reply.content.endsWith("EOF\n```")).toBe(true);
      // No message of the conversation is beyond what a chat call takes.
      expect(Math.max(...turn.messages.map((m) => m.content.length))).toBeLessThan(400_000);
    }
    // He is told once, with the command's result, so he doesn't take the short form for what he sent.
    const told = later[0]!.messages[2]!.content;
    expect(told).toMatch(/^exit 0 · /);
    expect(told).toMatch(/Your reply was \d[\d,]* characters long: only its beginning and end are kept in this conversation \(the command ran as you sent it\)/);
    expect(later[1]!.messages[4]!.content).not.toContain("Your reply was");
    // The reviewer reads what was run: that command's beginning and end, with how much lies between, and the rest whole.
    const review = h.seen.find((s) => s.role === "reviewer")!.messages[0]!.content;
    expect(review.length).toBeLessThan(30_000);
    expect(review).toContain("1. $ cat > data.csv <<'EOF'\nrow 0,0");
    expect(review).toMatch(/… \[\d+ characters cut\] …/);
    expect(review).toContain("2. $ wc -l data.csv");
  });
});

describe("a knight that has run its gates is told to say so (keep-reads)", () => {
  const gates = ["bun run typecheck", "bun test outcomes"];
  const told = (h: ReturnType<typeof harness>) => h.seen.filter((x) => x.role === "engineer").at(-1)!.messages.filter((m) => m.role === "user").map((m) => m.content);
  const NOTE = "Your commands have now run every one of the gates on the work as it is. If they passed and the work is done, reply DONE now";

  test("once his commands have run every gate clean since the work last changed: said once, and again only after another change", async () => {
    const h = harness(
      { engineer: [sh("sed -i 's/a/b/' src/x.ts"), sh("bun run typecheck"), sh("cd /work && bun test outcomes 2>&1 | tail -5"), sh("cat src/x.ts"), sh("sed -i 's/b/c/' src/x.ts"), sh("bun run typecheck && bun test outcomes"), "DONE\nChanged; both gates pass."] },
      { keepReads: true, gates },
    );
    expect((await h.run).status).toBe("done");
    const said = told(h).slice(1).map((content) => content.includes(NOTE));
    // After the edit, the first gate, the second (now both: said), a read (not again), an edit (starts over), both at once (said).
    expect(said).toEqual([false, false, true, false, false, true]);
    // His briefing says when to stop checking.
    expect(told(h)[0]).toContain("When the work is done and its gates pass where you run them, reply with DONE at once");
  });

  test("a gate that failed is not counted, nor is one run before a change; without keep-reads nothing is said", async () => {
    const failing = harness(
      { engineer: [sh("bun run typecheck"), sh("bun test outcomes"), "DONE\nDone."], outputs: [{ exitCode: 2, stdout: "error TS2304\n" }, { stdout: "ok\n" }] },
      { keepReads: true, gates },
    );
    await failing.run;
    expect(told(failing).some((content) => content.includes(NOTE))).toBe(false);
    const lean = harness({ engineer: [sh("bun run typecheck"), sh("bun test outcomes"), "DONE\nDone."] }, { gates });
    await lean.run;
    expect(told(lean).some((content) => content.includes(NOTE))).toBe(false);
    expect(told(lean)[0]).toContain("When the quest is done and you have verified it");
  });
});

describe("routed by the work: hard work starts on the strongest models (your word: smart routing for performance and low cost)", () => {
  test("a plan that says the work needs the strongest models has the planner's do it from its start; one that says usual, the engineer's", async () => {
    const strong = harness({ planner: ["1. Change the three files together.\nDone when: the tests pass.\nEngineer: strong", sh("echo done"), "DONE\nChanged."], engineer: [] }, { escalate: true });
    expect((await strong.run).status).toBe("done");
    expect(strong.seen.map((x) => x.role)).toEqual(["planner", "planner", "planner", "reviewer"]);
    expect(strong.events).toContainEqual({ type: "routed", to: "planner", why: "its plan says the work needs the strongest models" });
    const usual = harness({ planner: ["1. Fix the typo.\nDone when: it reads right.\nEngineer: usual"], engineer: [sh("echo done"), "DONE\nFixed."] }, { escalate: true });
    expect((await usual.run).status).toBe("done");
    expect(usual.seen.map((x) => x.role)).toEqual(["planner", "engineer", "engineer", "reviewer"]);
    expect(usual.events.some((e) => e.type === "routed")).toBe(false);
    // The planner is asked for the line only where the work may go to its models (escalate), and told what they cost.
    expect(usual.seen[0]!.messages[0]!.content).toContain('Then a line "Engineer: strong" when the work needs the strongest models from its start');
    const lean = harness({ planner: ["1. Do it.\nDone when: done.\nEngineer: strong"], engineer: [sh("echo done"), "DONE\nDone."] });
    expect((await lean.run).status).toBe("done");
    expect(lean.seen[0]!.messages[0]!.content).not.toContain("Engineer: strong");
    expect(lean.seen[1]!.role).toBe("engineer");
  });
});

describe("how hard each step thinks (your word, 19 November 2026: never fixed, always adaptable)", () => {
  test("a plan and a review think carefully; the loop's first turn too; a turn after work that failed thinks hardest, one after a command that ran clean, or a look that found nothing, less; work sent back, hardest", async () => {
    const h = harness({
      engineer: [sh("cat a.ts"), sh("bun test"), sh("grep -n missing a.ts"), "DONE\nFixed.", sh("bun test"), "DONE\nFixed and tested."],
      reviewer: ["REVISE\nThe test still fails.", "PASS\nIt holds."],
      outputs: [{ stdout: "the file\n" }, { exitCode: 1, stdout: "1 fail\n" }, { exitCode: 1, stdout: "" }, { stdout: "1 pass\n" }],
    });
    expect((await h.run).status).toBe("done");
    const by = (role: QuestRole) => h.seen.filter((x) => x.role === role).map((x) => x.messages);
    expect(by("planner")[0]![0]!.effort).toBe("high");
    expect(by("reviewer").map((messages) => messages[0]!.effort)).toEqual(["high", "high"]);
    // The engineer's last conversation, each of its messages of his liege's side with the level it was said with.
    const last = by("engineer").at(-1)!;
    const said = last.filter((m) => m.role === "user").map((m) => [m.content.split("\n")[0]!.slice(0, 17), m.effort]);
    expect(said).toEqual([
      ["Quest: make it so", "high"],
      ["exit 0 · 5 ms", "medium"],
      ["exit 1 · 5 ms", "xhigh"],
      ["exit 1 · 5 ms", "medium"],
      [said[4]![0], "xhigh"],
      ["exit 0 · 5 ms", "medium"],
    ]);
    // Once said, a message keeps its level on every later turn, so what a provider cached is sent again as it was.
    for (const turn of by("engineer")) for (const [i, m] of turn.entries()) expect(m.effort).toBe(last[i]!.effort);
  });
});

describe("a long quest's conversation stays affordable, and stays the same", () => {
  test("older observations become excerpts a batch at a time: between batches every turn's conversation begins with the turn before's, whole", async () => {
    const n = 26;
    const page = "x".repeat(3000);
    const h = harness(
      { engineer: [...Array.from({ length: n }, (_, i) => sh(`echo ${i}`)), "DONE\nAll of them ran."], outputs: Array.from({ length: n }, (_, i) => ({ stdout: `out ${i}\n${page}\n` })) },
      { maxSteps: 30 },
    );
    expect((await h.run).status).toBe("done");
    const turns = h.seen.filter((s) => s.role === "engineer").map((s) => s.messages);
    expect(turns).toHaveLength(n + 1);
    // A provider reads a prompt's unchanged beginning from its cache: a turn that rewrites something earlier pays for
    // everything after it again. Cutting one more observation every turn did that on every turn past the ninth.
    let rewritten = 0;
    for (let t = 1; t < turns.length; t++) if (JSON.stringify(turns[t]!.slice(0, turns[t - 1]!.length)) !== JSON.stringify(turns[t - 1])) rewritten += 1;
    expect(rewritten).toBeGreaterThan(0);
    expect(rewritten).toBeLessThanOrEqual(3);
    for (const messages of turns) {
      const observations = messages.filter((m, i) => i > 0 && m.role === "user" && m.content.startsWith("exit 0"));
      const whole = observations.filter((m) => m.content.includes(page));
      // Affordable: never more than a dozen whole, the newest four always among them, and what was cut says so.
      expect(whole.length).toBeLessThanOrEqual(12);
      expect(observations.slice(-4).every((m) => m.content.includes(page))).toBe(true);
      for (const m of observations.filter((o) => !o.content.includes(page))) expect(m.content).toMatch(/… \[\d+ characters cut\] …/);
    }
    // By the end all but the newest few are excerpts.
    expect(turns.at(-1)!.filter((m) => m.content.includes(page)).length).toBeLessThanOrEqual(12);
    expect(turns.at(-1)!.filter((m) => /characters cut/.test(m.content)).length).toBeGreaterThanOrEqual(14);
  });

  test("an older run of a command that ran again later, both in the part cut short, is a line, not an excerpt; the beginning still holds between batches", async () => {
    const n = 26;
    const page = "y".repeat(3000);
    // The tests, run again after each change: their older failures are superseded by the newer runs.
    const commands = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? "bun test" : `sed -i 's/a${i}/b${i}/' src/x.ts`));
    const h = harness(
      {
        engineer: [...commands.map((c) => sh(c)), "DONE\nThe tests pass."],
        outputs: commands.map((c, i) => (c === "bun test" ? { exitCode: 1, stdout: `${i} fail\n${page}\n` } : { stdout: "" })),
      },
      { maxSteps: 30 },
    );
    expect((await h.run).status).toBe("done");
    const turns = h.seen.filter((s) => s.role === "engineer").map((s) => s.messages);
    let rewritten = 0;
    for (let t = 1; t < turns.length; t++) if (JSON.stringify(turns[t]!.slice(0, turns[t - 1]!.length)) !== JSON.stringify(turns[t - 1])) rewritten += 1;
    expect(rewritten).toBeLessThanOrEqual(3);
    const last = turns.at(-1)!.filter((m, i) => i > 0 && m.role === "user" && /^exit -?\d+ · /.test(m.content));
    const superseded = last.filter((m) => m.content.includes("(superseded:"));
    // Each is its first line and what superseded it; the newest runs stay whole, and the last cut one of each command an excerpt.
    expect(superseded.length).toBeGreaterThanOrEqual(8);
    for (const m of superseded) expect(m.content).toMatch(/^exit 1 · \d+ ms\n\(superseded: `bun test` ran again later, and what it printed then is further on\)$/);
    expect(last.slice(-4).every((m) => m.content.includes(page) || m.content.startsWith("exit 0"))).toBe(true);
    const runs = last.filter((m) => m.content.startsWith("exit 1"));
    expect(runs.at(-1)!.content).toContain(page);
    expect(runs.filter((m) => /characters cut/.test(m.content)).length).toBeGreaterThanOrEqual(1);
  });

  test("a check that failed and passed later, both in the part cut short, is a line: on what it checked or on all of it, however it was piped; the beginning still holds", async () => {
    const page = "z".repeat(3000);
    // A test file failing, then the typecheck, each fixed in turn, and the whole suite and the typecheck passing at the end.
    const commands = Array.from({ length: 6 }, (_, i) => [`cd /work && bun test src/t${i}.test.ts 2>&1 | tail -60`, `sed -i 's/bug/fix/' src/m${i}.ts`, "bunx tsc --noEmit 2>&1 | head -40", `sed -i 's/any/T/' src/m${i}.ts`]).flat();
    commands.push("cd /work && bun test", "bunx tsc --noEmit", ...Array.from({ length: 8 }, (_, i) => `echo note${i}`));
    const failing = (c: string) => / src\/t\d\.test\.ts|tsc --noEmit 2>&1/.test(c);
    const h = harness(
      { engineer: [...commands.map((c) => sh(c)), "DONE\nIt passes."], outputs: commands.map((c) => (failing(c) ? { exitCode: 1, stdout: `FAIL\n${page}\n` } : { stdout: c.startsWith("echo") ? `${page}\n` : "ok\n" })) },
      { maxSteps: 40 },
    );
    expect((await h.run).status).toBe("done");
    const turns = h.seen.filter((s) => s.role === "engineer").map((s) => s.messages);
    let rewritten = 0;
    for (let t = 1; t < turns.length; t++) if (JSON.stringify(turns[t]!.slice(0, turns[t - 1]!.length)) !== JSON.stringify(turns[t - 1])) rewritten += 1;
    expect(rewritten).toBeLessThanOrEqual(4);
    // Six test files, each fixed by the whole suite passing; of the typecheck's six identical runs, five superseded by the
    // next, and the last fixed by the typecheck passing.
    const fixed = turns.at(-1)!.filter((m) => m.content.includes("(fixed since:"));
    expect(fixed).toHaveLength(7);
    expect(turns.at(-1)!.filter((m) => m.content.includes("(superseded: `bunx tsc --noEmit 2>&1 | head -40`"))).toHaveLength(5);
    const said = new Set(fixed.map((m) => m.content.split("\n")[1]));
    expect(said).toEqual(new Set(["(fixed since: `cd /work && bun test` passed later; what failed here no longer does)", "(fixed since: `bunx tsc --noEmit` passed later; what failed here no longer does)"]));
    for (const m of fixed) expect(m.content).toMatch(/^exit 1 · \d+ ms\n/);
  });

  test("a check that failed is never said fixed by another check, by one that checked less, or by one that failed again", () => {
    const failed = { exitCode: 1, stdout: `FAIL\n${"q".repeat(3000)}\n` };
    const run = (commands: [string, Partial<ExecResult>][]) =>
      harness({ engineer: [...commands.map(([c]) => sh(c)), ...Array.from({ length: 14 }, (_, i) => sh(`echo pad${i}`)), "DONE\nDone."], outputs: [...commands.map(([, o]) => o), ...Array.from({ length: 14 }, () => ({ stdout: `${"p".repeat(3000)}\n` }))] }, { maxSteps: 40 });
    return Promise.all([
      run([["bun test src/a.test.ts src/b.test.ts", failed], ["bun test src/a.test.ts", {}]]),
      run([["bunx tsc --noEmit", failed], ["bun test", {}]]),
      run([["bun test src/a.test.ts", failed], ["bun test src/a.test.ts 2>&1 | tail -5", failed]]),
      run([["grep -rn missing src", failed], ["grep -rn missing src docs", {}]]),
    ]).then(async (harnesses) => {
      for (const h of harnesses) {
        await h.run;
        const last = h.seen.filter((s) => s.role === "engineer").at(-1)!.messages;
        expect(last.some((m) => m.content.includes("(fixed since:"))).toBe(false);
        // (It was cut short all the same: only not said to be fixed.)
        expect(last.find((m) => m.content.startsWith("exit 1"))!.content).toMatch(/characters cut/);
      }
    });
  });

  test("keep-reads: of the outputs cut short, the newest current file reads stay whole, within a budget; the beginning still holds between batches", async () => {
    const n = 26;
    // (Pages large enough that keep-reads, which cuts by size, cuts them too.)
    const page = "r".repeat(12_000);
    // A task that has to understand code: each command reads another part of the code, none of it changed.
    const commands = Array.from({ length: n }, (_, i) => `sed -n '${i * 100 + 1},${i * 100 + 100}p' src/watch.ts`);
    const run = (keepReads: boolean) =>
      harness({ engineer: [...commands.map((c) => sh(c)), "DONE\nRead it all."], outputs: commands.map(() => ({ stdout: `${page}\n` })) }, { maxSteps: 30, keepReads });
    const turnsOf = async (h: ReturnType<typeof run>) => {
      expect((await h.run).status).toBe("done");
      return h.seen.filter((s) => s.role === "engineer").map((s) => s.messages);
    };
    const whole = (messages: ChatMessage[]) => messages.filter((m, i) => i > 0 && m.role === "user" && m.content.includes(page)).length;
    const plain = await turnsOf(run(false));
    const kept = await turnsOf(run(true));
    // Without it, a dozen at most are whole, and each is cut to its head and tail; with it, the reads cut short stay
    // whole too, up to its budget beside the newest.
    expect(whole(plain.at(-1)!)).toBe(0);
    expect(whole(kept.at(-1)!)).toBeGreaterThan(12);
    expect(whole(kept.at(-1)!) * 12_000).toBeLessThanOrEqual(160_000 + 160_000);
    let rewritten = 0;
    for (let t = 1; t < kept.length; t++) if (JSON.stringify(kept[t]!.slice(0, kept[t - 1]!.length)) !== JSON.stringify(kept[t - 1])) rewritten += 1;
    expect(rewritten).toBeLessThanOrEqual(3);
  });

  test("keep-reads takes a knight's reads as they come (`cd … && awk … && sed -n …`), and a later script, which could change anything, ends them", async () => {
    const page = "k".repeat(12_000);
    const n = 26;
    const read = (i: number) => `cd /work/tasks/t && awk 'NR>=${i * 50 + 1} && NR<=${i * 50 + 50}' packages/node/src/ci-watch.ts && echo === && sed -n '${i * 50 + 1},${i * 50 + 50}p' packages/node/src/ci-back.ts`;
    const commands = Array.from({ length: n }, (_, i) => (i === 10 ? "python3 edit.py" : read(i)));
    const h = harness({ engineer: [...commands.map((c) => sh(c)), "DONE\nRead and edited."], outputs: commands.map(() => ({ stdout: `${page}\n` })) }, { maxSteps: 30, keepReads: true });
    expect((await h.run).status).toBe("done");
    const last = h.seen.filter((s) => s.role === "engineer").at(-1)!.messages.filter((m, i) => i > 0 && m.role === "user" && /^exit -?\d+ · /.test(m.content));
    // By the end the script and the reads before it are among those cut short. The reads after it stay whole as ever
    // (the newest) or kept; every read before it is an excerpt again.
    expect(last.slice(0, 10).every((m) => !m.content.includes(page))).toBe(true);
    expect(last.slice(11).every((m) => m.content.includes(page))).toBe(true);
  });

  test("keep-reads: a file's contents come whole up to some 100,000 characters, and any other output is cut only past 30,000; without it, past 8,000", async () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i} ${"x".repeat(50)}`).join("\n");
    const file = lines(1_500); // some 89,000 characters: a large source file
    const log = lines(1_000); // some 59,000: a long test run
    const shown = async (keepReads: boolean) => {
      const h = harness({ engineer: [sh("cat -n src/big.ts"), sh("bun test"), "DONE\nRead and ran."], outputs: [{ stdout: `${file}\n` }, { stdout: `${log}\n` }] }, { keepReads });
      expect((await h.run).status).toBe("done");
      return h.seen.filter((x) => x.role === "engineer").at(-1)!.messages.filter((m, i) => i > 0 && m.role === "user" && /^exit -?\d+ · /.test(m.content));
    };
    const [read, test] = await shown(true);
    expect(read!.content).toContain("line 0 ");
    expect(read!.content).toContain("line 750 ");
    expect(read!.content).toContain("line 1499 ");
    expect(read!.content).not.toContain("characters cut");
    // The test run's end is there, where its summary and last error are; its middle is cut.
    expect(test!.content).toContain("line 999 ");
    expect(test!.content).toMatch(/… \[\d+ characters cut\] …/);
    expect(test!.content.length).toBeLessThan(31_000);
    const [lean] = await shown(false);
    expect(lean!.content.length).toBeLessThan(8_500);
  });

  test("keep-reads: he is told that what he reads comes whole and stays in view, and how to edit so it does", async () => {
    const briefing = async (keepReads: boolean) => {
      const h = harness({ engineer: ["DONE\nNothing to do."] }, { keepReads });
      await h.run;
      return h.seen.find((x) => x.role === "engineer")!.messages[0]!.content;
    };
    const told = await briefing(true);
    expect(told).toContain("What you show of files (cat, sed -n, head, tail, nl, awk) comes whole, up to 100,000 characters, and stays in view while nothing changes it: read a file once, whole, rather than in pieces.");
    expect(told).toContain("or a python3 script that writes the files it names: what you read of the others stays in view.");
    expect(told).toContain("start anything longer in the background and check on it");
    // A quest without it is briefed as ever.
    expect(await briefing(false)).toContain("long output is cut to its head and tail.\n");
  });

  test("keep-reads: the conversation is cut by its size, not by a count: small outputs stay whole however many; past 160,000 characters the oldest go together, and the beginning holds between batches", async () => {
    const small = Array.from({ length: 40 }, (_, i) => `ls src/d${i}`);
    const few = harness({ engineer: [...small.map((c) => sh(c)), "DONE\nListed."], outputs: small.map(() => ({ stdout: `${"s".repeat(1_500)}\n` })) }, { maxSteps: 50, keepReads: true });
    expect((await few.run).status).toBe("done");
    const fewLast = few.seen.filter((x) => x.role === "engineer").at(-1)!.messages;
    // Forty outputs of 1,500 characters are 60,000 in all: none is cut, where a count would have cut 36 of them.
    expect(fewLast.filter((m) => /characters cut/.test(m.content))).toHaveLength(0);

    const big = Array.from({ length: 40 }, (_, i) => `bun test t${i}`);
    const many = harness({ engineer: [...big.map((c) => sh(c)), "DONE\nRan them."], outputs: big.map(() => ({ stdout: `${"t".repeat(9_000)}\n` })) }, { maxSteps: 50, keepReads: true });
    expect((await many.run).status).toBe("done");
    const turns = many.seen.filter((x) => x.role === "engineer").map((x) => x.messages);
    let rewritten = 0;
    for (let t = 1; t < turns.length; t++) if (JSON.stringify(turns[t]!.slice(0, turns[t - 1]!.length)) !== JSON.stringify(turns[t - 1])) rewritten += 1;
    expect(rewritten).toBeGreaterThan(0);
    expect(rewritten).toBeLessThanOrEqual(4);
    for (const messages of turns) {
      const whole = messages.filter((m, i) => i > 0 && m.role === "user" && /^exit -?\d+ · /.test(m.content) && !/characters cut/.test(m.content));
      expect(whole.reduce((sum, m) => sum + m.content.length, 0)).toBeLessThanOrEqual(160_000 + 10_000);
    }
  });

  test("keep-reads: an inline python3 edit that names the files it writes makes only those stale: what was read of the others stays whole", async () => {
    const page = (c: string) => c.repeat(12_000);
    const edit = `cd /work/t && python3 - <<'PY'\nimport pathlib\np = pathlib.Path("src/a.ts")\np.write_text(p.read_text().replace("old", "new"))\nPY`;
    // Two files read, then a dozen test runs to have them cut short, then an edit of one of them, then more runs.
    const commands = ["cat src/a.ts", "cat src/b.ts", ...Array.from({ length: 12 }, (_, i) => `bun test t${i}`), edit, ...Array.from({ length: 8 }, (_, i) => `bun test u${i}`)];
    const outputs = commands.map((c) => ({ stdout: `${c === "cat src/a.ts" ? page("a") : c === "cat src/b.ts" ? page("b") : c.startsWith("cd /work/t") ? "" : "t".repeat(12_000)}\n` }));
    const h = harness({ engineer: [...commands.map((c) => sh(c)), "DONE\nEdited."], outputs }, { maxSteps: 40, keepReads: true });
    expect((await h.run).status).toBe("done");
    const last = h.seen.filter((x) => x.role === "engineer").at(-1)!.messages.filter((m, i) => i > 0 && m.role === "user" && /^exit -?\d+ · /.test(m.content));
    expect(last[0]!.content).not.toContain(page("a"));
    expect(last[1]!.content).toContain(page("b"));
  });

  test("a file read before a later command changed it, both in the part cut short, is a line saying so; one never changed stays an excerpt", async () => {
    const n = 26;
    const page = "z".repeat(3000);
    // Each file is read, then edited in place; the last file is only read, never edited.
    const commands = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? `cat src/f${i}.ts` : `sed -i 's/a/b/' src/f${i - 1}.ts`));
    commands[0] = "cat src/kept.ts";
    const h = harness(
      {
        engineer: [...commands.map((c) => sh(c)), "DONE\nEdited."],
        outputs: commands.map((c) => (c.startsWith("cat") ? { stdout: `${page}\n` } : { stdout: "" })),
      },
      { maxSteps: 30 },
    );
    expect((await h.run).status).toBe("done");
    const turns = h.seen.filter((s) => s.role === "engineer").map((s) => s.messages);
    let rewritten = 0;
    for (let t = 1; t < turns.length; t++) if (JSON.stringify(turns[t]!.slice(0, turns[t - 1]!.length)) !== JSON.stringify(turns[t - 1])) rewritten += 1;
    expect(rewritten).toBeLessThanOrEqual(3);
    const last = turns.at(-1)!.filter((m, i) => i > 0 && m.role === "user" && /^exit -?\d+ · /.test(m.content));
    const stale = last.filter((m) => m.content.includes("(stale:"));
    expect(stale.length).toBeGreaterThanOrEqual(8);
    for (const m of stale) expect(m.content).toMatch(/^exit 0 · \d+ ms\n\(stale: `src\/f\d+\.ts` was changed later, by `sed -i 's\/a\/b\/' src\/f\d+\.ts`; read it again for what it holds now\)$/);
    // The file never edited is still an excerpt of what it held.
    expect(last[0]!.content).toMatch(/characters cut/);
    expect(last[0]!.content).not.toContain("(stale:");
    // The newest reads stay whole.
    expect(last.slice(-4).some((m) => m.content.includes(page))).toBe(true);
  });
});


// On Ultra (22 November 2026) a deciding reviewer, asked with no tools, replied three times with a call to read the
// file it was judging, in its own model's markup; each was taken as REVISE, and a knight's finished work ended unverified.
describe("a reviewer's reply that is no verdict", () => {
  const reading = '<tool_calls>\n<invoke name="read">\n<parameter name="path" string="true">/work/tasks/t/review.md</parameter>\n</invoke>\n</tool_calls>';

  const verdicts = (h: ReturnType<typeof harness>) => h.events.filter((e) => e.type === "review").map((e) => (e as { verdict: string }).verdict);

  test("is asked again once, told it has no tools: the verdict it gives then is the verdict", async () => {
    // (A second DONE is there for the work had it been sent back, as it was.)
    const h = harness({ engineer: [sh("echo hi > a.txt"), "DONE\nWrote a.txt.", "DONE\nIt is written."], reviewer: [reading, "PASS\nThe evidence shows a.txt written."] });
    const outcome = await h.run;
    expect(outcome.status).toBe("done");
    expect(verdicts(h)).toEqual(["pass"]);
    const asks = h.seen.filter((s) => s.role === "reviewer");
    expect(asks).toHaveLength(2);
    expect(asks[1]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(asks[1]!.messages.at(-1)!.content).toContain("You have no tools here");
  });

  test("no verdict again is sent back, as ever: an unsure reviewer is no approval", async () => {
    const h = harness({ engineer: [sh("echo hi > a.txt"), "DONE\nWrote a.txt.", "DONE\nIt is written.", "DONE\nStill written."], reviewer: [reading, reading, "PASS\nFine.", "PASS\nFine."] });
    const outcome = await h.run;
    expect(outcome.status).toBe("done");
    expect(verdicts(h)).toEqual(["revise", "pass"]);
    expect(h.seen.filter((s) => s.role === "reviewer")).toHaveLength(3);
  });
});
