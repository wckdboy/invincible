import { type AgenticTask, type Built, type Check, int, js, packageJson, pickOne } from "./kit.ts";

/*
 * Concurrency: a race or an ordering bug. A small store over a slow backend: counters
 * that lose increments made at once, a loader that runs once per caller instead of
 * once, results reported in the order they finish instead of the order they were asked
 * for. The hidden tests force each interleaving with promises they release by hand, so
 * nothing depends on a clock and every run is the same.
 *
 * The dial: how many of the three are broken (one a level up to three), whether there
 * is a reproduction, and at level 4 whether the task says what goes wrong at all. The
 * easy fix (one lock for everything) fails: counters of different keys mustn't wait
 * for each other.
 */

const WORLDS = [
  { counter: "stock level", counters: "stock levels", catalogue: "price list", batch: "import" },
  { counter: "seat count", counters: "seat counts", catalogue: "venue plan", batch: "booking run" },
  { counter: "quota", counters: "quotas", catalogue: "tariff table", batch: "billing run" },
] as const;

const INCREMENT = {
  bad: js`    /** Adds by to the counter under key; resolves to its value right after. */
    async increment(key, by = 1) {
      const current = (await backend.read(key)) ?? 0;
      const next = current + by;
      await backend.write(key, next);
      return next;
    },`,
  good: js`    /** Adds by to the counter under key; resolves to its value right after. One at a time a key, in the order asked. */
    increment(key, by = 1) {
      const before = tails.get(key) ?? Promise.resolve();
      const mine = before.then(async () => {
        const next = ((await backend.read(key)) ?? 0) + by;
        await backend.write(key, next);
        return next;
      });
      // The next one waits for this one to be over, however it ended.
      const tail = mine.then(
        () => {},
        () => {},
      );
      tails.set(key, tail);
      tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      return mine;
    },`,
  // One queue for every key: nothing is lost, and every counter waits for every other.
  mutex: js`    /** Adds by to the counter under key; resolves to its value right after. */
    increment(key, by = 1) {
      const mine = queue.then(async () => {
        const next = ((await backend.read(key)) ?? 0) + by;
        await backend.write(key, next);
        return next;
      });
      queue = mine.then(
        () => {},
        () => {},
      );
      return mine;
    },`,
};

const GET_OR_LOAD = {
  bad: js`    /** The value for key: loaded with loader(key) the first time, remembered after. */
    async getOrLoad(key, loader) {
      if (cache.has(key)) return cache.get(key);
      const value = await loader(key);
      cache.set(key, value);
      return value;
    },`,
  good: js`    /** The value for key: loaded with loader(key) once (callers at the same time share the load), remembered after. */
    getOrLoad(key, loader) {
      if (cache.has(key)) return Promise.resolve(cache.get(key));
      let pending = loading.get(key);
      if (!pending) {
        pending = Promise.resolve()
          .then(() => loader(key))
          .then((value) => {
            cache.set(key, value);
            return value;
          })
          .finally(() => loading.delete(key));
        loading.set(key, pending);
      }
      return pending;
    },`,
  // The promise is remembered for good: a load that failed is failed for ever.
  sticky: js`    /** The value for key: loaded with loader(key) once, remembered after. */
    getOrLoad(key, loader) {
      if (!loading.has(key)) loading.set(key, Promise.resolve().then(() => loader(key)));
      return loading.get(key);
    },`,
};

const RUN_IN_ORDER = {
  bad: js`    /** Runs every job at once; onResult(index, outcome) for each, in the order the jobs were given. */
    async runInOrder(jobs, onResult) {
      await Promise.all(
        jobs.map(async (job, index) => {
          try {
            onResult(index, { ok: true, value: await job() });
          } catch (error) {
            onResult(index, { ok: false, error });
          }
        }),
      );
    },`,
  good: js`    /** Runs every job at once; onResult(index, outcome) for each, in the order the jobs were given. */
    async runInOrder(jobs, onResult) {
      const outcomes = jobs.map((job) => {
        try {
          return Promise.resolve(job()).then(
            (value) => ({ ok: true, value }),
            (error) => ({ ok: false, error }),
          );
        } catch (error) {
          return Promise.resolve({ ok: false, error });
        }
      });
      for (let index = 0; index < outcomes.length; index++) onResult(index, await outcomes[index]);
    },`,
};

