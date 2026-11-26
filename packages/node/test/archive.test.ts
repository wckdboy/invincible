import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveId } from "@galahad/core";
import { LocalDiskBackend, sha256Hex } from "../src/archive/blobs.ts";
import { asText, chunkCode, chunkEntry, chunkProse, chunkChat, modelFacts, notebookText, transcript } from "../src/archive/chunk.ts";
import { refuseFile, scrub } from "../src/archive/guard.ts";
import { ftsQuery, fuse, queryTerms, snippet } from "../src/archive/search.ts";
import { ArchiveStore } from "../src/archive/store.ts";
import { cosine, dequantize, quantize, TopK, VectorIndex } from "../src/archive/vectors.ts";
import { conceptVector } from "./archive-fixtures.ts";

/*
 * The archive's store: content-addressed blobs, an append-only index with tombstones,
 * an integrity check that catches a flipped byte, chunking per kind, int8 vectors, and
 * hybrid search ranked by reciprocal rank fusion over a corpus with known answers.
 */

const dirs: string[] = [];
const stores: ArchiveStore[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "galahad-archive-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  // Windows may hold a just-written file a moment longer (an antivirus scan): rm waits for it.
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function open(dir = temp(), now = () => 1_700_000_000_000) {
  const blobs = new LocalDiskBackend(join(dir, "blobs"));
  const store = new ArchiveStore(join(dir, "archive.db"), blobs, { now });
  stores.push(store);
  return { dir, blobs, store };
}

const enc = (s: string) => new TextEncoder().encode(s);
/** Obviously fake, but shaped like a key: the scanner must catch it. */
const FAKE_KEY = "sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEFAKE";

describe("blobs: stored once, by SHA-256", () => {
  test("the hash names the blob; the same bytes are stored once; the backend computes the hash itself", async () => {
    const { blobs } = open();
    const a = await blobs.put(enc("hello"));
    expect(a.sha256).toBe(sha256Hex(enc("hello")));
    expect(await blobs.put(enc("hello"))).toEqual(a);
    expect(new TextDecoder().decode((await blobs.get(a.sha256))!)).toBe("hello");
    expect(await blobs.has(a.sha256)).toBe(true);
    const listed = [];
    for await (const b of blobs.list()) listed.push(b);
    expect(listed).toEqual([{ sha256: a.sha256, size: 5 }]);
    expect(await blobs.has("0".repeat(64))).toBe(false);
    await expect(blobs.get("../../etc/passwd")).rejects.toThrow("not a SHA-256");
  });

  test("a file streams in, hashed on the way", async () => {
    const { blobs, dir } = open();
    const path = join(dir, "big.bin");
    const bytes = new Uint8Array(3 * 2 ** 20).map((_, i) => i % 251);
    writeFileSync(path, bytes);
    const stored = await blobs.putFile(path);
    expect(stored).toEqual({ sha256: sha256Hex(bytes), size: bytes.length });
    expect(await blobs.rehash(stored.sha256)).toBe(stored.sha256);
  });

  test.skipIf(process.platform === "win32")("files are 600 and directories 700: the node's user alone", async () => {
    const { blobs, dir, store } = open();
    const { sha256 } = await blobs.put(enc("private"));
    const file = join(dir, "blobs", sha256.slice(0, 2), sha256.slice(2, 4), sha256);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "blobs", sha256.slice(0, 2))).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "blobs", sha256.slice(0, 2), sha256.slice(2, 4))).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "blobs")).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "archive.db")).mode & 0o777).toBe(0o600);
  });
});

