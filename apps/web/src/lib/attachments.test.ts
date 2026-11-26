import { describe, expect, test } from "bun:test";
import type { AttachmentRef, StoredMessage } from "@galahad/core";
import { ATTACHMENT_LIMITS } from "@galahad/core/attachments";
import { ATTACH_ACCEPT, base64Of, nameOf, prepare, refusal } from "./attachments.ts";
import { beginTurn, type Thread, turnOf } from "./turns.ts";

/*
 * Files with a message, on this side (attachments.ts): what is said of one that can't go, before it goes; its name as
 * the node takes it; its bytes as base64. (A picture drawn again needs a browser's canvas: tried in one, not here.)
 */

describe("a file with a message", () => {
  test("its bytes as base64, a chunk at a time, the same as the platform's", () => {
    const bytes = new Uint8Array(100_000).map((_, i) => (i * 7) % 256);
    expect(base64Of(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    expect(base64Of(new Uint8Array())).toBe("");
  });

  test("its name as the node takes it: no folders, no control characters, at most 200 characters", () => {
    expect(nameOf("C:\\Users\\me\\shot.png")).toBe("shot.png");
    expect(nameOf("../../etc/passwd")).toBe("passwd");
    expect(nameOf("bad\u0000name\u0007.txt")).toBe("badname.txt");
    expect(nameOf("   ")).toBe("file");
    expect(nameOf(`${"a".repeat(300)}.log`)).toHaveLength(200);
  });

  test("what is said before one goes that can't: not a picture or text, empty, or too big for its kind", () => {
    expect(refusal("notes.pdf", null, 10)).toBe("notes.pdf isn't a picture or text: only those go with a message.");
    expect(refusal("empty.txt", "text/plain", 0)).toBe("empty.txt is empty.");
    expect(refusal("huge.log", "text/plain", ATTACHMENT_LIMITS.textBytes + 1)).toBe("huge.log is too big: a text goes with a message up to 256 KB.");
    expect(refusal("huge.jpg", "image/jpeg", ATTACHMENT_LIMITS.imageBytes + 1)).toBe("huge.jpg is too big: a picture goes with a message up to 5 MB.");
    expect(refusal("shot.png", "image/png", 1000)).toBeNull();
  });

  test("a text is taken as it is; anything that is neither a picture nor text is refused, by its bytes, whatever its name", async () => {
    const log = new File(["FAIL db.test.ts\n"], "test.log", { type: "" });
    expect(await prepare(log)).toEqual({ name: "test.log", type: "text/plain", bytes: new TextEncoder().encode("FAIL db.test.ts\n"), preview: null });
    const elf = new File([new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 1])], "notes.txt", { type: "text/plain" });
    expect(await prepare(elf)).toEqual({ problem: "notes.txt isn't a picture or text: only those go with a message." });
  });

  test("the picker offers pictures and the kinds of text one attaches", () => {
    for (const kind of ["image/*", "text/*", ".log", ".md", ".ts", ".py", ".json"]) expect(ATTACH_ACCEPT.split(",")).toContain(kind);
    expect(ATTACH_ACCEPT).not.toContain(".pdf");
  });
});

describe("a message of yours with files, in the thread", () => {
  const shot: AttachmentRef = { id: "a".repeat(64), name: "shot.png", type: "image/png", bytes: 1200 };
  test("sent from here, and read back from a kept chat, it carries them", () => {
    const thread: Thread = { turns: [], nextId: 1, target: null, base: null };
    beginTurn(thread, "", "planner", 1, [shot]);
    expect(thread.turns[0]).toMatchObject({ role: "user", content: "", attachments: [shot] });
    beginTurn(thread, "Plain words", "planner", 2);
    expect(thread.turns[2]!.attachments).toBeUndefined();
    const kept: StoredMessage = { id: 7, role: "user", content: "Why?", attachments: [shot], model: null, steps: [], status: "done", error: null, createdAt: 1, endedAt: 1 };
    expect(turnOf(kept, "planner", 1).attachments).toEqual([shot]);
  });
});
