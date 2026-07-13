/**
 * Database integration tests.
 *
 * These tests previously used bun:sqlite in-memory databases. After the
 * migration to PostgreSQL + Drizzle, they require a live PG connection.
 *
 * Session-CRUD suite (7.2) uses the scratch-schema pattern from
 * `migration-0010-orphans.test.ts`: each run creates a unique schema inside
 * `POSTGRES_URL`, builds the current sessions/projects/agents shape there,
 * runs assertions, and drops the schema in teardown. This avoids polluting
 * the main `public` schema and makes tests re-runnable in parallel.
 *
 * To run these tests:
 *   1. docker compose -f docker-compose.test.yml up -d
 *   2. export POSTGRES_URL=postgres://nexus:nexus@localhost:5433/nexus_test
 *   3. bun test apps/agent/src/db/db.test.ts
 *
 * PG-gated: suites skip cleanly when POSTGRES_URL is unset.
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { createDb, agents as agentsTable, eq as eqOp } from "@nexus/db";
import type { Db } from "@nexus/db";
import {
  getSessionById,
  insertSession,
  updateSessionStatus,
  queryActiveSessions,
  queryRecentSessions,
} from "./sessions";
import type { SessionRow } from "./sessions";
import { appendSessionEvent, querySessionEvents } from "./events";
import { runRetentionCleanup } from "./retention";

type Sql = ReturnType<typeof createDb>["client"];

import { hasLivePg as hasPg } from "../testing/live-pg";

// ─── 7.1 Migration runner ────────────────────────────────────────────────────
//
// Intentionally absent: there is no in-repo migration runner to integration-
// test. Schema lifecycle is owned by `drizzle-kit generate` / `db:migrate`
// (see the file header). Migration *content* is exercised by
// migration-0010-orphans.test.ts. No stub here — nothing to assert.

// ─── 7.2 Session CRUD ───────────────────────────────────────────────────────

// Unique schema name per run so parallel workers don't collide and
// abandoned runs never block the next invocation — mirrors the pattern
// established by migration-0010-orphans.test.ts.
const SESSION_CRUD_SCHEMA = `nx_dbtest_${Date.now()}_${Math.floor(
  Math.random() * 1e6,
)}`;

// Minimal DDL reproducing the CURRENT production shape for the three tables
// session-CRUD touches: sessions, projects, agents. Column set + nullability
// mirror `packages/db/src/schema/sessions.ts` exactly. The sessions block
// previously drifted (missing git_provider / git_owner_repo /
// parent_session_id / child_role) which false-failed `getSessionById`'s
// full-column SELECT — that drift is the mock-divergence class this spec
// guards. Keep this in lockstep with the Drizzle schema.
//
// nx-w94di root-cause note: the "stop_reason does not exist" failure
// originally attributed to a schema drop/recreate race under
// NEXUS_HEAVY_TESTS load was actually THIS block missing stop_reason /
// error_details (added by nx-f060f) — deterministic DDL drift, not a race.
// Reproduced 100% across 3 consecutive isolated runs with no concurrent
// load. Each describe block still creates its own uniquely-named schema
// (Date.now()+Math.random), so cross-file/cross-run isolation was never the
// problem.
const SESSION_CRUD_DDL = `
  CREATE TABLE "agents" (
    "id" text PRIMARY KEY NOT NULL,
    "name" text DEFAULT '',
    "host" text NOT NULL,
    "port" integer DEFAULT 7400,
    "projects_dir" text DEFAULT '',
    "enabled" boolean DEFAULT true,
    "last_seen" timestamp,
    "created_at" timestamp DEFAULT now()
  );

  CREATE TABLE "projects" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "name" text NOT NULL,
    "git_remote_url" text,
    "primary_agent_id" text NOT NULL,
    "description" text,
    "tags" text[],
    "status" text DEFAULT 'active' NOT NULL,
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
    "total_cost_usd" double precision,
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
`;

describe.skipIf(!hasPg)("session CRUD (requires live PG)", () => {
  // Two clients intentionally:
  //   * adminClient / adminDb — default pool for schema create/drop (DDL
  //     ops on the admin schema). Mirrors migration-0010 where the raw
  //     client is used for all teardown.
  //   * scopedDb — pool pinned to the isolated schema via
  //     `connection.search_path`. postgres.js applies that parameter in
  //     the startup packet of every new pooled connection, so Drizzle's
  //     ORM calls resolve unqualified table names inside
  //     SESSION_CRUD_SCHEMA automatically.
  let adminSql: Sql;
  let adminClient: Sql;
  let scopedClient: Sql;
  let db: Db;

  beforeAll(async () => {
    const url = process.env.POSTGRES_URL!;

    // Admin client — no search_path override, used strictly for DDL
    // against the outer database (CREATE SCHEMA / DROP SCHEMA).
    const adminHandle = createDb(url);
    adminClient = adminHandle.client;
    adminSql = adminClient;

    await adminSql.unsafe(`CREATE SCHEMA "${SESSION_CRUD_SCHEMA}"`);
    await adminSql.unsafe(
      `SET search_path TO "${SESSION_CRUD_SCHEMA}", public`,
    );
    await adminSql.unsafe(SESSION_CRUD_DDL);

    // Scoped client — every connection in this pool sees
    // SESSION_CRUD_SCHEMA first on its search_path, so Drizzle queries
    // land in the test schema without qualification.
    const scopedHandle = createDb(url, {
      connection: { search_path: `"${SESSION_CRUD_SCHEMA}",public` },
    });
    scopedClient = scopedHandle.client;
    db = scopedHandle.db;
  });

  afterAll(async () => {
    try {
      await scopedClient.end({ timeout: 5 });
    } finally {
      try {
        await adminSql.unsafe(
          `DROP SCHEMA IF EXISTS "${SESSION_CRUD_SCHEMA}" CASCADE`,
        );
      } finally {
        await adminClient.end({ timeout: 5 });
      }
    }
  });

  it("inserts a session and retrieves it by id", async () => {
    const now = new Date();
    const row: SessionRow = {
      id: "sess-crud-insert-1",
      projectId: null,
      machine: "omarchy",
      status: "active",
      startedAt: now,
      lastActivity: now,
      endedAt: null,
      stopReason: null,
      errorDetails: null,
      pid: 12345,
      cwd: "/home/nyaptor/dev/nx",
      branch: "main",
      sessionType: "ad_hoc",
      model: "claude-opus-4-7",
      rateLimitUtilization: 0.42,
      totalCostUsd: 1.23,
      rateLimitResetAt: null,
      idleSince: null,
      ccSessionId: "cc-abc-123",
      tmuxSession: "nexus-main",
      tmuxTarget: "nexus-main:0.1",
      spec: null,
      credentialId: null,
      credentialFingerprint: null,
      gitProvider: null,
      gitOwnerRepo: null,
      agentState: null,
      parentSessionId: null,
      childRole: null,
    };

    await insertSession(db, row);

    const fetched = await getSessionById(db, row.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(row.id);
    expect(fetched!.machine).toBe("omarchy");
    expect(fetched!.pid).toBe(12345);
    expect(fetched!.cwd).toBe("/home/nyaptor/dev/nx");
    expect(fetched!.branch).toBe("main");
    expect(fetched!.status).toBe("active");
    expect(fetched!.ccSessionId).toBe("cc-abc-123");
    expect(fetched!.tmuxSession).toBe("nexus-main");
    // postgres.js returns real/double precision as JS number — compare with
    // toBeCloseTo to survive float round-trip.
    expect(fetched!.rateLimitUtilization).toBeCloseTo(0.42, 5);
    expect(fetched!.totalCostUsd).toBeCloseTo(1.23, 5);
  });

  it("returns null for non-existent session id", async () => {
    const result = await getSessionById(db, "does-not-exist-ever-abc123");
    expect(result).toBeNull();
  });
});

// ─── 7.2b Session CRUD (remaining) ──────────────────────────────────────────
//
// Previously a `describe.skip` placeholder. Un-stubbed (nx-qsj1) with real
// assertions against live PG using the same scratch-schema isolation as the
// 7.2 suite above.

const SESSION_CRUD2_SCHEMA = `nx_dbtest2_${Date.now()}_${Math.floor(
  Math.random() * 1e6,
)}`;

/** Build a fully-populated SessionRow with overridable fields. */
function makeSessionRow(over: Partial<SessionRow> & { id: string }): SessionRow {
  const now = new Date();
  return {
    projectId: null,
    machine: "omarchy",
    status: "active",
    startedAt: now,
    lastActivity: now,
    endedAt: null,
    stopReason: null,
    errorDetails: null,
    pid: null,
    cwd: "/tmp/x",
    branch: null,
    sessionType: "ad_hoc",
    model: "claude",
    rateLimitUtilization: null,
    totalCostUsd: null,
    rateLimitResetAt: null,
    idleSince: null,
    ccSessionId: null,
    tmuxSession: null,
    tmuxTarget: null,
    spec: null,
    credentialId: null,
    credentialFingerprint: null,
    gitProvider: null,
    gitOwnerRepo: null,
    agentState: null,
    parentSessionId: null,
    childRole: null,
    ...over,
  };
}

