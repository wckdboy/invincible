import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/*
 * The workshop image (sandbox/Dockerfile) is built on Ultra for x86-64 and on a Mac for Apple silicon (`container build
 * --platform linux/arm64`, where BuildKit says TARGETARCH=arm64). Node.js, OpenCode and Engram are fetched by version for
 * the platform being built and checked against that platform's SHA-256 (Node's from its release's signed SHASUMS256.txt;
 * the others the digest GitHub records for the asset, the x86-64 ones the pins reviewed before). Here the Dockerfile's own choice of asset and checksum is run in sh for each
 * platform: nothing is fetched, nothing built.
 */

const dockerfile = readFileSync(new URL("../../../sandbox/Dockerfile", import.meta.url), "utf8");
const arg = (name: string) => dockerfile.match(new RegExp(`^ARG ${name}=(\\S+)$`, "m"))?.[1];
/** The RUN that fetches `tool`, as one line, its steps split. */
const steps = (tool: string) =>
  (dockerfile.replace(/\\\n/g, " ").split("\n").find((line) => line.startsWith("RUN") && line.includes(`/tmp/${tool}.tgz`)) ?? "")
    .replace(/^RUN\s+/, "")
    .split(" && ")
    .map((s) => s.trim());

/** What the RUN's first step (its `case` on the platform) picks, run in sh with the image's own build arguments. */
async function picked(tool: string, targetArch: string | null): Promise<{ code: number; out: string }> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
  for (const name of ["NODE_VERSION", "NODE_SHA256", "NODE_SHA256_ARM64", "OPENCODE_VERSION", "OPENCODE_SHA256", "OPENCODE_SHA256_ARM64", "ENGRAM_VERSION", "ENGRAM_SHA256", "ENGRAM_SHA256_ARM64"]) env[name] = arg(name) ?? "";
  if (targetArch !== null) env.TARGETARCH = targetArch;
  // Only ever a `case` on the platform: never the download that follows it.
  const choice = steps(tool)[0] ?? "";
  if (!/^case "\$\{TARGETARCH:-amd64\}" in .* esac$/.test(choice)) return { code: -1, out: `its first step isn't a choice on the platform: ${choice.slice(0, 80)}` };
  const url = steps(tool).find((s) => s.startsWith("curl "))!.match(/"(https:[^"]+)"/)![1]!;
  const proc = Bun.spawn(["sh", "-c", `${choice}; echo "${url} \${sum}"`], { env, stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { code, out: out.trim() };
}

describe("the workshop image, for each platform it is built for", () => {
  test("its build arguments pin both platforms' assets", () => {
    expect(arg("NODE_VERSION")).toBe("26.13.1");
    expect(arg("NODE_SHA256")).toBe("518674de2b621728a5e4486f5fb3b7d2900bb3cc4aa97969edaa463db99f9778");
    expect(arg("NODE_SHA256_ARM64")).toBe("80a330b35415382878df18d41afbd106ea89bfb3be0087d6608e289a14c5cc7d");
    expect(arg("OPENCODE_VERSION")).toBe("2.2.6");
    expect(arg("OPENCODE_SHA256")).toBe("08bb21d6326ce740d91cce7ebe88a6536933f6e1e30353b91a06b01f25da306c");
    expect(arg("OPENCODE_SHA256_ARM64")).toBe("f2d27600c367e45057d6a16f6a5c2aa8d77b41a9b10d4bc3d849c2f88870e944");
    expect(arg("ENGRAM_VERSION")).toBe("3.7.2");
    expect(arg("ENGRAM_SHA256")).toBe("8db9d5db1c1574b8b830aac4ffbe86c024014aed6b9a3f0406ac3361a152cdf0");
    expect(arg("ENGRAM_SHA256_ARM64")).toBe("cdbbcb68d3e842d3e52e27edccef55e6fe98ce3cdbc90cd79894323b029efb50");
    expect(dockerfile).toMatch(/^ARG TARGETARCH$/m);
  });

  test("x86-64 (Ultra), and a builder that doesn't say: the assets and checksums it always had", async () => {
    for (const platform of ["amd64", null]) {
      expect(await picked("node", platform)).toEqual({ code: 0, out: "https://nodejs.org/dist/v26.13.1/node-v26.13.1-linux-x64.tar.gz 518674de2b621728a5e4486f5fb3b7d2900bb3cc4aa97969edaa463db99f9778" });
      expect(await picked("opencode", platform)).toEqual({ code: 0, out: "https://github.com/anomalyco/opencode/releases/download/v2.2.6/opencode-linux-x64.tar.gz 08bb21d6326ce740d91cce7ebe88a6536933f6e1e30353b91a06b01f25da306c" });
      expect(await picked("engram", platform)).toEqual({ code: 0, out: "https://github.com/Gentleman-Programming/engram/releases/download/v3.7.2/engram_3.7.2_linux_amd64.tar.gz 8db9d5db1c1574b8b830aac4ffbe86c024014aed6b9a3f0406ac3361a152cdf0" });
    }
  });

  test("Apple silicon (a Mac): the arm64 assets, each checked against its own checksum", async () => {
    expect(await picked("node", "arm64")).toEqual({ code: 0, out: "https://nodejs.org/dist/v26.13.1/node-v26.13.1-linux-arm64.tar.gz 80a330b35415382878df18d41afbd106ea89bfb3be0087d6608e289a14c5cc7d" });
    expect(await picked("opencode", "arm64")).toEqual({ code: 0, out: "https://github.com/anomalyco/opencode/releases/download/v2.2.6/opencode-linux-arm64.tar.gz f2d27600c367e45057d6a16f6a5c2aa8d77b41a9b10d4bc3d849c2f88870e944" });
    expect(await picked("engram", "arm64")).toEqual({ code: 0, out: "https://github.com/Gentleman-Programming/engram/releases/download/v3.7.2/engram_3.7.2_linux_arm64.tar.gz cdbbcb68d3e842d3e52e27edccef55e6fe98ce3cdbc90cd79894323b029efb50" });
  });

  test("a platform nothing is pinned for stops the build, rather than fetching what it can't check", async () => {
    for (const tool of ["node", "opencode", "engram"]) {
      // (Its own `exit 1`, not the guard's -1 for a step that isn't a choice on the platform.)
      expect((await picked(tool, "riscv64")).code).toBe(1);
    }
  });

  test("each is checked before anything of it is unpacked", () => {
    for (const tool of ["node", "opencode", "engram"]) {
      const at = steps(tool);
      const checked = at.findIndex((s) => s === `echo "\${sum}  /tmp/${tool}.tgz" | sha256sum -c -`);
      const unpacked = at.findIndex((s) => s.includes(`tar -xzf /tmp/${tool}.tgz`));
      expect(checked).toBeGreaterThan(0);
      expect(unpacked).toBeGreaterThan(checked);
    }
  });
});