const moduleOf = (parts: { increment: string; getOrLoad: string; runInOrder: string }): string => js`/**
 * A store over a slow backend: backend.read(key) resolves to the stored number (undefined when there is none),
 * backend.write(key, value) stores it. README.md says what each function here guarantees.
 */
export function createStore(backend) {
  const cache = new Map();
  const loading = new Map();
  const tails = new Map();
  let queue = Promise.resolve();
  return {
${parts.increment}

${parts.getOrLoad}

${parts.runInOrder}
  };
}
`;

const PRELUDE = js`const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
/** Lets everything that can run without the backend run. */
const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};
/** A backend whose every call waits until the test serves it: a read sees what is stored when it is served. */
const manual = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  const waiting = [];
  const call = (op, key, value) => {
    const d = deferred();
    waiting.push({
      op,
      key,
      serve() {
        if (op === "read") d.resolve(data.get(key));
        else {
          data.set(key, value);
          d.resolve();
        }
      },
      fail(error) {
        d.reject(error);
      },
    });
    return d.promise;
  };
  return {
    data,
    waiting,
    read: (key) => call("read", key),
    write: (key, value) => call("write", key, value),
    /** Serve every call that's waiting, and whatever they lead to, until nothing waits. */
    async drain() {
      for (let rounds = 0; rounds < 10000; rounds++) {
        await flush();
        if (!waiting.length) return;
        for (const next of waiting.splice(0)) next.serve();
      }
      throw new Error("the store never stops calling its backend");
    },
  };
};
const settled = (promise) => promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
const fresh = async (backend) => {
  testsIntact();
  const { createStore } = await load("src/store.js");
  return createStore(backend);
};
`;

