import { describe, expect, test } from "bun:test";
import { fuzzyMatch, rank } from "./fuzzy.ts";
import { type Block, type Inline, inlineText, parseInline, parseMarkdown, safeHref } from "./markdown.ts";
import { describeSchedule, onceSoon, scheduleProblem } from "./schedule.ts";
import { describeWake as describeWakeHere, describeWakes } from "./wakes.ts";
import { describeWake, type LoopWake } from "@galahad/core";
import { detectProvider, detectSignIn, matchRanges, parseCommand, planLine, providerSetup, roleParts } from "./text.ts";
import { countdown, duration, hlcMs, minutesLabel, relativeTime } from "./time.ts";

const text = (v: string): Inline => ({ t: "text", v });

describe("markdown-lite", () => {
  test("paragraphs keep single newlines as line breaks", () => {
    expect(parseMarkdown("one\ntwo\n\nthree")).toEqual([
      { t: "p", c: [text("one"), { t: "br" }, text("two")] },
      { t: "p", c: [text("three")] },
    ]);
  });

  test("raw HTML is never interpreted: it stays literal text", () => {
    const blocks = parseMarkdown('<img src=x onerror="alert(1)"> <script>alert(1)</script>');
    expect(blocks).toEqual([{ t: "p", c: [text('<img src=x onerror="alert(1)"> <script>alert(1)</script>')] }]);
  });

  test("only http(s) links become links", () => {
    expect(parseInline("[ok](https://example.com/a)")).toEqual([{ t: "link", href: "https://example.com/a", c: [text("ok")] }]);
    expect(parseInline("[bad](javascript:alert(1))")).toEqual([text("[bad](javascript:alert(1))")]);
    expect(parseInline("[bad](data:text/html,x)")).toEqual([text("[bad](data:text/html,x)")]);
    expect(safeHref("JAVASCRIPT:alert(1)")).toBeNull();
    expect(safeHref("https://example.com")).toBe("https://example.com/");
  });

  test("bare URLs are linked without trailing punctuation", () => {
    expect(parseInline("see https://example.com/x.")).toEqual([
      text("see "),
      { t: "link", href: "https://example.com/x", c: [text("https://example.com/x")] },
      text("."),
    ]);
  });

  test("fenced code keeps its content verbatim, and an unclosed fence is still code (streaming)", () => {
    expect(parseMarkdown("```ts\nconst a = **b**;\n```")).toEqual([{ t: "code", lang: "ts", v: "const a = **b**;", open: false }]);
    expect(parseMarkdown("intro\n```\nhalf")).toEqual([
      { t: "p", c: [text("intro")] },
      { t: "code", lang: "", v: "half", open: true },
    ]);
  });

  test("a fence line may say more after its language, and an answer block written on one line is still that block", () => {
    // How models write them (and his guide shows them): the JSON on the fence line, nothing inside.
    expect(parseMarkdown('```choices ["15°", "30°"]\n```\n\nThen **one more**.')).toEqual([
      { t: "code", lang: "choices", v: '["15°", "30°"]', open: false },
      { t: "p", c: [text("Then "), { t: "strong", c: [text("one more")] }, text(".")] },
    ]);
    // Code keeps its own body: what follows its language is never code.
    expect(parseMarkdown('```ts title="a.ts"\nconst a = 1;\n```')).toEqual([{ t: "code", lang: "ts", v: "const a = 1;", open: false }]);
    expect(parseMarkdown("```ts title=x\n```")).toEqual([{ t: "code", lang: "ts", v: "", open: false }]);
    // Backticks after the opening run make inline code, not a fence.
    expect(parseMarkdown("```x``` stays text")[0]!.t).toBe("p");
  });

  test("inline code, bold, italic and strike", () => {
    expect(parseInline("a `x*y*` **b** *c* ~~d~~ snake_case_name")).toEqual([
      text("a "),
      { t: "code", v: "x*y*" },
      text(" "),
      { t: "strong", c: [text("b")] },
      text(" "),
      { t: "em", c: [text("c")] },
      text(" "),
      { t: "del", c: [text("d")] },
      text(" snake_case_name"),
    ]);
    expect(parseInline("2 * 3 * 4")).toEqual([text("2 * 3 * 4")]);
    expect(parseInline("**unclosed")).toEqual([text("**unclosed")]);
  });

  test("lists, nested by indentation", () => {
    const blocks = parseMarkdown("- one\n- two\n  - deep\n3. not this list");
    expect(blocks[0]).toEqual({
      t: "list",
      ordered: false,
      start: 1,
      items: [
        [{ t: "p", c: [text("one")] }],
        [
          { t: "p", c: [text("two")] },
          { t: "list", ordered: false, start: 1, items: [[{ t: "p", c: [text("deep")] }]] },
        ],
      ],
    });
    expect(blocks[1]).toMatchObject({ t: "list", ordered: true, start: 3 });
  });

  test("headings, quotes, rules and tables", () => {
    const blocks = parseMarkdown("## Plan\n> careful\n---\n| a | b |\n|:--|--:|\n| 1 | `x|y` |");
    expect(blocks[0]).toEqual({ t: "h", level: 2, c: [text("Plan")] });
    expect(blocks[1]).toEqual({ t: "quote", c: [{ t: "p", c: [text("careful")] }] });
    expect(blocks[2]).toEqual({ t: "hr" });
    const table = blocks[3] as Extract<Block, { t: "table" }>;
    expect(table.align).toEqual(["left", "right"]);
    expect(table.rows[0]!.map(inlineText)).toEqual(["1", "x|y"]);
  });

  test("pathological input stays bounded (it is re-parsed every frame while streaming)", () => {
    const deep = `${"> ".repeat(200)}x`;
    expect(() => parseMarkdown(deep)).not.toThrow();
    // Bounded means linear: four times the input takes about four times as long, on any machine
    // (a quadratic parser would take sixteen). Timed by this process's own CPU, so a machine busy with other work
    // isn't counted (the wall clock read 10.4 on a gate's loaded machine on 22 November 2026, where the parser's own
    // ratio is about four), and each size's fastest of fifteen runs, the two taken in turn, keeps a pause out of it.
    const cpu = () => {
      const used = process.cpuUsage();
      return used.user + used.system;
    };
    const ratio = (small: string, large: string) => {
      let fastSmall = Infinity;
      let fastLarge = Infinity;
      for (let i = 0; i < 15; i++) {
        let started = cpu();
        parseMarkdown(small);
        fastSmall = Math.min(fastSmall, cpu() - started);
        started = cpu();
        parseMarkdown(large);
        fastLarge = Math.min(fastLarge, cpu() - started);
      }
      return fastLarge / fastSmall;
    };
    for (const unit of ["*a ", "a *b ", "_x ", "**a ", "~~a "]) {
      parseMarkdown(unit.repeat(1000)); // warm
      expect(ratio(unit.repeat(2000), unit.repeat(8000))).toBeLessThan(10);
    }
    // Every line is asked whether it opens a fence: spaces or words after the backticks, then one that isn't.
    for (const line of [(n: number) => `\`\`\`${" ".repeat(n)}\``, (n: number) => `\`\`\`ts ${"a ".repeat(n)}\``, (n: number) => `\`\`\`ts a${" ".repeat(n)}\``]) {
      parseMarkdown(line(1000)); // warm
      expect(ratio(line(8000), line(32_000))).toBeLessThan(10);
    }
  });

  test("link text never nests another link", () => {
    const [link] = parseInline("[https://example.com](https://evil.example/x)");
    expect(link).toEqual({ t: "link", href: "https://evil.example/x", c: [text("https://example.com")] });
  });
});

