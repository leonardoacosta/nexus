/**
 * GET /exceptions route + SWR cache tests (add-fleet-exceptions-feed 1.4).
 *
 * Exercises the cache staleness / detached-refresh behavior with an injected
 * clock + compute counter, and the handler's fail-soft empty-200 contract.
 */

import { describe, expect, it } from "bun:test";
import {
  createExceptionsCache,
  handleGetExceptions,
  type ExceptionsCache,
} from "./exceptions";
import type {
  FleetExceptionEntry,
  FleetExceptionsResult,
} from "../lib/fleet-exceptions";

function sampleEntry(repo: string): FleetExceptionEntry {
  return { repo, class: "p0_open", count: 1, offenders: [`${repo}-1`] };
}

describe("createExceptionsCache", () => {
  it("computes once, then serves the cached value within TTL", async () => {
    let calls = 0;
    let clock = 1000;
    const cache = createExceptionsCache({
      ttlMs: 5000,
      now: () => clock,
      compute: async (): Promise<FleetExceptionsResult> => {
        calls++;
        return { exceptions: [sampleEntry("nx")], skipped: [] };
      },
    });

    // First read: cache empty + stale -> triggers refresh, returns [] immediately.
    expect(cache.read()).toEqual([]);
    await cache.refresh(); // settle the in-flight compute
    expect(calls).toBe(1);
    expect(cache.peek()).toEqual([sampleEntry("nx")]);

    // Within TTL: fresh -> no recompute.
    clock = 4000;
    expect(cache.isStale()).toBe(false);
    expect(cache.read()).toEqual([sampleEntry("nx")]);
    expect(calls).toBe(1);
  });

  it("recomputes after the TTL elapses", async () => {
    let calls = 0;
    let clock = 1000;
    const cache = createExceptionsCache({
      ttlMs: 5000,
      now: () => clock,
      compute: async (): Promise<FleetExceptionsResult> => {
        calls++;
        return { exceptions: [sampleEntry(`gen${calls}`)], skipped: [] };
      },
    });

    await cache.refresh();
    expect(calls).toBe(1);

    // Advance past TTL -> stale -> a read schedules a refresh.
    clock = 7000;
    expect(cache.isStale()).toBe(true);
    cache.read();
    await cache.refresh();
    expect(calls).toBe(2);
    expect(cache.peek()).toEqual([sampleEntry("gen2")]);
  });

  it("coalesces concurrent refreshes into one compute", async () => {
    let calls = 0;
    const cache = createExceptionsCache({
      ttlMs: 5000,
      now: () => 0,
      compute: async (): Promise<FleetExceptionsResult> => {
        calls++;
        await new Promise((r) => setTimeout(r, 10));
        return { exceptions: [], skipped: [] };
      },
    });
    await Promise.all([cache.refresh(), cache.refresh(), cache.refresh()]);
    expect(calls).toBe(1);
  });

  it("keeps the stale cache when a refresh throws", async () => {
    let clock = 1000;
    let mode: "ok" | "throw" = "ok";
    const cache = createExceptionsCache({
      ttlMs: 5000,
      now: () => clock,
      compute: async (): Promise<FleetExceptionsResult> => {
        if (mode === "throw") throw new Error("boom");
        return { exceptions: [sampleEntry("nx")], skipped: [] };
      },
    });
    await cache.refresh();
    expect(cache.peek()).toEqual([sampleEntry("nx")]);

    clock = 7000;
    mode = "throw";
    await cache.refresh();
    // Prior value survives; not clobbered to empty.
    expect(cache.peek()).toEqual([sampleEntry("nx")]);
  });
});

describe("handleGetExceptions", () => {
  it("returns a JSON array body with 200", async () => {
    const cache = createExceptionsCache({
      now: () => 0,
      ttlMs: 5000,
      compute: async () => ({ exceptions: [sampleEntry("nx")], skipped: [] }),
    });
    await cache.refresh();
    const res = await handleGetExceptions(cache);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const body = (await res.json()) as FleetExceptionEntry[];
    expect(Array.isArray(body)).toBe(true);
    expect(body).toEqual([sampleEntry("nx")]);
  });

  it("fail-soft: returns empty-200 when the cache read throws", async () => {
    const brokenCache = {
      read() {
        throw new Error("cache exploded");
      },
      peek: () => [],
      isStale: () => true,
      refresh: async () => {},
    } as ExceptionsCache;
    const res = await handleGetExceptions(brokenCache);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("returns [] on first call (SWR: empty before first refresh settles)", async () => {
    const cache = createExceptionsCache({
      compute: async () => ({ exceptions: [sampleEntry("nx")], skipped: [] }),
    });
    const res = await handleGetExceptions(cache);
    expect(await res.json()).toEqual([]);
  });
});
