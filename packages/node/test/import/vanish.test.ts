import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { oldHome } from "./homes.ts";

/*
 * A write that ends between two looks at its journal is a write that ended. The import asked whether a database's
 * rollback journal was there and then how big it was, and a journal gone in between threw ENOENT: the import failed as
 * "can't be read" instead of reading on (once, in a full check under load, as the writer's process ended its write).
 * It looked at a write-ahead log the same way. Here the file vanishes at that very moment, in a process of its own
 * (vanish-child.ts mocks node:fs).
 */

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const root = mkdtempSync(join(tmpdir(), "q5v-"));
  roots.push(root);
  return oldHome(join(root, "galahad"));
}

/** Opens `database` with openReadOnly while `vanishing` goes the moment a look first finds it there. */
async function openWhileVanishing(database: string, vanishing: string): Promise<{ ok?: true; error?: string }> {
  const child = Bun.spawn(["bun", join(import.meta.dir, "vanish-child.ts"), database, vanishing], { stdout: "pipe", stderr: "inherit" });
  const out = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  return JSON.parse(out.trim().split("\n").at(-1)!);
}

describe("a file beside a database that goes between two looks at it", () => {
  test("its rollback journal: the write it held has ended, so the database is read on", async () => {
    const old = home();
    const journal = join(old, "team.db-journal");
    writeFileSync(journal, "a write under way");
    expect(await openWhileVanishing(join(old, "team.db"), journal)).toEqual({ ok: true });
  }, 30_000);

  test("its write-ahead log: said in the import's own words, never as ENOENT", async () => {
    const old = home();
    const wal = join(old, "mind.db-wal");
    writeFileSync(wal, "pages of a write under way");
    const { error } = await openWhileVanishing(join(old, "mind.db"), wal);
    expect(error).not.toContain("ENOENT");
    expect(error).toContain("has pages in its write-ahead log but no index beside it");
  }, 30_000);
});
