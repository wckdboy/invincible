import { expect, test } from "bun:test";
import type { SandboxView } from "@invincible/core";
import { environment } from "../src/run-cli.ts";

/*
 * What a run's agent is told of its sandbox (`invincible run`, an eval's run): a desktop where its image has one (C1
 * step 8), and on it the hardware tools where its image is the hardware one (C1 step 11). Told by the image's name, as
 * the node knows it; one without either is told nothing of them.
 */

const sandbox = (image: string) => ({ id: "0123456789", image, isolation: "vm", network: "gateway", providers: [], cpus: 1, memoryGb: 2 }) as unknown as SandboxView;

test("a run is told of its desktop where its image has one, and of the hardware tools where its image is theirs", () => {
  const plain = environment(sandbox("invincible/sandbox:1"), "ultra");
  const desktop = environment(sandbox("invincible/desktop:1"), "ultra");
  const hardware = environment(sandbox("invincible/desktop-hardware:1"), "ultra");
  expect(plain).not.toContain("desktop");
  expect(desktop).toContain("This VM has a desktop");
  expect(desktop).not.toContain("hardware tools");
  expect(hardware).toContain("This VM has a desktop");
  expect(hardware).toContain("This desktop has the hardware tools: KiCad 9 for boards and schematics, and FreeCAD 1.0 for parts.");
  // (The Lab's own words aren't the hardware image's: its name says desktop, not lab.)
  expect(hardware).not.toContain("The Lab:");
});
