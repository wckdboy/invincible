import { afterAll, beforeAll, describe, expect, test } from "bun:test";

/*
 * This browser's key lives in IndexedDB. A store that can't be read right now (Safari
 * drops its storage connection after a Home Screen app sleeps; a private window may
 * refuse it) must never look like "not paired": the welcome screen would then offer to
 * pair again, and pairing writes a new key over the enrolled one.
 */

type Req = { result?: unknown; error?: unknown; onsuccess?: () => void; onerror?: () => void; onupgradeneeded?: () => void };
let failOpens = 0;
let stored: unknown = undefined;
let opens = 0;

const fakeDb = {
  transaction: () => ({
    objectStore: () => ({
      get: () => {
        const r: Req = {};
        queueMicrotask(() => {
          r.result = stored;
          r.onsuccess?.();
        });
        return r;
      },
    }),
  }),
  close: () => {},
};

const saved = (globalThis as { indexedDB?: unknown }).indexedDB;
beforeAll(() => {
  (globalThis as { indexedDB?: unknown }).indexedDB = {
    open: () => {
      opens++;
      const r: Req = {};
      setTimeout(() => {
        if (failOpens > 0) {
          failOpens--;
          r.error = new Error("Connection to Indexed Database server lost. Refresh the page to try again");
          r.onerror?.();
        } else {
          r.result = fakeDb;
          r.onsuccess?.();
        }
      }, 0);
      return r;
    },
  };
});
afterAll(() => {
  (globalThis as { indexedDB?: unknown }).indexedDB = saved;
});

describe("this browser's key", () => {
  test("no key stored: nothing to load (pairing may make one)", async () => {
    const { loadIdentity } = await import("./identity.ts");
    stored = undefined;
    failOpens = 0;
    expect(await loadIdentity()).toBeNull();
  });

  test("a store that fails once is tried again, and the key is found", async () => {
    const { loadIdentity } = await import("./identity.ts");
    stored = { device: "c_test", enrolled: true, name: "Test browser" };
    failOpens = 1;
    opens = 0;
    expect((await loadIdentity())?.device).toBe("c_test");
    expect(opens).toBe(2);
  });

  test("a store that can't be read is an error, never 'not paired'", async () => {
    const { loadIdentity, KeyStoreUnavailable } = await import("./identity.ts");
    stored = { device: "c_test", enrolled: true, name: "Test browser" };
    failOpens = 10;
    await expect(loadIdentity()).rejects.toBeInstanceOf(KeyStoreUnavailable);
    failOpens = 0;
  });
});

describe("a new device's name", () => {
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1";
  const ANDROID = "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36";
  const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

  test("a browser tab is named for the browser and the device", async () => {
    const { defaultDeviceName } = await import("./identity.ts");
    expect(defaultDeviceName(IPHONE, false)).toBe("Safari on iPhone");
    expect(defaultDeviceName(ANDROID, false)).toBe("Chrome on Android");
    expect(defaultDeviceName(MAC, false)).toBe("Chrome on Mac");
  });

  test("an installed app is its own device, and named as the app: never the browser it was added from", async () => {
    const { defaultDeviceName } = await import("./identity.ts");
    expect(defaultDeviceName(IPHONE, true)).toBe("Galahad app on iPhone");
    expect(defaultDeviceName(ANDROID, true)).toBe("Galahad app on Android");
    expect(defaultDeviceName(MAC, true)).toBe("Galahad app on Mac");
  });
});
