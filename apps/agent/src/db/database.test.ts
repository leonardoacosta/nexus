/**
 * Startup schema-verification tests — exercise `verifySchema()` /
 * `checkSchemaForHealth()` against a live Postgres instance.
 *
 * Context (`bd show nx-dbame`): the homelab agent connected to a freshly-
 * provisioned `nexus` database with ZERO tables and served 500s for seven
 * weeks because /health only verified the PG handshake. The functions under
 * test convert that class of silent failure into a fast fail-exit on startup
 * AND a falsy `schema_ok` field on /health.
 *
 * Isolation pattern mirrors `migration-0010-orphans.test.ts` and `db.test.ts`:
 * each describe-block carves out its own Postgres schema, builds whichever
 * subset of the required tables it needs, runs the assertions, and drops the
 * schema in teardown. POSTGRES_URL-gated so the suite skips cleanly when no
 * live PG is available.
 *
 * To run:
 *   docker compose -f docker-compose.test.yml up -d
 *   export POSTGRES_URL=postgres://nexus:nexus@localhost:5433/nexus_test
 *   bun test apps/agent/src/db/database.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createDb } from "@nexus/db";
import type { Db } from "@nexus/db";
import {
  REQUIRED_TABLES,
  SchemaIncompleteError,
  checkSchemaForHealth,
  verifySchema,
} from "./database";

type Sql = ReturnType<typeof createDb>["client"];

import { hasLivePg as hasPg } from "../testing/live-pg";

// Minimal DDL that creates ALL required tables. The schema-verify probe
// only checks for existence (`SELECT to_regclass(name)`), so the column set
// can be a stripped-down placeholder — verifySchema doesn't read columns.
function ddlForAllRequiredTables(): string {
  return `
    CREATE TABLE "sessions" (
      "id" text PRIMARY KEY NOT NULL,
      "machine" text NOT NULL
    );
    CREATE TABLE "session_events" (
      "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      "session_id" text NOT NULL
    );
    CREATE TABLE "health_snapshots" (
      "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      "timestamp" timestamp NOT NULL
    );
    CREATE TABLE "notifications" (
      "id" text PRIMARY KEY NOT NULL,
      "channel" text NOT NULL,
      "title" text NOT NULL,
      "body" text NOT NULL
    );
    CREATE TABLE "credential_swaps" (
      "id" text PRIMARY KEY NOT NULL,
      "session_id" text NOT NULL,
      "to_fingerprint" text NOT NULL,
      "reason" text NOT NULL,
      "created_at" timestamp DEFAULT now() NOT NULL
    );
  `;
}

/** Same as above but missing `notifications` — used by the negative test. */
function ddlMissingNotifications(): string {
  return `
    CREATE TABLE "sessions" (
      "id" text PRIMARY KEY NOT NULL,
      "machine" text NOT NULL
    );
    CREATE TABLE "session_events" (
      "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      "session_id" text NOT NULL
    );
    CREATE TABLE "health_snapshots" (
      "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      "timestamp" timestamp NOT NULL
    );
  `;
}

/** Build an isolated schema with the given DDL and return a scoped Db. */
async function buildIsolatedDb(
  schemaName: string,
  ddl: string,
): Promise<{ db: Db; adminClient: Sql; scopedClient: Sql }> {
  const url = process.env.POSTGRES_URL!;
  const adminHandle = createDb(url);
  const adminClient = adminHandle.client;

  await adminClient.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  await adminClient.unsafe(`CREATE SCHEMA "${schemaName}"`);
  await adminClient.unsafe(`SET search_path TO "${schemaName}", public`);
  await adminClient.unsafe(ddl);

  const scopedHandle = createDb(url, {
    connection: { search_path: `"${schemaName}",public` },
  });
  return { db: scopedHandle.db, adminClient, scopedClient: scopedHandle.client };
}

async function dropIsolatedDb(
  schemaName: string,
  adminClient: Sql,
  scopedClient: Sql,
): Promise<void> {
  try {
    await scopedClient.end({ timeout: 5 });
  } finally {
    try {
      await adminClient.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    } finally {
      await adminClient.end({ timeout: 5 });
    }
  }
}

// ─── Sanity check: the constant the agent uses matches the docs ─────────────

describe("REQUIRED_TABLES", () => {
  it("lists the hot-path tables nx-dbame called out", () => {
    // The original four (nx-dbame) MUST stay covered.
    expect(REQUIRED_TABLES).toContain("sessions");
    expect(REQUIRED_TABLES).toContain("session_events");
    expect(REQUIRED_TABLES).toContain("health_snapshots");
    expect(REQUIRED_TABLES).toContain("notifications");
  });

  // nx-fbje2 — homelab DB drifted post D&D cleanup; ensure credential_swaps
  // stays guarded so a future schema removal fails loud at startup.
  it("guards credential_swaps so a future removal fails at startup [nx-fbje2]", () => {
    expect(REQUIRED_TABLES).toContain("credential_swaps");
  });
});

// ─── 1. Happy path — all tables present ─────────────────────────────────────