describe("the index: append-only, idempotent, with tombstones", () => {
  const idea = { kind: "idea", source: "ideas", sourceId: "i-1", title: "A sourdough oven", description: "Bake bread in the lab's furnace.", trust: "owner" as const, createdAt: 1_699_000_000_000 };

  test("an entry's id is the hash of where it came from; archiving it again is a no-op", async () => {
    const { store } = open();
    const first = await store.ingest(idea);
    expect(first).toEqual({ id: archiveId("ideas", "i-1"), created: true });
    expect(await store.ingest({ ...idea, title: "changed" })).toEqual({ id: first.id, created: false });
    expect(store.get(first.id)!.title).toBe("A sourdough oven");
    expect(store.counts().entries).toBe(1);
    expect(archiveId("ideas", "i-1")).toMatch(/^arc_[A-Za-z0-9_-]{22}$/);
    expect(archiveId("ideas", "i-1")).not.toBe(archiveId("memories", "i-1"));
  });

  test("files are stored once by SHA-256, whoever refers to them", async () => {
    const { store } = open();
    const file = { path: "out/beam.py", bytes: enc("import numpy as np\n\ndef deflection(P, L, E, I):\n    return P * L**3 / (3 * E * I)\n") };
    await store.ingest({ ...idea, sourceId: "a", files: [file] });
    await store.ingest({ ...idea, sourceId: "b", files: [file, { path: "notes.md", bytes: enc("# Notes\n\nThe cantilever held.") }] });
    expect(store.counts()).toMatchObject({ entries: 2, blobs: 2 });
    const entry = store.get(archiveId("ideas", "b"))!;
    expect(entry.files.map((f) => [f.path, f.sha256, f.text])).toEqual([
      ["notes.md", sha256Hex(enc("# Notes\n\nThe cantilever held.")), true],
      ["out/beam.py", sha256Hex(file.bytes), true],
    ]);
    const read = await store.file(entry.id, "out/beam.py");
    expect(new TextDecoder().decode(read.bytes)).toContain("def deflection");
  });

  test("deleting leaves a tombstone: the words, passages and unshared files go, and it's never archived again", async () => {
    const { store, blobs } = open();
    const shared = { path: "shared.txt", bytes: enc("shared between two entries") };
    const own = { path: "own.txt", bytes: enc("only the first entry holds this") };
    const a = await store.ingest({ ...idea, sourceId: "a", files: [shared, own] });
    const b = await store.ingest({ ...idea, sourceId: "b", files: [shared] });
    expect(store.search("sourdough", {}).hits.length).toBe(2);
    const result = await store.delete(a.id, "not wanted", "you");
    expect(result).toEqual({ deleted: [a.id], blobs: 1 });
    expect(store.get(a.id)).toBeNull();
    expect(await blobs.has(sha256Hex(own.bytes))).toBe(false);
    expect(await blobs.has(sha256Hex(shared.bytes))).toBe(true);
    expect(store.search("sourdough", {}).hits.map((h) => h.id)).toEqual([b.id]);
    // The tombstone holds no words, only what keeps it out.
    const row = store.db.query<{ title: string; description: string; deleted_reason: string }, [string]>("SELECT title, description, deleted_reason FROM entries WHERE id = ?").get(a.id)!;
    expect(row).toEqual({ title: "", description: "", deleted_reason: "not wanted" });
    expect(await store.ingest({ ...idea, sourceId: "a" })).toEqual({ id: a.id, created: false });
    expect(store.counts()).toMatchObject({ entries: 1, deleted: 1 });
    await expect(store.delete(a.id, "again", "you")).rejects.toThrow("no such entry");
  });

  test("secrets: text is redacted and says where; key material is refused and says why", async () => {
    const { store } = open();
    const { id } = await store.ingest({
      ...idea,
      sourceId: "s",
      title: `token ${FAKE_KEY}`,
      description: `My key is ${FAKE_KEY} — oops.`,
      meta: { note: `again ${FAKE_KEY}` },
      files: [
        { path: "deploy.sh", bytes: enc(`export ANTHROPIC_API_KEY=${FAKE_KEY}\necho ok\n`) },
        { path: "id_ed25519", bytes: enc("not even a key") },
        { path: "notes/server.pem", bytes: enc("anything") },
        { path: "notebook.txt", bytes: enc("-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n") },
        { path: ".env", bytes: enc("X=1") },
      ],
    });
    const entry = store.get(id)!;
    expect(entry.title).not.toContain(FAKE_KEY);
    expect(entry.description).toContain("[redacted Anthropic API key]");
    expect(JSON.stringify(entry.meta)).not.toContain(FAKE_KEY);
    expect(entry.redactions.map((r) => r.where).sort()).toEqual(["deploy.sh", "description", "meta.note", "title"]);
    expect(entry.refused.map((r) => r.path).sort()).toEqual([".env", "id_ed25519", "notebook.txt", "notes/server.pem"]);
    expect(entry.refused.find((r) => r.path === "notebook.txt")!.why).toBe("it holds a private key");
    // The script is kept, without the key: its bytes (and so its hash) are the redacted ones.
    const script = new TextDecoder().decode((await store.file(id, "deploy.sh")).bytes);
    expect(script).toContain("[redacted");
    expect(script).not.toContain(FAKE_KEY);
    // Nothing secret-shaped anywhere in the index file's passages.
    const all = store.db.query<{ text: string }, []>("SELECT text FROM chunks").all().map((r) => r.text).join("\n");
    expect(all).not.toContain(FAKE_KEY);
  });

  test("the integrity check re-hashes every file and catches a flipped byte, and a missing one", async () => {
    const { store, dir } = open();
    const bytes = enc("a model of the keep, 1:100");
    const { id } = await store.ingest({ ...idea, sourceId: "m", files: [{ path: "keep.obj", bytes }, { path: "b.txt", bytes: enc("second") }] });
    expect(await store.verify()).toEqual({ checked: 2, problems: [] });
    const sha = sha256Hex(bytes);
    const path = join(dir, "blobs", sha.slice(0, 2), sha.slice(2, 4), sha);
    const flipped = readFileSync(path);
    flipped[3] = flipped[3]! ^ 0x01;
    writeFileSync(path, flipped);
    const second = sha256Hex(enc("second"));
    rmSync(join(dir, "blobs", second.slice(0, 2), second.slice(2, 4), second));
    const { checked, problems } = await store.verify();
    expect(checked).toBe(2);
    expect(problems.length).toBe(2);
    expect(problems.some((p) => p.startsWith(`changed: ${sha.slice(0, 16)}`) && p.includes(`${id} keep.obj`))).toBe(true);
    expect(problems.some((p) => p.startsWith("missing:") && p.includes("b.txt"))).toBe(true);
    expect(store.lastIntegrity()).toMatchObject({ ok: false, checked: 2 });
    // Serving a changed file refuses it rather than sending what no longer matches.
    await expect(store.file(id, "keep.obj")).rejects.toThrow("no longer matches its SHA-256");
    await expect(store.file(id, "b.txt")).rejects.toThrow("missing");
  });

  test("cursors move only forward with what was pulled; failures are recorded", () => {
    const { store } = open();
    expect(store.cursor("memories")).toEqual({ cursor: null, lastRun: null, lastError: null, pulled: 0 });
    store.advance("memories", "100", 3);
    store.sourceFailed("memories", "the mind was busy");
    expect(store.cursor("memories")).toMatchObject({ cursor: "100", pulled: 3, lastError: "the mind was busy" });
    store.advance("memories", "200", 2);
    expect(store.cursor("memories")).toMatchObject({ cursor: "200", pulled: 5, lastError: null });
  });
});

