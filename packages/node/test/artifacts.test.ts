import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { type ArtifactView, b64u, newNodeIdentity, type RouteName, routes } from "@invincible/core";
import { enrollDevice, foundFleet, LedgerStore } from "@invincible/ledger";
import type { ExtractLimits, ExtractResult } from "@invincible/sandbox";
import { ArtifactStore, artifactTarget, contentTypeOf } from "../src/artifacts.ts";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { freePort } from "./ports.ts";

/*
 * Artifacts: what a sandbox's /work/out leaves behind. The collector (docker cp
 * through the hostile-archive extractor) is faked here; tar.test.ts and the
 * Docker integration tests cover the real one.
 */

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** A collector that "finds" these files in the sandbox, and leaves out what it is told was left out there. */
function collector(files: Record<string, string>, skipped: ExtractResult["skipped"] = [], said: { skippedCount?: number; skippedCut?: true } = {}) {
  return async (_sandbox: string, _from: string, dest: string, limits: ExtractLimits): Promise<ExtractResult | null> => {
    const entries = Object.entries(files);
    if (!entries.length) return null;
    let bytes = 0;
    const out: ExtractResult & typeof said = { files: [], bytes: 0, skipped: [...skipped], ...said };
    for (const [path, text] of entries) {
      bytes += text.length;
      if (bytes > limits.maxBytes) throw new Error("too big");
      const target = join(dest, ...path.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
      out.files.push({ path, size: text.length, sha256: sha(text) });
    }
    out.bytes = bytes;
    return out;
  };
}

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "invincible-art-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("keeping a sandbox's work", () => {
  const identity = newNodeIdentity();
  const store = new LedgerStore(":memory:");
  foundFleet(store, identity, { fleetName: "homelab", nodeName: "ultra" });
  const ledger: { resource: string; class: string; detail?: string }[] = [];
  const artifacts = new ArtifactStore({ store, identity, dir: temp(), ledger: (e) => ledger.push(e) });

  test("files are kept with their hashes, and the mind records what they are", async () => {
    const { artifact: kept } = await artifacts.save(collector({ "report.md": "# Beam\nδ = 1.67 mm\n", "plots/mode1.png": "PNG…", "data/u.csv": "x,u\n0,0\n" }), {
      sandbox: "0123456789",
      label: "Cantilever check",
      run: "q-1",
    });
    expect(kept).toMatchObject({ label: "Cantilever check", run: "q-1", sandbox: "0123456789", count: 3, here: true, nodeName: "ultra" });
    expect(kept!.files.find((f) => f.path === "report.md")!.sha256).toBe(sha("# Beam\nδ = 1.67 mm\n"));
    expect(store.lww<{ count: number }>(`artifact:${kept!.id}`)?.value?.count).toBe(3);
    expect(ledger.at(-1)).toMatchObject({ resource: "artifact", class: "create" });
    expect(new TextDecoder().decode(artifacts.read(kept!.id, "data/u.csv").bytes)).toBe("x,u\n0,0\n");
  });

  test("what a folder kept left out is named in its line of the ledger, each with why: as many as fit, the rest counted", async () => {
    const skipped = [
      { path: "out/closed", reason: "it can't be read here (PermissionError)" },
      { path: "out/pipe", reason: "neither a file, a folder nor a link" },
      { path: "out/peek", reason: "link" },
    ];
    await artifacts.save(collector({ "report.md": "# r\n" }, skipped), { sandbox: "0123456789" });
    expect(ledger.at(-1)!.detail).toBe("1 file(s), 4 bytes from sandbox 0123456789 · left out 3: out/closed (it can't be read here (PermissionError)); out/pipe (neither a file, a folder nor a link); out/peek (link)");
    // Many: as many as fit in the line, then how many more; no control character of a name reaches it.
    const many = Array.from({ length: 5000 }, (_, i) => ({ path: `out/n${i}\u001b[31m\n`, reason: "link" }));
    await artifacts.save(collector({ "report.md": "# r\n" }, many), { sandbox: "0123456789" });
    const line = ledger.at(-1)!.detail!;
    expect(line.length).toBeLessThanOrEqual(400);
    expect(line).toStartWith("1 file(s), 4 bytes from sandbox 0123456789 · left out 5000: out/n0?[31m? (link); out/n1?[31m? (link); ");
    expect(line).toMatch(/; … and \d+ more$/);
    expect(line).not.toMatch(/[\u0000-\u001f\u007f]/);
    const named = line.split("; ").length - 1;
    expect(line).toEndWith(`… and ${5000 - named} more`);
  });

  test("what was left out past those named is counted; a VM's account cut is said to be, and the count is then the least", async () => {
    const two = [
      { path: "out/closed", reason: "it can't be read here (PermissionError)" },
      { path: "out/peek", reason: "link" },
    ];
    const counted = await artifacts.save(collector({ "report.md": "# r\n" }, two, { skippedCount: 1100 }), { sandbox: "0123456789" });
    expect(counted.skipped).toEqual({ count: 1100, named: two });
    expect(ledger.at(-1)!.detail).toBe("1 file(s), 4 bytes from sandbox 0123456789 · left out 1100: out/closed (it can't be read here (PermissionError)); out/peek (link); … and 1098 more");
    const cut = await artifacts.save(collector({ "report.md": "# r\n" }, two, { skippedCount: 1100, skippedCut: true }), { sandbox: "0123456789" });
    expect(cut.skipped).toEqual({ count: 1100, named: two, cut: true });
    expect(ledger.at(-1)!.detail).toBe("1 file(s), 4 bytes from sandbox 0123456789 · left out at least 1100: out/closed (it can't be read here (PermissionError)); out/peek (link); … and at least 1098 more: the VM said more of it than the node reads");
  });

  test("nothing in /work/out: nothing kept, nothing recorded", async () => {
    const before = artifacts.list().length;
    expect(await artifacts.save(collector({}), { sandbox: "0123456789" })).toEqual({ artifact: null });
    expect(artifacts.list()).toHaveLength(before);
  });

  test("only files the manifest lists are ever served: no other path is opened", async () => {
    const kept = (await artifacts.save(collector({ "a.txt": "a" }), { sandbox: "0123456789" })).artifact!;
    for (const path of ["../manifest.json", "../../a.txt", "/etc/passwd", "a.txt/..", "b.txt"]) {
      expect(() => artifacts.read(kept.id, path)).toThrow(/no such file/);
    }
    expect(() => artifacts.read("art_xxxxxxxxxxxxxxxxxxxxxx", "a.txt")).toThrow(/no such artifact/);
  });

  test("HTML and SVG are shown as their source, never rendered; raster images inline; the rest downloads", () => {
    expect(contentTypeOf("report.html")).toEqual({ type: "text/plain; charset=utf-8", inline: true });
    expect(contentTypeOf("diagram.svg")).toEqual({ type: "text/plain; charset=utf-8", inline: true });
    expect(contentTypeOf("plot.PNG")).toEqual({ type: "image/png", inline: true });
    expect(contentTypeOf("part.stl")).toEqual({ type: "application/octet-stream", inline: false });
    expect(contentTypeOf("paper.pdf")).toEqual({ type: "application/pdf", inline: false });
  });

  test("removing deletes the files and records it; only the node holding them may record that", async () => {
    const kept = (await artifacts.save(collector({ "x.txt": "x" }), { sandbox: "0123456789" })).artifact!;
    const other = newNodeIdentity();
    enrollDevice(store, identity, { device: other.id, name: "laptop", kind: "node", box: b64u(other.boxPublic) });
    expect(() => store.emit(other, "artifact.removed", { id: kept.id })).toThrow(/only the node holding/);
    artifacts.remove(kept.id, "by you");
    expect(artifacts.get(kept.id)).toBeNull();
    expect(() => artifacts.read(kept.id, "x.txt")).toThrow(/no such artifact/);
    expect(() => store.emit(identity, "artifact.removed", { id: kept.id })).toThrow(/no such artifact/);
  });
});

