/**
 * reaper-job persistence + heartbeat tests — real PG, no Drizzle mocks.
 *
 * Uses the scratch-schema isolation pattern (`db.test.ts` § 7.2): each run
 * creates a unique schema under POSTGRES_URL, builds the cron_runs +
 * bloat_radar shape there, pins every pooled connection to it via
 * `connection.search_path`, and drops the schema in teardown.
 *
 * Skips cleanly when POSTGRES_URL is unset.
 */

import { describe, expect, it, beforeAll, beforeEach, afterAll } from "bun:test";
import { createDb } from "@nexus/db";
import type { Db } from "@nexus/db";
import {
  persistReaperResult,
  checkReaperHeartbeat,
  STALE_HEARTBEAT_MS,
} from "./reaper-job";
import type { ReaperResult } from "./reaper-job";

type Sql = ReturnType<typeof createDb>["client"];

import { hasLivePg as hasPg } from "../testing/live-pg";

const SCHEMA = `nx_reaper_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const DDL = `
  CREATE TABLE "cron_runs" (
    "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    "timestamp" timestamp NOT NULL,
    "job" text NOT NULL,
    "status" text NOT NULL,
    "details" jsonb,
    "metrics" jsonb
  );
  CREATE INDEX "cron_runs_timestamp_idx" ON "cron_runs" USING btree ("timestamp");

  CREATE TABLE "bloat_radar" (
    "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    "run_timestamp" timestamp NOT NULL,
    "label" text NOT NULL,
    "path" text NOT NULL,
    "size_bytes" integer NOT NULL,
    "threshold_bytes" integer NOT NULL
  );
  CREATE INDEX "bloat_radar_run_timestamp_idx" ON "bloat_radar" USING btree ("run_timestamp");