describe("fuzzy search", () => {
  test("subsequence match with word-start preference", () => {
    expect(fuzzyMatch("nc", "New chat")?.indices).toEqual([0, 4]);
    expect(fuzzyMatch("xyz", "New chat")).toBeNull();
  });

  test("rank puts prefix and word-start matches first", () => {
    const items = [{ label: "Invite a machine" }, { label: "New chat" }, { label: "Theme: dark" }];
    expect(rank("nc", items)[0]!.item.label).toBe("New chat");
    expect(rank("dark", items)[0]!.item.label).toBe("Theme: dark");
    expect(rank("", items).map((r) => r.item.label)).toEqual(items.map((i) => i.label));
  });

  test("keywords are searchable", () => {
    expect(rank("api key", [{ label: "Add a key", keywords: ["api key", "secret"] }])).toHaveLength(1);
  });
});

describe("text helpers", () => {
  test("matchRanges merges overlapping hits case-insensitively", () => {
    expect(matchRanges("Tailscale serve on tailnet", "tail")).toEqual([
      [0, 4],
      [19, 23],
    ]);
    expect(matchRanges("abc", "")).toEqual([]);
  });

  test("parseCommand splits argv and routes shell syntax through sh -c", () => {
    expect(parseCommand(`git commit -m "first try" 'it''s'`)).toEqual({ argv: ["git", "commit", "-m", "first try", "its"], viaShell: false });
    expect(parseCommand("ls -la | head")).toEqual({ argv: ["sh", "-c", "ls -la | head"], viaShell: true });
    expect(parseCommand('echo "$HOME"')).toEqual({ argv: ["sh", "-c", 'echo "$HOME"'], viaShell: true });
    expect(parseCommand("echo 'a|b'")).toEqual({ argv: ["echo", "a|b"], viaShell: false });
    expect(parseCommand("   ")).toEqual({ argv: [], viaShell: false });
  });

  test("detectProvider: the longest prefix wins", () => {
    const presets = [
      { id: "openai", keyPrefixes: ["sk-"] },
      { id: "orcarouter", keyPrefixes: ["sk-orca-"] },
      { id: "anthropic", keyPrefixes: ["sk-ant-"] },
      { id: "deepseek" },
    ];
    expect(detectProvider("sk-orca-abc", presets)).toBe("orcarouter");
    expect(detectProvider("sk-ant-abc", presets)).toBe("anthropic");
    expect(detectProvider("sk-abc", presets)).toBe("openai");
    expect(detectProvider("nothing", presets)).toBeNull();
  });

  test("a subscription's sign-in is told from a key by what the node says of them, and is never taken for the vendor's API key", () => {
    const presets = [{ id: "anthropic", keyPrefixes: ["sk-ant-"] }];
    const signIns = [{ prefix: "sk-ant-oat", signIn: { vendor: "Anthropic", tool: "Claude Code", why: "A subscription's sign-in, not an API key." } }];
    // (Fake: the form of a token from `claude setup-token`, not one.)
    const oat = "sk-ant-oat01-FAKE-not-a-token-0000000000000000";
    expect(detectSignIn(oat, signIns)).toEqual(signIns[0]!.signIn);
    expect(detectSignIn("sk-ant-api03-FAKE", signIns)).toBeNull();
    expect(detectProvider(oat, presets, signIns)).toBeNull();
    expect(detectProvider("sk-ant-api03-FAKE", presets, signIns)).toBe("anthropic");
    // An older node says nothing of sign-ins: its keys read as they always did.
    expect(detectSignIn(oat, undefined)).toBeNull();
    expect(detectProvider(oat, presets)).toBe("anthropic");
  });

  test("a coding plan is said to be one, in a line that says who uses it, as its vendor's terms allow (what the CLI says too)", () => {
    const plan = (name: string, allows: { native: boolean; tools: "unattended" | "interactive" }) => ({ id: name, plan: { name, says: "", terms: "https://example.test/terms", models: ["m"], allows } });
    // Made for coding agents that call as themselves: he and the knights code on it.
    expect(planLine(plan("OpenCode Go", { native: true, tools: "unattended" }))).toBe(
      "OpenCode Go is a coding plan: Galahad and the other knights code on it, and their coding tools use it. His talk with you never does.",
    );
    // Only inside the coding tools its terms name: never his own calls.
    expect(planLine(plan("GLM Coding Plan", { native: false, tools: "unattended" }))).toBe(
      "GLM Coding Plan is a coding plan its terms allow only inside the coding tools they name: a knight's coding tool runs on it, and so does one you run yourself (galahad run). Galahad never calls it himself.",
    );
    // Interactive use only: a tool you run yourself, and nothing of his or the knights'.
    expect(planLine(plan("Kimi Code", { native: false, tools: "interactive" }))).toBe(
      "Kimi Code is a coding plan for interactive use only, by its terms: it is lent to a coding tool you run yourself (galahad run), and never to Galahad or a knight's work.",
    );
    expect(planLine({ id: "anthropic" })).toBeNull();
    expect(planLine(undefined)).toBeNull();
  });

  test("a sealed key's provider is configured from its preset, pointed at the new key when it exists, and left alone otherwise", () => {
    const data = {
      providers: [{ id: "openrouter", kind: "openai", baseUrl: "https://openrouter.ai/api/v1", secret: "openrouter" }],
      presets: [{ id: "anthropic", baseUrl: "https://api.anthropic.com" }, { id: "zai-coding", baseUrl: "https://api.z.ai/api/coding/paas/v4", plan: { name: "GLM Coding Plan", says: "", terms: "", models: [], allows: { native: false, tools: "unattended" as const } } }, { id: "verda", note: "Verda needs your own base URL." }, { id: "cloudflare-ai" }],
    };
    expect(providerSetup(data, "anthropic", "anthropic", true)).toEqual({ request: { id: "anthropic", secret: "anthropic" }, say: "anthropic is configured and ready." });
    expect(providerSetup(data, "zai-coding", "zai-coding", true).say).toContain("GLM Coding Plan is a coding plan");
    expect(providerSetup(data, "openrouter", "openrouter", true)).toEqual({ request: null, say: null });
    expect(providerSetup(data, "openrouter", "openrouter-2", true)).toEqual({ request: { id: "openrouter", kind: "openai", baseUrl: "https://openrouter.ai/api/v1", secret: "openrouter-2" }, say: "openrouter now uses this key." });
    expect(providerSetup(data, "verda", "verda", true)).toEqual({ request: null, say: "Verda needs your own base URL." });
    expect(providerSetup(data, "cloudflare-ai", "cf", true)).toEqual({ request: null, say: "Add cloudflare-ai's base URL on the Models page to start using it." });
    expect(providerSetup(data, "mine", "mine", true)).toEqual({ request: null, say: null });
    // A device that may not configure providers seals the key and nothing else.
    expect(providerSetup(data, "anthropic", "anthropic", false)).toEqual({ request: null, say: null });
  });

  test("a preset with no address of its own (a Cloudflare AI Gateway) is set up at the address given with its key", () => {
    const data = { providers: [], presets: [{ id: "cloudflare-ai", baseUrl: "", note: "Your gateway's address: --base-url …" }] };
    const gateway = "https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/galahad/compat";
    expect(providerSetup(data, "cloudflare-ai", "cloudflare-ai", true, gateway)).toEqual({ request: { id: "cloudflare-ai", baseUrl: gateway, secret: "cloudflare-ai" }, say: "cloudflare-ai is configured and ready." });
    // With none given, it says what is still needed, as ever.
    expect(providerSetup(data, "cloudflare-ai", "cloudflare-ai", true)).toEqual({ request: null, say: "Your gateway's address: --base-url …" });
    // Configured already, it is pointed at the new key, at the address given with it.
    const configured = { providers: [{ id: "cloudflare-ai", kind: "openai", baseUrl: gateway, secret: "cloudflare-ai" }], presets: data.presets };
    expect(providerSetup(configured, "cloudflare-ai", "cloudflare-ai", true, gateway)).toEqual({ request: null, say: null });
    expect(providerSetup(configured, "cloudflare-ai", "cf-2", true, gateway)).toEqual({ request: { id: "cloudflare-ai", kind: "openai", baseUrl: gateway, secret: "cf-2" }, say: "cloudflare-ai now uses this key." });
    expect(providerSetup(configured, "cloudflare-ai", "cloudflare-ai", true, `${gateway}-2`)).toEqual({ request: { id: "cloudflare-ai", kind: "openai", baseUrl: `${gateway}-2`, secret: "cloudflare-ai" }, say: "cloudflare-ai now uses this key." });
  });

  test("a preset that has an address is set up at another one given with its key (its plan's other region), where the key is pinned", () => {
    const sgp = "https://token-plan-sgp.xiaomimimo.com/v1";
    const ams = "https://token-plan-ams.xiaomimimo.com/v1";
    const data = { providers: [], presets: [{ id: "mimo-token", baseUrl: sgp }] };
    expect(providerSetup(data, "mimo-token", "mimo-token", true, ams)).toEqual({ request: { id: "mimo-token", baseUrl: ams, secret: "mimo-token" }, say: "mimo-token is configured and ready." });
    // Its own address given, or none, it is set up at its own, as ever.
    expect(providerSetup(data, "mimo-token", "mimo-token", true, sgp)).toEqual({ request: { id: "mimo-token", secret: "mimo-token" }, say: "mimo-token is configured and ready." });
    expect(providerSetup(data, "mimo-token", "mimo-token", true)).toEqual({ request: { id: "mimo-token", secret: "mimo-token" }, say: "mimo-token is configured and ready." });
  });

  test("a role's models as he uses them: his own in order, and the plans that do coding", () => {
    const presets = [{ id: "zai-coding", plan: { name: "GLM Coding Plan", says: "", terms: "", models: [], allows: { native: false, tools: "unattended" as const } } }, { id: "zai" }, { id: "anthropic" }];
    expect(roleParts(["zai-coding/glm-5.3", "anthropic/claude-opus-5-5", "zai/glm-5.3"], presets)).toEqual({ own: ["anthropic/claude-opus-5-5", "zai/glm-5.3"], plans: ["zai-coding/glm-5.3"] });
    expect(roleParts(["anthropic/claude-opus-5-5"], presets)).toEqual({ own: ["anthropic/claude-opus-5-5"], plans: [] });
    expect(roleParts(["zai-coding/glm-5.3"], presets)).toEqual({ own: [], plans: ["zai-coding/glm-5.3"] });
    // A provider of your own that only starts like a plan's id is not the plan.
    expect(roleParts(["zai-coding-mine/m"], presets)).toEqual({ own: ["zai-coding-mine/m"], plans: [] });
  });
});