describe("chunking, per kind", () => {
  test("prose by paragraph, headings start a passage, each passage carries the title", () => {
    const paragraphs = Array.from({ length: 6 }, (_, i) => `Paragraph ${i} ${"word ".repeat(60)}`);
    const text = `# One\n\n${paragraphs.slice(0, 3).join("\n\n")}\n\n## Two\n\n${paragraphs.slice(3).join("\n\n")}`;
    const chunks = chunkProse(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.some((c) => c.startsWith("## Two"))).toBe(true);
    expect(chunks.every((c) => c.length <= 2000)).toBe(true);
    const entry = chunkEntry({ kind: "teaching", title: "Beams", description: text, files: [] });
    expect(entry.every((c) => c.text.startsWith("Beams\n"))).toBe(true);
  });

  test("code by top-level definition", () => {
    const code = ["import numpy as np", "", ...Array.from({ length: 8 }, (_, i) => `def f${i}(x):\n${"    x = x + 1\n".repeat(25)}    return x\n`)].join("\n");
    const chunks = chunkCode(code);
    expect(chunks.length).toBeGreaterThan(1);
    // No passage starts in the middle of a function.
    expect(chunks.every((c) => c.startsWith("def ") || c.startsWith("import"))).toBe(true);
  });

  test("a chat by exchange; a notebook without its outputs; data by its head", () => {
    const text = transcript([
      { role: "user", content: "How stiff is the beam?" },
      { role: "assistant", content: "About 2 kN/mm." },
      { role: "user", content: "And the bridge?" },
      { role: "assistant", content: "Stiffer." },
    ]);
    expect(chunkChat(text)).toEqual(["You: How stiff is the beam?\n\nGalahad: About 2 kN/mm.", "You: And the bridge?\n\nGalahad: Stiffer."]);
    const nb = JSON.stringify({ cells: [{ cell_type: "markdown", source: ["# Rocket\n"] }, { cell_type: "code", source: "thrust = 10", outputs: [{ data: { "image/png": "iVBORw0KGgo" } }] }] });
    expect(notebookText(nb)).toBe("# Rocket\n\n# [code cell]\nthrust = 10");
    const csv = `t,x\n${Array.from({ length: 10_000 }, (_, i) => `${i},${i * 2}`).join("\n")}`;
    const entry = chunkEntry({ kind: "artifact", title: "Run", description: "", files: [{ path: "out/data.csv", text: csv }] });
    expect(entry.length).toBe(1);
    expect(entry[0]!.origin).toBe("out/data.csv");
  });

  test("binary isn't read as text", () => {
    expect(asText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 1]))).toBeNull();
    expect(asText(enc("plain words"))).toBe("plain words");
  });
});