describe.skipIf(!hasPg)("session CRUD — remaining (requires live PG)", () => {
  let adminSql: Sql;
  let adminClient: Sql;
  let scopedClient: Sql;
  let db: Db;

  beforeAll(async () => {
    const url = process.env.POSTGRES_URL!;
    const adminHandle = createDb(url);
    adminClient = adminHandle.client;
    adminSql = adminClient;

    await adminSql.unsafe(`CREATE SCHEMA "${SESSION_CRUD2_SCHEMA}"`);
    await adminSql.unsafe(
      `SET search_path TO "${SESSION_CRUD2_SCHEMA}", public`,
    );
    await adminSql.unsafe(SESSION_CRUD_DDL);

    const scopedHandle = createDb(url, {
      connection: { search_path: `"${SESSION_CRUD2_SCHEMA}",public` },
    });
    scopedClient = scopedHandle.client;
    db = scopedHandle.db;
  });

  afterAll(async () => {
    try {
      await scopedClient.end({ timeout: 5 });
    } finally {
      try {
        await adminSql.unsafe(
          `DROP SCHEMA IF EXISTS "${SESSION_CRUD2_SCHEMA}" CASCADE`,
        );
      } finally {
        await adminClient.end({ timeout: 5 });
      }
    }
  });

  it("updates session status", async () => {
    await insertSession(db, makeSessionRow({ id: "crud2-status-1" }));
    await updateSessionStatus(db, "crud2-status-1", "idle");

    const fetched = await getSessionById(db, "crud2-status-1");
    expect(fetched).not.toBeNull();
    expect(fetched!.status).toBe("idle");
    // last_activity refreshed; ended_at untouched for a non-ended status.
    expect(fetched!.endedAt).toBeNull();
  });

  it("sets ended_at when status is 'ended'", async () => {
    await insertSession(db, makeSessionRow({ id: "crud2-ended-1" }));
    expect((await getSessionById(db, "crud2-ended-1"))!.endedAt).toBeNull();

    await updateSessionStatus(db, "crud2-ended-1", "ended");

    const fetched = await getSessionById(db, "crud2-ended-1");
    expect(fetched!.status).toBe("ended");
    expect(fetched!.endedAt).toBeInstanceOf(Date);
  });

  it("queries active sessions (active + idle)", async () => {
    await insertSession(
      db,
      makeSessionRow({ id: "crud2-active-1", status: "active" }),
    );
    await insertSession(
      db,
      makeSessionRow({ id: "crud2-idle-1", status: "idle" }),
    );
    await insertSession(
      db,
      makeSessionRow({
        id: "crud2-ended-2",
        status: "ended",
        endedAt: new Date(),
      }),
    );

    const rows = await queryActiveSessions(db);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("crud2-active-1");
    expect(ids).toContain("crud2-idle-1");
    expect(ids).not.toContain("crud2-ended-2");
  });

  it("queries recent sessions within the time window", async () => {
    const now = new Date();
    await insertSession(
      db,
      makeSessionRow({ id: "crud2-recent-1", lastActivity: now }),
    );
    // 48h-old activity is outside the 24h window.
    await insertSession(
      db,
      makeSessionRow({
        id: "crud2-stale-1",
        status: "ended",
        endedAt: new Date(now.getTime() - 48 * 3600_000),
        lastActivity: new Date(now.getTime() - 48 * 3600_000),
      }),
    );

    const rows = await queryRecentSessions(db, 24);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("crud2-recent-1");
    expect(ids).not.toContain("crud2-stale-1");
  });
});