`;

function makeResult(overrides: Partial<ReaperResult> = {}): ReaperResult {
  return {
    status: "success",
    pruned: 4,
    freedBytes: 10_485_760,
    durationMs: 12_345,
    bloatFindings: [],
    logPath: "/tmp/weekly-cleanup.log",
    stdout: "",
    stderr: "",
    ...overrides,
  };
}

describe.skipIf(!hasPg)("reaper persistence + heartbeat (requires live PG)", () => {
  let adminClient: Sql;
  let scopedClient: Sql;
  let db: Db;

  beforeAll(async () => {
    const url = process.env.POSTGRES_URL!;
    const adminHandle = createDb(url);
    adminClient = adminHandle.client;

    await adminClient.unsafe(`CREATE SCHEMA "${SCHEMA}"`);
    await adminClient.unsafe(`SET search_path TO "${SCHEMA}", public`);
    await adminClient.unsafe(DDL);

    const scopedHandle = createDb(url, {
      connection: { search_path: `"${SCHEMA}",public` },
    });
    scopedClient = scopedHandle.client;
    db = scopedHandle.db;
  });

  // Per-test cleanup: truncate the shared schema's tables before each test so
  // rows never leak across `it` blocks. Without this, tests are order-dependent
  // — a heartbeat query in one test sees success rows persisted by an earlier
  // one (nx-gwnpb). RESTART IDENTITY keeps ids deterministic per test.
  beforeEach(async () => {
    await scopedClient.unsafe(
      `TRUNCATE "cron_runs", "bloat_radar" RESTART IDENTITY CASCADE`,
    );
  });

  afterAll(async () => {
    try {
      await scopedClient.end({ timeout: 5 });
    } finally {
      try {
        await adminClient.unsafe(
          `DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`,
        );
      } finally {
        await adminClient.end({ timeout: 5 });
      }
    }
  });

  // ── persistReaperResult ──────────────────────────────────────────────

  it("persists a clear-run success with no bloat rows", async () => {
    const ts = new Date("2026-05-21T03:00:00Z");
    const result = makeResult({
      status: "success",
      pruned: 4,
      freedBytes: 10_485_760,
      bloatFindings: [],
    });

    const out = await persistReaperResult({ db, result, timestamp: ts });
    expect(out.cronRunId).toBeGreaterThan(0);
    expect(out.bloatRowsInserted).toBe(0);

    const rows = await db.query.cronRuns.findMany({
      where: (cr, { eq, and }) =>
        and(eq(cr.job, "reaper"), eq(cr.timestamp, ts)),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("success");
    expect(rows[0]?.metrics).toMatchObject({
      pruned: 4,
      freedBytes: 10_485_760,
    });

    const bloat = await db.query.bloatRadar.findMany({
      where: (br, { eq }) => eq(br.runTimestamp, ts),
    });
    expect(bloat).toHaveLength(0);
  });

  it("persists each bloat finding when the result carries findings", async () => {
    const ts = new Date("2026-05-21T03:01:00Z");
    const result = makeResult({
      bloatFindings: [
        {
          label: "CoreSimulator",
          path: "/Users/x/Library/Developer/CoreSimulator",
          // Larger than int32 — wrapper clamps to INT32_MAX on insert.
          sizeBytes: 42_949_672_960,
          thresholdBytes: 21_474_836_480,
        },
        {
          label: "Chrome 'Default' History",
          path: "/Users/x/Chrome/Default/History",
          sizeBytes: 419_430_400,
          thresholdBytes: 314_572_800,
        },
      ],
    });

    const out = await persistReaperResult({ db, result, timestamp: ts });
    expect(out.bloatRowsInserted).toBe(2);

    const bloat = await db.query.bloatRadar.findMany({
      where: (br, { eq }) => eq(br.runTimestamp, ts),
      orderBy: (br, { asc }) => [asc(br.label)],
    });
    expect(bloat).toHaveLength(2);
    // Chrome label comes first alphabetically.
    expect(bloat[0]?.label).toContain("Chrome");
    expect(bloat[1]?.label).toBe("CoreSimulator");
    // Verify clamp to INT32_MAX.
    expect(bloat[1]?.sizeBytes).toBe(2_147_483_647);
    expect(bloat[1]?.thresholdBytes).toBe(2_147_483_647);
  });

  it("persists an aborted run as status=aborted", async () => {
    const ts = new Date("2026-05-21T03:02:00Z");
    const result = makeResult({
      status: "aborted",
      pruned: 0,
      freedBytes: 0,
      bloatFindings: [],
    });
    await persistReaperResult({ db, result, timestamp: ts });

    const row = await db.query.cronRuns.findFirst({
      where: (cr, { eq, and }) =>
        and(eq(cr.job, "reaper"), eq(cr.timestamp, ts)),
    });
    expect(row?.status).toBe("aborted");
  });

  // ── checkReaperHeartbeat ─────────────────────────────────────────────

  it("returns stale=true when no prior success row exists", async () => {
    // Use a fresh scratch schema for this assertion so prior tests don't
    // pollute the result. The simplest way: query before any inserts in
    // a new sub-schema.
    const subSchema = `${SCHEMA}_hb_empty`;
    await adminClient.unsafe(`CREATE SCHEMA "${subSchema}"`);
    await adminClient.unsafe(`SET search_path TO "${subSchema}", public`);
    await adminClient.unsafe(DDL);

    const subHandle = createDb(process.env.POSTGRES_URL!, {
      connection: { search_path: `"${subSchema}",public` },
    });
    try {
      const result = await checkReaperHeartbeat(subHandle.db);
      expect(result.stale).toBe(true);
      expect(result.reason).toBe("no-prior-success");
      expect(result.lastSuccessAt).toBeNull();
    } finally {
      await subHandle.client.end({ timeout: 5 });
      await adminClient.unsafe(`DROP SCHEMA "${subSchema}" CASCADE`);
    }
  });

  it("returns stale=true when the latest success is older than 8 days", async () => {
    const now = new Date("2026-05-21T03:00:00Z");
    const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);

    // Insert a stale success row.
    await persistReaperResult({
      db,
      result: makeResult({ status: "success" }),
      timestamp: tenDaysAgo,
    });

    const result = await checkReaperHeartbeat(db, now);
    expect(result.stale).toBe(true);
    expect(result.reason).toBe("older-than-8d");
    // Per-test truncation (beforeEach) makes this exact: the only success row
    // in the schema is the stale one this test just inserted — no cross-test
    // leakage, so lastSuccessAt is deterministically that row's timestamp.
    expect(result.lastSuccessAt).toBeInstanceOf(Date);
    expect(result.lastSuccessAt?.getTime()).toBe(tenDaysAgo.getTime());
  });

  it("returns stale=false when a fresh success exists", async () => {
    const now = new Date("2026-05-21T03:30:00Z");
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

    await persistReaperResult({
      db,
      result: makeResult({ status: "success" }),
      timestamp: oneHourAgo,
    });

    const result = await checkReaperHeartbeat(db, now);
    expect(result.stale).toBe(false);
    expect(result.reason).toBe("fresh");
    expect(result.lastSuccessAt).toBeInstanceOf(Date);
  });

  it("STALE_HEARTBEAT_MS is exactly 8 days", () => {
    expect(STALE_HEARTBEAT_MS).toBe(8 * 24 * 60 * 60 * 1000);
  });
});
