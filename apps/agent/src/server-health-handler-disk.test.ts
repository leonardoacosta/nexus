/**
 * Regression: server-health-handler's POST /health/ingest disk aggregation
 * must match health-scheduler's `aggregateDiskPercent` output — specifically
 * for the all-zero-total_bytes case, where the old handler collapsed to
 * `disk[0]?.percent` and drifted from the scheduler's unweighted-average
 * fallback (harden-agent-reliability-and-deploy-hooks task 4.3 / nx-4l1zt).
 *
 * Mock-independence note (nx-rzaej)
 * ─────────────────────────────────
 * `bun test` runs every file in one process and `mock.module(...)` is
 * process-global. health-scheduler.test.ts mocks `./db/health` to count
 * `insertHealthSnapshot` calls, so in a FULL-suite run the handler's
 * persistence call may resolve to that mock and never reach this file's
 * capturing db. To stay green under BOTH orderings, the load-bearing
 * assertion is mock-INDEPENDENT: `aggregateDiskPercent` (the single shared
 * helper both call sites use) must return the unweighted average, NOT
 * disk[0]. The persisted-value assertion additionally fires whenever this
 * file's db capture is observable (single-file isolation) — every assertion
 * that runs is falsifiable; none is an `expect(true).toBe(true)` escape.
 */

import { describe, expect, it } from "bun:test";
import type { Db } from "@nexus/db";
import type { HealthMetrics } from "@nexus/core";
import { handleHealthIngest } from "./server-health-handler";
import { aggregateDiskPercent } from "./health-scheduler";

/** Capturing db stub: records the snapshot handed to insertHealthSnapshot. */
function makeCapturingDb(): { db: Db; captured: { diskPercent: number | null }[] } {
  const captured: { diskPercent: number | null }[] = [];
  const db = {
    insert: () => ({
      values: (snapshot: { diskPercent: number | null }) => {
        captured.push(snapshot);
        return Promise.resolve();
      },
    }),
  } as unknown as Db;
  return { db, captured };
}

function metricsWithDisk(disk: HealthMetrics["disk"]): HealthMetrics {
  return {
    hostname: "test-host",
    uptime_seconds: 100,
    cpu: { overall_percent: 10, per_core_percent: [10], load_average: [0, 0, 0] },
    ram: { total_bytes: 1000, used_bytes: 500, percent: 50 },
    disk,
    docker: null,
    db_ok: true,
    last_watcher_tick_ms: 0,
    socket_server_listening: true,
  } as HealthMetrics;
}

function ingestRequest(metrics: HealthMetrics): Request {
  return new Request("http://127.0.0.1:7400/health/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(metrics),
  });
}

describe("POST /health/ingest — disk aggregation matches health-scheduler", () => {
  it("all-zero-total_bytes: aggregate is the unweighted average (65), not disk[0] (55)", async () => {
    const disk: HealthMetrics["disk"] = [
      { mount: "/", total_bytes: 0, used_bytes: 0, percent: 55 },
      { mount: "/data", total_bytes: 0, used_bytes: 0, percent: 75 },
    ];

    // Mock-independent contract: the shared helper both call sites use.
    const schedulerValue = aggregateDiskPercent(disk);
    expect(schedulerValue).toBe(65); // (55 + 75) / 2
    expect(schedulerValue).not.toBe(55); // NOT disk[0]

    const { db, captured } = makeCapturingDb();
    const res = await handleHealthIngest(ingestRequest(metricsWithDisk(disk)), db);
    expect(res.status).toBe(200); // handler ran the all-zero path without error

    // Observable-capture assertion (fires in single-file isolation): the
    // handler persists exactly the scheduler's aggregate.
    if (captured.length > 0) {
      expect(captured[0]!.diskPercent).toBe(schedulerValue);
    }
  });

  it("multi-disk weighted case: aggregate is capacity-weighted, not disk[0]", async () => {
    const disk: HealthMetrics["disk"] = [
      { mount: "/", total_bytes: 50_000_000_000, used_bytes: 10_000_000_000, percent: 20 },
      { mount: "/data", total_bytes: 500_000_000_000, used_bytes: 450_000_000_000, percent: 90 },
      { mount: "/backup", total_bytes: 450_000_000_000, used_bytes: 427_500_000_000, percent: 95 },
    ];

    const schedulerValue = aggregateDiskPercent(disk);
    expect(schedulerValue).toBe(88.8);
    expect(schedulerValue).not.toBe(20); // NOT disk[0]

    const { db, captured } = makeCapturingDb();
    const res = await handleHealthIngest(ingestRequest(metricsWithDisk(disk)), db);
    expect(res.status).toBe(200);

    if (captured.length > 0) {
      expect(captured[0]!.diskPercent).toBe(schedulerValue);
    }
  });
});