describe("model files: recognised, with what's known about them", () => {
  test("a binary STL: triangles and its bounding box", () => {
    const tri = 2;
    const buf = new ArrayBuffer(84 + tri * 50);
    const view = new DataView(buf);
    view.setUint32(80, tri, true);
    const verts = [
      [0, 0, 0, 10, 0, 0, 0, 5, 0],
      [0, 0, 2, 10, 5, 2, 0, 5, 2],
    ];
    verts.forEach((v, t) => v.forEach((x, i) => view.setFloat32(84 + t * 50 + 12 + i * 4, x, true)));
    const facts = modelFacts("part.stl", new Uint8Array(buf), null)!;
    expect(facts.format).toBe("STL mesh");
    expect(facts.facts).toContain("2 triangles (binary)");
    expect(facts.facts).toContain("bounding box 10 × 5 × 2 (units as drawn)");
  });

  test("a URDF's links and joints; a script that builds a model; not a model", () => {
    const urdf = `<robot name="so101"><link name="base"/><link name="shoulder"/><joint name="pan" type="revolute"/></robot>`;
    expect(modelFacts("robot.urdf", enc(urdf), urdf)!.facts).toEqual([`URDF robot, ${urdf.length} bytes`, "named so101", "2 links: base, shoulder", "1 joints: pan (revolute)"]);
    const script = "from build123d import *\nimport numpy\nwith BuildPart() as p:\n    Box(1, 2, 3)\n";
    expect(modelFacts("make_box.py", enc(script), script)!.format).toBe("script that builds a model (build123d)");
    expect(modelFacts("report.py", enc("print(1)"), "print(1)")).toBeNull();
    expect(modelFacts("notes.md", enc("x"), "x")).toBeNull();
  });
});

