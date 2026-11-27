import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DEFAULT_IMAGE, HARNESS_IMAGE, HARNESS_PINS, OWN_IMAGES } from "../src/index.ts";

/*
 * The vendors' own coding tools, pinned in a layer of the workshop image (sandbox/harnesses): each its vendor's release,
 * fetched by version for the platform being built, checked against that platform's SHA-256 before it is installed, and
 * installed as it came (no patch, no wrapper), with its updates off by its own setting. Here the Dockerfile's own choice
 * of asset and checksum is run in sh for each platform: nothing is fetched, nothing built.
 */

const dockerfile = readFileSync(new URL("../../../sandbox/harnesses/Dockerfile", import.meta.url), "utf8");
const arg = (name: string): string => new RegExp(`^ARG ${name}=(\\S+)$`, "m").exec(dockerfile)?.[1] ?? "";
const TOOLS = {
  claude: { version: "CLAUDE_CODE_VERSION", sums: ["CLAUDE_CODE_SHA256", "CLAUDE_CODE_SHA256_ARM64"], file: "/tmp/claude", url: /^https:\/\/downloads\.claude\.ai\/claude-code-releases\/[\d.]+\/linux-(x64|arm64)\/claude$/ },
  codex: { version: "CODEX_VERSION", sums: ["CODEX_SHA256", "CODEX_SHA256_ARM64"], file: "/tmp/codex.tgz", url: /^https:\/\/github\.com\/openai\/codex\/releases\/download\/rust-v[\d.]+\/codex-(x86_64|aarch64)-unknown-linux-musl\.tar\.gz$/ },
  // (Google's storage names a release by its version and its build: both are pinned.)
  agy: { version: "AGY_VERSION", sums: ["AGY_SHA256", "AGY_SHA256_ARM64"], also: ["AGY_BUILD"], file: "/tmp/agy.tgz", url: /^https:\/\/storage\.googleapis\.com\/antigravity-public\/antigravity-cli\/[\d.]+-\d+\/linux-(x64|arm)\/cli_linux_(x64|arm64)\.tar\.gz$/ },
} as const;

/** The RUN that fetches a tool, as one line, its steps split. */
const steps = (file: string) =>
  (dockerfile.replace(/\\\n/g, " ").split("\n").find((line) => line.startsWith("RUN") && line.includes(`-o ${file} `)) ?? "")
    .replace(/^RUN\s+/, "")
    .split(" && ")
    .map((s) => s.trim());

/** What the RUN's first step (its `case` on the platform) picks, run in sh with the image's own build arguments. */
async function picked(tool: keyof typeof TOOLS, targetArch: string | null): Promise<{ code: number; out: string; err: string }> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
  for (const t of Object.values(TOOLS)) for (const name of [t.version, ...t.sums, ...("also" in t ? t.also : [])]) env[name] = arg(name);
  if (targetArch !== null) env.TARGETARCH = targetArch;
  const run = steps(TOOLS[tool].file);
  const choice = run[0] ?? "";
  if (!/^case "\$\{TARGETARCH:-amd64\}" in .* esac$/.test(choice)) return { code: -1, out: "", err: `its first step isn't a choice on the platform: ${choice.slice(0, 80)}` };
  const url = run.find((s) => s.startsWith("curl "))!.match(/"(https:[^"]+)"/)![1]!;
  const proc = Bun.spawn(["sh", "-c", `${choice}; echo "${url} \${sum}"`], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out: out.trim(), err: err.trim() };
}

describe("the vendors' tools, pinned in the image", () => {
  test("it is the workshop image, made where a VM needs it, and kept like the others", () => {
    expect(dockerfile).toMatch(/^FROM invincible\/sandbox:1$/m);
    expect(OWN_IMAGES[HARNESS_IMAGE]).toEqual({ context: "harnesses", keeper: "invincible-harnesses-image", base: DEFAULT_IMAGE });
  });

  test("its tag is the releases it pins, so a new pin is a new image; what readiness names is the same", () => {
    for (const t of Object.values(TOOLS)) expect(arg(t.version)).toMatch(/^\d+\.\d+\.\d+$/);
    expect(arg("AGY_BUILD")).toMatch(/^\d+$/);
    expect(HARNESS_IMAGE).toBe(`invincible/harnesses:claude-${arg("CLAUDE_CODE_VERSION")}.codex-${arg("CODEX_VERSION")}.agy-${arg("AGY_VERSION")}`);
    expect(HARNESS_PINS as Record<string, string>).toEqual({ claude: arg("CLAUDE_CODE_VERSION"), codex: arg("CODEX_VERSION"), agy: arg("AGY_VERSION") });
  });

  test("for each platform, each tool is its vendor's own release over https, with that platform's checksum", async () => {
    for (const [tool, t] of Object.entries(TOOLS) as [keyof typeof TOOLS, (typeof TOOLS)[keyof typeof TOOLS]][]) {
      for (const sum of t.sums) expect(arg(sum)).toMatch(/^[0-9a-f]{64}$/);
      expect(arg(t.sums[0])).not.toBe(arg(t.sums[1]));
      const amd = await picked(tool, "amd64");
      const arm = await picked(tool, "arm64");
      const unsaid = await picked(tool, null);
      expect(amd.code).toBe(0);
      expect(arm.code).toBe(0);
      const [amdUrl, amdSum] = amd.out.split(" ");
      const [armUrl, armSum] = arm.out.split(" ");
      expect(amdUrl).toMatch(t.url);
      expect(armUrl).toMatch(t.url);
      expect(amdUrl).toMatch(/x64|x86_64/);
      expect(armUrl).toMatch(/arm64|aarch64/);
      expect([amdSum, armSum]).toEqual([arg(t.sums[0]), arg(t.sums[1])]);
      // A builder that doesn't say builds for amd64, as the workshop's does.
      expect(unsaid.out).toBe(amd.out);
      // An architecture with no pin is refused, never installed unchecked.
      const other = await picked(tool, "riscv64");
      expect(other.code).not.toBe(0);
      expect(other.err).toMatch(/is pinned for riscv64/);
    }
  });

  test("each is checked before it is installed, and installed as it came: no patch, no wrapper", () => {
    for (const t of Object.values(TOOLS)) {
      const run = steps(t.file);
      const fetched = run.findIndex((s) => s.startsWith("curl -fsSL -o "));
      const checked = run.findIndex((s) => s.endsWith(`| sha256sum -c -`) && s.includes(t.file));
      const installed = run.findIndex((s) => s.startsWith("install -m 0755 "));
      expect(fetched).toBeGreaterThan(0);
      expect(checked).toBeGreaterThan(fetched);
      expect(installed).toBeGreaterThan(checked);
    }
    // The only writes to where the tools are found are the installs of what was checked.
    const installs = dockerfile.match(/\/usr\/local\/bin\/[a-z-]+/g) ?? [];
    expect([...new Set(installs)].sort()).toEqual(["/usr/local/bin/agy", "/usr/local/bin/claude", "/usr/local/bin/codex"]);
    expect(dockerfile).not.toMatch(/\b(sed|patch|perl)\b[^\n]*\/usr\/local\/bin|cat\s*>\s*\/usr\/local\/bin|ln -s[^\n]*\/usr\/local\/bin/);
  });

  test("none updates itself past its pin, and it ends as the agents' user", () => {
    expect(dockerfile).toContain("ENV DISABLE_UPDATES=1 \\\n    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \\\n    AGY_CLI_DISABLE_AUTO_UPDATE=true\n");
    expect(dockerfile.trimEnd().split("\n").filter((line) => line.startsWith("USER ")).at(-1)).toBe("USER 1000:1000");
  });
});