// ─── 7.3 Health snapshots ────────────────────────────────────────────────────

// Unique schema name for health-snapshot tests — mirrors the session-CRUD
// pattern so these tests are isolated and re-runnable in parallel.
const HEALTH_SCHEMA = `nx_health_test_${Date.now()}_${Math.floor(
  Math.random() * 1e6,
)}`;

// Minimal DDL for the health_snapshots + agents tables (needed for FK).
const HEALTH_DDL = `
  CREATE TABLE "agents" (
    "id" text PRIMARY KEY NOT NULL,
    "host" text NOT NULL,
    "name" text DEFAULT '',
    "port" integer DEFAULT 7400
  );

  CREATE TABLE "health_snapshots" (
    "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    "timestamp" timestamp NOT NULL,
    "agent_id" text NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
    "cpu_percent" real,
    "ram_percent" real,
    "disk_percent" real,
    "docker_containers" integer,
    "raw_json" text
  );
`;

describe.skipIf(!hasPg)("health snapshots (requires live PG)", () => {
  let adminSql: ReturnType<typeof createDb>["client"];
  let scopedDb: import("@nexus/db").Db;
  let scopedClient: ReturnType<typeof createDb>["client"];

  beforeAll(async () => {
    const url = process.env.POSTGRES_URL!;
    const adminHandle = createDb(url);
    adminSql = adminHandle.client;

    await adminSql.unsafe(`CREATE SCHEMA "${HEALTH_SCHEMA}"`);
    await adminSql.unsafe(`SET search_path TO "${HEALTH_SCHEMA}", public`);
    await adminSql.unsafe(HEALTH_DDL);

    // Insert a test agent so FK references succeed
    await adminSql.unsafe(
      `INSERT INTO "agents" ("id", "host") VALUES ('test-agent-hs', 'localhost')`,
    );

    const scopedHandle = createDb(url, {
      connection: { search_path: `"${HEALTH_SCHEMA}",public` },
    });
    scopedClient = scopedHandle.client;
    scopedDb = scopedHandle.db;
  });

  afterAll(async () => {
    try {
      await scopedClient.end({ timeout: 5 });
    } finally {
      try {
        await adminSql.unsafe(
          `DROP SCHEMA IF EXISTS "${HEALTH_SCHEMA}" CASCADE`,
        );
      } finally {
        await adminSql.end({ timeout: 5 });
      }
    }
  });

  it("inserts a health snapshot", async () => {
    // Use raw SQL to avoid mock.module("./db/health") interference from
    // health-scheduler.test.ts which replaces insertHealthSnapshot with a spy.
    const ts = new Date().toISOString();
    await adminSql.unsafe(`
      INSERT INTO "${HEALTH_SCHEMA}".health_snapshots
        ("timestamp", "agent_id", "cpu_percent", "ram_percent", "disk_percent", "docker_containers", "raw_json")
      VALUES
        ('${ts}', 'test-agent-hs', 42.5, 60.0, 75.0, 3, '{"hostname":"test-host"}')
    `);

    const rows = await adminSql.unsafe(
      `SELECT * FROM "${HEALTH_SCHEMA}".health_snapshots WHERE agent_id = 'test-agent-hs' ORDER BY id DESC LIMIT 1`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[0] as Record<string, unknown>;
    expect(Number(row.cpu_percent)).toBeCloseTo(42.5, 4);
    expect(Number(row.ram_percent)).toBeCloseTo(60.0, 4);
    expect(Number(row.disk_percent)).toBeCloseTo(75.0, 4);
    expect(row.docker_containers).toBe(3);
  });

  it("handles null metric fields", async () => {
    const ts = new Date().toISOString();
    await adminSql.unsafe(`
      INSERT INTO "${HEALTH_SCHEMA}".health_snapshots
        ("timestamp", "agent_id", "cpu_percent", "ram_percent", "disk_percent", "docker_containers", "raw_json")
      VALUES
        ('${ts}', 'test-agent-hs', NULL, NULL, NULL, NULL, NULL)
    `);

    const rows = await adminSql.unsafe(
      `SELECT * FROM "${HEALTH_SCHEMA}".health_snapshots WHERE cpu_percent IS NULL AND agent_id = 'test-agent-hs' ORDER BY id DESC LIMIT 1`,
    );
    expect(rows.length).toBe(1);
    const row = rows[0] as Record<string, unknown>;
    expect(row.cpu_percent).toBeNull();
    expect(row.ram_percent).toBeNull();
    expect(row.disk_percent).toBeNull();
    expect(row.docker_containers).toBeNull();
    expect(row.raw_json).toBeNull();
  });

  it("queries time-series within the window, ordered ascending", async () => {
    const now = Date.now();
    const t1 = new Date(now - 3000).toISOString();
    const t2 = new Date(now - 2000).toISOString();
    const t3 = new Date(now - 1000).toISOString();

    // Insert 3 snapshots via raw SQL to bypass any module mock on ./db/health
    await adminSql.unsafe(`
      INSERT INTO "${HEALTH_SCHEMA}".health_snapshots
        ("timestamp", "agent_id", "cpu_percent")
      VALUES
        ('${t1}', 'test-agent-hs', 10),
        ('${t2}', 'test-agent-hs', 20),
        ('${t3}', 'test-agent-hs', 30)
    `);

    // Query via raw SQL with a 1-hour window, ordering by timestamp ascending
    const cutoff = new Date(now - 3_600_000).toISOString();
    const results = await adminSql.unsafe(
      `SELECT * FROM "${HEALTH_SCHEMA}".health_snapshots
       WHERE "timestamp" >= '${cutoff}'
       ORDER BY "timestamp" ASC`,
    ) as Array<Record<string, unknown>>;

    // At minimum the 3 rows we just inserted are within range
    expect(results.length).toBeGreaterThanOrEqual(3);

    // Verify ascending order
    for (let i = 1; i < results.length; i++) {
      const prev = new Date(results[i - 1]!.timestamp as string).getTime();
      const curr = new Date(results[i]!.timestamp as string).getTime();
      expect(curr).toBeGreaterThanOrEqual(prev);
    }
  });
});

// ─── 7.4 Session events ─────────────────────────────────────────────────────
//
// Un-stubbed (nx-it4u). Exercises appendSessionEvent / querySessionEvents
// against live PG with the scratch-schema isolation pattern.

const EVENTS_SCHEMA = `nx_events_test_${Date.now()}_${Math.floor(
  Math.random() * 1e6,
)}`;

const EVENTS_DDL = `
  CREATE TABLE "sessions" (
    "id" text PRIMARY KEY NOT NULL,
    "machine" text NOT NULL,
    "status" text DEFAULT 'active' NOT NULL,
    "started_at" timestamp NOT NULL,
    "last_activity" timestamp NOT NULL,
    "ended_at" timestamp
  );

  CREATE TABLE "session_events" (
    "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    "session_id" text NOT NULL REFERENCES "sessions"("id"),
    "event_type" text NOT NULL,
    "timestamp" timestamp NOT NULL,
    "metadata" text
  );
`;

describe.skipIf(!hasPg)("session events (requires live PG)", () => {
  let adminSql: Sql;
  let adminClient: Sql;
  let scopedClient: Sql;
  let db: Db;

  beforeAll(async () => {
    const url = process.env.POSTGRES_URL!;
    const adminHandle = createDb(url);
    adminClient = adminHandle.client;
    adminSql = adminClient;

    await adminSql.unsafe(`CREATE SCHEMA "${EVENTS_SCHEMA}"`);
    await adminSql.unsafe(`SET search_path TO "${EVENTS_SCHEMA}", public`);
    await adminSql.unsafe(EVENTS_DDL);

    const scopedHandle = createDb(url, {
      connection: { search_path: `"${EVENTS_SCHEMA}",public` },
    });
    scopedClient = scopedHandle.client;
    db = scopedHandle.db;

    // Seed parent sessions so the session_id FK resolves.
    const now = new Date();
    for (const id of ["evt-sess-a", "evt-sess-b"]) {
      await adminSql.unsafe(
        `INSERT INTO "${EVENTS_SCHEMA}".sessions
           ("id", "machine", "status", "started_at", "last_activity")
         VALUES ('${id}', 'test', 'active', '${now.toISOString()}', '${now.toISOString()}')`,
      );
    }
  });

  afterAll(async () => {
    try {
      await scopedClient.end({ timeout: 5 });
    } finally {
      try {
        await adminSql.unsafe(
          `DROP SCHEMA IF EXISTS "${EVENTS_SCHEMA}" CASCADE`,
        );
      } finally {
        await adminClient.end({ timeout: 5 });
      }
    }
  });

  it("appends an event and queries it back", async () => {
    const id = await appendSessionEvent(db, {
      sessionId: "evt-sess-a",
      eventType: "PreToolUse",
      timestamp: new Date(),
      metadata: JSON.stringify({ tool: "Bash" }),
    });
    expect(typeof id).toBe("number");
    expect(id).toBeGreaterThan(0);

    const rows = await querySessionEvents(db, "evt-sess-a");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows.find((r) => r.id === id)!;
    expect(row.eventType).toBe("PreToolUse");
    expect(row.metadata).toBe(JSON.stringify({ tool: "Bash" }));
  });

  it("handles null metadata", async () => {
    const id = await appendSessionEvent(db, {
      sessionId: "evt-sess-a",
      eventType: "Stop",
      timestamp: new Date(),
      metadata: null,
    });
    const rows = await querySessionEvents(db, "evt-sess-a");
    expect(rows.find((r) => r.id === id)!.metadata).toBeNull();
  });

  it("returns events ordered by timestamp ascending", async () => {
    const base = Date.now();
    // Insert out of chronological order.
    await appendSessionEvent(db, {
      sessionId: "evt-sess-b",
      eventType: "third",
      timestamp: new Date(base + 3000),
      metadata: null,
    });
    await appendSessionEvent(db, {
      sessionId: "evt-sess-b",
      eventType: "first",
      timestamp: new Date(base + 1000),
      metadata: null,
    });
    await appendSessionEvent(db, {
      sessionId: "evt-sess-b",
      eventType: "second",
      timestamp: new Date(base + 2000),
      metadata: null,
    });

    const rows = await querySessionEvents(db, "evt-sess-b");
    expect(rows.map((r) => r.eventType)).toEqual(["first", "second", "third"]);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.timestamp.getTime()).toBeGreaterThanOrEqual(
        rows[i - 1]!.timestamp.getTime(),
      );
    }
  });

  it("filters events by session_id", async () => {
    // evt-sess-a has PreToolUse + Stop; evt-sess-b has first/second/third.
    const aRows = await querySessionEvents(db, "evt-sess-a");
    const bRows = await querySessionEvents(db, "evt-sess-b");
    expect(aRows.every((r) => r.sessionId === "evt-sess-a")).toBe(true);
    expect(bRows.every((r) => r.sessionId === "evt-sess-b")).toBe(true);
    expect(aRows.some((r) => r.eventType === "first")).toBe(false);
  });
});

