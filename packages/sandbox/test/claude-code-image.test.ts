import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CLAUDE_CODE_IMAGE, DEFAULT_IMAGE, OWN_IMAGES } from "../src/index.ts";

/*
 * Claude Code for trials alone: the workshop image with Anthropic's release, pinned and checked against the checksums
 * of its signed manifest, so a run can put Claude Code and Galahad's own loop to the same tasks on the same model.
 */

const dockerfile = readFileSync(new URL("../../../sandbox/claude-code/Dockerfile", import.meta.url), "utf8");
const arg = (name: string): string => new RegExp(`^ARG ${name}=(\\S+)$`, "m").exec(dockerfile)?.[1] ?? "";

test("it is the workshop image, made where a trial needs it, and kept like the others", () => {
  expect(dockerfile).toMatch(/^FROM galahad\/sandbox:1$/m);
  expect(OWN_IMAGES[CLAUDE_CODE_IMAGE]).toEqual({ context: "claude-code", keeper: "galahad-claude-code-image", base: DEFAULT_IMAGE });
});

test("its tag is the release it pins, so a new pin is a new image and never the old one under the new name", () => {
  expect(arg("CLAUDE_CODE_VERSION")).toMatch(/^\d+\.\d+\.\d+$/);
  expect(CLAUDE_CODE_IMAGE).toBe(`galahad/claude-code:${arg("CLAUDE_CODE_VERSION")}`);
});

test("what it downloads is Anthropic's release, over https, and is checked before it is installed", () => {
  for (const sum of ["CLAUDE_CODE_SHA256", "CLAUDE_CODE_SHA256_ARM64"]) expect(arg(sum)).toMatch(/^[0-9a-f]{64}$/);
  const run = dockerfile.replace(/\\\n/g, " ");
  expect(run).toContain('curl -fsSL -o /tmp/claude "https://downloads.claude.ai/claude-code-releases/${CLAUDE_CODE_VERSION}/${platform}/claude"');
  expect(run.indexOf("sha256sum -c -")).toBeGreaterThan(run.indexOf("curl -fsSL"));
  expect(run.indexOf("install -m 0755 /tmp/claude /usr/local/bin/claude")).toBeGreaterThan(run.indexOf("sha256sum -c -"));
  // An architecture with no pin is refused, never installed unchecked.
  expect(run).toContain('*) echo "no Claude Code is pinned for ${TARGETARCH}" >&2; exit 1 ;;');
});

test("it never updates itself past the pin nor reports on itself, and ends as the knights' user", () => {
  expect(dockerfile).toContain("ENV DISABLE_UPDATES=1 \\\n    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1\n");
  expect(dockerfile.trimEnd().split("\n").filter((line) => line.startsWith("USER ")).at(-1)).toBe("USER 1000:1000");
});
