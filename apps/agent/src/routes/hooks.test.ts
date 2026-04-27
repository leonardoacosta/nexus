/**
 * Integration tests for POST /hooks persistence.
 *
 * Validates the behavior implemented in `apps/agent/src/routes/hooks.ts`:
 *   - session_start → sessions row inserted (status=active) + event row
 *   - session_summary with cost_usd → sessions.total_cost_usd updated
 *   - session_summary without cost_usd but with tokens+model → cost computed
 *     server-side via services/cost-calculator
 *   - session_stop → sessions.ended_at set, status=ended
 *   - stop_failure → sessions.status=errored, stop_reason in event metadata
 *   - diagnostic_ping → event row written end-to-end without manual session
 *     pre-creation (handler creates a stub session row for FK satisfaction)
 *
 * PG-gated: skips cleanly when POSTGRES_URL is unset. Mirrors the
 * scratch-schema pattern from `db/db.test.ts`.
 *
 * To run:
 *   docker compose -f docker-compose.test.yml up -d
 *   export POSTGRES_URL=postgres://nexus:nexus@localhost:5433/nexus_test
 *   bun test apps/agent/src/routes/hooks.test.ts
 */

import {
  describe,
  expect,
  it,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import { createDb, sessions, sessionEvents, eq } from "@nexus/db";
import type { Db } from "@nexus/db";

import { handleHooks } from "./hooks";
import { computeCostUsd } from "../services/cost-calculator";

type Sql = ReturnType<typeof createDb>["client"];

const hasPg = !!process.env.POSTGRES_URL;
if (!hasPg) {
  // eslint-disable-next-line no-console
  console.log(
    "[hooks.test] POSTGRES_URL not set — skipping persistence integration tests",
  );
}

const SCHEMA = `nx_hooks_test_${Date.now()}_${Math.floor(
  Math.random() * 1e6,
)}`;

// DDL mirrors db.test.ts session_crud DDL (sessions+projects+agents) and adds
// the session_events table whose definition lives in
// `packages/db/src/schema/sessionEvents.ts`.
const DDL = `
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
    "updated_at" timestamp DEFAULT now()
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

  CREATE TABLE "session_events" (
    "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    "session_id" text NOT NULL REFERENCES "sessions"("id"),
    "event_type" text NOT NULL,
    "timestamp" timestamp NOT NULL,
    "metadata" text
  );
`;

function buildHookRequest(body: unknown): Request {
  return new Request("http://localhost:7400/hooks", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe.skipIf(!hasPg)("POST /hooks — persistence (requires live PG)", () => {
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

  afterAll(async () => {
    try {
      await scopedClient.end({ timeout: 5 });
    } finally {
      try {
        await adminClient.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      } finally {
        await adminClient.end({ timeout: 5 });
      }
    }
  });

  beforeEach(async () => {
    // Wipe between tests so id reuse and row-count assertions are clean.
    // Children first to satisfy FK.
    await scopedClient.unsafe(`DELETE FROM "${SCHEMA}"."session_events"`);
    await scopedClient.unsafe(`DELETE FROM "${SCHEMA}"."sessions"`);
  });

  // ─── 1. session_start ───────────────────────────────────────────────────

  it("session_start inserts a session row with status='active' and an event row", async () => {
    const sessionId = "sess-start-1";
    const payload = {
      hook_event_name: "session_start",
      session_id: sessionId,
      cwd: "/home/nyaptor/dev/nx",
      branch: "main",
      model: "claude-opus-4-7",
      cc_session_id: "cc-abc",
      pid: 4242,
      machine: "omarchy",
    };

    const res = await handleHooks(db, buildHookRequest(payload));
    expect(res.status).toBe(200);

    const sessionRows = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(sessionRows).toHaveLength(1);
    expect(sessionRows[0]!.status).toBe("active");
    expect(sessionRows[0]!.cwd).toBe("/home/nyaptor/dev/nx");
    expect(sessionRows[0]!.branch).toBe("main");
    expect(sessionRows[0]!.ccSessionId).toBe("cc-abc");

    const eventRows = await db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, sessionId));
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0]!.eventType).toBe("session_start");
  });

  // ─── 2. session_summary with cost_usd ───────────────────────────────────

  it("session_summary with cost_usd updates sessions.total_cost_usd", async () => {
    const sessionId = "sess-summary-cost-1";

    // Seed via session_start.
    await handleHooks(
      db,
      buildHookRequest({
        hook_event_name: "session_start",
        session_id: sessionId,
        model: "claude-opus-4-7",
      }),
    );

    const res = await handleHooks(
      db,
      buildHookRequest({
        hook_event_name: "session_summary",
        session_id: sessionId,
        cost_usd: 1.2345,
      }),
    );
    expect(res.status).toBe(200);

    const rows = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.totalCostUsd).toBeCloseTo(1.2345, 5);
  });

  // ─── 3. session_summary computed cost from tokens+model ─────────────────

  it("session_summary without cost_usd computes cost from tokens + model", async () => {
    const sessionId = "sess-summary-compute-1";
    const model = "claude-opus-4-7";
    const tokens = {
      input_tokens: 10_000,
      output_tokens: 2_000,
      cache_read_input_tokens: 50_000,
      cache_creation_input_tokens: 1_000,
    };

    await handleHooks(
      db,
      buildHookRequest({
        hook_event_name: "session_start",
        session_id: sessionId,
        model,
      }),
    );

    const res = await handleHooks(
      db,
      buildHookRequest({
        hook_event_name: "session_summary",
        session_id: sessionId,
        model,
        ...tokens,
      }),
    );
    expect(res.status).toBe(200);

    const expected = computeCostUsd(model, {
      input: tokens.input_tokens,
      output: tokens.output_tokens,
      cacheRead: tokens.cache_read_input_tokens,
      cacheCreation: tokens.cache_creation_input_tokens,
    });

    const rows = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.totalCostUsd).not.toBeNull();
    expect(rows[0]!.totalCostUsd!).toBeCloseTo(expected, 8);
  });

  // ─── 4. session_stop ────────────────────────────────────────────────────

  it("session_stop sets ended_at and status='ended'", async () => {
    const sessionId = "sess-stop-1";

    await handleHooks(
      db,
      buildHookRequest({
        hook_event_name: "session_start",
        session_id: sessionId,
      }),
    );

    const res = await handleHooks(
      db,
      buildHookRequest({
        hook_event_name: "session_stop",
        session_id: sessionId,
      }),
    );
    expect(res.status).toBe(200);

    const rows = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("ended");
    expect(rows[0]!.endedAt).not.toBeNull();
  });

  // ─── 5. stop_failure ────────────────────────────────────────────────────

  it("stop_failure marks session status='errored' and persists stop_reason in event metadata", async () => {
    const sessionId = "sess-fail-1";

    await handleHooks(
      db,
      buildHookRequest({
        hook_event_name: "session_start",
        session_id: sessionId,
      }),
    );

    const res = await handleHooks(
      db,
      buildHookRequest({
        hook_event_name: "stop_failure",
        session_id: sessionId,
        stop_reason: "api_error",
      }),
    );
    expect(res.status).toBe(200);

    const sessionRows = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(sessionRows).toHaveLength(1);
    expect(sessionRows[0]!.status).toBe("errored");
    expect(sessionRows[0]!.endedAt).not.toBeNull();

    const eventRows = await db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, sessionId));
    const failureEvent = eventRows.find((r) => r.eventType === "stop_failure");
    expect(failureEvent).toBeDefined();
    expect(failureEvent!.metadata).toBeTruthy();
    const meta = JSON.parse(failureEvent!.metadata!) as {
      stop_reason?: string;
    };
    expect(meta.stop_reason).toBe("api_error");
  });

  // ─── 6. diagnostic_ping smoke test (task 3.2) ───────────────────────────

  it("diagnostic_ping persists an event row end-to-end without manual session pre-creation", async () => {
    const sessionId = "sess-ping-1";

    const res = await handleHooks(
      db,
      buildHookRequest({
        hook_event_name: "diagnostic_ping",
        session_id: sessionId,
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; event_id?: number };
    expect(body.status).toBe("ok");
    expect(typeof body.event_id).toBe("number");
    expect(body.event_id!).toBeGreaterThan(0);

    const eventRows = await db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, sessionId));
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0]!.eventType).toBe("diagnostic_ping");

    // Stub session row was auto-created so the FK is satisfied.
    const sessionRows = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(sessionRows).toHaveLength(1);
  });
});