// ─── 7.5 Retention cleanup ──────────────────────────────────────────────────
//
// Un-stubbed (nx-3awz). Exercises runRetentionCleanup against live PG: rows
// older than the retention window are deleted; in-window rows survive.

const RETENTION_SCHEMA = `nx_retention_test_${Date.now()}_${Math.floor(
  Math.random() * 1e6,
)}`;

const RETENTION_DDL = `
  CREATE TABLE "agents" (
    "id" text PRIMARY KEY NOT NULL,
    "host" text NOT NULL,
    "name" text DEFAULT '',
    "port" integer DEFAULT 7400
  );

  CREATE TABLE "sessions" (
    "id" text PRIMARY KEY NOT NULL,
    "machine" text NOT NULL,
    "status" text DEFAULT 'active' NOT NULL,
    "started_at" timestamp NOT NULL,
    "last_activity" timestamp NOT NULL,
    "ended_at" timestamp
  );

  CREATE TABLE "health_snapshots" (
    "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    "timestamp" timestamp NOT NULL,
    "agent_id" text NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
    "cpu_percent" real,
    "ram_percent" real,
    "disk_percent" real,
    "docker_containers" integer,
    "raw_json" text
  );

  CREATE TABLE "session_events" (
    "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    "session_id" text NOT NULL REFERENCES "sessions"("id"),
    "event_type" text NOT NULL,
    "timestamp" timestamp NOT NULL,
    "metadata" text
  );

  CREATE TABLE "cc_profile_events" (
    "id" text PRIMARY KEY NOT NULL,
    "profile_id" text NOT NULL,
    "event_type" text NOT NULL,
    "session_id" text,
    "metadata" jsonb,
    "created_at" timestamp NOT NULL DEFAULT now()
  );

  -- Added for nx-w94di: runRetentionCleanup (../db/retention.ts) also
  -- prunes cron_runs, bloat_radar, and spec_sessions (adopt-reaper-into-
  -- nx-cron / specs-tab-start-on-spec). This DDL previously omitted all
  -- three, so every retention-cleanup call failed with "relation ... does
  -- not exist" deterministically whenever NEXUS_PG_TESTS actually ran.
  CREATE TABLE "cron_runs" (
    "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    "timestamp" timestamp NOT NULL,
    "job" text NOT NULL,
    "status" text NOT NULL,
    "details" jsonb,
    "metrics" jsonb
  );

  CREATE TABLE "bloat_radar" (
    "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    "run_timestamp" timestamp NOT NULL,
    "label" text NOT NULL,
    "path" text NOT NULL,
    "size_bytes" integer NOT NULL,
    "threshold_bytes" integer NOT NULL
  );

  CREATE TABLE "spec_sessions" (
    "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    "project" text NOT NULL,
    "spec_name" text NOT NULL,
    "session_id" text NOT NULL,
    "created_at" timestamp with time zone NOT NULL DEFAULT now()
  );

  -- Added for add-project-status-snapshots (task 4.2): runRetentionCleanup
  -- (../db/retention.ts) also prunes spec_snapshots and
  -- project_status_snapshots at 90 days. The DDL previously omitted both, so
  -- every retention-cleanup call would fail with "relation ... does not exist"
  -- deterministically once these deletes landed — same drift class as the
  -- nx-w94di cron_runs/bloat_radar/spec_sessions omission above.
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

  -- Added for add-git-status-orbit (task 4.2): runRetentionCleanup
  -- (../db/retention.ts) also prunes git_events at 90 days
  -- (GIT_EVENTS_RETENTION_DAYS). Omitting it would fail the retention-cleanup
  -- call with "relation git_events does not exist" — same drift class as the
  -- spec_snapshots / project_status_snapshots omission above.
  CREATE TABLE "git_events" (
    "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    "project" text NOT NULL,
    "event_type" text NOT NULL,
    "from_ref" text,
    "to_ref" text,
    "sha" text,
    "created_at" timestamp with time zone NOT NULL DEFAULT now()
  );
`;

