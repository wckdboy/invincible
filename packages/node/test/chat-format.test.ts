import { describe, expect, test } from "bun:test";
import { escapeHtml, escapeSlack, inlineHtml, inlineSlack, SLACK_CHUNK, slackAnswer, TELEGRAM_CHUNK, telegramAnswer } from "../src/chat-format.ts";

/* His answer as a chat app shows it: its own markup, choices as buttons, blocks in words, and pieces short enough to send. */

describe("an answer in Telegram", () => {
  test("bold, italic, code and links; anything else is escaped, never markup", () => {
    expect(inlineHtml("**Done**: the *tests* pass, see `bun test` and [the run](https://github.com/x/y/actions/runs/1).")).toBe(
      '<b>Done</b>: the <i>tests</i> pass, see <code>bun test</code> and <a href="https://github.com/x/y/actions/runs/1">the run</a>.',
    );
    expect(inlineHtml("a < b && <script>alert(1)</script>")).toBe("a &lt; b &amp;&amp; &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(inlineHtml("`<b>` stays code")).toBe("<code>&lt;b&gt;</code> stays code");
    // Only http(s) links; snake_case and 2*3*4 stay as they are.
    expect(inlineHtml("[x](javascript:alert(1)) snake_case_name 2*3*4")).toBe("[x](javascript:alert(1)) snake_case_name 2*3*4");
    expect(escapeHtml('"&<>')).toBe('"&amp;&lt;&gt;');
  });

  test("headings, lists and quotes read as lines; code fences are code", () => {
    const { chunks, choices } = telegramAnswer("## What I found\n\n- one\n  - nested\n> quoted\n\n```ts\nconst a = 1 < 2;\n```");
    expect(chunks).toEqual(["<b>What I found</b>\n\n• one\n  • nested\n▎quoted\n\n<pre>const a = 1 &lt; 2;</pre>"]);
    expect(choices).toEqual([]);
  });

  test("a choices block becomes buttons (written on one line too); a plan, figures, a chart and a page are said in words", () => {
    const answer = [
      "Three parts:",
      "",
      '```steps\n[{"text":"Predict","state":"done"},{"text":"Try it","state":"doing"},{"text":"Aim","state":"todo"}]\n```',
      "",
      '```stats\n[{"label":"Range","value":10.19,"unit":"m","delta":1.36,"note":"vs 30°"}]\n```',
      "",
      '```chart\n{"type":"line","title":"Range by angle","labels":["15","45"],"series":[{"name":"m","values":[5.1,10.2]}]}\n```',
      "",
      "```artifact\n<!doctype html><title>Launcher</title><svg></svg>\n```",
      "",
      "Which goes farthest?",
      "",
      '```choices ["30°", "45°", "60°"]\n```',
    ].join("\n");
    const { chunks, choices } = telegramAnswer(answer);
    expect(choices).toEqual(["30°", "45°", "60°"]);
    const text = chunks.join("\n\n");
    expect(text).toContain("✓ Predict\n→ Try it\n○ Aim");
    // Figures as the apps show them (compactNumber).
    expect(text).toContain("<b>Range</b>: 10.2 m (+1.36 vs 30°)");
    expect(text).toContain("<i>A chart: Range by angle, drawn in the app.</i>");
    expect(text).toContain("<i>A page, Launcher: open this chat in the app to see it.</i>");
    expect(text).not.toContain("```");
    expect(text.endsWith("Which goes farthest?")).toBe(true);
  });

  test("a block that isn't valid stays its text, as code", () => {
    expect(telegramAnswer("```choices\nnot json\n```").chunks).toEqual(["<pre>not json</pre>"]);
  });

  test("a long answer goes in pieces Telegram takes, split between blocks; a long code block stays code in each piece", () => {
    const paragraphs = Array.from({ length: 30 }, (_, i) => `Paragraph ${i}: ${"word ".repeat(40)}`).join("\n\n");
    const { chunks } = telegramAnswer(paragraphs);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_CHUNK);
    expect(chunks.join("\n\n")).toContain("Paragraph 29");
    const code = telegramAnswer(`\`\`\`\n${"x <&> y\n".repeat(900)}\`\`\``).chunks;
    expect(code.length).toBeGreaterThan(1);
    for (const chunk of code) {
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_CHUNK);
      expect(chunk.startsWith("<pre>") && chunk.endsWith("</pre>")).toBe(true);
      // No entity cut in two.
      expect(/&(?!amp;|lt;|gt;|quot;)/.test(chunk)).toBe(false);
    }
  });
});