describe("the guard", () => {
  test("scrub says what it took out and where", () => {
    expect(scrub(`a ${FAKE_KEY} b`, "description")).toEqual({ text: "a [redacted Anthropic API key] b", redactions: [{ where: "description", kind: "Anthropic API key" }] });
    expect(scrub("nothing here", "x")).toEqual({ text: "nothing here", redactions: [] });
  });

  test("key material and session files by name, private keys by content", () => {
    for (const path of ["id_rsa", ".ssh/config", "secrets.json", "x/.env.local", "cookies.sqlite", "admin.token", "keys.json", "a.p12", ".galahad/keys.json"]) expect(refuseFile(path, enc("x"))).not.toBeNull();
    expect(refuseFile("model.stl", enc("-----BEGIN RSA PRIVATE KEY-----"))).toBe("it holds a private key");
    for (const path of ["model.stl", "id_rsa.pub", "report.md", "keyboard.py"]) expect(refuseFile(path, enc("ok"))).toBeNull();
  });
});

describe("vectors", () => {
  test("int8 with a scale per vector keeps cosine similarity within 1%", () => {
    for (let n = 0; n < 50; n++) {
      const a = Float32Array.from({ length: 384 }, () => Math.random() - 0.5);
      const b = Float32Array.from({ length: 384 }, () => Math.random() - 0.5);
      expect(Math.abs(cosine(dequantize(quantize(a)), dequantize(quantize(b))) - cosine(a, b))).toBeLessThan(0.01);
    }
  });

  test("top-k keeps the best, in order", () => {
    const top = new TopK(3);
    for (const [id, s] of [[1, 0.2], [2, 0.9], [3, 0.5], [4, 0.1], [5, 0.95]] as const) top.push(id, s);
    expect(top.ids).toEqual([5, 2, 3]);
  });

  test("the index scans, filters, and drops an entry's vectors", () => {
    const index = new VectorIndex("m", 64);
    const docs = ["the car", "a puppy", "the bridge span", "a dog and a hound"];
    docs.forEach((d, i) => index.add(i + 1, i + 10, quantize(conceptVector(d))));
    const found = index.search(conceptVector("canine"), 2);
    expect(found.map((f) => f.chunk).sort()).toEqual([2, 4]);
    expect(index.search(conceptVector("canine"), 2, (entry) => entry !== 11).map((f) => f.chunk)[0]).toBe(4);
    index.removeEntries(new Set([13]));
    expect(index.size).toBe(3);
    expect(index.search(conceptVector("canine"), 1)[0]!.chunk).toBe(2);
  });
});

