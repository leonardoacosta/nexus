/**
 * Integration test (session-enrichment, nx-8s85n): the full
 * socket dispatcher -> processHookEvent spine -> DB -> read-back path.
 *
 * The three sibling suites cover slices of this path with the DB faked out:
 *   - db/agent-state.test.ts       — pure `deriveAgentState` mapping (no DB).
 *   - process-hook-event.test.ts   — asserts `updateSessionAgentState` is
 *                                    CALLED with the right args (writer mocked,
 *                                    never hits a real DB nor reads back).
 *   - socket-server.test.ts /
 *     dispatcher.test.ts           — drive the dispatcher with a MOCK
 *                                    SessionManager and no real DB, so the
 *                                    persisted `agentState` is never asserted.
 *
 * NONE of them exercise the live persistence + read-back: a hook event entering
 * `createSocketEventDispatcher` and the resulting `agent_state` column being
 * read back out of a real Postgres row. This suite closes that gap by driving a
 * full transition sequence (heartbeat -> blocked, notification -> waiting,
 * stop -> ready) through the real dispatcher against a scratch Postgres schema,
 * asserting the persisted column after each step.
 *
 * Isolation: scratch-schema pattern (db.test.ts § 7.2 / reaper-persistence) —
 * a unique schema under POSTGRES_URL holds the `sessions` +
 * `hook_schema_fingerprints` tables (the dispatcher fires schema-drift on
 * session_start, so that table must exist for a clean run), pinned via
 * `connection.search_path`, dropped in teardown. PG-gated: skips when
 * POSTGRES_URL is unset.
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { createDb } from "@nexus/db";
import type { Db } from "@nexus/db";
import type { WatcherEvent, Session } from "@nexus/core";
import { createSocketEventDispatcher } from "./dispatcher";
import { LifecycleBus } from "../lifecycle-bus";
import type { SocketEvent } from "../../types/socket-events";
import type { SessionManager } from "../../session-manager";
import { insertSession, getSessionById } from "../../db/sessions";
import type { SessionRow } from "../../db/sessions";

type Sql = ReturnType<typeof createDb>["client"];

import { hasLivePg as hasPg } from "../../testing/live-pg";

const SCHEMA = `nx_dispatch_astate_${Date.now()}_${Math.floor(
  Math.random() * 1e6,
)}`;

// Minimal DDL for the two tables this path touches. The `sessions` block
// mirrors packages/db/src/schema/sessions.ts (kept in lockstep with the
// db.test.ts § 7.2 DDL); `hook_schema_fingerprints` mirrors
// packages/db/src/schema/hookSchemaFingerprints.ts.
const DDL = `
  CREATE TABLE "sessions" (
    "id" text PRIMARY KEY NOT NULL,
    "project_id" uuid,
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
    "rate_limit_utilization" real,    "rate_limit_reset_at" timestamp,
    "idle_since" timestamp,
    "stop_reason" text,
    "error_details" text,
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

  CREATE TABLE "hook_schema_fingerprints" (
    "event_type" text NOT NULL,
    "fingerprint" text NOT NULL,
    "first_seen" timestamp DEFAULT now() NOT NULL,
    "last_seen" timestamp DEFAULT now() NOT NULL
  );
  CREATE UNIQUE INDEX "hook_schema_fingerprints_event_fp_uidx"
    ON "hook_schema_fingerprints" ("event_type", "fingerprint");
  CREATE INDEX "hook_schema_fingerprints_event_idx"
    ON "hook_schema_fingerprints" ("event_type");
`;

/**
 * Minimal real SessionManager seam. The dispatcher only invokes
 * `handleWatcherEvent` / `updateLinkage` on the agent-state path — both are
 * no-ops here. Agent-state persistence happens entirely via the shared
 * `processHookEvent` -> `updateSessionAgentState` DB writer, NOT through the
 * session manager, so a stub is faithful for this assertion.
 */
function createStubSessionManager(): SessionManager {
  return {
    handleWatcherEvent: (_e: WatcherEvent) => {},
    getAll: () => [],
    getActive: () => [],
    getById: () => null as Session | null,
    sweepIdle: () => {},
    stop: () => {},
    init: async () => {},
    updateLinkage: () => {},
    patch: () => {},
  } as unknown as SessionManager;
}

/** Seed a session row with agent_state initially null (no hook observed yet). */
function makeSeedRow(id: string): SessionRow {
  const now = new Date();
  return {
    id,
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
    rateLimitUtilization: null,    rateLimitResetAt: null,
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
  };
}