describe("artifacts over the API", () => {
  const caps: Capabilities = {
    os: "linux",
    arch: "x64",
    hostname: "art",
    cores: 4,
    cpu: "test",
    memoryGb: 8,
    hasBattery: false,
    gpu: [],
    docker: false,
    vm: { kvm: false, tools: [] },
    tools: [],
    localModels: [],
    tailscale: null,
  };
  const root = temp();
  const home = new Home(join(root, "node"));
  const port = freePort();
  let daemon: Daemon;
  let armToken: string;
  let kept: ArtifactView;
  const send = (token: string, name: RouteName, input?: unknown) =>
    fetch(`http://127.0.0.1:${port}${routes[name].path}`, {
      method: routes[name].method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: routes[name].method === "POST" ? JSON.stringify(input ?? {}) : undefined,
    });

  beforeAll(async () => {
    const { identity, keystore } = await home.createIdentity("file");
    const store = new LedgerStore(home.ledgerPath);
    const fleet = foundFleet(store, identity, { fleetName: "homelab", nodeName: "ultra" });
    store.close();
    home.writeConfig({ v: 1, name: "ultra", fleet, port, keystore, advertise: "127.0.0.1" });
    daemon = await startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {} });
    armToken = ((await (await send(home.adminToken(), "mintArm", { label: "reader" })).json()) as { token: string }).token;
    kept = (await daemon.artifacts.save(collector({ "report.md": "# Result\n", "page.html": "<script>alert(1)</script>", "part.stl": "solid x" }), {
      sandbox: "0123456789",
      label: "API test",
    })).artifact!;
  });
  afterAll(async () => {
    await daemon?.stop();
  });

  test("listed for any reader; a file comes back as bytes, fenced", async () => {
    const list = (await (await send(armToken, "artifacts")).json()) as { artifacts: ArtifactView[] };
    expect(list.artifacts.map((a) => a.id)).toContain(kept.id);
    const md = await send(armToken, "artifactFile", { id: kept.id, path: "report.md" });
    expect(await md.text()).toBe("# Result\n");
    expect(md.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(md.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(md.headers.get("x-content-type-options")).toBe("nosniff");
    const html = await send(armToken, "artifactFile", { id: kept.id, path: "page.html" });
    expect(html.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const stl = await send(armToken, "artifactFile", { id: kept.id, path: "part.stl" });
    expect(stl.headers.get("content-disposition")).toBe('attachment; filename="part.stl"');
    expect((await send(armToken, "artifactFile", { id: kept.id, path: "../manifest.json" })).status).toBe(404);
  });

  test("an agent can't remove kept work; you can", async () => {
    expect((await send(armToken, "removeArtifact", { id: kept.id })).status).toBe(403);
    expect((await send(home.adminToken(), "removeArtifact", { id: kept.id })).status).toBe(200);
    expect((await send(home.adminToken(), "artifactFile", { id: kept.id, path: "report.md" })).status).toBe(404);
  });

  test("investigations: registered before they run, concluded once, readable by any reader", async () => {
    const registration = {
      question: "Does the cantilever's first mode sit near 2.09 Hz?",
      hypothesis: "Euler–Bernoulli gives 2.0888 Hz.",
      alternative: "Shear deformation shifts it by more than 1 %.",
      predictions: [{ id: "P1", statement: "FEM f1 ≈ theory", quantity: "f1 (Hz)", expected: "2.0888 ± 0.1 %", refutedIf: "differs by more than 0.1 %" }],
      method: "Hermite FEM, 4 to 256 elements",
      verification: ["convergence order ≈ 4"],
      uncertainty: "Richardson extrapolation",
      decision: "Supported if P1 holds on a converged mesh.",
    };
    const registered = (await (await send(armToken, "registerInvestigation", { registration })).json()) as { id: string };
    expect(registered.id).toMatch(/^inv_/);
    expect((await send(armToken, "registerInvestigation", { registration: { ...registration, predictions: [] } })).status).toBe(400);
    let list = (await (await send(armToken, "investigations")).json()) as { investigations: { id: string; status: string; registration: unknown }[] };
    expect(list.investigations.find((i) => i.id === registered.id)).toMatchObject({ status: "running", registration });
    expect((await send(armToken, "concludeInvestigation", { id: registered.id, status: "done", summary: "no conclusion given" })).status).toBe(400);
    const concluded = await send(armToken, "concludeInvestigation", {
      id: registered.id,
      status: "done",
      conclusion: "supported",
      summary: "f1 = 2.08879 Hz, 3e-8 from theory.",
      predictions: [{ id: "P1", verdict: "consistent", value: 2.088791, units: "Hz" }],
    });
    expect(concluded.status).toBe(200);
    expect((await send(armToken, "concludeInvestigation", { id: registered.id, status: "done", conclusion: "refuted", summary: "changed my mind" })).status).toBe(409);
    list = (await (await send(armToken, "investigations")).json()) as typeof list;
    expect(list.investigations.find((i) => i.id === registered.id)).toMatchObject({ status: "done", conclusion: "supported", predictions: [{ id: "P1", value: 2.088791 }] });
  });

  test("evals: recorded by you (never by an agent), and only when the marks add up", async () => {
    const record = {
      run: "r-api",
      suite: "engineering",
      problem: "rlc-step",
      title: "Step response of a series RLC circuit",
      domain: "electrical",
      seed: 9,
      status: "scored",
      score: 0.5,
      answers: [
        { key: "zeta", units: "1", expected: 0.25, got: 0.2501, tolerance: 0.00075, ok: true },
        { key: "t_peak_us", units: "µs", expected: 560.9, got: 600, tolerance: 1.68, ok: false },
      ],
      models: ["fake/engineer"],
      version: "abc1234",
      seconds: 120,
    };
    // The thing being measured can't write its own marks.
    expect((await send(armToken, "recordEval", record)).status).toBe(403);
    const inflated = await send(home.adminToken(), "recordEval", { ...record, score: 1 });
    expect(inflated.status).toBe(400);
    expect(await inflated.text()).toMatch(/score doesn't follow/);
    const ok = await send(home.adminToken(), "recordEval", record);
    expect(ok.status).toBe(200);
    const { evalCase } = (await ok.json()) as { evalCase: { id: string } };
    expect(evalCase.id).toMatch(/^tr_/);
    const list = (await (await send(armToken, "evals")).json()) as { evals: { id: string; nodeName: string; score: number }[] };
    expect(list.evals.find((t) => t.id === evalCase.id)).toMatchObject({ nodeName: "ultra", score: 0.5 });
  });

  test("this node isn't a sandbox host: saving says so", async () => {
    const response = await send(home.adminToken(), "saveArtifact", { sandbox: "0123456789" });
    expect(response.status).toBe(424);
    expect((await send(home.adminToken(), "saveArtifact", { sandbox: "0123456789", path: "/work/../etc" })).status).toBe(400);
  });
});

/*
 * Fetching an artifact (`invincible artifact <id> --out dir`) writes files named by the mind's
 * record, which another node signed. A stolen node key must not turn "fetch them all"
 * into a write anywhere on the machine that fetches.
 */
describe("where a fetched file lands", () => {
  const out = join(tmpdir(), "invincible-fetch-out");
  const root = resolve(out);

  test("inside the directory you chose, folders and all", () => {
    expect(artifactTarget(out, "report.md")).toBe(join(root, "report.md"));
    expect(artifactTarget(out, "plots/run 1/stress.png")).toBe(join(root, "plots", "run 1", "stress.png"));
  });

  test("a path that climbs out, is absolute or isn't a path is refused", () => {
    for (const path of ["../outside.txt", "a/../../outside.txt", "..", "/etc/cron.d/job", "", "a//b", "./a", "a/./b", "a/"]) {
      expect(() => artifactTarget(out, path)).toThrow("not a path inside the artifact");
    }
  });

  test("whatever this system's separators and drives are, nothing lands outside", () => {
    for (const path of ["..\\..\\outside.txt", "C:\\Windows\\evil.dll", "C:evil.txt", "\\\\server\\share\\x", "a/..\\..\\..\\x"]) {
      let target: string | null = null;
      try {
        target = artifactTarget(out, path);
      } catch {
        continue; // refused
      }
      expect(target.startsWith(root + sep)).toBe(true);
    }
  });
});

describe("a directory only just written, renamed", () => {
  const refuse = (code: string, times: number) => {
    let calls = 0;
    const rename = () => {
      if (calls++ < times) throw Object.assign(new Error(code), { code });
    };
    return { rename, calls: () => calls };
  };

  test("on Windows a momentary refusal (a scanner still reading it) is waited out; a lasting one stands", async () => {
    const { renameSettled } = await import("../src/artifacts.ts");
    const brief = refuse("EPERM", 2);
    await renameSettled("a", "b", brief.rename, "win32");
    expect(brief.calls()).toBe(3);
    const lasting = refuse("EBUSY", 99);
    await expect(renameSettled("a", "b", lasting.rename, "win32")).rejects.toThrow("EBUSY");
    expect(lasting.calls()).toBe(6);
  });

  test("anywhere else, and for any other error, the first refusal stands", async () => {
    const { renameSettled } = await import("../src/artifacts.ts");
    const linux = refuse("EPERM", 1);
    await expect(renameSettled("a", "b", linux.rename, "linux")).rejects.toThrow("EPERM");
    expect(linux.calls()).toBe(1);
    const missing = refuse("ENOENT", 1);
    await expect(renameSettled("a", "b", missing.rename, "win32")).rejects.toThrow("ENOENT");
    expect(missing.calls()).toBe(1);
  });
});
