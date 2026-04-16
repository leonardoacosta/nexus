/**
 * Migration 0010 (finalize-audit-cleanup) — orphan-session regression test.
 *
 * Context
 * -------
 * Migration `drizzle/0010_finalize_audit_cleanup_schema.sql` replaces the
 * legacy `sessions.project text NOT NULL` + drifted `sessions.project_id text`
 * columns with a proper `project_id uuid REFERENCES projects(id) ON DELETE
 * SET NULL`. The migration uses DROP + ADD because production sessions tables
 * were effectively empty at the time (see task nx-rck7 notes).
 *
 * This test validates the same DDL against a non-empty table that contains
 * "orphan" rows — sessions whose legacy `project_id text` value does not
 * correspond to any `projects.id` — and confirms the resulting schema is
 * well-formed:
 *   - The DDL applies cleanly (no throw)
 *   - Every pre-existing session row survives the column swap
 *   - The new `project_id` column is uuid and nullable on every row
 *   - The FK constraint `sessions_project_id_projects_id_fk` is present in
 *     `information_schema.referential_constraints` and points at
 *     `projects(id)` with `ON DELETE SET NULL`
 *   - Inserting a session with a non-existent `project_id` uuid fails with a
 *     foreign-key violation (the constraint is enforced, not just declared)
 *   - Deleting a referenced project nulls the FK on the child row
 *     (ON DELETE SET NULL is wired correctly)
 *
 * Isolation
 * ---------
 * The test creates a dedicated Postgres schema (`nx_mig_test_<timestamp>`)
 * inside POSTGRES_URL, builds a minimal pre-migration shape inside that
 * schema, runs the consolidated DDL, asserts, and drops the schema in
 * teardown. This means the test never mutates the main `public` schema and
 * never assumes anything about the state of the main migration table.
 *
 * PG-gated: skipped automatically when POSTGRES_URL is not set.
 *
 * To run locally:
 *   1. docker compose -f docker-compose.test.yml up -d
 *   2. export POSTGRES_URL=postgres://nexus:nexus@localhost:5433/nexus_test
 *   3. bun test apps/agent/src/db/migration-0010-orphans.test.ts
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createDb } from "@nexus/db";

const hasPg = !!process.env.POSTGRES_URL;

const MIGRATION_PATH = path.resolve(
  __dirname,
  "../../../../packages/db/drizzle/0010_finalize_audit_cleanup_schema.sql",
);

// Use a unique schema name per run so parallel test workers cannot collide
// and an abandoned run never blocks the next invocation.
const TEST_SCHEMA = `nx_mig_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

// ─── Pre-migration shape ───────────────────────────────────────────────────
//
// These DDL statements reproduce just the columns the 0010 migration
// touches. They mirror the sessions/projects/credentials/notifications/
// health_snapshots shape immediately BEFORE 0010 ran in production — see
// drizzle/0000..0009 for the authoritative history.
//
// Only the columns referenced by 0010 are present; the rest of each table is
// elided because the migration does not read them.

const PRE_MIGRATION_DDL = `
  CREATE TABLE "projects" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "name" text NOT NULL,
    "primary_agent_id" text NOT NULL
  );

  CREATE TABLE "agents" (
    "id" text PRIMARY KEY NOT NULL,
    "host" text NOT NULL
  );

  -- Legacy shape: "project" text NOT NULL + "project_id" text (no FK).
  -- This is what the production table looked like on 2026-04 when 0010 was
  -- generated.
  CREATE TABLE "sessions" (
    "id" text PRIMARY KEY NOT NULL,
    "project" text NOT NULL,
    "project_id" text,
    "machine" text NOT NULL,
    "status" text DEFAULT 'active' NOT NULL,
    "started_at" timestamp NOT NULL,
    "last_activity" timestamp NOT NULL
  );

  CREATE TABLE "health_snapshots" (
    "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    "timestamp" timestamp NOT NULL
  );

  CREATE TABLE "credentials" (
    "id" text PRIMARY KEY NOT NULL,
    "name" text NOT NULL
  );

  CREATE TABLE "notifications" (
    "id" text PRIMARY KEY NOT NULL,
    "channel" text NOT NULL,
    "title" text NOT NULL,
    "body" text NOT NULL,
    "created_at" timestamp NOT NULL
  );
`;

// ─── Helpers ───────────────────────────────────────────────────────────────

type Sql = ReturnType<typeof createDb>["client"];

/**
 * Split `0010_...sql` on the drizzle `statement-breakpoint` marker so
 * each statement can be executed independently. `postgres.unsafe()` happily
 * executes multiple statements in one call, but the breakpoint comments are
 * stripped so we get cleaner error messages when one statement fails.
 */
