import { expect, test } from "bun:test";
import { gateSweepArgs, gateUsers } from "../src/index.ts";

/*
 * A round of gates' VM's users (gate.ts gateUsers; the twelfth fabric re-review's R12-1): the image's own /etc/passwd
 * and /etc/group, then each gate's user, gate1… (61001…), so a tool that asks who it runs as has an answer.
 */

const PASSWD = "root:x:0:0:root:/root:/bin/bash\nagent:x:1000:1000::/home/agent:/bin/bash\nnobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n";
const GROUP = "root:x:0:\nagent:x:1000:\nnogroup:x:65534:\n";

test("the image's own users first, as they were, then each gate's: gate1 is 61001, gate256 is 61256", () => {
  const made = gateUsers(PASSWD, GROUP);
  if ("why" in made) throw new Error(made.why);
  const passwd = made.passwd.split("\n").filter(Boolean);
  expect(passwd.slice(0, 3)).toEqual(PASSWD.trim().split("\n"));
  expect(passwd[3]).toBe("gate1:x:61001:61001:a gate's user:/nonexistent:/usr/sbin/nologin");
  expect(passwd.at(-1)).toBe("gate256:x:61256:61256:a gate's user:/nonexistent:/usr/sbin/nologin");
  expect(passwd).toHaveLength(3 + 256);
  const group = made.group.split("\n").filter(Boolean);
  expect(group.slice(0, 3)).toEqual(GROUP.trim().split("\n"));
  expect(group[3]).toBe("gate1:x:61001:");
  // (A file with no newline at its end keeps its last line whole.)
  const bare = gateUsers(PASSWD.trimEnd(), GROUP.trimEnd());
  if ("why" in bare) throw new Error(bare.why);
  expect(bare.passwd.split("\n")[2]).toBe("nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin");
});

test("an image that already has a gate's user, by id or by name, in either file makes no round: its gates couldn't be told apart", () => {
  expect(gateUsers(`${PASSWD}ci:x:61005:61005::/home/ci:/bin/sh\n`, GROUP)).toEqual({ why: "its image's passwd already names ci (61005), a gate's user" });
  expect(gateUsers(`${PASSWD}gate7:x:2000:2000::/home/g:/bin/sh\n`, GROUP)).toEqual({ why: "its image's passwd already names gate7 (2000), a gate's user" });
  expect(gateUsers(PASSWD, `${GROUP}builders:x:61100:\n`)).toEqual({ why: "its image's group already names builders (61100), a gate's user" });
  // Ids beside the range are an image's own to have.
  expect("why" in gateUsers(`${PASSWD}a:x:61000:61000::/:/bin/sh\nb:x:61257:61257::/:/bin/sh\n`, GROUP)).toBe(false);
});

test("the sweep runs as a gate's user alone", () => {
  expect(gateSweepArgs("invincible-sbx-0123456789", 61001).slice(0, 6)).toEqual(["exec", "--user", "61001:61001", "--workdir", "/gates", "invincible-sbx-0123456789"]);
  for (const uid of [65534, 1000, 0, 61257]) expect(() => gateSweepArgs("invincible-sbx-0123456789", uid)).toThrow("not a gate's user");
});
