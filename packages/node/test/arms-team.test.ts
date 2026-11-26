import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomId, sha256B64u } from "@galahad/core";
import { ArmTokens } from "../src/arms.ts";

test("legacy external tokens cannot impersonate a newly reserved hivemind knight", () => {
  const db = new Database(":memory:");
  try {
    const arms = new ArmTokens(db);
    const legacy = `arm_${randomId(32)}`;
    db.query("INSERT INTO arm_tokens(label,hash,scopes,created_at) VALUES(?,?,?,?)").run("team.ada", sha256B64u(legacy), JSON.stringify(["sandbox", "mind:read"]), 1);
    expect(arms.verify(legacy)).toBeNull();
    expect(() => arms.mint("team.ada")).toThrow(/reserved/);
    const normal = arms.mint("hermes");
    expect(arms.verify(normal.token)?.label).toBe("hermes");
    expect(arms.revoke("team.ada")).toBe(true);
  } finally { db.close(); }
});

test("a legacy external token named for Galahad himself cannot act as him", () => {
  const db = new Database(":memory:");
  try {
    const arms = new ArmTokens(db);
    // Minted before his own name was reserved: it must not become the one identity his own tools' routes accept.
    const legacy = `arm_${randomId(32)}`;
    db.query("INSERT INTO arm_tokens(label,hash,scopes,created_at) VALUES(?,?,?,?)").run("galahad", sha256B64u(legacy), JSON.stringify(["mind:read", "mind:write", "chat"]), 1);
    expect(arms.verify(legacy)).toBeNull();
    expect(() => arms.mint("galahad")).toThrow(/Galahad himself/);
    expect(arms.revoke("galahad")).toBe(true);
  } finally { db.close(); }
});