const CHECKS: Record<"increment" | "getOrLoad" | "runInOrder", Check[]> = {
  increment: [
    {
      key: "no_lost_updates",
      what: "increments of one key made at once all count, each resolving to the value right after its own",
      body: js`    const backend = manual({ a: 5 });
    const store = await fresh(backend);
    const adds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 1, 1, 1, 25, 3];
    const results = adds.map((by) => store.increment("a", by));
    await backend.drain();
    const got = await Promise.all(results);
    let sum = 5;
    assert.deepEqual(got, adds.map((by) => (sum += by)), "each increment resolves to the value right after its own, in the order asked");
    assert.equal(backend.data.get("a"), sum);
    // A key that was never stored starts at 0.
    const more = [store.increment("new"), store.increment("new"), store.increment("new", 5)];
    await backend.drain();
    assert.deepEqual(await Promise.all(more), [1, 2, 7]);`,
    },
    {
      key: "keys_stay_apart",
      what: "nothing is lost, and counters of different keys don't wait for each other",
      body: js`    const backend = manual();
    const store = await fresh(backend);
    const results = [store.increment("a"), store.increment("b"), store.increment("a", 2), store.increment("b", 3)];
    await flush();
    // Both keys' first reads are out before either is served: neither waits for the other.
    assert.deepEqual(backend.waiting.map((w) => w.op + " " + w.key).sort(), ["read a", "read b"], "what the backend is asked first");
    await backend.drain();
    assert.deepEqual(await Promise.all(results), [1, 1, 3, 4]);
    assert.deepEqual([backend.data.get("a"), backend.data.get("b")], [3, 4]);`,
    },
    {
      key: "survives_a_failure",
      what: "a backend call that fails rejects that increment alone; the next ones still count",
      body: js`    const backend = manual({ a: 10 });
    const store = await fresh(backend);
    const results = [store.increment("a", 1), store.increment("a", 2), store.increment("a", 3)].map(settled);
    await flush();
    // Serve the first read, then fail the write it leads to.
    backend.waiting.splice(0, 1)[0].serve();
    await flush();
    const write = backend.waiting.findIndex((w) => w.op === "write");
    assert.ok(write >= 0, "the first increment never wrote");
    backend.waiting.splice(write, 1)[0].fail(new Error("disk full"));
    await backend.drain();
    const got = await Promise.all(results);
    assert.equal(got[0].ok, false, "the increment whose write failed must reject");
    assert.equal(got[0].error.message, "disk full");
    assert.deepEqual(got.slice(1), [{ ok: true, value: 12 }, { ok: true, value: 15 }]);
    assert.equal(backend.data.get("a"), 15);`,
    },
  ],
  getOrLoad: [
    {
      key: "loads_once",
      what: "callers at the same time share one load; a loaded value isn't loaded again; other keys load meanwhile",
      body: js`    const store = await fresh(manual());
    const loads = [];
    const loader = (key) => {
      const d = deferred();
      loads.push({ key, d });
      return d.promise;
    };
    const first = [store.getOrLoad("k", loader), store.getOrLoad("k", loader), store.getOrLoad("k", loader)];
    const other = store.getOrLoad("j", loader);
    await flush();
    assert.deepEqual(loads.map((l) => l.key).sort(), ["j", "k"], "one load a key, and both under way at once");
    loads.find((l) => l.key === "k").d.resolve({ rows: 3 });
    const got = await Promise.all(first);
    assert.ok(got[0] === got[1] && got[1] === got[2], "every caller gets the one loaded value");
    assert.deepEqual(got[0], { rows: 3 });
    assert.ok((await store.getOrLoad("k", loader)) === got[0]);
    assert.equal(loads.length, 2, "a loaded value was loaded again");
    loads.find((l) => l.key === "j").d.resolve(7);
    assert.equal(await other, 7);`,
    },
    {
      key: "failed_load_forgotten",
      what: "a failed load rejects everyone waiting on it and isn't remembered",
      body: js`    const store = await fresh(manual());
    const loads = [];
    const loader = () => {
      const d = deferred();
      loads.push(d);
      return d.promise;
    };
    const waiting = [store.getOrLoad("k", loader), store.getOrLoad("k", loader)].map(settled);
    await flush();
    assert.equal(loads.length, 1, "callers at the same time share one load");
    loads[0].reject(new Error("offline"));
    const got = await Promise.all(waiting);
    assert.ok(got.every((g) => !g.ok && g.error.message === "offline"), "everyone waiting on a failed load is rejected with its error");
    const again = store.getOrLoad("k", loader);
    await flush();
    assert.equal(loads.length, 2, "a failed load must be tried again by the next caller");
    loads[1].resolve("ready");
    assert.equal(await again, "ready");
    assert.equal(await store.getOrLoad("k", loader), "ready");
    assert.equal(loads.length, 2);
    // A loader that throws before it returns a promise is a failed load like any other.
    const thrown = await settled(store.getOrLoad("t", () => { throw new Error("no loader"); }));
    assert.equal(thrown.ok, false);`,
    },
  ],
  runInOrder: [
    {
      key: "results_in_order",
      what: "every job starts at once; results are reported in the order the jobs were given, each as soon as it can be",
      body: js`    const store = await fresh(manual());
    const jobs = [deferred(), deferred(), deferred(), deferred()];
    const started = [];
    const seen = [];
    let over = false;
    const run = store.runInOrder(jobs.map((d, i) => () => (started.push(i), d.promise)), (index, outcome) => seen.push([index, outcome.ok, outcome.value])).then(() => (over = true));
    await flush();
    assert.deepEqual(started, [0, 1, 2, 3], "every job starts at once, in order");
    jobs[2].resolve("c");
    jobs[3].resolve("d");
    await flush();
    assert.deepEqual(seen, [], "a result was reported before the ones ahead of it");
    jobs[0].resolve("a");
    await flush();
    assert.deepEqual(seen, [[0, true, "a"]], "a result is reported as soon as everything ahead of it has been");
    assert.equal(over, false);
    jobs[1].resolve("b");
    await run;
    assert.deepEqual(seen, [[0, true, "a"], [1, true, "b"], [2, true, "c"], [3, true, "d"]]);
    assert.equal(await store.runInOrder([], () => assert.fail("nothing to report")), undefined);`,
    },
    {
      key: "order_with_failures",
      what: "a job that rejects or throws is reported in its place, and the others carry on",
      body: js`    const store = await fresh(manual());
    const last = deferred();
    const seen = [];
    const jobs = [() => Promise.reject(new Error("first failed")), () => { throw new Error("second threw"); }, () => last.promise, () => 4];
    const run = settled(store.runInOrder(jobs, (index, outcome) => seen.push([index, outcome.ok, outcome.ok ? outcome.value : outcome.error.message])));
    await flush();
    assert.deepEqual(seen, [[0, false, "first failed"], [1, false, "second threw"]]);
    last.resolve(3);
    assert.deepEqual(await run, { ok: true, value: undefined }, "runInOrder itself must not reject when a job fails");
    assert.deepEqual(seen, [[0, false, "first failed"], [1, false, "second threw"], [2, true, 3], [3, true, 4]]);`,
    },
  ],
};

