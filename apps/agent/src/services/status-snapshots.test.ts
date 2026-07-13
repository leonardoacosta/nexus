/**
 * Change-only status-snapshot writer tests (add-project-status-snapshots 4.2).
 *
 * Covers the change-only insert semantics of `services/status-snapshots.ts`:
 *   - a second write with IDENTICAL totals is a no-op (one row, not two)
 *   - a write with DIFFERENT totals inserts a second row
 *   - the change comparison is against the most recently PERSISTED row (the DB
 *     latest), so a fresh/stateless call — modelling an agent restart — still
 *     no-ops when the DB latest already matches
 *   - `recordProjectStatusFromBeads` emits a `BeadTransition` only on a change
 *
 * These are DB-backed and therefore PG-gated: they skip cleanly when no live
 * Postgres is configured (NEXUS_PG_TESTS=1 + POSTGRES_URL), mirroring
 * `db/db.test.ts` and `routes/health-history.test.ts`.
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { createDb } from "@nexus/db";
import type { Db } from "@nexus/db";
import type { BeadTransitionPayload } from "@nexus/core";
import {
  recordProjectStatusFromBeads,
  recordSpecSnapshot,
} from "./status-snapshots";
import { lifecycleBus } from "./lifecycle-bus";

import { hasLivePg as hasPg } from "../testing/live-pg";

// ── Scratch-schema DDL for the two snapshot tables ────────────────────────
// Mirrors packages/db/src/schema/{specSnapshots,projectStatusSnapshots}.ts.

const SS_SCHEMA = `nx_ss_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const SS_DDL = `
  CREATE TABLE "spec_snapshots" (
    "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    "project" text NOT NULL,
    "spec_name" text NOT NULL,
    "completed" integer NOT NULL,
    "total" integer NOT NULL,
    "created_at" timestamp with time zone NOT NULL DEFAULT now()
  );

  CREATE TABLE "project_status_snapshots" (
    "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    "project" text NOT NULL,
    "proposals_unarchived" integer NOT NULL,
    "beads_ready_unlinked" integer NOT NULL,
    "beads_blocked_unlinked" integer NOT NULL,
    "created_at" timestamp with time zone NOT NULL DEFAULT now()
  );
`;

let adminSql: ReturnType<typeof createDb>["client"];
let scopedClient: ReturnType<typeof createDb>["client"];
let db: Db;

describe.skipIf(!hasPg)("status-snapshots writer (requires live PG)", () => {
  beforeAll(async () => {
    const url = process.env.POSTGRES_URL!;
    const adminHandle = createDb(url);
    adminSql = adminHandle.client;

    await adminSql.unsafe(`CREATE SCHEMA "${SS_SCHEMA}"`);
    await adminSql.unsafe(`SET search_path TO "${SS_SCHEMA}", public`);
    await adminSql.unsafe(SS_DDL);

    const scopedHandle = createDb(url, {
      connection: { search_path: `"${SS_SCHEMA}",public` },
    });
    scopedClient = scopedHandle.client;
    db = scopedHandle.db;
  });

  afterAll(async () => {
    try {
      await scopedClient.end({ timeout: 5 });
    } finally {
      try {
        await adminSql.unsafe(`DROP SCHEMA IF EXISTS "${SS_SCHEMA}" CASCADE`);
      } finally {
        await adminSql.end({ timeout: 5 });
      }
    }
  });

  const countSpecRows = async (project: string, specName: string) => {
    const rows = (await adminSql.unsafe(
      `SELECT count(*)::int AS n FROM "${SS_SCHEMA}".spec_snapshots
       WHERE project = '${project}' AND spec_name = '${specName}'`,
    )) as Array<{ n: number }>;
    return rows[0]!.n;
  };

  const countProjectRows = async (project: string) => {
    const rows = (await adminSql.unsafe(
      `SELECT count(*)::int AS n FROM "${SS_SCHEMA}".project_status_snapshots
       WHERE project = '${project}'`,
    )) as Array<{ n: number }>;
    return rows[0]!.n;
  };

  // ── 1. Change-only insert semantics (spec_snapshots) ────────────────────

  it("inserts exactly one row when called twice with identical totals", async () => {
    const first = await recordSpecSnapshot(db, "p1", "spec-a", 3, 10);
    const second = await recordSpecSnapshot(db, "p1", "spec-a", 3, 10);

    expect(first).toBe(true); // first write persists a row
    expect(second).toBe(false); // identical totals -> no-op
    expect(await countSpecRows("p1", "spec-a")).toBe(1);
  });

  it("inserts a second row when the totals differ", async () => {
    await recordSpecSnapshot(db, "p2", "spec-b", 1, 10);
    const changed = await recordSpecSnapshot(db, "p2", "spec-b", 2, 10);

    expect(changed).toBe(true);
    expect(await countSpecRows("p2", "spec-b")).toBe(2);
  });

  // ── 2. Restart-compare-against-latest-row ───────────────────────────────

  it("no-ops after a simulated restart when the DB latest already matches", async () => {
    // Seed one row, then compare against the DB latest via a fresh stateless
    // call — the writer holds no in-memory state, which is what makes it
    // restart-safe. A "restarted" writer sees the persisted row and skips.
    await recordSpecSnapshot(db, "p3", "spec-c", 5, 5);

    const afterRestart = await recordSpecSnapshot(db, "p3", "spec-c", 5, 5);

    expect(afterRestart).toBe(false);
    expect(await countSpecRows("p3", "spec-c")).toBe(1);
  });

  // ── 3. Bead-count change-only + BeadTransition emission ─────────────────

  it("records a project-status row and emits BeadTransition only when bead counts change", async () => {
    const seen: BeadTransitionPayload[] = [];
    const handler = (env: { payload: BeadTransitionPayload }) =>
      seen.push(env.payload);
    lifecycleBus.on("BeadTransition", handler);
    try {
      const first = await recordProjectStatusFromBeads(db, "p4", {
        beadsReadyUnlinked: 2,
        beadsBlockedUnlinked: 1,
      });
      const repeat = await recordProjectStatusFromBeads(db, "p4", {
        beadsReadyUnlinked: 2,
        beadsBlockedUnlinked: 1,
      });
      const moved = await recordProjectStatusFromBeads(db, "p4", {
        beadsReadyUnlinked: 4,
        beadsBlockedUnlinked: 1,
      });

      expect(first).toBe(true);
      expect(repeat).toBe(false); // identical counts -> no insert, no emit
      expect(moved).toBe(true);
      expect(await countProjectRows("p4")).toBe(2);

      // One emission per change (first + moved), none for the no-op repeat.
      const p4 = seen.filter((p) => p.project === "p4");
      expect(p4.length).toBe(2);
      expect(p4[1]!.previous.beadsReadyUnlinked).toBe(2);
      expect(p4[1]!.current.beadsReadyUnlinked).toBe(4);
    } finally {
      lifecycleBus.off("BeadTransition", handler);
    }
  });
});
