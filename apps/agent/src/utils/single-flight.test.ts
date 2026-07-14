import { describe, test, expect } from "bun:test";
import { createSingleFlight } from "./single-flight";

/** A promise plus its resolve/reject handles, for driving timing precisely. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createSingleFlight", () => {
  test("coalesces concurrent callers of the same key onto one execution", async () => {
    const single = createSingleFlight<number>();
    const gate = deferred<void>();
    let calls = 0;

    const fn = async () => {
      calls++;
      await gate.promise;
      return 42;
    };

    // Three concurrent callers of the same key while the computation is in flight.
    const a = single("k", fn);
    const b = single("k", fn);
    const c = single("k", fn);

    // Same key mid-flight → exactly one underlying execution.
    expect(calls).toBe(1);

    gate.resolve();
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect([ra, rb, rc]).toEqual([42, 42, 42]);
    expect(calls).toBe(1);
  });

  test("does not coalesce across distinct keys", async () => {
    const single = createSingleFlight<string>();
    let calls = 0;
    const fn = async (tag: string) => {
      calls++;
      return tag;
    };

    const [x, y] = await Promise.all([
      single("x", () => fn("x")),
      single("y", () => fn("y")),
    ]);

    expect(x).toBe("x");
    expect(y).toBe("y");
    expect(calls).toBe(2);
  });

  test("clears the key after settle so a later call recomputes fresh", async () => {
    const single = createSingleFlight<number>();
    let calls = 0;
    const fn = async () => {
      calls++;
      return calls;
    };

    const first = await single("k", fn);
    // Sequential (not concurrent) → the key was released, so this re-runs.
    const second = await single("k", fn);

    expect(first).toBe(1);
    expect(second).toBe(2);
    expect(calls).toBe(2);
  });

  test("a rejected computation clears the key (no wedged in-flight entry)", async () => {
    const single = createSingleFlight<number>();
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return 7;
    };

    await expect(single("k", fn)).rejects.toThrow("boom");

    // Key released despite the rejection — the next call succeeds.
    const result = await single("k", fn);
    expect(result).toBe(7);
    expect(calls).toBe(2);
  });
});