describe.skipIf(!hasPg)("retention cleanup (requires live PG)", () => {
  let adminSql: Sql;
  let adminClient: Sql;
  let scopedClient: Sql;
  let db: Db;

  beforeAll(async () => {
    const url = process.env.POSTGRES_URL!;
    const adminHandle = createDb(url);
    adminClient = adminHandle.client;
    adminSql = adminClient;

    await adminSql.unsafe(`CREATE SCHEMA "${RETENTION_SCHEMA}"`);
    await adminSql.unsafe(`SET search_path TO "${RETENTION_SCHEMA}", public`);
    await adminSql.unsafe(RETENTION_DDL);
    await adminSql.unsafe(
      `INSERT INTO "${RETENTION_SCHEMA}".agents ("id", "host")
       VALUES ('ret-agent', 'localhost')`,
    );
    await adminSql.unsafe(
      `INSERT INTO "${RETENTION_SCHEMA}".sessions
         ("id", "machine", "status", "started_at", "last_activity")
       VALUES ('ret-sess', 'test', 'active', now(), now())`,
    );

    const scopedHandle = createDb(url, {
      connection: { search_path: `"${RETENTION_SCHEMA}",public` },
    });
    scopedClient = scopedHandle.client;
    db = scopedHandle.db;
  });

  afterAll(async () => {
    try {
      await scopedClient.end({ timeout: 5 });
    } finally {
      try {
        await adminSql.unsafe(
          `DROP SCHEMA IF EXISTS "${RETENTION_SCHEMA}" CASCADE`,
        );
      } finally {
        await adminClient.end({ timeout: 5 });
      }
    }
  });

  it("deletes health_snapshots older than 30 days and keeps fresh ones", async () => {
    const old = new Date(Date.now() - 45 * 86_400_000).toISOString();
    const fresh = new Date().toISOString();
    await adminSql.unsafe(
      `INSERT INTO "${RETENTION_SCHEMA}".health_snapshots
         ("timestamp", "agent_id", "cpu_percent")
       VALUES ('${old}', 'ret-agent', 1), ('${fresh}', 'ret-agent', 2)`,
    );

    await runRetentionCleanup(db);

    const rows = (await adminSql.unsafe(
      `SELECT cpu_percent FROM "${RETENTION_SCHEMA}".health_snapshots`,
    )) as Array<Record<string, unknown>>;
    const cpus = rows.map((r) => Number(r.cpu_percent));
    expect(cpus).toContain(2); // fresh survives
    expect(cpus).not.toContain(1); // 45-day-old purged
  });

  it("deletes session_events older than 90 days and keeps in-window", async () => {
    const old = new Date(Date.now() - 120 * 86_400_000).toISOString();
    const fresh = new Date().toISOString();
    await adminSql.unsafe(
      `INSERT INTO "${RETENTION_SCHEMA}".session_events
         ("session_id", "event_type", "timestamp")
       VALUES ('ret-sess', 'old-evt', '${old}'),
              ('ret-sess', 'fresh-evt', '${fresh}')`,
    );

    await runRetentionCleanup(db);

    const rows = (await adminSql.unsafe(
      `SELECT event_type FROM "${RETENTION_SCHEMA}".session_events`,
    )) as Array<Record<string, unknown>>;
    const types = rows.map((r) => r.event_type);
    expect(types).toContain("fresh-evt");
    expect(types).not.toContain("old-evt");
  });

  it("deletes aged spec_snapshots and project_status_snapshots from both tables", async () => {
    // add-project-status-snapshots task 4.2, retention requirement #7: both
    // change-only time-series tables are pruned at 90 days.
    const old = new Date(Date.now() - 120 * 86_400_000).toISOString();
    const fresh = new Date().toISOString();

    await adminSql.unsafe(
      `INSERT INTO "${RETENTION_SCHEMA}".spec_snapshots
         ("project", "spec_name", "completed", "total", "created_at")
       VALUES ('nx', 'aged-spec', 1, 2, '${old}'),
              ('nx', 'fresh-spec', 3, 4, '${fresh}')`,
    );
    await adminSql.unsafe(
      `INSERT INTO "${RETENTION_SCHEMA}".project_status_snapshots
         ("project", "proposals_unarchived", "beads_ready_unlinked", "beads_blocked_unlinked", "created_at")
       VALUES ('nx', 1, 0, 0, '${old}'),
              ('nx', 2, 0, 0, '${fresh}')`,
    );

    await runRetentionCleanup(db);

    const specRows = (await adminSql.unsafe(
      `SELECT spec_name FROM "${RETENTION_SCHEMA}".spec_snapshots`,
    )) as Array<Record<string, unknown>>;
    const specNames = specRows.map((r) => r.spec_name);
    expect(specNames).toContain("fresh-spec"); // in-window survives
    expect(specNames).not.toContain("aged-spec"); // 120-day-old purged

    const projRows = (await adminSql.unsafe(
      `SELECT proposals_unarchived FROM "${RETENTION_SCHEMA}".project_status_snapshots`,
    )) as Array<Record<string, unknown>>;
    const proposals = projRows.map((r) => Number(r.proposals_unarchived));
    expect(proposals).toContain(2); // fresh row survives
    expect(proposals).not.toContain(1); // aged row purged
  });

  it("deletes aged git_events rows and keeps in-window", async () => {
    // add-git-status-orbit task 4.2: git_events is pruned at 90 days
    // (GIT_EVENTS_RETENTION_DAYS), matching the cron_runs / project_status_
    // snapshots trend-window tables.
    const old = new Date(Date.now() - 120 * 86_400_000).toISOString();
    const fresh = new Date().toISOString();
    await adminSql.unsafe(
      `INSERT INTO "${RETENTION_SCHEMA}".git_events
         ("project", "event_type", "sha", "created_at")
       VALUES ('nx', 'new_commit', 'aged-sha', '${old}'),
              ('nx', 'new_commit', 'fresh-sha', '${fresh}')`,
    );

    await runRetentionCleanup(db);

    const rows = (await adminSql.unsafe(
      `SELECT sha FROM "${RETENTION_SCHEMA}".git_events`,
    )) as Array<Record<string, unknown>>;
    const shas = rows.map((r) => r.sha);
    expect(shas).toContain("fresh-sha"); // in-window survives
    expect(shas).not.toContain("aged-sha"); // 120-day-old purged
  });

  it("handles cleanup on empty tables without error", async () => {
    await adminSql.unsafe(
      `TRUNCATE "${RETENTION_SCHEMA}".health_snapshots,
                "${RETENTION_SCHEMA}".session_events,
                "${RETENTION_SCHEMA}".cc_profile_events`,
    );
    // Must not throw on empty tables.
    await expect(runRetentionCleanup(db)).resolves.toBeUndefined();
  });
});

