import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/*
 * The agents' image puts its tools on the PATH with ENV, and an agent's commands run in login shells
 * (packages/agents/src/team-runtime.ts), where /etc/profile sets PATH afresh: Debian's does. Seen on ultra on
 * 14 November 2026, in the first task an agent ran in a real VM: its gate, `bun test`, exited 127, though bun
 * was in the image and the agent's tests passed when it called bun by its whole path. So the image carries a
 * script that every login shell reads, which puts the image's tools back, and this holds the two together.
 */

const context = new URL("../../../sandbox/", import.meta.url);
const dockerfile = readFileSync(new URL("Dockerfile", context), "utf8");
const script = fileURLToPath(new URL("tools-path.sh", context));

/** The PATH a plain shell has in the image, from `base`: each `ENV PATH=…` of the Dockerfile, in order. */
const imagePath = (base: string): string =>
  [...dockerfile.matchAll(/^ENV PATH=(\S+)$/gm)].reduce((path, line) => line[1]!.replaceAll("$PATH", path), base);
/** What Debian's /etc/profile leaves a login shell that isn't root's. */
const PROFILE_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/local/games:/usr/games";

/** The PATH after a shell that begins with `path` reads the script (`times`: a login shell started from another reads it again). */
const afterScript = async (path: string, times = 1): Promise<string> => {
  const proc = Bun.spawn(["/bin/sh", "-c", `${'. "$1"; '.repeat(times)}printf %s "$PATH"`, "sh", script], { env: { PATH: path, HOME: "/work" }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect({ stderr, exitCode }).toEqual({ stderr: "", exitCode: 0 });
  return stdout;
};

test("the image puts tools on the PATH (or there is nothing here to hold together)", () => {
  expect(imagePath("BASE").split(":")).toEqual(["/opt/engram/bin", "/opt/opencode/bin", "/opt/node/bin", "/opt/bun/bin", "BASE", "/work/.local/bin"]);
});

test("what npm installs globally goes to the workspace, where the agent's PATH finds it: the image is read-only", () => {
  expect(dockerfile).toContain("ENV NPM_CONFIG_PREFIX=/work/.local\n");
  expect(imagePath("BASE").split(":")).toContain("/work/.local/bin");
});

test("what an agent's VM has installed for itself (~/.local/bin, kept with its workspace) is found, and last: it can't stand in for a tool the image or the system has", async () => {
  // AGENTS.md tells the owner to install a vendor's coding tool there; Claude Code's installer puts it there.
  expect(dockerfile).toContain("ENV HOME=/work\n");
  expect(imagePath("BASE").split(":").at(-1)).toBe("/work/.local/bin");
  expect((await afterScript(PROFILE_PATH)).split(":").at(-1)).toBe("/work/.local/bin");
});

test("a login shell in the agents' image has every tool a plain shell there has, in the same order", async () => {
  expect(await afterScript(PROFILE_PATH)).toBe(imagePath(PROFILE_PATH));
});

test("a login shell started from another (a harness that starts its own) has them once, not twice", async () => {
  expect(await afterScript(PROFILE_PATH, 2)).toBe(imagePath(PROFILE_PATH));
  // And one whose PATH was never set afresh is left as it was.
  expect(await afterScript(imagePath("/usr/bin:/bin"))).toBe(imagePath("/usr/bin:/bin"));
});

test("the image installs that script where Debian's /etc/profile reads it, readable by the agent", () => {
  const copied = /^COPY tools-path\.sh (\/etc\/profile\.d\/(\S+))$/m.exec(dockerfile);
  expect(copied).not.toBeNull();
  // /etc/profile reads only names of this form (its run-parts --regex).
  expect(copied![2]).toMatch(/^[a-zA-Z0-9_][a-zA-Z0-9._-]*\.sh$/);
  // Its mode is said, not left to whatever the checkout's umask gave the file.
  expect(dockerfile).toContain(`RUN chmod 0644 ${copied![1]}\n`);
  // Before the image drops to the agent's user: /etc is root's.
  expect(dockerfile.indexOf(`RUN chmod 0644 ${copied![1]}`)).toBeLessThan(dockerfile.indexOf("USER 1000:1000"));
});

/** The agents' desktop, made from the workshop: what its own Dockerfile adds to the environment. */
const desktopDockerfile = readFileSync(new URL("desktop/Dockerfile", context), "utf8");

test("the desktop image adds no PATH of its own: a login shell there has every tool the workshop's has, in the same order", () => {
  expect(desktopDockerfile).not.toMatch(/^ENV PATH=/m);
  // Its command is where every login shell looks already (deskd beside it is run by it, by its whole path).
  expect(desktopDockerfile).toMatch(/-o \/usr\/local\/bin\/desktop /);
  expect(PROFILE_PATH.split(":")).toContain("/usr/local/bin");
});

test("its text is UTF-8 in a login shell too: the image sets LANG, and what every login shell reads leaves it as it is", async () => {
  expect(desktopDockerfile).toMatch(/^ENV LANG=C\.UTF-8$/m);
  const proc = Bun.spawn(["/bin/sh", "-c", '. "$1"; printf %s "$LANG"', "sh", script], { env: { PATH: PROFILE_PATH, HOME: "/work", LANG: "C.UTF-8" }, stdout: "pipe", stderr: "pipe" });
  expect(await new Response(proc.stdout).text()).toBe("C.UTF-8");
  expect(await proc.exited).toBe(0);
});
