import { describe, expect, test } from "bun:test";
import type { ArchiveStatusView } from "@galahad/core";
import { archiveStep } from "./chats.ts";
import { deleteName, embeddedShare, embedderLine, emptyFilter, filterSummary, filtering, kindInfo, searchBody } from "./archive.ts";

const status = (over: Partial<ArchiveStatusView> = {}): ArchiveStatusView => ({
  node: "ultra",
  entries: 10,
  byKind: { idea: 4, model: 6 },
  deleted: 0,
  chunks: 30,
  embedded: 20,
  backlog: 10,
  embedder: { model: "ollama/qwen3-embedding:0.6b", state: "ready", error: null, dims: 1024, local: true },
  understanding: { perDay: 200, localOnly: true, usedToday: 3, backlog: 7, lastError: null, lastRun: null },
  integrity: { lastAt: null, ok: null, checked: 0, problems: [] },
  disk: { blobBytes: 0, blobs: 0, indexBytes: 0, backend: "local", root: "/var/lib/galahad/.galahad/archive" },
  sources: [],
  paused: false,
  ...over,
});

describe("the Archive page's logic", () => {
  test("the selector says what's on in plain words", () => {
    const f = emptyFilter();
    expect(filterSummary(f)).toBe("Everything");
    expect(filtering(f)).toBe(false);
    f.kinds.add("idea");
    f.kinds.add("model");
    f.span = "week";
    f.trust.add("owner");
    expect(filterSummary(f)).toBe("Ideas, models · this week · yours");
    f.kinds.add("lesson");
    expect(filterSummary(f)).toBe("3 kinds · this week · yours");
    f.trust.add("agent");
    f.trust.add("untrusted");
    // All three trusts is no trust filter at all.
    expect(filterSummary(f)).toBe("3 kinds · this week");
  });

  test("the search it asks for", () => {
    const f = emptyFilter();
    expect(searchBody("  bridge  ", f, 20, 1000)).toEqual({ q: "bridge", limit: 20 });
    f.kinds.add("artifact");
    f.trust.add("untrusted");
    f.span = "day";
    expect(searchBody("", f, 20, 100_000_000)).toEqual({ q: "", limit: 20, kinds: ["artifact"], trust: ["untrusted"], since: 100_000_000 - 86_400_000 });
  });

  test("kinds a newer node knows are shown as they are", () => {
    expect(kindInfo("idea").plural).toBe("Ideas");
    expect(kindInfo("recording")).toEqual({ label: "Recording", plural: "Recordings", icon: "file" });
  });

  test("the embedder in words: none, local, remote (passages go to it), failing", () => {
    expect(embedderLine(status({ embedder: { model: null, state: "none", error: null, dims: null, local: null } }))).toMatchObject({ text: "None: searching by words", tone: "neutral" });
    expect(embedderLine(status())).toEqual({ text: "ollama/qwen3-embedding:0.6b, on this machine", tone: "ok", hint: null });
    expect(embedderLine(status({ embedder: { model: "openai/text-embedding-3-small", state: "ready", error: null, dims: 1536, local: false } })).tone).toBe("warn");
    expect(embedderLine(status({ embedder: { model: "ollama/x", state: "failing", error: "connection refused", dims: null, local: true } }))).toMatchObject({ tone: "warn", hint: "connection refused" });
    expect(embeddedShare(status())).toBeCloseTo(2 / 3);
    expect(embeddedShare(status({ embedded: 0, backlog: 0 }))).toBe(1);
  });

  test("a chat answer's archive step lists what it was given", () => {
    expect(archiveStep([{ id: "arc_AAAAAAAAAAAAAAAAAAAAAA", title: "A drawbridge", kind: "idea", trust: "owner" }, { id: "arc_BBBBBBBBBBBBBBBBBBBBBB", title: "A page", kind: "teaching", trust: "untrusted" }])).toEqual({
      text: "Read 2 archived entries",
      detail: "[arc_AAAAAAAAAAAAAAAAAAAAAA] A drawbridge · [arc_BBBBBBBBBBBBBBBBBBBBBB] A page (untrusted)",
    });
  });

  test("deleting asks you to type a short name", () => {
    expect(deleteName({ id: "arc_AAAAAAAABBBBBBBBCCCCCC", title: "Short" })).toBe("Short");
    expect(deleteName({ id: "arc_AAAAAAAABBBBBBBBCCCCCC", title: "x".repeat(60) })).toBe("AAAAAAAA");
  });
});