describe.skipIf(!hasPg)(
  "dispatcher -> DB agent_state read-back (requires live PG)",
  () => {
    let adminClient: Sql;
    let scopedClient: Sql;
    let db: Db;
    let dispatch: (event: SocketEvent) => void;

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

      // Real dispatcher wired with the real scoped DB. The lifecycle bus and
      // session manager are local/stub — the assertion is on the DB column.
      dispatch = createSocketEventDispatcher({
        sessionManager: createStubSessionManager(),
        lifecycleBus: new LifecycleBus(),
        db,
      });
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

    /**
     * The dispatcher's agent-state persist is fire-and-forget (it returns
     * synchronously and `.catch()`-es the async helper). Read-back must wait
     * for the microtask + DB round-trip to settle. Mirrors the
     * `await Bun.sleep(20)` drain convention in socket-server.test.ts; we use a
     * short poll so a slow round-trip doesn't flake.
     */
    async function readAgentStateWhenSettled(
      sessionId: string,
      expected: string,
    ): Promise<string | null> {
      for (let attempt = 0; attempt < 25; attempt++) {
        const row = await getSessionById(db, sessionId);
        if (row?.agentState === expected) return row.agentState;
        await Bun.sleep(20);
      }
      const row = await getSessionById(db, sessionId);
      return row?.agentState ?? null;
    }

    it("persists the full blocked -> waiting -> ready transition sequence read back from the DB", async () => {
      const sessionId = "sess-astate-seq";
      await insertSession(db, makeSeedRow(sessionId));

      // Sanity: the seeded row starts with no agent-state signal.
      const seeded = await getSessionById(db, sessionId);
      expect(seeded).not.toBeNull();
      expect(seeded!.agentState).toBeNull();

      // 1. A mid-turn tool hook reaches the agent as a heartbeat -> blocked.
      dispatch({ event: "session_heartbeat", session_id: sessionId });
      expect(await readAgentStateWhenSettled(sessionId, "blocked")).toBe(
        "blocked",
      );

      // 2. A session-scoped notification means awaiting user input -> waiting.
      dispatch({
        event: "notification",
        session_id: sessionId,
        message: "Permission required to run Bash",
      } as unknown as SocketEvent);
      expect(await readAgentStateWhenSettled(sessionId, "waiting")).toBe(
        "waiting",
      );

      // 3. Stop -> ready (turn ended, awaiting next prompt).
      dispatch({ event: "session_stop", session_id: sessionId });
      expect(await readAgentStateWhenSettled(sessionId, "ready")).toBe("ready");
    });

    it("persists stop_reason + error_details on a crash session_stop (nx-f060f)", async () => {
      const sessionId = "sess-stop-reason";
      await insertSession(db, makeSeedRow(sessionId));

      // A crash stop carries the reason + captured error text on the wire.
      dispatch({
        event: "session_stop",
        session_id: sessionId,
        stop_reason: "api_error",
        error_details: "API Error: 529 Overloaded",
      });

      // recordSessionStop is fire-and-forget — poll for the columns to settle.
      let row: SessionRow | null = null;
      for (let attempt = 0; attempt < 25; attempt++) {
        row = await getSessionById(db, sessionId);
        if (row?.stopReason === "api_error") break;
        await Bun.sleep(20);
      }
      expect(row).not.toBeNull();
      expect(row!.stopReason).toBe("api_error");
      expect(row!.errorDetails).toBe("API Error: 529 Overloaded");
      // ended_at is stamped by recordSessionStop.
      expect(row!.endedAt).not.toBeNull();
    });

    it("a project-level notification with no session_id does not clobber a prior state", async () => {
      const sessionId = "sess-astate-no-clobber";
      await insertSession(db, makeSeedRow(sessionId));

      // Drive the session to `blocked` first.
      dispatch({ event: "session_heartbeat", session_id: sessionId });
      expect(await readAgentStateWhenSettled(sessionId, "blocked")).toBe(
        "blocked",
      );

      // A project-scoped notification carries no per-session signal — the
      // dispatcher's sessionId guard skips the persist, so the existing
      // `blocked` state must survive. Give any errant async write time to land
      // before asserting the state is unchanged.
      dispatch({
        event: "notification",
        message: "Build finished for nova",
        project: "nova",
      } as unknown as SocketEvent);
      await Bun.sleep(80);

      const after = await getSessionById(db, sessionId);
      expect(after!.agentState).toBe("blocked");
    });
  },
);
