import { expect, test } from "bun:test";
import { containerName, LABEL, SandboxHost, type DockerRunner } from "../src/index.ts";

/*
 * A host lists its sandboxes with `docker ps`, then inspects them in one call. A sandbox removed between the two (another
 * quest's, ending) makes `docker inspect` exit 1, though it still prints every other one. That was read as "Docker
 * couldn't say", so the listing came back empty and a sandbox in use read as missing: on ultra on 21 November 2026, four
 * trials at a time, one crashed on its first command with "no such sandbox on this node".
 */

const LIVE = "0123456789";
const GONE = "9876543210";

function host(inspectAnswer: { code: number; stderr: string }) {
  const labels = (id: string) => ({
    [LABEL]: "1", [`${LABEL}.id`]: id, [`${LABEL}.node`]: "test", [`${LABEL}.quest`]: "test.quest",
    [`${LABEL}.network`]: "gateway", [`${LABEL}.ephemeral`]: "true", [`${LABEL}.isolation`]: "vm",
  });
  const runner: DockerRunner = async (args) => {
    if (args[0] === "info") return { code: 0, stdout: "29.0.0", stderr: "" };
    if (args[0] === "ps") return { code: 0, stdout: `${GONE}\n${LIVE}`, stderr: "" };
    // (Docker prints what it found, whatever it didn't.)
    if (args[0] === "inspect") return { ...inspectAnswer, stdout: JSON.stringify([{ Config: { Labels: labels(LIVE), Image: "galahad/sandbox:1" }, State: { Status: "running" } }]) };
    return { code: 0, stdout: "", stderr: "" };
  };
  return new SandboxHost({
    node: "test", maxCpus: 4, maxMemoryGb: 4, runner, ledger: () => {},
    tokens: { mint: () => ({ token: "test-only-token", info: { hash: "test-only-hash" } }), revoke: () => true },
  });
}

test("a sandbox that ended between the listing and the look is left out, and the rest are as they are", async () => {
  const h = host({ code: 1, stderr: `error: no such object: ${GONE}` });
  expect((await h.listed())?.map((s) => s.id)).toEqual([LIVE]);
  expect((await h.get(LIVE))?.status).toBe("running");
  expect((await h.exec(LIVE, ["true"])).exitCode).toBe(0);
});

test("Docker's older wording is read the same way", async () => {
  const h = host({ code: 1, stderr: `Error: No such object: ${containerName(GONE)}` });
  expect((await h.listed())?.map((s) => s.id)).toEqual([LIVE]);
});

test("any other failure is still Docker not saying, never a listing", async () => {
  const h = host({ code: 1, stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" });
  expect(await h.listed()).toBeNull();
  await expect(h.exec(LIVE, ["true"])).rejects.toThrow("no such sandbox on this node");
});