describe("time", () => {
  test("hlc carries wall-clock milliseconds before the dot", () => {
    expect(hlcMs("001762689012345.000003")).toBe(1762689012345);
    expect(hlcMs("000001762689012345.000003")).toBe(1762689012345);
    expect(hlcMs("garbage")).toBeNull();
  });

  test("relative and durations read like people speak", () => {
    const now = Date.UTC(2026, 10, 9, 12, 0, 0);
    expect(relativeTime(now - 10_000, now)).toBe("just now");
    expect(relativeTime(now - 4 * 60_000, now)).toBe("4 min ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(relativeTime(now + 5 * 60_000, now)).toBe("in 5 min");
    expect(duration(850)).toBe("850 ms");
    expect(duration(4_200)).toBe("4.2 s");
    expect(duration(200_000)).toBe("3 min 20 s");
    expect(countdown(9 * 60_000 + 5_000)).toBe("9:05");
    expect(minutesLabel(90)).toBe("1 h 30 min");
    expect(minutesLabel(24 * 60)).toBe("1 d");
  });
});

describe("what wakes a loop", () => {
  const wakes: LoopWake[] = [
    { kind: "webhook" },
    { kind: "mail", connector: "gmail", query: "from:boss@example.com" },
    { kind: "mail", connector: "outlook" },
    { kind: "github", owner: "amiriteorg", repo: "galahad", on: ["ci.failed", "pushed"], branch: "main" },
    { kind: "github", owner: "amiriteorg", repo: "site", on: ["pushed"] },
    { kind: "github", owner: "amiriteorg", repo: "galahad", on: ["issue.opened", "pr.opened", "ci.failed"] },
  ];

  test("is said here as the node and the terminal say it", () => {
    for (const wake of wakes) expect(describeWakeHere(wake)).toBe(describeWake(wake));
    expect(describeWakeHere(wakes[3]!)).toBe("a failed CI run on main or a push in amiriteorg/galahad");
    expect(describeWakeHere(wakes[5]!)).toBe("a new issue or a new pull request or a failed CI run in amiriteorg/galahad");
  });

  test("in a sentence with its cooldown, and nothing when nothing else wakes it", () => {
    expect(describeWakes(wakes.slice(0, 2), 15 * 60_000)).toBe('Also wakes on a webhook · new Gmail mail matching "from:boss@example.com"; a burst within 15 min is one run.');
    expect(describeWakes([], 60_000)).toBe("");
  });

  test('"never" is a schedule here too: it runs only when woken', () => {
    expect(describeSchedule("never")).toBe("Only when woken");
    expect(scheduleProblem("Never")).toBeNull();
  });
});

describe("schedules", () => {
  test("intervals and common cron lines read like people say them", () => {
    expect(describeSchedule("every 30m")).toBe("Every 30 minutes");
    expect(describeSchedule("every 1h")).toBe("Every hour");
    expect(describeSchedule("Every 2 d")).toBe("Every 2 days");
    expect(describeSchedule("*/15 * * * *")).toBe("Every 15 minutes");
    expect(describeSchedule("0 * * * *")).toBe("Every hour");
    expect(describeSchedule("@hourly")).toBe("Every hour");
    expect(describeSchedule("30 * * * *")).toBe("Every hour at :30");
    expect(describeSchedule("0 7 * * *")).toBe("Every day at 07:00");
    expect(describeSchedule("0 7 * * 1-5")).toBe("Weekdays at 07:00");
    expect(describeSchedule("0 9 * * sat,sun")).toBe("Weekends at 09:00");
    expect(describeSchedule("15 18 * * 5-7")).toBe("Fri, Sat, Sun at 18:15");
    expect(describeSchedule("0 8 * * 1")).toBe("Mondays at 08:00");
    expect(describeSchedule("0 8 * * 7")).toBe("Sundays at 08:00");
    expect(describeSchedule("0 6 1 * *")).toBe("Monthly on day 1 at 06:00");
  });

  test("anything unusual is left as written", () => {
    expect(describeSchedule("0 7 * 1 *")).toBeNull();
    expect(describeSchedule("0 7,19 * * *")).toBeNull();
    expect(describeSchedule("0 7 * * */2")).toBeNull();
    expect(describeSchedule("whenever")).toBeNull();
  });

  test("the quick check catches the wrong shape and leaves values to the node", () => {
    expect(scheduleProblem("")).not.toBeNull();
    expect(scheduleProblem("every 30m")).toBeNull();
    expect(scheduleProblem("every thirty minutes")).not.toBeNull();
    expect(scheduleProblem("0 7 * * 1-5")).toBeNull();
    expect(scheduleProblem("@daily")).toBeNull();
    expect(scheduleProblem("0 7 * *")).not.toBeNull();
    expect(scheduleProblem("at 2026-11-25 09:00")).toBeNull();
    expect(scheduleProblem("at 2026-11-25T09:00")).toBeNull();
    expect(scheduleProblem("at tomorrow 9")).toBe('Write a time once as "at 2026-11-25 09:00".');
  });

  test("once, as a date and a time: the time it runs, then never again", () => {
    expect(describeSchedule("at 2026-11-25 09:00")).toBe("Once, on 25 November 2026 at 09:00");
    expect(describeSchedule("At 2027-01-03T18:30")).toBe("Once, on 3 January 2027 at 18:30");
    expect(describeSchedule("at 2026-13-25 09:00")).toBeNull();
  });

  test("the chip for once fills in an hour from now, to the next five minutes, in the zone it is read in", () => {
    // 20:07 UTC is 21:07 in Copenhagen: an hour on, 22:07, and up to 22:10.
    expect(onceSoon(Date.parse("2026-11-24T20:07:31Z"), "Europe/Copenhagen")).toBe("at 2026-11-24 22:10");
    expect(onceSoon(Date.parse("2026-11-24T23:55:00Z"), "UTC")).toBe("at 2026-11-25 00:55");
  });
});
