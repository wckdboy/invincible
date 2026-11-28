import { describe, expect, test } from "bun:test";
import { askPlain } from "./asks.ts";

describe("an approval in plain words, as its ask says it in a chat (the lead's word, 28 November 2026)", () => {
  test("what it would do, to or on which service, and the first words it would send, in quotes", () => {
    expect(askPlain({ connector: "forge", tool: "post", args: { text: "Sync survives a dropped connection." } }, "Forge")).toBe("Post to Forge: “Sync survives a dropped connection.”");
    expect(askPlain({ connector: "github", tool: "create_pull_request", args: { title: "Fix the importer", body: "It reads ISO dates now." } }, "GitHub")).toBe("Create pull request on GitHub: “Fix the importer”");
  });

  test("its service named by its label, else by its id with a capital", () => {
    expect(askPlain({ connector: "forge", tool: "post", args: { text: "Hello" } })).toBe("Post to Forge: “Hello”");
    expect(askPlain({ connector: "s3", tool: "bucket.delete", args: { bucket: "old-logs" } }, null)).toBe("Bucket delete on S3");
  });

  test("its words: the first line of the first of its text, title, subject, message, body, content, name or summary, cut at 60", () => {
    expect(askPlain({ connector: "forge", tool: "post", args: { text: "  First line.\nSecond line." } }, "Forge")).toBe("Post to Forge: “First line.”");
    const long = "Sync survives a dropped connection: thanks to everyone who tested it on their own nodes.";
    expect(askPlain({ connector: "forge", tool: "post", args: { text: long } }, "Forge")).toBe("Post to Forge: “Sync survives a dropped connection: thanks to everyone who…”");
    // (Cut on a character, never inside one.)
    expect(askPlain({ connector: "forge", tool: "post", args: { text: `${"a".repeat(58)}😀😀😀` } }, "Forge")).toBe(`Post to Forge: “${"a".repeat(58)}😀…”`);
    // (None of them, or none in words: what it does alone.)
    expect(askPlain({ connector: "github", tool: "merge", args: { number: 12 } }, "GitHub")).toBe("Merge on GitHub");
    expect(askPlain({ connector: "github", tool: "merge", args: { title: "   " } }, "GitHub")).toBe("Merge on GitHub");
  });

  test("what sends takes \"to\": post, send, publish, upload, push, write, comment, reply, message, email, share", () => {
    expect(askPlain({ connector: "mail", tool: "send_email", args: { subject: "The 0.4 notes", body: "Attached." } }, "Mail")).toBe("Send email to Mail: “The 0.4 notes”");
    expect(askPlain({ connector: "drive", tool: "upload", args: { name: "notes.md" } }, "Drive")).toBe("Upload to Drive: “notes.md”");
  });
});
