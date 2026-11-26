import { describe, expect, test } from "bun:test";
import { leavesPage, pageOf } from "./dialog.ts";

/*
 * A sheet belongs to the page it was opened on. Going to another page (the phone's
 * back gesture, a link inside the sheet) closes it; the address changing within the
 * same page (a chat getting its id while you type in a sheet) doesn't.
 */

describe("a sheet and the page under it", () => {
  test("the page is the address's first part", () => {
    expect(pageOf("#/skills")).toBe("skills");
    expect(pageOf("#/chat/cv_abc123")).toBe("chat");
    expect(pageOf("#/loops?trace=1")).toBe("loops");
    expect(pageOf("")).toBe("");
    expect(pageOf("#")).toBe("");
  });

  test("another page closes it; the same page with more in its address doesn't", () => {
    expect(leavesPage("#/skills", "#/settings")).toBe(true);
    expect(leavesPage("#/skills", "#/overview")).toBe(true);
    expect(leavesPage("#/chat", "#/chat/cv_abc123")).toBe(false);
    expect(leavesPage("#/chat/cv_abc123", "#/chat/cv_other")).toBe(false);
    expect(leavesPage("#/skills", "#/skills")).toBe(false);
  });
});
