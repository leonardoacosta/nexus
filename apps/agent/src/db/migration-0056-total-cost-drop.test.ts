/**
 * Migration 0056 (redesign-status-usage-endpoints) — total_cost_usd drop
 * regression test.
 *
 * Context
 * -------
 * Migration `drizzle/0056_round_shriek.sql` is a single statement:
 *   ALTER TABLE "sessions" DROP COLUMN "total_cost_usd";
 * Task 1.1 of redesign-status-usage-endpoints removed the `totalCostUsd`
 * field from the Drizzle schema and shipped this migration. This test is the
 * regression guard (task 4.2, nx-1gw6k): it proves the column is *genuinely*
 * gone from the live Postgres schema after the migration runs — not merely
 * absent from the TS `$inferSelect` type, which a schema edit alone would
 * satisfy without the column ever being dropped in the database.
 *
 * The test is a self-contained positive control:
 *   - Pre-migration: `information_schema.columns` confirms `total_cost_usd`
 *     EXISTS (so an assertion that it is later absent is meaningful, not
 *     vacuous).
 *   - The 0056 DDL applies cleanly (no throw).
 *   - Every pre-existing session row survives the column drop.
 *   - Post-migration: `information_schema.columns` confirms `total_cost_usd`
 *     is GONE.
 *
 * Isolation
 * ---------
 * Mirrors migration-0010-orphans.test.ts exactly: a dedicated Postgres schema
 * (`nx_mig0056_test_<timestamp>`) inside POSTGRES_URL, a minimal pre-migration
 * sessions shape, apply the real migration SQL, assert, drop the schema in
 * teardown. Never touches the main `public` schema.
 *
 * PG-gated: skipped automatically unless NEXUS_PG_TESTS=1 and POSTGRES_URL are
 * set (see ../testing/live-pg.ts).
 *
 * To run locally:
 *   1. docker compose -f docker-compose.test.yml up -d
 *   2. export POSTGRES_URL=postgres://nexus:nexus@localhost:5433/nexus_test
 *   3. NEXUS_PG_TESTS=1 bun test apps/agent/src/db/migration-0056-total-cost-drop.test.ts
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createDb } from "@nexus/db";

import { hasLivePg as hasPg } from "../testing/live-pg";

const MIGRATION_PATH = path.resolve(
  __dirname,
  "../../../../packages/db/drizzle/0056_round_shriek.sql",
);

// Unique schema name per run so parallel workers cannot collide and an
// abandoned run never blocks the next invocation.
const TEST_SCHEMA = `nx_mig0056_test_${Date.now()}_${Math.floor(
  Math.random() * 1e6,
)}`;

// Pre-0056 sessions shape. Only the columns 0056 touches (total_cost_usd) plus
// the minimal NOT NULL columns needed to insert a row are present; the rest of
// the table is elided because the migration does not read them. `real` mirrors
// the column type total_cost_usd carried before it was dropped.
const PRE_MIGRATION_DDL = `
  CREATE TABLE "sessions" (
    "id" text PRIMARY KEY NOT NULL,
    "machine" text NOT NULL,
    "status" text DEFAULT 'active' NOT NULL,
    "started_at" timestamp NOT NULL,
    "last_activity" timestamp NOT NULL,
    "total_cost_usd" real
  );
`;

type Sql = ReturnType<typeof createDb>["client"];

/**
 * Split the migration on the drizzle `statement-breakpoint` marker so each
 * statement executes independently with a clean error message on failure.
 */
function splitMigrationSql(raw: string): string[] {
  return raw
    .split(/--\s*>\s*statement-breakpoint/i)
    .map((stmt) => stmt.trim())
    .filter((stmt) => stmt.length > 0);
}

/** Retarget `"public"."…"` references at the isolated test schema. */
function retargetPublicSchema(raw: string, schema: string): string {
  return raw.replaceAll('"public".', `"${schema}".`);
}

async function totalCostUsdExists(sql: Sql): Promise<boolean> {
  const rows = await sql<{ column_name: string }[]>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = ${TEST_SCHEMA}
      AND table_name = 'sessions'
      AND column_name = 'total_cost_usd'
  `;
  return rows.length > 0;
}

describe.skipIf(!hasPg)("migration 0056 — total_cost_usd drop", () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = createDb(process.env.POSTGRES_URL!).client;

    await sql.unsafe(`CREATE SCHEMA "${TEST_SCHEMA}"`);
    await sql.unsafe(`SET search_path TO "${TEST_SCHEMA}", public`);
    await sql.unsafe(PRE_MIGRATION_DDL);

    const now = new Date().toISOString();
    // Seed rows, including a non-null total_cost_usd, so the drop is exercised
    // against real data — not an empty table.
    await sql.unsafe(
      `INSERT INTO sessions (id, machine, status, started_at, last_activity, total_cost_usd)
       VALUES
         ('sess-a', 'omarchy', 'active', $1, $1, 1.23),
         ('sess-b', 'omarchy', 'ended',  $1, $1, NULL)`,
      [now],
    );
  });

  afterAll(async () => {
    try {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it("has total_cost_usd present before the migration (positive control)", async () => {
    expect(await totalCostUsdExists(sql)).toBe(true);
  });

  it("applies the 0056 DROP COLUMN DDL cleanly", async () => {
    const raw = readFileSync(MIGRATION_PATH, "utf8");
    const retargeted = retargetPublicSchema(raw, TEST_SCHEMA);
    const statements = splitMigrationSql(retargeted);
    expect(statements.length).toBeGreaterThan(0);

    for (const [idx, stmt] of statements.entries()) {
      try {
        await sql.unsafe(stmt);
      } catch (err) {
        throw new Error(
          `migration statement #${idx} failed:\n${stmt}\n\ncause: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  });

  it("drops total_cost_usd from the live schema", async () => {
    expect(await totalCostUsdExists(sql)).toBe(false);
  });

  it("preserves all pre-existing session rows through the column drop", async () => {
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM sessions ORDER BY id
    `;
    expect(rows.map((r) => r.id)).toEqual(["sess-a", "sess-b"]);
  });
});
