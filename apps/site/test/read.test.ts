import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { androidVersion, readAndroid, readAndroidMinSdk, readAppcast, readAppleTargets, readBunPin, readInstaller, readPlan, readTagline } from "../src/lib/read.ts";
import { installSteps, parts } from "../src/lib/install-steps.ts";

/*
 * What invincible.sh says, read from the repository (src/lib/read.ts): the files as they are now, and what a release
 * writes into the feeds. A file that doesn't say what the page needs fails the build, never a page that says otherwise.
 */

const ROOT = resolve(import.meta.dir, "../../..");
const file = (path: string) => readFileSync(join(ROOT, path), "utf8");
const REPO = "wckdboy/invincible";

describe("the installer, as the page tells it", () => {
  const installer = readInstaller(file("scripts/install.sh"));

  test("its one line, its repository and ref, its options and where things go, from the script itself", () => {
    expect(installer.command).toBe("curl -fsSL https://invincible.sh | bash");
    expect(installer.repo).toBe(REPO);
    expect(installer.ref).toBe("main");
    expect(installer.options.map((o) => o.flag)).toEqual(expect.arrayContaining(["--join <invite>", "--ref <ref>", "--no-service", "--plan"]));
    expect(installer.places).toEqual([
      { variable: "INVINCIBLE_INSTALL_DIR", path: "~/.local/share/invincible" },
      { variable: "INVINCIBLE_BIN_DIR", path: "~/.local/bin" },
      { variable: "INVINCIBLE_HOME", path: "~/.invincible" },
    ]);
  });

  test("each of its sections is a step on the page, in its order, with a line of its own", () => {
    const steps = installSteps(installer, readBunPin(file("scripts/bun-pin.sh")));
    expect(steps.map((s) => s.heading)).toEqual(installer.steps);
    expect(steps.length).toBeGreaterThanOrEqual(7);
    for (const step of steps) expect(step.line.length).toBeGreaterThan(20);
    expect(steps.find((s) => s.heading.startsWith("Bun"))!.line).toContain(readBunPin(file("scripts/bun-pin.sh")));
  });

  test("a section the page doesn't tell, or one it tells that the script dropped, fails the build", () => {
    expect(() => installSteps({ ...installer, steps: [...installer.steps, "Something new"] }, "1.4.4")).toThrow(/new: "Something new"/);
    expect(() => installSteps({ ...installer, steps: installer.steps.slice(1) }, "1.4.4")).toThrow(/gone: "Which Invincible/);
  });

  test("a script without its line, its repository or its sections isn't read as one", () => {
    expect(() => readInstaller("#!/usr/bin/env bash\n# nothing\nREPO=a/b\nREF=main\n")).toThrow(/curl -fsSL/);
    expect(() => readBunPin("BUN_VERSION=latest")).toThrow(/BUN_VERSION/);
  });

  test("a line's `code` is set apart", () => {
    expect(parts("Run `inv ask` now")).toEqual([{ text: "Run ", code: false }, { text: "inv ask", code: true }, { text: " now", code: false }]);
  });
});

describe("the apps' feeds", () => {
  test("as committed: the Mac's an empty channel and Android's an empty record, until each one's first release", () => {
    expect(readAppcast(file("apps/site/public/mac/appcast.xml"), REPO)).toBeNull();
    expect(readAndroid(file("apps/site/public/android/latest.json"), REPO)).toBeNull();
  });

  test("the Mac's feed as apps/apple/scripts/mac-release.sh writes it", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>Invincible for Mac</title>
    <link>https://invincible.sh</link>
    <item>
      <title>Invincible 0.1.0 (202612011200)</title>
      <pubDate>Tue, 01 Dec 2026 12:00:00 +0000</pubDate>
      <sparkle:version>202612011200</sparkle:version>
      <sparkle:shortVersionString>0.1.0</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>27.0</sparkle:minimumSystemVersion>
      <enclosure url="https://github.com/${REPO}/releases/download/mac-202612011200/Invincible-for-Mac-202612011200.zip" sparkle:edSignature="FAKE-FOR-TESTS" length="48123456" type="application/octet-stream"/>
    </item>
  </channel>
</rss>`;
    expect(readAppcast(xml, REPO)).toEqual({ version: "0.1.0", build: "202612011200", macOS: "27", url: `https://github.com/${REPO}/releases/download/mac-202612011200/Invincible-for-Mac-202612011200.zip`, bytes: 48123456, date: "2026-12-01T12:00:00.000Z" });
    expect(() => readAppcast(xml.replace(`github.com/${REPO}`, "example.test/elsewhere"), REPO)).toThrow(/outside the repository's releases/);
    expect(() => readAppcast("<html></html>", REPO)).toThrow(/RSS/);
  });

  test("Android's record as apps/android/scripts/publish.sh writes it", () => {
    const record = {
      version: "0.1.0 (202612011200)",
      build: "202612011200",
      url: `https://github.com/${REPO}/releases/download/android-202612011200/Invincible-202612011200.apk`,
      size: 21_500_000,
      sha256: "a".repeat(64),
      certificate: "b".repeat(64),
      minSdk: 29,
      date: "2026-12-01T12:00:00Z",
    };
    expect(readAndroid(JSON.stringify(record), REPO)).toMatchObject({ build: "202612011200", bytes: 21_500_000, minSdk: 29, date: "2026-12-01T12:00:00.000Z" });
    expect(() => readAndroid(JSON.stringify({ ...record, url: "https://example.test/app.apk" }), REPO)).toThrow(/outside/);
    expect(() => readAndroid(JSON.stringify({ ...record, sha256: undefined }), REPO)).toThrow(/sha256/);
    expect(() => readAndroid("[]", REPO)).toThrow(/object/);
  });
});

describe("the rest of what the page says", () => {
  test("the apps' oldest systems, from their builds", () => {
    expect(readAppleTargets(file("apps/apple/project.yml"))).toEqual({ iOS: expect.stringMatching(/^\d+(\.\d+)?$/), macOS: expect.stringMatching(/^\d+(\.\d+)?$/) });
    expect(androidVersion(readAndroidMinSdk(file("apps/android/app/build.gradle.kts")))).toMatch(/^\d+/);
    expect(androidVersion(29)).toBe("10");
    expect(() => androidVersion(5)).toThrow();
  });

  test("the plan's phases, each with where it stands, and the README's own line", () => {
    const phases = readPlan(file("docs/PLAN.md"));
    expect(phases.map((p) => p.n)).toEqual(phases.map((_, i) => i));
    expect(phases.every((p) => ["done", "building", "next"].includes(p.state) && p.title.length > 2)).toBe(true);
    expect(readTagline(file("README.md"))).toMatch(/agent/);
    expect(() => readPlan("# no phases")).toThrow();
  });
});
