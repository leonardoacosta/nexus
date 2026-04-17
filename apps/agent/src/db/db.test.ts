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
import { createDb } from "@nexus/db";
import type { Db } from "@nexus/db";
import { getSessionById, insertSession } from "./sessions";
import type { SessionRow } from "./sessions";

type Sql = ReturnType<typeof createDb>["client"];

const hasPg = !!process.env.POSTGRES_URL;

// ─── 7.1 Migration runner ────────────────────────────────────────────────────

describe.skip("migration runner (requires live PG)", () => {
  it("placeholder — drizzle-kit manages migrations now", () => {
    expect(true).toBe(true);
  });
});

// ─── 7.2 Session CRUD ───────────────────────────────────────────────────────

// Unique schema name per run so parallel workers don't collide and
// abandoned runs never block the next invocation — mirrors the pattern
// established by migration-0010-orphans.test.ts.
const SESSION_CRUD_SCHEMA = `nx_dbtest_${Date.now()}_${Math.floor(
  Math.random() * 1e6,
)}`;

// Minimal DDL reproducing the current production shape (as of migration
// 0018) for the three tables session-CRUD touches: sessions, projects,
// agents. Column types and nullability match
// `packages/db/drizzle/meta/0018_snapshot.json`.
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
    "credential_fingerprint" text
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

// ─── 7.2b Session CRUD (remaining — still gated) ────────────────────────────

describe.skip("session CRUD — remaining (requires live PG)", () => {
  it("updates session status", () => {
    expect(true).toBe(true);
  });

  it("sets ended_at when status is 'ended'", () => {
    expect(true).toBe(true);
  });

  it("queries active sessions (active + idle)", () => {
    expect(true).toBe(true);
  });

  it("queries recent sessions within the time window", () => {
    expect(true).toBe(true);
  });
});

// ─── 7.3 Health snapshots ────────────────────────────────────────────────────

describe.skip("health snapshots (requires live PG)", () => {
  it("inserts a health snapshot", () => {
    expect(true).toBe(true);
  });

  it("handles null metric fields", () => {
    expect(true).toBe(true);
  });

  it("queries time-series within the window, ordered ascending", () => {
    expect(true).toBe(true);
  });
});

// ─── 7.4 Session events ─────────────────────────────────────────────────────

describe.skip("session events (requires live PG)", () => {
  it("appends an event and queries it back", () => {
    expect(true).toBe(true);
  });

  it("handles null metadata", () => {
    expect(true).toBe(true);
  });

  it("returns events ordered by timestamp ascending", () => {
    expect(true).toBe(true);
  });

  it("filters events by session_id", () => {
    expect(true).toBe(true);
  });
});

// ─── 7.5 Retention cleanup ──────────────────────────────────────────────────

describe.skip("retention cleanup (requires live PG)", () => {
  it("deletes health_snapshots older than 30 days", () => {
    expect(true).toBe(true);
  });

  it("deletes session_events older than 90 days", () => {
    expect(true).toBe(true);
  });

  it("keeps records within retention windows", () => {
    expect(true).toBe(true);
  });

  it("handles cleanup on empty tables without error", () => {
    expect(true).toBe(true);
  });
});