// ─── 7.6 Soft-delete tombstone tolerance ────────────────────────────────────
//
// Verifies that an ID-based agent lookup (no isNull(deletedAt) filter) still
// resolves the row after it has been soft-deleted. This locks the requirement
// that historical session joins can always reach their agent record even after
// the agent has been tombstoned via DELETE /agents/:id.

const TOMBSTONE_SCHEMA = `nx_tombstone_test_${Date.now()}_${Math.floor(
  Math.random() * 1e6,
)}`;

// Full agents DDL matching production shape (migration 0019) so Drizzle ORM
// can SELECT all columns without "column does not exist" errors.
const TOMBSTONE_DDL = `
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

  CREATE TABLE "sessions" (
    "id" text PRIMARY KEY NOT NULL,
    "machine" text NOT NULL,
    "status" text DEFAULT 'active' NOT NULL,
    "started_at" timestamp NOT NULL,
    "last_activity" timestamp NOT NULL,
    "ended_at" timestamp
  );
`;

describe.skipIf(!hasPg)("soft-delete tombstone tolerance (requires live PG)", () => {
  let adminSql: Sql;
  let adminClient: Sql;
  let scopedClient: ReturnType<typeof createDb>["client"];
  let db: Db;

  beforeAll(async () => {
    const url = process.env.POSTGRES_URL!;

    const adminHandle = createDb(url);
    adminClient = adminHandle.client;
    adminSql = adminClient;

    await adminSql.unsafe(`CREATE SCHEMA "${TOMBSTONE_SCHEMA}"`);
    await adminSql.unsafe(
      `SET search_path TO "${TOMBSTONE_SCHEMA}", public`,
    );
    await adminSql.unsafe(TOMBSTONE_DDL);

    const scopedHandle = createDb(url, {
      connection: { search_path: `"${TOMBSTONE_SCHEMA}",public` },
    });
    scopedClient = scopedHandle.client;
    db = scopedHandle.db;
  });

  afterAll(async () => {
    try {
      await scopedClient.end({ timeout: 5 });
    } finally {
      try {
        await adminSql.unsafe(
          `DROP SCHEMA IF EXISTS "${TOMBSTONE_SCHEMA}" CASCADE`,
        );
      } finally {
        await adminClient.end({ timeout: 5 });
      }
    }
  });

  it("ID lookup resolves a soft-deleted agent row (no isNull filter)", async () => {
    const agentId = "tombstone-agent-001";
    const now = new Date();

    // Seed agent + a session that references it via machine.
    await adminSql.unsafe(
      `INSERT INTO "${TOMBSTONE_SCHEMA}".agents ("id", "host", "enabled")
       VALUES ('${agentId}', 'localhost', true)`,
    );
    await adminSql.unsafe(
      `INSERT INTO "${TOMBSTONE_SCHEMA}".sessions ("id", "machine", "status", "started_at", "last_activity")
       VALUES ('sess-tombstone-001', '${agentId}', 'ended', '${now.toISOString()}', '${now.toISOString()}')`,
    );

    // Soft-delete the agent.
    await adminSql.unsafe(
      `UPDATE "${TOMBSTONE_SCHEMA}".agents
       SET "deleted_at" = NOW()
       WHERE "id" = '${agentId}'`,
    );

    // ID-based lookup (mirrors agent-self.ts: db.select().from(agents).where(eq(agents.id, id)))
    // — no isNull(deletedAt) guard. The row must still be returned.
    const rows = await db.select().from(agentsTable).where(eqOp(agentsTable.id, agentId));

    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe(agentId);
    expect(rows[0]!.deletedAt).toBeInstanceOf(Date);
  });

  it("the session referencing the tombstoned agent is still queryable", async () => {
    // Confirm the session row itself is intact — historical joins are not broken.
    const sessionRows = await adminSql.unsafe(
      `SELECT * FROM "${TOMBSTONE_SCHEMA}".sessions WHERE id = 'sess-tombstone-001'`,
    ) as Array<Record<string, unknown>>;

    expect(sessionRows.length).toBe(1);
    expect(sessionRows[0]!.machine).toBe("tombstone-agent-001");
  });
});
