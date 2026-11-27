// Which runs are a private loop's (private-data.ts): by every id a loop's runs go by, a loop's name holding a dot too.
import { expect, test } from "bun:test";
import { runOfLoops, withheldRunLine } from "../src/private-data.ts";

test("a run is a loop's as the loop calls it, as its arm runs it, and as its arm names a run of its own; no other", () => {
  const loops = new Set(["rent", "mail.home"]);
  for (const run of ["loop.rent", "arm.loop.rent", "arm.loop.rent.t1", "arm.loop.mail.home", "arm.loop.mail.home.t2", "loop.mail.home"]) expect([run, runOfLoops(run, loops)]).toEqual([run, true]);
  for (const run of ["loop.rental", "arm.loop.ren", "arm.coder", "arm.rent", "rent", "q-check", "arm.loop.mail", "loop.mail.homes", undefined, null, 7]) expect([run, runOfLoops(run, loops)]).toEqual([run, false]);
  expect(runOfLoops("arm.loop.rent", new Set())).toBe(false);
});

test("a private run's lines in its own words say what they were and how they ended; a line of another kind is as it was", () => {
  const line = { class: "modify" as const, verdict: "allow" as const, run: "arm.loop.rent" };
  expect(withheldRunLine({ ...line, resource: "sandbox.exec", target: "invincible-sbx-0123456789", detail: "printf 'Ingrid' → exit 3" })?.detail).toBe("a command of a run your private data woke → exit 3");
  for (const resource of ["sandbox.stream", "sandbox.terminal", "rule"]) expect([resource, withheldRunLine({ ...line, resource, target: "t", detail: "printf 'Ingrid'" })?.detail]).toEqual([resource, "a line of a run your private data woke"]);
  const search = withheldRunLine({ ...line, class: "read", resource: "search", target: "Ingrid Vestergaard", reason: "a sandbox searched the web through its gateway" });
  expect([search?.target, search?.reason]).toEqual(["a search of a run your private data woke", "a sandbox searched the web through its gateway"]);
  for (const resource of ["docker.container", "connector.notes", "artifact"]) expect([resource, withheldRunLine({ ...line, resource, target: "t", detail: "d" })]).toEqual([resource, null]);
});
