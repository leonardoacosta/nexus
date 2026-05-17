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
  afterEach,
} from "bun:test";
import { createDb, sessions, sessionEvents, eq } from "@nexus/db";
import type { Db } from "@nexus/db";

import { handleHooks } from "./hooks";
import { computeCostUsd } from "../services/cost-calculator";
import {
  lifecycleBus,
  type LifecycleEnvelope,
} from "../services/lifecycle-bus";
import { hookEventThrottle } from "../services/hook-event-throttle";
import {
  initNotificationRoutes,
  resetNotificationRoutes,
} from "./notifications";
import { _clearSuppressionForTests } from "../notifications/hook-trigger";

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

  CREATE TABLE "notifications" (
    "id" text PRIMARY KEY NOT NULL,
    "channel" text NOT NULL,
    "title" text NOT NULL,
    "body" text NOT NULL,
    "project" text,
    "agent_id" text REFERENCES "agents"("id") ON DELETE SET NULL,
    "priority" text DEFAULT 'normal' NOT NULL,
    "status" text DEFAULT 'queued' NOT NULL,
    "created_at" timestamp NOT NULL,
    "sent_at" timestamp
  );

  CREATE TABLE "notification_settings" (
    "id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
    "tts_enabled" boolean DEFAULT true NOT NULL,
    "banner_enabled" boolean DEFAULT true NOT NULL,
    "ducking_mode" text DEFAULT 'full' NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );

  INSERT INTO "notification_settings" ("id", "tts_enabled", "banner_enabled", "ducking_mode")
    VALUES (1, true, true, 'full') ON CONFLICT ("id") DO NOTHING;
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

  // ─── 6. diagnostic_ping smoke test (task 3.2 / fix-agent 4.1) ───────────

  it("diagnostic_ping for a pre-seeded session persists an event row (no orphan drop)", async () => {
    // Per fix-agent-cc-session-tracking task 2.3 / 4.1: the handler MUST
    // NOT synthesize a stub session row for non-session_start events. We
    // now pre-seed via session_start so the event row can be appended.
    const sessionId = "sess-ping-1";

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
    const pingRows = eventRows.filter((r) => r.eventType === "diagnostic_ping");
    expect(pingRows).toHaveLength(1);

    // Parent row exists because session_start created it (NOT auto-stubbed
    // by the diagnostic_ping handler).
    const sessionRows = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(sessionRows).toHaveLength(1);
  });

  // ─── 6b. Orphan-drop coverage (fix-agent-cc-session-tracking 4.1) ──────

  describe("Orphan-event drop (fix-agent-cc-session-tracking 4.1)", () => {
    it("hook event for an unknown sessionId returns 204 and writes no rows", async () => {
      const sessionId = "definitely-not-in-db";

      // Snapshot row counts so we can prove nothing was written.
      const sessionsBefore = await db.select().from(sessions);
      const eventsBefore = await db.select().from(sessionEvents);

      const res = await handleHooks(
        db,
        buildHookRequest({
          hook_event_name: "diagnostic_ping",
          session_id: sessionId,
        }),
      );

      // Per spec scenario "Hook event without matching session is dropped":
      //   - 204 No Content (no body)
      //   - no new session row inserted
      //   - no new session_events row inserted
      expect(res.status).toBe(204);

      const sessionsAfter = await db.select().from(sessions);
      const eventsAfter = await db.select().from(sessionEvents);
      expect(sessionsAfter.length).toBe(sessionsBefore.length);
      expect(eventsAfter.length).toBe(eventsBefore.length);

      // Targeted assertion: no row with the orphan id exists.
      const orphanSession = sessionsAfter.find((s) => s.id === sessionId);
      expect(orphanSession).toBeUndefined();
      const orphanEvents = eventsAfter.filter((e) => e.sessionId === sessionId);
      expect(orphanEvents).toHaveLength(0);
    });

    it("hook event for a KNOWN sessionId still records the event (no false orphan)", async () => {
      const sessionId = "sess-known-after-seed";

      // Seed via session_start.
      await handleHooks(
        db,
        buildHookRequest({
          hook_event_name: "session_start",
          session_id: sessionId,
        }),
      );

      // Snapshot the event count for THIS session after the seed.
      const eventsBefore = await db
        .select()
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionId, sessionId));

      const res = await handleHooks(
        db,
        buildHookRequest({
          hook_event_name: "diagnostic_ping",
          session_id: sessionId,
        }),
      );
      expect(res.status).toBe(200);

      const eventsAfter = await db
        .select()
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionId, sessionId));
      // session_start was the only prior event → +1 row for diagnostic_ping.
      expect(eventsAfter.length).toBe(eventsBefore.length + 1);
      expect(
        eventsAfter.some((r) => r.eventType === "diagnostic_ping"),
      ).toBe(true);
    });

    it("returns 204 for orphan events across multiple event types", async () => {
      const cases = [
        "post_compact",
        "heartbeat",
        "tool_use_end",
        "agent_telemetry",
        "command_start",
        "notification",
      ];

      for (const eventName of cases) {
        const sessionId = `orphan-${eventName}-${Math.random()
          .toString(36)
          .slice(2, 8)}`;

        const res = await handleHooks(
          db,
          buildHookRequest({
            hook_event_name: eventName,
            session_id: sessionId,
          }),
        );
        expect(res.status).toBe(204);

        const orphan = await db
          .select()
          .from(sessions)
          .where(eq(sessions.id, sessionId));
        expect(orphan).toHaveLength(0);

        const events = await db
          .select()
          .from(sessionEvents)
          .where(eq(sessionEvents.sessionId, sessionId));
        expect(events).toHaveLength(0);
      }
    });
  });

  // ─── 7. Lifecycle event family (task 3.1) ───────────────────────────────

  describe("Lifecycle events (extend-hooks-event-taxonomy 3.1)", () => {
    it("session_terminate finalizes a still-active session (status='ended', endedAt set)", async () => {
      const sessionId = "sess-terminate-1";

      // Seed via session_start so the parent row is active.
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
          hook_event_name: "session_terminate",
          session_id: sessionId,
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; message: string };
      expect(body.status).toBe("ok");
      expect(body.message).toContain("session_terminate acknowledged");

      const sessionRows = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, sessionId));
      expect(sessionRows).toHaveLength(1);
      expect(sessionRows[0]!.status).toBe("ended");
      expect(sessionRows[0]!.endedAt).not.toBeNull();

      const eventRows = await db
        .select()
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionId, sessionId));
      const terminate = eventRows.find(
        (r) => r.eventType === "session_terminate",
      );
      expect(terminate).toBeDefined();
    });

    it("post_compact persists with compaction_count preserved in metadata", async () => {
      const sessionId = "sess-postcompact-1";

      // Seed the parent row — orphan drops are tested separately.
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
          hook_event_name: "post_compact",
          session_id: sessionId,
          compaction_count: 3,
        }),
      );
      expect(res.status).toBe(200);

      const eventRows = await db
        .select()
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionId, sessionId));
      const postCompact = eventRows.find((r) => r.eventType === "post_compact");
      expect(postCompact).toBeDefined();
      expect(postCompact!.metadata).toBeTruthy();
      const meta = JSON.parse(postCompact!.metadata!) as {
        compaction_count?: number;
      };
      expect(meta.compaction_count).toBe(3);
    });

    it("repeated post_compact appends one row per event (no upsert)", async () => {
      const sessionId = "sess-postcompact-2";

      await handleHooks(
        db,
        buildHookRequest({
          hook_event_name: "session_start",
          session_id: sessionId,
        }),
      );

      for (const count of [1, 2, 3]) {
        const res = await handleHooks(
          db,
          buildHookRequest({
            hook_event_name: "post_compact",
            session_id: sessionId,
            compaction_count: count,
          }),
        );
        expect(res.status).toBe(200);
      }

      const eventRows = await db
        .select()
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionId, sessionId));
      const postCompacts = eventRows.filter(
        (r) => r.eventType === "post_compact",
      );
      expect(postCompacts).toHaveLength(3);
    });

    it("pre_compact persists an event row", async () => {
      const sessionId = "sess-precompact-1";

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
          hook_event_name: "pre_compact",
          session_id: sessionId,
        }),
      );
      expect(res.status).toBe(200);

      const eventRows = await db
        .select()
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionId, sessionId));
      expect(
        eventRows.some((r) => r.eventType === "pre_compact"),
      ).toBe(true);
    });

    it("heartbeat (singular) persists despite legacy session_heartbeat name divergence", async () => {
      const sessionId = "sess-heartbeat-1";

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
          hook_event_name: "heartbeat",
          session_id: sessionId,
        }),
      );
      expect(res.status).toBe(200);

      const eventRows = await db
        .select()
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionId, sessionId));
      expect(
        eventRows.some((r) => r.eventType === "heartbeat"),
      ).toBe(true);
    });
  });

  // ─── 8. Agent-Lifecycle event family (task 3.2) ─────────────────────────

  describe("Agent-Lifecycle events (extend-hooks-event-taxonomy 3.2)", () => {
    it("agent_spawn persists with full audit fields in metadata", async () => {
      const sessionId = "sess-agentspawn-1";

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
          hook_event_name: "agent_spawn",
          session_id: sessionId,
          agent_type: "ui-engineer",
          agent_name: "ui-engineer-abc",
          parent_agent: "orchestrator",
          child_role: "engineer",
          model: "claude-sonnet-4-5",
        }),
      );
      expect(res.status).toBe(200);

      const eventRows = await db
        .select()
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionId, sessionId));
      const spawnRow = eventRows.find((r) => r.eventType === "agent_spawn");
      expect(spawnRow).toBeDefined();
      const meta = JSON.parse(spawnRow!.metadata!) as {
        agent_type?: string;
        agent_name?: string;
        parent_agent?: string;
        child_role?: string;
        model?: string;
      };
      expect(meta.agent_type).toBe("ui-engineer");
      expect(meta.agent_name).toBe("ui-engineer-abc");
      expect(meta.parent_agent).toBe("orchestrator");
      expect(meta.child_role).toBe("engineer");
      expect(meta.model).toBe("claude-sonnet-4-5");
    });

    it("agent_complete persists deregistration row", async () => {
      const sessionId = "sess-agentcomplete-1";

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
          hook_event_name: "agent_complete",
          session_id: sessionId,
          agent_type: "ui-engineer",
        }),
      );
      expect(res.status).toBe(200);

      const eventRows = await db
        .select()
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionId, sessionId));
      expect(
        eventRows.some((r) => r.eventType === "agent_complete"),
      ).toBe(true);
    });

    it("agent_telemetry persists token + duration + spec/wave/phase metrics", async () => {
      const sessionId = "sess-agenttelem-1";

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
          hook_event_name: "agent_telemetry",
          session_id: sessionId,
          agent_name: "ui-engineer-abc",
          spec: "extend-hooks-event-taxonomy",
          wave: "2",
          phase: "apply",
          model: "claude-sonnet-4-5",
          total_tokens: 12450,
          tool_uses: 8,
          duration_ms: 23000,
          status: "success",
        }),
      );
      expect(res.status).toBe(200);

      const eventRows = await db
        .select()
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionId, sessionId));
      const telemRow = eventRows.find((r) => r.eventType === "agent_telemetry");
      expect(telemRow).toBeDefined();
      const meta = JSON.parse(telemRow!.metadata!) as {
        total_tokens?: number;
        tool_uses?: number;
        duration_ms?: number;
        phase?: string;
        wave?: string;
        spec?: string;
      };
      expect(meta.total_tokens).toBe(12450);
      expect(meta.tool_uses).toBe(8);
      expect(meta.duration_ms).toBe(23000);
      expect(meta.phase).toBe("apply");
      expect(meta.wave).toBe("2");
      expect(meta.spec).toBe("extend-hooks-event-taxonomy");
    });
  });

  // ─── 9. Tool-Use event family (task 3.3) ────────────────────────────────

  describe("Tool-Use events (extend-hooks-event-taxonomy 3.3)", () => {
    it("tool_use_end persists with tool name and duration in metadata", async () => {
      const sessionId = "sess-tooluseend-1";

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
          hook_event_name: "tool_use_end",
          session_id: sessionId,
          tool: "Edit",
          success: true,
          duration_ms: 1200,
        }),
      );
      expect(res.status).toBe(200);

      const eventRows = await db
        .select()
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionId, sessionId));
      const toolEndRow = eventRows.find((r) => r.eventType === "tool_use_end");
      expect(toolEndRow).toBeDefined();
      const meta = JSON.parse(toolEndRow!.metadata!) as {
        tool?: string;
        duration_ms?: number;
      };
      expect(meta.tool).toBe("Edit");
      expect(meta.duration_ms).toBe(1200);
    });

    it("tool_use_fail preserves tool, error, command, duration_ms verbatim", async () => {
      const sessionId = "sess-toolusefail-1";

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
          hook_event_name: "tool_use_fail",
          session_id: sessionId,
          tool: "Bash",
          error: "permission denied",
          command: "git push",
          duration_ms: 80,
        }),
      );
      expect(res.status).toBe(200);

      const eventRows = await db
        .select()
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionId, sessionId));
      const failRow = eventRows.find((r) => r.eventType === "tool_use_fail");
      expect(failRow).toBeDefined();
      const meta = JSON.parse(failRow!.metadata!) as {
        tool?: string;
        error?: string;
        command?: string;
        duration_ms?: number;
      };
      expect(meta.tool).toBe("Bash");
      expect(meta.error).toBe("permission denied");
      expect(meta.command).toBe("git push");
      expect(meta.duration_ms).toBe(80);
    });
  });

  // ─── 10. Command event family (task 3.4) ────────────────────────────────

  describe("Command events (extend-hooks-event-taxonomy 3.4)", () => {
    it("command_start persists run_id for downstream join", async () => {
      const sessionId = "sess-commandstart-1";

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
          hook_event_name: "command_start",
          session_id: sessionId,
          run_id: "run-abc",
          command: "/apply:all",
          project: "nx",
        }),
      );
      expect(res.status).toBe(200);

      const eventRows = await db
        .select()
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionId, sessionId));
      const cmdStart = eventRows.find((r) => r.eventType === "command_start");
      expect(cmdStart).toBeDefined();
      const meta = JSON.parse(cmdStart!.metadata!) as {
        run_id?: string;
        command?: string;
      };
      expect(meta.run_id).toBe("run-abc");
      expect(meta.command).toBe("/apply:all");
    });

    it("command_end persists status and duration_ms", async () => {
      const sessionId = "sess-commandend-1";

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
          hook_event_name: "command_end",
          session_id: sessionId,
          run_id: "run-abc",
          command: "/apply:all",
          status: "success",
          duration_ms: 540000,
          agent_count: 3,
          total_tokens: 87654,
        }),
      );
      expect(res.status).toBe(200);

      const eventRows = await db
        .select()
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionId, sessionId));
      const cmdEnd = eventRows.find((r) => r.eventType === "command_end");
      expect(cmdEnd).toBeDefined();
      const meta = JSON.parse(cmdEnd!.metadata!) as {
        status?: string;
        duration_ms?: number;
      };
      expect(meta.status).toBe("success");
      expect(meta.duration_ms).toBe(540000);
    });

    it("user_prompt persists row with event_type='user_prompt'", async () => {
      const sessionId = "sess-userprompt-1";

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
          hook_event_name: "user_prompt",
          session_id: sessionId,
          project: "nx",
        }),
      );
      expect(res.status).toBe(200);

      const eventRows = await db
        .select()
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionId, sessionId));
      expect(
        eventRows.some((r) => r.eventType === "user_prompt"),
      ).toBe(true);
    });
  });

  // ─── 11. Operational event family (task 3.5) ────────────────────────────

  describe("Operational events (extend-hooks-event-taxonomy 3.5)", () => {
    // Each operational event:
    //  (a) returns HTTP 200 with `${event} acknowledged`
    //  (b) writes exactly one session_events row with the right event_type
    //  (c) does NOT mutate the parent sessions row
    //
    // We seed each test with session_start and capture the post-seed
    // sessions snapshot so we can assert no mutation after the operational
    // event.

    const OPERATIONAL_EVENTS = [
      "permission_request",
      "teammate_idle",
      "task_completed",
      "instructions_loaded",
      "config_change",
      "worktree_create",
      "worktree_remove",
      "notification",
      "hook_failure",
    ] as const;

    for (const eventName of OPERATIONAL_EVENTS) {
      it(`${eventName} writes one event row and does NOT mutate sessions`, async () => {
        const sessionId = `sess-op-${eventName}`;

        // Seed the parent row so we can later assert non-mutation.
        await handleHooks(
          db,
          buildHookRequest({
            hook_event_name: "session_start",
            session_id: sessionId,
          }),
        );

        const before = await db
          .select()
          .from(sessions)
          .where(eq(sessions.id, sessionId));
        expect(before).toHaveLength(1);
        const beforeStatus = before[0]!.status;
        const beforeEndedAt = before[0]!.endedAt;

        const res = await handleHooks(
          db,
          buildHookRequest({
            hook_event_name: eventName,
            session_id: sessionId,
            // Sprinkle a typical payload field so metadata is non-trivial.
            tool: eventName === "permission_request" ? "Bash" : undefined,
            handler:
              eventName === "hook_failure" ? "handle_session_stop" : undefined,
          }),
        );
        expect(res.status).toBe(200);

        const eventRows = await db
          .select()
          .from(sessionEvents)
          .where(eq(sessionEvents.sessionId, sessionId));
        const ourRows = eventRows.filter((r) => r.eventType === eventName);
        expect(ourRows).toHaveLength(1);

        // Parent sessions row must NOT have been mutated by an
        // operational event. status and endedAt should match the
        // post-session_start snapshot.
        const after = await db
          .select()
          .from(sessions)
          .where(eq(sessions.id, sessionId));
        expect(after).toHaveLength(1);
        expect(after[0]!.status).toBe(beforeStatus);
        expect(after[0]!.endedAt).toBe(beforeEndedAt);
      });
    }

    it("permission_request preserves tool name in metadata", async () => {
      const sessionId = "sess-op-permreq-meta";

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
          hook_event_name: "permission_request",
          session_id: sessionId,
          tool: "Bash",
        }),
      );
      expect(res.status).toBe(200);

      const eventRows = await db
        .select()
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionId, sessionId));
      const row = eventRows.find((r) => r.eventType === "permission_request");
      expect(row).toBeDefined();
      const meta = JSON.parse(row!.metadata!) as { tool?: string };
      expect(meta.tool).toBe("Bash");
    });

    it("hook_failure preserves handler / exit_code / stderr in metadata", async () => {
      const sessionId = "sess-op-hookfail-meta";

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
          hook_event_name: "hook_failure",
          session_id: sessionId,
          handler: "handle_session_stop",
          event: "session_stop",
          exit_code: 1,
          stderr: "stats jq write failed",
        }),
      );
      expect(res.status).toBe(200);

      const eventRows = await db
        .select()
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionId, sessionId));
      const row = eventRows.find((r) => r.eventType === "hook_failure");
      expect(row).toBeDefined();
      const meta = JSON.parse(row!.metadata!) as {
        handler?: string;
        exit_code?: number;
        stderr?: string;
      };
      expect(meta.handler).toBe("handle_session_stop");
      expect(meta.exit_code).toBe(1);
      expect(meta.stderr).toBe("stats jq write failed");
    });
  });

  // ─── 12. Backward-compat: unknown future event (task 3.6) ───────────────

  describe("Backward-compat — unrecognized future event (extend-hooks-event-taxonomy 3.6)", () => {
    it("unknown event_type returns HTTP 200 with 'unknown event:' message and writes NO session_events row", async () => {
      const sessionId = "sess-future-1";

      // Pre-seed parent row so a missing session_events row can't be
      // explained by FK protection — we want to prove the handler chose
      // not to write, not that it couldn't.
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
          hook_event_name: "future_event_type_not_yet_invented",
          session_id: sessionId,
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; message: string };
      expect(body.status).toBe("ok");
      expect(body.message).toContain("unknown event:");
      expect(body.message).toContain("future_event_type_not_yet_invented");

      const eventRows = await db
        .select()
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionId, sessionId));
      const futureRows = eventRows.filter(
        (r) => r.eventType === "future_event_type_not_yet_invented",
      );
      expect(futureRows).toHaveLength(0);
    });
  });

  // ─── 13. Lifecycle-bus fan-out (add-hooks-sse-fanout 1.6) ───────────────

  describe("Lifecycle-bus emission (add-hooks-sse-fanout 1.6)", () => {
    let captured: LifecycleEnvelope<"HookEventReceived">[];
    let handler: (env: LifecycleEnvelope<"HookEventReceived">) => void;

    beforeEach(() => {
      // Drop any pending throttle state from a previous test so single
      // emits don't interleave with leftover bursts.
      hookEventThrottle.clear();
      captured = [];
      handler = (env) => captured.push(env);
      lifecycleBus.on("HookEventReceived", handler);
    });

    afterEach(() => {
      lifecycleBus.off("HookEventReceived", handler);
      hookEventThrottle.clear();
    });

    it("session_start (lifecycle, non-throttled) emits HookEventReceived immediately", async () => {
      const sessionId = "sess-emit-start-1";

      const res = await handleHooks(
        db,
        buildHookRequest({
          hook_event_name: "session_start",
          session_id: sessionId,
          project: "nx",
        }),
      );
      expect(res.status).toBe(200);

      // Lifecycle events bypass the throttle — emission is sync, so it
      // already fired by the time handleHooks returned.
      expect(captured).toHaveLength(1);
      const env = captured[0]!;
      expect(env.event).toBe("HookEventReceived");
      expect(env.payload.eventType).toBe("session_start");
      expect(env.payload.sessionId).toBe(sessionId);
      expect(env.payload.project).toBe("nx");
      expect(typeof env.payload.eventId).toBe("number");
      expect(env.payload.eventId).toBeGreaterThan(0);
      // Lifecycle events have no count field.
      expect(env.payload.count).toBeUndefined();
    });

    it("notification event emits with project field omitted when payload lacks it", async () => {
      const sessionId = "sess-emit-noproject-1";

      // Seed parent — orphan-drop is tested separately and would suppress
      // emission since the handler returns 204 without ever broadcasting.
      await handleHooks(
        db,
        buildHookRequest({
          hook_event_name: "session_start",
          session_id: sessionId,
        }),
      );
      // session_start fires its own emit; drop that so we count just the
      // notification under test.
      captured.length = 0;

      const res = await handleHooks(
        db,
        buildHookRequest({
          hook_event_name: "notification",
          session_id: sessionId,
        }),
      );
      expect(res.status).toBe(200);
      expect(captured).toHaveLength(1);
      expect(captured[0]!.payload.eventType).toBe("notification");
      expect(captured[0]!.payload.project).toBeUndefined();
    });

    it("unknown (unrecognized) event suppresses emit (no persistence, no broadcast)", async () => {
      const sessionId = "sess-emit-unknown-1";

      // Pre-seed parent row so FK isn't the reason for missing event row.
      await handleHooks(
        db,
        buildHookRequest({
          hook_event_name: "session_start",
          session_id: sessionId,
        }),
      );
      captured.length = 0;

      const res = await handleHooks(
        db,
        buildHookRequest({
          hook_event_name: "future_unknown_thing",
          session_id: sessionId,
        }),
      );
      expect(res.status).toBe(200);
      expect(captured).toHaveLength(0);
    });

    it("burst of tool_use_end events coalesces to ≤1 emit within the throttle window", async () => {
      const sessionId = "sess-emit-throttle-1";

      // Seed parent row so the burst doesn't waste cycles on stub creation.
      await handleHooks(
        db,
        buildHookRequest({
          hook_event_name: "session_start",
          session_id: sessionId,
        }),
      );
      // Drop the session_start emit so we count only the burst.
      captured.length = 0;

      // Fire 10 tool_use_end events back-to-back.
      for (let i = 0; i < 10; i++) {
        await handleHooks(
          db,
          buildHookRequest({
            hook_event_name: "tool_use_end",
            session_id: sessionId,
            tool: "Edit",
            duration_ms: 50 + i,
          }),
        );
      }

      // No emit should have fired yet — buffer is still pending.
      expect(captured).toHaveLength(0);

      // Wait for the production 500ms throttle window to expire.
      await Bun.sleep(600);

      // Exactly one coalesced emit with count=10.
      expect(captured).toHaveLength(1);
      expect(captured[0]!.payload.eventType).toBe("tool_use_end");
      expect(captured[0]!.payload.sessionId).toBe(sessionId);
      expect(captured[0]!.payload.count).toBe(10);
    }, 5_000);
  });

  // ─── 12. Notification triggers (add-hooks-notification-triggers 2.7) ────

  describe("Notification triggers", () => {
    beforeAll(async () => {
      // Wire the singleton manager against the scoped test DB so handleHooks
      // can dispatch through the real NotificationManager.send() pipeline.
      await initNotificationRoutes(db);
    });

    afterAll(async () => {
      await resetNotificationRoutes();
    });

    beforeEach(async () => {
      // Each test starts with a clean suppression cache and an empty
      // notifications table so the row-count assertion is deterministic.
      _clearSuppressionForTests();
      await scopedClient.unsafe(`DELETE FROM "${SCHEMA}"."notifications"`);
    });

    it("tool_use_fail persists session_event AND a desktop row in notifications", async () => {
      const sessionId = "sess-trigger-tool-fail-1";

      // Seed parent so we don't rely on stub-creation paths in this test.
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
          hook_event_name: "tool_use_fail",
          session_id: sessionId,
          project: "nx",
          tool_name: "Bash",
          error_message: "permission denied",
        }),
      );
      // Hook handler MUST return 200 even when notification dispatch
      // misbehaves — the contract is fire-and-forget.
      expect(res.status).toBe(200);

      // 1. The session_events row landed.
      const eventRows = await db
        .select()
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionId, sessionId));
      expect(
        eventRows.some((r) => r.eventType === "tool_use_fail"),
      ).toBe(true);

      // 2. A desktop notification was inserted via the manager pipeline.
      //    We query the table directly via the scoped client (mirrors the
      //    runtime smoke verification step) rather than coupling to the
      //    Drizzle relational handle.
      const notifs = await scopedClient.unsafe<
        Array<{
          channel: string;
          title: string;
          body: string;
          project: string | null;
        }>
      >(
        `SELECT channel, title, body, project FROM "${SCHEMA}"."notifications" ORDER BY created_at ASC`,
      );

      const desktop = notifs.find((n) => n.channel === "desktop");
      expect(desktop).toBeDefined();
      expect(desktop!.title).toContain("Bash");
      expect(desktop!.body).toContain("permission denied");
      expect(desktop!.body.startsWith("nx: ")).toBe(true);
      expect(desktop!.project).toBe("nx");

      // Slack row no longer lands — remove-slack-channel dropped it from
      // the rule registry; the rule is now desktop-only.
      const slack = notifs.find((n) => n.channel === "slack");
      expect(slack).toBeUndefined();
    });
  });
});