describe.skipIf(!hasPg)("verifySchema (requires live PG) — happy path", () => {
  const schemaName = `nx_verify_ok_${Date.now()}_${Math.floor(
    Math.random() * 1e6,
  )}`;
  let db: Db;
  let adminClient: Sql;
  let scopedClient: Sql;
  const originalSkipFlag = process.env.NEXUS_SKIP_SCHEMA_CHECK;

  beforeAll(async () => {
    delete process.env.NEXUS_SKIP_SCHEMA_CHECK;
    ({ db, adminClient, scopedClient } = await buildIsolatedDb(
      schemaName,
      ddlForAllRequiredTables(),
    ));
  });

  afterAll(async () => {
    if (originalSkipFlag !== undefined) {
      process.env.NEXUS_SKIP_SCHEMA_CHECK = originalSkipFlag;
    }
    await dropIsolatedDb(schemaName, adminClient, scopedClient);
  });

  it("resolves without throwing when every required table exists", async () => {
    await expect(verifySchema(db)).resolves.toBeUndefined();
  });

  it("checkSchemaForHealth returns { schema_ok: true, missing: [] }", async () => {
    const result = await checkSchemaForHealth(db);
    expect(result.schema_ok).toBe(true);
    expect(result.missing).toEqual([]);
  });
});

// ─── 2. Missing-table path — verifySchema throws SchemaIncompleteError ──────

describe.skipIf(!hasPg)("verifySchema (requires live PG) — missing table", () => {
  const schemaName = `nx_verify_miss_${Date.now()}_${Math.floor(
    Math.random() * 1e6,
  )}`;
  let db: Db;
  let adminClient: Sql;
  let scopedClient: Sql;
  const originalSkipFlag = process.env.NEXUS_SKIP_SCHEMA_CHECK;

  beforeAll(async () => {
    delete process.env.NEXUS_SKIP_SCHEMA_CHECK;
    ({ db, adminClient, scopedClient } = await buildIsolatedDb(
      schemaName,
      ddlMissingNotifications(),
    ));
  });

  afterAll(async () => {
    if (originalSkipFlag !== undefined) {
      process.env.NEXUS_SKIP_SCHEMA_CHECK = originalSkipFlag;
    }
    await dropIsolatedDb(schemaName, adminClient, scopedClient);
  });

  it("throws SchemaIncompleteError naming the missing table", async () => {
    let caught: unknown;
    try {
      await verifySchema(db);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SchemaIncompleteError);
    const err = caught as SchemaIncompleteError;
    expect(err.missingTables).toContain("notifications");
    expect(err.missingTables).not.toContain("sessions");
    // The message MUST be actionable — mention the sanctioned db:migrate
    // command and the POSTGRES_URL hint per the spec.
    expect(err.message).toContain("notifications");
    expect(err.message).toContain("pnpm --filter @nexus/db db:migrate");
    expect(err.message).toContain("POSTGRES_URL");
  });

  it("checkSchemaForHealth returns { schema_ok: false, missing: [...] }", async () => {
    const result = await checkSchemaForHealth(db);
    expect(result.schema_ok).toBe(false);
    expect(result.missing).toContain("notifications");
  });
});

// ─── 3. Bypass path — NEXUS_SKIP_SCHEMA_CHECK=1 ─────────────────────────────

describe.skipIf(!hasPg)(
  "verifySchema (requires live PG) — NEXUS_SKIP_SCHEMA_CHECK bypass",
  () => {
    const schemaName = `nx_verify_skip_${Date.now()}_${Math.floor(
      Math.random() * 1e6,
    )}`;
    let db: Db;
    let adminClient: Sql;
    let scopedClient: Sql;
    const originalSkipFlag = process.env.NEXUS_SKIP_SCHEMA_CHECK;

    beforeAll(async () => {
      ({ db, adminClient, scopedClient } = await buildIsolatedDb(
        schemaName,
        // Intentionally missing every table so the bypass MUST be the reason
        // verifySchema resolves.
        ``,
      ));
      process.env.NEXUS_SKIP_SCHEMA_CHECK = "1";
    });

    afterAll(async () => {
      if (originalSkipFlag === undefined) {
        delete process.env.NEXUS_SKIP_SCHEMA_CHECK;
      } else {
        process.env.NEXUS_SKIP_SCHEMA_CHECK = originalSkipFlag;
      }
      await dropIsolatedDb(schemaName, adminClient, scopedClient);
    });

    it("resolves without throwing even when every table is missing", async () => {
      await expect(verifySchema(db)).resolves.toBeUndefined();
    });

    it("checkSchemaForHealth also short-circuits to schema_ok=true under bypass", async () => {
      const result = await checkSchemaForHealth(db);
      expect(result.schema_ok).toBe(true);
      expect(result.missing).toEqual([]);
    });
  },
);

// ─── SchemaIncompleteError message contract (no PG required) ────────────────
// Pins the operator remediation text to the sanctioned migration-only path.
// Context: nx-vtzmd (2026-06-20) — the previous message instructed the
// state-based push command, which skips the migrations journal and can
// silently drop columns on the shared homelab DB.
describe("SchemaIncompleteError message", () => {
  it("instructs db:migrate and never the banned push command", () => {
    const err = new SchemaIncompleteError(["notifications"], {
      host: "localhost:5436",
      database: "nexus",
    });
    expect(err.message).toContain("pnpm --filter @nexus/db db:migrate");
    expect(err.message).toContain("POSTGRES_URL");
    expect(err.message).toContain("localhost:5436/nexus");
    expect(err.message).not.toContain("db:push"); // banned (nx-vtzmd)
    expect(err.message).not.toContain("drizzle-kit push"); // banned (nx-vtzmd)
  });
});