describe("an answer in Slack", () => {
  test("bold, italic, code and links in its own mrkdwn; anything else is escaped, so no answer can mention anyone or @channel", () => {
    expect(inlineSlack("**Done**: the *tests* pass, see `bun test` and [the run](https://github.com/x/y/actions/runs/1).")).toBe(
      "*Done*: the _tests_ pass, see `bun test` and <https://github.com/x/y/actions/runs/1|the run>.",
    );
    expect(inlineSlack("a < b && <script> <!channel> <@U0123ABCD> ~~old~~")).toBe("a &lt; b &amp;&amp; &lt;script&gt; &lt;!channel&gt; &lt;@U0123ABCD&gt; ~old~");
    expect(inlineSlack("`<!here>` stays code")).toBe("`&lt;!here&gt;` stays code");
    // Only http(s) links, and a label's | can't end one early; snake_case and 2*3*4 stay as they are.
    expect(inlineSlack("[x](javascript:alert(1)) [a|b](https://x.test/) snake_case_name 2*3*4")).toBe("[x](javascript:alert(1)) <https://x.test/|a¦b> snake_case_name 2*3*4");
    expect(escapeSlack("&<>\u0007")).toBe("&amp;&lt;&gt;");
  });

  test("headings, lists and quotes read as lines; code fences are code, and code can't close its own block", () => {
    const { chunks, choices } = slackAnswer("## What I found\n\n- one\n  - nested\n> quoted\n\n```ts\nconst a = 1 < 2; // ``` inside\n```");
    expect(chunks).toEqual(["*What I found*\n\n• one\n  • nested\n>quoted\n\n```const a = 1 &lt; 2; // ``ˋ inside```"]);
    expect(choices).toEqual([]);
  });

  test("a choices block becomes buttons; a plan, figures, a chart and a page are said in words", () => {
    const { chunks, choices } = slackAnswer('Which?\n\n```steps\n[{"text":"Predict","state":"done"},{"text":"Try it","state":"doing"}]\n```\n\n```stats\n[{"label":"Range","value":10.19,"unit":"m","delta":1.36,"note":"vs 30°"}]\n```\n\n```chart\n{"type":"line","title":"Range by angle","labels":["15","45"],"series":[{"name":"m","values":[5.1,10.2]}]}\n```\n\n```choices ["30°", "45°"]\n```');
    expect(choices).toEqual(["30°", "45°"]);
    const text = chunks.join("\n\n");
    expect(text).toContain("✓ Predict\n→ Try it");
    expect(text).toContain("*Range*: 10.2 m (+1.36 vs 30°)");
    expect(text).toContain("_A chart: Range by angle, drawn in the app._");
    expect(text).not.toContain("```");
  });

  test("a long answer goes in pieces Slack draws whole; a long code block stays code in each piece", () => {
    const { chunks } = slackAnswer(Array.from({ length: 30 }, (_, i) => `Paragraph ${i}: ${"word ".repeat(40)}`).join("\n\n"));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(SLACK_CHUNK);
    const code = slackAnswer(`\`\`\`\n${"x <&> y\n".repeat(900)}\`\`\``).chunks;
    expect(code.length).toBeGreaterThan(1);
    for (const chunk of code) {
      expect(chunk.length).toBeLessThanOrEqual(SLACK_CHUNK);
      expect(chunk.startsWith("```") && chunk.endsWith("```")).toBe(true);
      expect(/&(?!amp;|lt;|gt;)/.test(chunk)).toBe(false);
    }
  });
});