describe("hybrid search: words and meaning, fused", () => {
  test("reciprocal rank fusion: what both lists like rises; each list counts an entry once", () => {
    const fused = fuse([
      [
        { entry: 1, chunk: 10 },
        { entry: 1, chunk: 11 },
        { entry: 2, chunk: 20 },
      ],
      [
        { entry: 2, chunk: 21 },
        { entry: 3, chunk: 30 },
      ],
    ]);
    expect(fused.map((f) => f.entry)).toEqual([2, 1, 3]);
    expect(fused[0]).toMatchObject({ entry: 2, best: [20, 21], found: [0, 1] });
    expect(fused[0]!.score).toBeCloseTo(1 / 62 + 1 / 61, 10);
  });

  test("query terms are inert in FTS (no syntax), stop words go, a snippet centres on a match", () => {
    expect(queryTerms("What is the DEFLECTION of a beam?")).toEqual(["deflection", "beam"]);
    expect(queryTerms("the")).toEqual(["the"]);
    expect(ftsQuery(['a"b', "NEAR"])).toBe('"ab"* OR "NEAR"*');
    expect(snippet(`Title\n${"x ".repeat(300)}needle ${"y ".repeat(300)}`, ["needle"], 100)).toContain("needle");
  });

  async function corpus() {
    const { store } = open();
    const docs = [
      ["a", "model", "Sedan crash test", "We drove the sedan into the barrier at 50 km/h; the crumple zone absorbed the energy.", "agent"],
      ["b", "teaching", "Cantilever deflection", "A beam fixed at one end deflects PL^3/3EI under a point load at its tip.", "owner"],
      ["c", "idea", "Truss for the stream crossing", "A small truss span over the stream by the lab, timber girders.", "owner"],
      ["d", "artifact", "Rocket thrust curve", "The booster's thrust peaked at 1.2 kN two seconds after launch.", "agent"],
      ["e", "chat", "Sourdough", "You: How long should the loaf proof?\n\nGalahad: Overnight, in the fridge.", "agent"],
      ["f", "teaching", "Web page on bridges", "Bridges: suspension, arch and beam bridges compared. Steel girders.", "untrusted"],
    ] as const;
    let t = 1_700_000_000_000;
    for (const [sourceId, kind, title, description, trust] of docs) {
      await store.ingest({ kind, source: "test", sourceId, title, description, trust, createdAt: (t += 1000) });
    }
    const pending = store.pendingChunks("concept", 100);
    store.storeVectors("concept", pending.map((c) => ({ chunk: c.id, entryRow: c.entryRow, vector: conceptVector(c.text) })));
    const id = (s: string) => archiveId("test", s);
    const search = (q: string, filters = {}, words = false) => store.search(q, filters, { model: words ? null : "concept", query: words ? null : conceptVector(q), limit: 3 });
    return { store, id, search };
  }

  test("by meaning, a passage that shares no word with the query is found; by words alone, it isn't", async () => {
    const { id, search } = await corpus();
    const hybrid = search("automobile");
    expect(hybrid.mode).toBe("hybrid");
    expect(hybrid.hits[0]).toMatchObject({ id: id("a"), matched: ["meaning"] });
    expect(hybrid.hits[0]!.similarity).toBeGreaterThan(0.5);
    // The meaning list's tail (passages about nothing like it) isn't offered as a result.
    expect(hybrid.hits.map((h) => h.id)).toEqual([id("a")]);
    expect(search("automobile", {}, true).hits).toEqual([]);
  });

  test("both lists agreeing beats either alone", async () => {
    const { id, search } = await corpus();
    // "girders" is in two documents' words; "span" (a bridge concept) only in one's.
    const hits = search("girders span").hits;
    expect(hits[0]!.id).toBe(id("c"));
    expect(hits[0]!.matched).toEqual(["text", "meaning"]);
    expect(hits.map((h) => h.id)).toContain(id("f"));
  });

  test("filters by kind, trust, source and time apply to both lists", async () => {
    const { id, search, store } = await corpus();
    expect(search("bridge", { trust: ["owner", "agent"] }).hits.map((h) => h.id)).not.toContain(id("f"));
    expect(search("bridge", { kinds: ["teaching"] }).hits.map((h) => h.id)).toEqual([id("f"), id("b")].filter((x) => search("bridge", { kinds: ["teaching"] }).hits.some((h) => h.id === x)));
    expect(search("bridge", { kinds: ["teaching"] }).hits.every((h) => h.kind === "teaching")).toBe(true);
    expect(search("rocket", { sources: ["elsewhere"] }).hits).toEqual([]);
    expect(search("rocket", { until: 1_700_000_003_000 }).hits.map((h) => h.id)).not.toContain(id("d"));
    expect(search("rocket", { since: 1_700_000_004_000 }).hits[0]!.id).toBe(id("d"));
    // Chats can be hidden from a caller who may not read them (agents).
    expect(store.search("loaf", {}, { model: "concept", query: conceptVector("loaf"), hideKinds: ["chat"] }).hits.map((h) => h.id)).not.toContain(id("e"));
  });

  test("an empty query lists the newest", async () => {
    const { id, store } = await corpus();
    const recent = store.search("", {}, { limit: 2 });
    expect(recent.mode).toBe("recent");
    expect(recent.hits.map((h) => h.id)).toEqual([id("f"), id("e")]);
  });

  test("nearest neighbours above a threshold become links", async () => {
    const { id, store } = await corpus();
    expect(store.linkSimilar(id("c"), "concept", 0.5)).toBeGreaterThan(0);
    const links = store.get(id("c"))!.links;
    expect(links.some((l) => l.rel === "similar" && l.id === id("f"))).toBe(true);
    expect(links.every((l) => (l.score ?? 0) >= 0.5)).toBe(true);
    expect(store.unlinked("concept", 10)).not.toContain(id("c"));
  });
});
