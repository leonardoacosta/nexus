/**
 * Integration test (wire-reactive-rate-limit-swap, task 4.2): the full
 * socket dispatcher -> reactive-swap detection -> performCredentialSwap ->
 * DB insert -> tmux auto-continue path, against a real scratch Postgres
 * schema (`credentials` + `credential_swaps`) and a stubbed 2-account
 * credential pool.
 *
 * Unlike the mocked-`performCredentialSwap` matrix in dispatcher.test.ts
 * (which pins the dispatcher's own branching logic), this suite drives the
 * REAL `performCredentialSwap` end to end: `findReactiveSwapCandidate`'s
 * actual SQL query runs against two real `credentials` rows, the swap
 * writes a real `credential_swaps` row, and `sendTextToSession` shells out
 * through a mocked `safeSpawn` (never a real `tmux` binary) — mirroring
 * `commands-send-text.test.ts`'s injected-spawn convention.
 *
 * `pool.manualSwap` itself is stubbed (not the real `CredentialPool` class):
 * the task calls for a "stubbed 2-account pool", and exercising
 * `pool-core.ts`'s own cooldown/lease machinery is out of scope here — that
 * surface has its own suite. Only `getActiveCredentialSnapshot` is spied
 * (there is no other seam to pin which of the two accounts is "active").
 *
 * Covers:
 *   - a "hit your limit" notification for a tracked session invokes
 *     `pool.manualSwap`, inserts a `credential_swaps` row, and sends
 *     `tmux send-keys ... continue Enter` for the session's real tmux target.
 *   - a second rate-limit hit for the SAME session inside the 180s debounce
 *     window sends only another "continue" — no second `manualSwap` call,
 *     no second `credential_swaps` row.
 *
 * PG-gated: skips cleanly when `POSTGRES_URL` is unset (hasLivePg), matching
 * every other `*.integration.test.ts` suite in this directory.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  spyOn,
} from "bun:test";
import { createDb, credentials, credentialSwaps, eq } from "@nexus/db";
import type { Db } from "@nexus/db";
import type { safeSpawn } from "@nexus/core/node";

import { createSocketEventDispatcher } from "./socket-server/dispatcher";
import { LifecycleBus } from "./lifecycle-bus";
import type { SocketEvent } from "../types/socket-events";
import type { SessionManager } from "../session-manager";
import type { CredentialPool } from "../credentials/pool";
import type { ManualSwapResult } from "../credentials/pool/types";
import { __resetDebounceForTests } from "./credential-swap-flow";
import * as credentialWatcherNs from "../credentials/credential-watcher";
import {
  initSendTextRoute,
  resetSendTextRoute,
} from "../routes/commands-send-text";
import { hasLivePg } from "../testing/live-pg";

type Sql = ReturnType<typeof createDb>["client"];

const SCHEMA = `nx_reactive_swap_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

// Mirrors packages/db/src/schema/credentials.ts + credentialSwaps.ts, PLUS
// the two tables the REST of the real dispatcher's "notification" case
// unconditionally touches as side effects (schema-drift + agent-state) —
// dispatching through the actual `createSocketEventDispatcher` (not just the
// reactive-swap branch) hits those paths too. Their absence doesn't fail the
// assertions this suite cares about (both writers catch and log
// non-fatally), but postgres.js was observed terminating the underlying
// connection when those unrelated queries hit an undefined relation
// concurrently with the credential_swaps insert — verified live: adding
// these two tables (DDL copied from
// `dispatcher-agent-state.integration.test.ts` / `dispatcher.test.ts`'s own
// live-PG fixtures) eliminated the `CONNECTION_ENDED` failure entirely. No FK
// on agent_id (the `agents` table is out of scope here) — same
// unenforced-FK convention `credential_swaps` itself documents for
// cross-table identity columns.
const DDL = `
  CREATE TABLE "sessions" (
    "id" text PRIMARY KEY NOT NULL,
    "project_id" uuid,
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

  CREATE TABLE "credentials" (
    "id" text PRIMARY KEY NOT NULL,
    "name" text NOT NULL,
    "type" text NOT NULL,
    "value_encrypted" text,
    "encryption_key_id" text DEFAULT 'v1',
    "agent_id" text,
    "status" text NOT NULL DEFAULT 'available',
    "leased_by" text,
    "leased_at" timestamptz,
    "cooldown_until" timestamptz,
    "rate_limit_count" integer NOT NULL DEFAULT 0,
    "fingerprint" text NOT NULL DEFAULT '',
    "duplicate_group_id" text,
    "is_primary" boolean NOT NULL DEFAULT false,
    "subscription_type" text,
    "rate_limit_tier" text,
    "expires_at" timestamptz,
    "account_email" text,
    "account_name" text,
    "account_uuid" text,
    "org_name" text,
    "org_uuid" text,
    "mcp_providers" text,
    "usage_5h_used" integer,
    "usage_5h_limit" integer,
    "usage_5h_reset_at" timestamptz,
    "usage_7d_used" integer,
    "usage_7d_limit" integer,
    "usage_7d_reset_at" timestamptz,
    "usage_polled_at" timestamptz,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE "credential_swaps" (
    "id" text PRIMARY KEY NOT NULL,
    "session_id" text NOT NULL,
    "from_fingerprint" text,
    "to_fingerprint" text NOT NULL,
    "reason" text NOT NULL,
    "created_at" timestamptz NOT NULL DEFAULT now()
  );
`;

const FP_A = "fp-integration-account-a";
const FP_B = "fp-integration-account-b";
const SESSION_ID = "sess-reactive-int-1";
const TMUX_TARGET = "nexus:cc-reactive-int-1";

interface SpawnCall {
  binary: string;
  args: readonly string[];
}

describe.skipIf(!hasLivePg)(
  "reactive rate-limit swap: dispatcher -> DB -> tmux (requires live PG)",
  () => {
    let adminClient: Sql;
    let scopedClient: Sql;
    let db: Db;
    let dispatch: (event: SocketEvent) => void;
    let manualSwapCalls: string[];
    let spawnCalls: SpawnCall[];
    let activeSnapshotSpy: ReturnType<
      typeof spyOn<typeof credentialWatcherNs, "getActiveCredentialSnapshot">
    >;

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

      // Two real primary/available credential rows — the "2-account pool"
      // findReactiveSwapCandidate's real SQL query selects from.
      await db.insert(credentials).values([
        {
          id: "cred-int-a",
          name: "Account A",
          type: "oauth",
          status: "available",
          isPrimary: true,
          fingerprint: FP_A,
        },
        {
          id: "cred-int-b",
          name: "Account B",
          type: "oauth",
          status: "available",
          isPrimary: true,
          fingerprint: FP_B,
        },
      ]);
    });

    afterAll(async () => {
      resetSendTextRoute();
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

    beforeEach(() => {
      __resetDebounceForTests();
      manualSwapCalls = [];
      spawnCalls = [];

      // Account A is "active" — the eligible candidate is always B.
      activeSnapshotSpy = spyOn(
        credentialWatcherNs,
        "getActiveCredentialSnapshot",
      ).mockReturnValue({
        fingerprint: FP_A,
        resolvedPath: null,
        observedAt: new Date().toISOString(),
      });

      const stubPool: Pick<CredentialPool, "manualSwap"> = {
        manualSwap: async (targetId: string) => {
          manualSwapCalls.push(targetId);
          return {
            parked: { id: "cred-int-a", fingerprint: FP_A, accountName: "Account A" },
            activated: { id: "cred-int-b", fingerprint: FP_B, accountName: "Account B" },
          } as unknown as ManualSwapResult;
        },
      };

      const sessionManager = {
        handleWatcherEvent: () => {},
        getAll: () => [],
        getActive: () => [],
        getById: (id: string) =>
          id === SESSION_ID
            ? ({ id, tmuxTarget: TMUX_TARGET } as unknown as ReturnType<
                SessionManager["getById"]
              >)
            : null,
        sweepIdle: () => {},
        stop: () => {},
        init: async () => {},
        updateLinkage: () => {},
        patch: () => {},
      } as unknown as SessionManager;

      const fakeSpawn = ((binary: string, args: string[]) => {
        spawnCalls.push({ binary, args: [...args] });
        return {
          pid: 999,
          stdin: undefined,
          stdout: undefined,
          stderr: undefined, // non-ReadableStream -> route reads "" per commands-send-text.ts
          exitCode: Promise.resolve(0),
          abort: async () => 0,
          kill: () => {},
        };
      }) as unknown as typeof safeSpawn;

      initSendTextRoute(sessionManager, fakeSpawn);

      dispatch = createSocketEventDispatcher({
        sessionManager,
        lifecycleBus: new LifecycleBus(),
        db,
        getCredentialPool: () => stubPool as unknown as CredentialPool,
      });
    });

    afterEach(() => {
      activeSnapshotSpy.mockRestore();
    });

    /**
     * Poll an in-memory predicate rather than a DB row count: within this
     * single test both dispatches target the SAME `SESSION_ID` (task 4.2's
     * "a second [hit for the] session inside 180s" scenario), so counting
     * `credential_swaps` rows can't distinguish "the first swap settled"
     * from "the first swap's row is still there" once the debounced second
     * dispatch has fired. `manualSwapCalls`/`spawnCalls` are synchronous,
     * per-test-local arrays — polling their length is race-free.
     */
    async function waitUntil(predicate: () => boolean): Promise<void> {
      for (let attempt = 0; attempt < 25; attempt++) {
        if (predicate()) return;
        await Bun.sleep(20);
      }
    }

    it("swaps the 2-account pool + writes credential_swaps on the first hit, then debounces a second hit within 180s to continue-only", async () => {
      // ── First hit: full reactive-swap flow ──────────────────────────────
      dispatch({
        event: "notification",
        message: "You hit your limit for this session",
        session_id: SESSION_ID,
      } as unknown as SocketEvent);

      await waitUntil(() => manualSwapCalls.length === 1);
      expect(manualSwapCalls).toEqual(["cred-int-b"]);

      await waitUntil(() => spawnCalls.some((c) => c.binary === "tmux"));
      const rows = await db
        .select()
        .from(credentialSwaps)
        .where(eq(credentialSwaps.sessionId, SESSION_ID));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        sessionId: SESSION_ID,
        fromFingerprint: FP_A,
        toFingerprint: FP_B,
        reason: "reactive",
      });

      const tmuxCallsAfterFirst = spawnCalls.filter((c) => c.binary === "tmux");
      expect(tmuxCallsAfterFirst).toHaveLength(1);
      expect(tmuxCallsAfterFirst[0]!.args).toEqual([
        "send-keys",
        "-t",
        TMUX_TARGET,
        "continue",
        "Enter",
      ]);

      // ── Second hit, same session, well inside the 180s debounce window ─
      dispatch({
        event: "notification",
        message: "You hit your limit for this session",
        session_id: SESSION_ID,
      } as unknown as SocketEvent);

      await waitUntil(
        () => spawnCalls.filter((c) => c.binary === "tmux").length > tmuxCallsAfterFirst.length,
      );

      // Debounced: another "continue" was sent, but no second swap and no
      // second credential_swaps row.
      expect(manualSwapCalls).toHaveLength(1);
      const rowsAfterSecond = await db
        .select()
        .from(credentialSwaps)
        .where(eq(credentialSwaps.sessionId, SESSION_ID));
      expect(rowsAfterSecond).toHaveLength(1);

      const tmuxCallsAfterSecond = spawnCalls.filter((c) => c.binary === "tmux");
      expect(tmuxCallsAfterSecond).toHaveLength(2);
      expect(tmuxCallsAfterSecond[1]!.args).toEqual([
        "send-keys",
        "-t",
        TMUX_TARGET,
        "continue",
        "Enter",
      ]);
    });
  },
);