const QUIET: Check = {
  key: "quiet_failures",
  what: "a failure that was handled by its caller leaves no unhandled rejection behind",
  body: js`    const stray = [];
    const note = (error) => stray.push(String((error && error.message) || error));
    process.on("unhandledRejection", note);
    try {
      const backend = manual({ a: 1 });
      const store = await fresh(backend);
      const results = [store.increment("a", 1), store.increment("a", 1), store.increment("a", 1)].map(settled);
      await flush();
      backend.waiting.splice(0, 1)[0].fail(new Error("read failed"));
      await backend.drain();
      const got = await Promise.all(results);
      assert.equal(got[0].ok, false);
      // The two after the failure both count.
      assert.deepEqual(got.slice(1), [{ ok: true, value: 2 }, { ok: true, value: 3 }]);
      const loaded = await settled(store.getOrLoad("x", () => Promise.reject(new Error("offline"))));
      assert.equal(loaded.ok, false);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.deepEqual(stray, [], "unhandled rejections");
    } finally {
      process.off("unhandledRejection", note);
    }`,
};

export const lostUpdate: AgenticTask = {
  id: "lost-update",
  title: "A store that loses work done at the same time",
  kind: "concurrency",
  dial: "how many of three races are in it (one a level); from level 3 there is no reproduction, and at level 4 the task doesn't say what goes wrong",
  build(rng, level): Built {
    const world = pickOne(rng, WORLDS);
    const broken = { increment: true, getOrLoad: level >= 2, runInOrder: level >= 3 };
    const given = moduleOf({
      increment: INCREMENT.bad,
      getOrLoad: broken.getOrLoad ? GET_OR_LOAD.bad : GET_OR_LOAD.good,
      runInOrder: broken.runInOrder ? RUN_IN_ORDER.bad : RUN_IN_ORDER.good,
    });
    const good = moduleOf({ increment: INCREMENT.good, getOrLoad: GET_OR_LOAD.good, runInOrder: RUN_IN_ORDER.good });
    const start = int(rng, 3, 40);
    const adds = [int(rng, 1, 5), int(rng, 1, 5), int(rng, 1, 5)];

    const repro = js`// Two requests add to the same ${world.counter} at the same moment. Run: bun repro.mjs
import { createStore } from "./src/store.js";

const data = new Map([["widget", ${start}]]);
const later = () => new Promise((resolve) => setTimeout(resolve, 0));
const backend = {
  read: async (key) => (await later(), data.get(key)),
  write: async (key, value) => (await later(), void data.set(key, value)),
};
const store = createStore(backend);
await Promise.all([store.increment("widget", ${adds[0]}), store.increment("widget", ${adds[1]}), store.increment("widget", ${adds[2]})]);
const want = ${start + adds[0]! + adds[1]! + adds[2]!};
console.log("${world.counter}: " + data.get("widget") + " (should be " + want + ")");
process.exit(data.get("widget") === want ? 0 : 1);
`;

    const tests = js`import { expect, test } from "bun:test";
import { createStore } from "../src/store.js";

const memory = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return { data, read: async (key) => data.get(key), write: async (key, value) => void data.set(key, value) };
};

test("increment adds, one after another", async () => {
  const backend = memory({ widget: ${start} });
  const store = createStore(backend);
  expect(await store.increment("widget", ${adds[0]})).toBe(${start + adds[0]!});
  expect(await store.increment("widget")).toBe(${start + adds[0]! + 1});
  expect(await store.increment("gadget", 4)).toBe(4);
});

test("getOrLoad remembers what it loaded", async () => {
  const store = createStore(memory());
  let loads = 0;
  const loader = async (key) => (loads++, key.toUpperCase());
  expect(await store.getOrLoad("${world.catalogue}", loader)).toBe(${JSON.stringify(world.catalogue.toUpperCase())});
  expect(await store.getOrLoad("${world.catalogue}", loader)).toBe(${JSON.stringify(world.catalogue.toUpperCase())});
  expect(loads).toBe(1);
});

test("runInOrder reports every job", async () => {
  const store = createStore(memory());
  const seen = [];
  await store.runInOrder([async () => "a", async () => "b"], (index, outcome) => seen.push([index, outcome.value]));
  expect(seen).toEqual([[0, "a"], [1, "b"]]);
});
`;

    const readme = `# The ${world.counters} store

\`createStore(backend)\` in \`src/store.js\` keeps ${world.counters} in a slow backend (\`backend.read(key)\` resolves to the stored
number, or undefined when there is none; \`backend.write(key, value)\` stores it; either may reject). Many requests use one
store at the same time. What each function guarantees:

## \`increment(key, by = 1)\`

- Adds \`by\` to the counter under \`key\` (a key never stored counts from 0) and resolves to the counter's value right after
  its own addition.
- **Nothing is lost.** Increments of one key made at the same time all count, and take effect in the order they were
  asked for: each one resolves to the value just after it.
- **Keys don't wait for each other.** An increment of one key never waits for an increment of another key.
- **A failure is one increment's.** If the backend rejects, that increment rejects with the backend's error, and the
  increments after it on that key still happen, on the value the backend then holds.

## \`getOrLoad(key, loader)\`

- Resolves to the value for \`key\`: \`loader(key)\`'s, the first time, and that same value from then on without calling
  \`loader\` again.
- **One load at a time a key.** Callers that ask for a key while it is being loaded share that one load, and all get its value.
- **A failed load isn't remembered.** If the load fails (it rejects, or \`loader\` throws), everyone waiting on it is rejected with
  its error, and the next caller loads again.
- Different keys load at the same time.

## \`runInOrder(jobs, onResult)\`

- Starts every job (a function that returns a value or a promise) at once, in the order given.
- Calls \`onResult(index, outcome)\` exactly once for each job, **in the order the jobs were given**, each as soon as its
  job is over and every result before it has been reported. \`outcome\` is \`{ ok: true, value }\` or \`{ ok: false, error }\`.
- A job that rejects or throws is reported in its place; the others carry on, and \`runInOrder\` itself doesn't reject.
- Resolves once the last result has been reported.
`;

    const symptoms = [
      `${world.counters} come up short when several requests change the same one at the same moment`,
      `the ${world.catalogue} is fetched several times over at startup, though it should be loaded once`,
      `the results of a ${world.batch} sometimes arrive out of order`,
    ].slice(0, level >= 3 ? 3 : level);
    const statement =
      level >= 4
        ? "The store in src/store.js misbehaves when many requests use it at once, in more than one way. The repository's tests pass, and there is no reproduction. README.md says what each function guarantees: make the store hold to every sentence of it."
        : [
            `The store in src/store.js misbehaves when many requests use it at once: ${symptoms.join("; ")}.`,
            level <= 2 ? "`bun repro.mjs` shows the first of these." : "The repository's tests pass: they only use it one request at a time.",
            "README.md says what each function guarantees. Make the store hold to it.",
          ].join(" ");

    const checks = [...CHECKS.increment, ...(broken.getOrLoad ? CHECKS.getOrLoad : []), ...(broken.runInOrder ? CHECKS.runInOrder : []), ...(level >= 4 ? [QUIET] : [])];
    const done = (why: string) => ({ outcome: "done" as const, why, evidence: ["src/store.js", "test/store.test.js"] });
    return {
      statement,
      files: {
        "package.json": packageJson("counter-store"),
        "README.md": readme,
        "src/store.js": given,
        "test/store.test.js": tests,
        ...(level <= 2 ? { "repro.mjs": repro } : {}),
      },
      gates: level <= 2 ? ["cd /work/repo && bun repro.mjs", "cd /work/repo && bun test"] : ["cd /work/repo && bun test"],
      prelude: PRELUDE,
      checks,
      reference: { name: "a queue a key, a shared load, results held until their turn", files: { "src/store.js": good }, result: done("Each key has its own queue; loads are shared; results are reported in order.") },
      wrong: [
        {
          name: "one lock for every key (and a load remembered even when it failed)",
          files: { "src/store.js": moduleOf({ increment: INCREMENT.mutex, getOrLoad: broken.getOrLoad ? GET_OR_LOAD.sticky : GET_OR_LOAD.good, runInOrder: RUN_IN_ORDER.good }) },
          result: done("Increments are serialised now; the reproduction passes."),
        },
      ],
      maxSteps: level >= 3 ? 40 : 30,
    };
  },
};
