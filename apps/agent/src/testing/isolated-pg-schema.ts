/**
 * Isolated throwaway-schema harness for live-PG integration tests.
 *
 * Extracts the scratch-schema pattern that `db/db.test.ts` and
 * `services/process-watcher.integration.test.ts` had each open-coded across
 * many `beforeAll`/`afterAll` pairs:
 *
 *   - an ADMIN handle (default pool) creates a uniquely-named schema and runs
 *     the caller's DDL into it, then is used for the single `DROP SCHEMA …
 *     CASCADE` teardown;
 *   - a SCOPED handle pins every pooled connection to
 *     `search_path = "<schema>",public`, so Drizzle ORM calls land in the
 *     throwaway schema without qualification.
 *
 * The one `DROP SCHEMA … CASCADE` tears down EVERYTHING seeded (sessions,
 * projects, events, anything) regardless of test outcome — and never touches
 * the real `public` tables. This makes the live-PG suites PROD-SAFE even when
 * `POSTGRES_URL` points at the production homelab DB (they only run under
 * `NEXUS_PG_TESTS=1`; see `live-pg.ts`).
 *
 * Usage:
 *
 *     let h: IsolatedSchema;
 *     beforeAll(async () => { h = await createIsolatedSchema(SESSIONS_DDL); });
 *     afterAll(async () => { await h.drop(); });
 *     // h.db is the scoped Drizzle handle — all writes land in the schema.
 */

import { createDb } from "@nexus/db";
import type { Db } from "@nexus/db";

type Sql = ReturnType<typeof createDb>["client"];

export interface IsolatedSchema {
  /** Scoped Drizzle handle — queries resolve inside the throwaway schema. */
  db: Db;
  /** Raw admin client (no search_path override) for DDL / raw seeding. */
  adminSql: Sql;
  /** Unique schema name created for this run. */
  schema: string;
  /**
   * Total prod-safe teardown: ends the scoped pool, then
   * `DROP SCHEMA … CASCADE` and ends the admin pool. Safe to call once in
   * `afterAll`. Never touches `public`.
   */
  drop: () => Promise<void>;
}

/**
 * Create a uniquely-named throwaway schema, run `ddl` into it, and return a
 * scoped Drizzle handle plus a `drop()` for total CASCADE teardown.
 *
 * @param ddl   DDL string (one or more `CREATE TABLE …`) defining the
 *              production shape the suite exercises. Runs with the admin
 *              connection's search_path already set to the new schema, so
 *              unqualified table names land inside it.
 * @param label Optional short tag woven into the schema name for grep-ability
 *              of any abandoned schema (defaults to "iso").
 */
export async function createIsolatedSchema(
  ddl: string,
  label = "iso",
): Promise<IsolatedSchema> {
  const url = process.env.POSTGRES_URL;
  if (!url) {
    throw new Error(
      "createIsolatedSchema requires POSTGRES_URL (run under NEXUS_PG_TESTS=1)",
    );
  }

  // Unique per run so parallel workers never collide and an abandoned run
  // never blocks the next invocation. Mirrors the db.test.ts naming style.
  const schema = `nx_${label}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  // Admin handle — default pool, used only for DDL against the outer DB
  // (CREATE SCHEMA / DROP SCHEMA) and any raw seeding the caller wants.
  const adminHandle = createDb(url);
  const adminSql = adminHandle.client;

  await adminSql.unsafe(`CREATE SCHEMA "${schema}"`); // SAFE: schema is a test-only generated name (nx_<label>_<ts>_<rand>, line 73), never request data
  await adminSql.unsafe(`SET search_path TO "${schema}", public`);
  await adminSql.unsafe(ddl);

  // Scoped handle — every connection in this pool sees `schema` first on its
  // search_path, so Drizzle queries resolve inside it without qualification.
  const scopedHandle = createDb(url, {
    connection: { search_path: `"${schema}",public` },
  });
  const scopedClient = scopedHandle.client;
  const db = scopedHandle.db;

  const drop = async (): Promise<void> => {
    try {
      await scopedClient.end({ timeout: 5 });
    } finally {
      try {
        await adminSql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); // SAFE: schema is a test-only generated name (nx_<label>_<ts>_<rand>, line 73), never request data
      } finally {
        await adminSql.end({ timeout: 5 });
      }
    }
  };

  return { db, adminSql, schema, drop };
}

/**
 * DDL for the production `sessions` + `projects` (+ `agents` for the project
 * FK) shape, matching `packages/db/src/schema/*.ts`. Used by the session and
 * project route suites. Keep in lockstep with the Drizzle schema — column set
 * + nullability mirror the migrations so full-column SELECTs don't false-fail.
 */
export const SESSIONS_PROJECTS_DDL = `
  CREATE TABLE "agents" (
    "id" text PRIMARY KEY NOT NULL,
    "name" text DEFAULT '',
    "host" text NOT NULL,
    "port" integer DEFAULT 7400,
    "projects_dir" text DEFAULT '',
    "enabled" boolean DEFAULT true,
    "last_seen" timestamp,
    "created_at" timestamp DEFAULT now(),
    "deleted_at" timestamp
  );

  CREATE TABLE "projects" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "name" text NOT NULL,
    "git_remote_url" text,
    "primary_agent_id" text NOT NULL,
    "description" text,
    "tags" text[],
    "status" text DEFAULT 'active' NOT NULL,
    "hidden" boolean DEFAULT false NOT NULL,
    "discovered_at" timestamp DEFAULT now(),
    "updated_at" timestamp DEFAULT now(),
    CONSTRAINT "projects_name_git_remote_url_unique" UNIQUE ("name", "git_remote_url")
  );

  CREATE TABLE "sessions" (
    "id" text PRIMARY KEY NOT NULL,
    "project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL,
    "machine" text NOT NULL,
    "status" text DEFAULT 'active' NOT NULL,
    "started_at" timestamp NOT NULL,
    "last_activity" timestamp NOT NULL,
    "ended_at" timestamp,
    "stop_reason" text,
    "error_details" text,
    "pid" integer,
    "cwd" text,
    "branch" text,
    "session_type" text,
    "model" text,
    "rate_limit_utilization" real,
    "rate_limit_reset_at" timestamp,
    "idle_since" timestamp,
    "cc_session_id" text,
    "tmux_session" text,
    "tmux_target" text,
    "spec" text,
    "credential_id" text,
    "credential_fingerprint" text,
    "git_provider" text,
    "git_owner_repo" text,
    "agent_state" text,
    "parent_session_id" text,
    "child_role" text
  );

  CREATE TABLE "session_events" (
    "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    "session_id" text NOT NULL REFERENCES "sessions"("id"),
    "event_type" text NOT NULL,
    "timestamp" timestamp NOT NULL,
    "metadata" text
  );

  CREATE TABLE "process_watcher_state" (
    "id" serial PRIMARY KEY NOT NULL,
    "observed_at" timestamp DEFAULT now() NOT NULL,
    "live_pid_count" integer NOT NULL,
    "tick_duration_ms" integer NOT NULL,
    "error_text" text
  );
`;
