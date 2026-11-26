import { describe, expect, test } from "bun:test";
import { cappedBytes, fileKind, refusedFile } from "../src/chat-files.ts";

/* A file you sent through a chat app: what it is by its bytes alone, and why one can't go with your message. */

const bytes = (...values: number[]) => new Uint8Array(values);

describe("a file sent through a chat app", () => {
  test("a picture by its own signature, whatever it was called; text when it reads as text", () => {
    expect(fileKind(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2))).toBe("image/png");
    expect(fileKind(bytes(0xff, 0xd8, 0xff, 0xe0, 1))).toBe("image/jpeg");
    expect(fileKind(new TextEncoder().encode("FAIL db.test.ts\n  connect ECONNREFUSED\tline\r\n"))).toBe("text/plain");
  });

  test("anything else is no file it carries, and says why: a PDF, a HEIC photo, too large", () => {
    const pdf = new Uint8Array([...new TextEncoder().encode("%PDF-1.7\n%"), 0xe2, 0xe3, 0xcf, 0xd3, 0x00]);
    const heic = new Uint8Array([0, 0, 0, 0x18, ...new TextEncoder().encode("ftypheic"), 0, 0, 0, 0]);
    expect([fileKind(pdf), fileKind(heic)]).toEqual([null, null]);
    expect(refusedFile(pdf)).toBe("it isn't a picture Galahad is shown (PNG, JPEG, WebP or GIF) or text");
    const bigText = new TextEncoder().encode("x".repeat(300 * 1024));
    expect(refusedFile(bigText)).toBe("it isn't a picture Galahad is shown (PNG, JPEG, WebP or GIF) or text");
    const bigPicture = new Uint8Array(6 * 1024 * 1024);
    bigPicture.set([0xff, 0xd8, 0xff]);
    expect(refusedFile(bigPicture)).toBe("it's over 5 MB");
    expect(refusedFile(bytes(0xff, 0xd8, 0xff, 0xe0))).toBeNull();
  });

  test("a download is read no further than what may be kept", async () => {
    expect(await cappedBytes(new Response("x".repeat(100)), 50)).toBeNull();
    expect(new TextDecoder().decode((await cappedBytes(new Response("hello"), 50))!)).toBe("hello");
  });
});
