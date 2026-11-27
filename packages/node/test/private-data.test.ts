// Which runs are a private loop's (private-data.ts): by every id a loop's runs go by, a loop's name holding a dot too.
import { expect, test } from "bun:test";
import { runOfLoops } from "../src/private-data.ts";

test("a run is a loop's as the loop calls it, as its arm runs it, and as its arm names a run of its own; no other", () => {
  const loops = new Set(["rent", "mail.home"]);
  for (const run of ["loop.rent", "arm.loop.rent", "arm.loop.rent.t1", "arm.loop.mail.home", "arm.loop.mail.home.t2", "loop.mail.home"]) expect([run, runOfLoops(run, loops)]).toEqual([run, true]);
  for (const run of ["loop.rental", "arm.loop.ren", "arm.coder", "arm.rent", "rent", "q-check", "arm.loop.mail", "loop.mail.homes", undefined, null, 7]) expect([run, runOfLoops(run, loops)]).toEqual([run, false]);
  expect(runOfLoops("arm.loop.rent", new Set())).toBe(false);
});
