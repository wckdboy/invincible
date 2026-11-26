import { expect, test } from "bun:test";
import { freePort, TEST_PORTS } from "./ports.ts";

test("a test's ports: never one the OS hands a server that asks for any port, never the same twice in a run", () => {
  const given = Array.from({ length: 50 }, () => freePort());
  expect(new Set(given).size).toBe(50);
  for (const port of given) expect(port >= TEST_PORTS.first && port <= TEST_PORTS.last).toBe(true);
  // What the OS hands out for `port: 0` is outside them, so a stand-in started after a port was chosen never takes it.
  for (let i = 0; i < 20; i++) {
    const any = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
    try {
      expect(any.port! < TEST_PORTS.first || any.port! > TEST_PORTS.last).toBe(true);
    } finally {
      any.stop(true);
    }
  }
});
