import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomId, sha256B64u } from "@invincible/core";
import { ArmTokens } from "../src/arms.ts";

test("legacy external tokens cannot impersonate a newly reserved hivemind agent", () => {
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

test("a legacy external token named for your agent itself cannot act as it", () => {
  const db = new Database(":memory:");
  try {
    const arms = new ArmTokens(db);
    // Minted before its own name was reserved: it must not become the one identity its own tools' routes accept.
    const legacy = `arm_${randomId(32)}`;
    db.query("INSERT INTO arm_tokens(label,hash,scopes,created_at) VALUES(?,?,?,?)").run("primary", sha256B64u(legacy), JSON.stringify(["mind:read", "mind:write", "chat"]), 1);
    expect(arms.verify(legacy)).toBeNull();
    expect(() => arms.mint("primary")).toThrow(/your agent itself/);
    expect(arms.revoke("primary")).toBe(true);
  } finally { db.close(); }
});