function splitMigrationSql(raw: string): string[] {
  return raw
    .split(/--\s*>\s*statement-breakpoint/i)
    .map((stmt) => stmt.trim())
    .filter((stmt) => stmt.length > 0);
}

/**
 * Retarget every `"public"."…"` reference in the migration SQL at the
 * isolated test schema. The drizzle-generated migration bakes
 * `REFERENCES "public"."projects"("id")` etc. into the DDL, but our test
 * puts every table inside `TEST_SCHEMA` to avoid polluting the main
 * database. Rewriting the schema qualifier is sufficient — the column
 * names, constraint names, and statement order remain byte-for-byte
 * identical to what drizzle-kit emits.
 */
function retargetPublicSchema(raw: string, schema: string): string {
  return raw.replaceAll('"public".', `"${schema}".`);
}

describe.skipIf(!hasPg)("migration 0010 — orphan sessions", () => {
  let sql: Sql;

  beforeAll(async () => {
    // Reuse the project's createDb helper so we pick up whatever postgres.js
    // config the rest of the codebase has standardised on. We only need the
    // raw client here — Drizzle's tagged API does not cover arbitrary DDL.
    sql = createDb(process.env.POSTGRES_URL!).client;

    // Create the isolated schema and route subsequent statements into it so
    // the same table names (sessions, projects, ...) do not collide with the
    // main `public` schema.
    await sql.unsafe(`CREATE SCHEMA "${TEST_SCHEMA}"`);
    await sql.unsafe(`SET search_path TO "${TEST_SCHEMA}", public`);

    // Build the pre-0010 schema shape.
    await sql.unsafe(PRE_MIGRATION_DDL);

    // ── Seed: 1 real project + orphan sessions + a linked session ──────────

    // Use a known, generated uuid so we can later seed an orphan reference
    // that is guaranteed NOT to exist in projects.id.
    await sql.unsafe(
      `INSERT INTO projects (id, name, primary_agent_id)
       VALUES ('11111111-1111-1111-1111-111111111111', 'real-project', 'omarchy')`,
    );

    const now = new Date().toISOString();

    // Session 1: project_id references a valid uuid (will become orphaned in
    //            text form since the new column is uuid-typed and we DROP the
    //            text column entirely — data does not carry over).
    // Session 2 & 3: project_id is a text value that is NOT a valid uuid at
    //            all (classic orphan from the dual-column drift era).
    // Session 4: project_id is NULL in the legacy column.
    await sql.unsafe(
      `INSERT INTO sessions (id, project, project_id, machine, status, started_at, last_activity)
       VALUES
         ('sess-valid',   'real-project',   '11111111-1111-1111-1111-111111111111', 'omarchy', 'active', $1, $1),
         ('sess-orphan1', 'ghost-project',  'not-a-uuid-at-all',                    'omarchy', 'active', $1, $1),
         ('sess-orphan2', 'ghost-project2', '00000000-0000-0000-0000-000000000999', 'omarchy', 'idle',   $1, $1),
         ('sess-null',    'legacy-project', NULL,                                   'omarchy', 'ended',  $1, $1)`,
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

  // ─────────────────────────────────────────────────────────────────────────
  // Test body
  // ─────────────────────────────────────────────────────────────────────────

  it("applies the 0010 DDL cleanly against a table with orphan sessions", async () => {
    const raw = readFileSync(MIGRATION_PATH, "utf8");
    const retargeted = retargetPublicSchema(raw, TEST_SCHEMA);
    const statements = splitMigrationSql(retargeted);
    expect(statements.length).toBeGreaterThan(0);

    // Execute each statement — any failure will throw with the statement
    // index so a regression is easy to diagnose.
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

  it("preserves all pre-existing session rows through the column swap", async () => {
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM sessions ORDER BY id
    `;
    expect(rows.map((r) => r.id)).toEqual([
      "sess-null",
      "sess-orphan1",
      "sess-orphan2",
      "sess-valid",
    ]);
  });

  it("drops the legacy sessions.project and text project_id columns", async () => {
    const cols = await sql<{ column_name: string; data_type: string }[]>`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = ${TEST_SCHEMA}
        AND table_name = 'sessions'
        AND column_name IN ('project', 'project_id')
      ORDER BY column_name
    `;

    // After 0010: no legacy "project" column, and "project_id" is uuid.
    expect(cols).toHaveLength(1);
    expect(cols[0].column_name).toBe("project_id");
    expect(cols[0].data_type).toBe("uuid");
  });

  it("sets every session's new project_id to NULL (orphans cannot carry over)", async () => {
    const rows = await sql<{ id: string; project_id: string | null }[]>`
      SELECT id, project_id FROM sessions ORDER BY id
    `;

    // DROP COLUMN followed by ADD COLUMN produces a fresh nullable column —
    // no row carries a stale text value forward, so every row starts NULL.
    // This is the exact behavior the ON DELETE SET NULL contract needs: no
    // broken FK can survive the migration.
    expect(rows.every((r) => r.project_id === null)).toBe(true);
  });

  it("installs the sessions.project_id -> projects.id FK with ON DELETE SET NULL", async () => {
    const rows = await sql<
      {
        constraint_name: string;
        delete_rule: string;
        fk_column: string;
        pk_table: string;
        pk_column: string;
      }[]
    >`
      SELECT
        rc.constraint_name,
        rc.delete_rule,
        kcu.column_name       AS fk_column,
        ccu.table_name        AS pk_table,
        ccu.column_name       AS pk_column
      FROM information_schema.referential_constraints rc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = rc.constraint_name
       AND kcu.constraint_schema = rc.constraint_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = rc.unique_constraint_name
       AND ccu.constraint_schema = rc.unique_constraint_schema
      WHERE rc.constraint_schema = ${TEST_SCHEMA}
        AND rc.constraint_name = 'sessions_project_id_projects_id_fk'
    `;

    expect(rows).toHaveLength(1);
    expect(rows[0].delete_rule).toBe("SET NULL");
    expect(rows[0].fk_column).toBe("project_id");
    expect(rows[0].pk_table).toBe("projects");
    expect(rows[0].pk_column).toBe("id");
  });

  it("enforces the FK: inserting a session with a non-existent project_id rejects", async () => {
    let threw = false;
    try {
      await sql.unsafe(
        `INSERT INTO sessions (id, project_id, machine, status, started_at, last_activity)
         VALUES ('sess-bad-fk', '22222222-2222-2222-2222-222222222222', 'omarchy', 'active', now(), now())`,
      );
    } catch (err) {
      threw = true;
      // Postgres SQLSTATE 23503 = foreign_key_violation
      expect((err as { code?: string }).code).toBe("23503");
    }
    expect(threw).toBe(true);
  });

  it("honors ON DELETE SET NULL when a referenced project is deleted", async () => {
    // Link sess-valid to the real project, then delete the project and
    // confirm the child row's project_id is set to NULL (not cascaded, not
    // rejected, not orphaned).
    await sql.unsafe(
      `UPDATE sessions
         SET project_id = '11111111-1111-1111-1111-111111111111'
       WHERE id = 'sess-valid'`,
    );

    const before = await sql<{ project_id: string | null }[]>`
      SELECT project_id FROM sessions WHERE id = 'sess-valid'
    `;
    expect(before[0].project_id).toBe("11111111-1111-1111-1111-111111111111");

    await sql.unsafe(
      `DELETE FROM projects WHERE id = '11111111-1111-1111-1111-111111111111'`,
    );

    const after = await sql<{ project_id: string | null }[]>`
      SELECT project_id FROM sessions WHERE id = 'sess-valid'
    `;
    expect(after[0].project_id).toBeNull();
  });

  it("adds agent_id columns + FKs to health_snapshots, credentials, and notifications", async () => {
    const rows = await sql<{ table_name: string; delete_rule: string }[]>`
      SELECT
        tc.table_name,
        rc.delete_rule
      FROM information_schema.table_constraints tc
      JOIN information_schema.referential_constraints rc
        ON rc.constraint_name = tc.constraint_name
       AND rc.constraint_schema = tc.constraint_schema
      WHERE tc.constraint_schema = ${TEST_SCHEMA}
        AND tc.constraint_type = 'FOREIGN KEY'
        AND tc.constraint_name IN (
          'health_snapshots_agent_id_agents_id_fk',
          'credentials_agent_id_agents_id_fk',
          'notifications_agent_id_agents_id_fk'
        )
      ORDER BY tc.table_name
    `;

    expect(rows).toHaveLength(3);
    const byTable = Object.fromEntries(rows.map((r) => [r.table_name, r.delete_rule]));
    expect(byTable.health_snapshots).toBe("CASCADE");
    expect(byTable.credentials).toBe("SET NULL");
    expect(byTable.notifications).toBe("SET NULL");
  });
});
