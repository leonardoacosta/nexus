/**
 * GET /statusline tests (redesign-status-usage-endpoints task 4.1).
 *
 * Two tiers:
 *
 *   1. NO-DB dispatch tests — the model-letter derivation cases (original
 *      add-session-model-authority coverage) plus the `both params → 400`
 *      mutual-exclusion guard, which returns before any DB access. These stub
 *      the DB-access seam via a RESTORABLE `spyOn` (never mock.module — avoids
 *      the process-global forward-leak class) and `execText` so the module-level
 *      git-status cache never shells out to the real `git` binary.
 *
 *   2. REAL-DB dispatch tests — the 4-mode contract (neither / accountId /
 *      sessionId / both), the session→project join, and cost-usage composition.
 *      These use the shared `createIsolatedSchema` throwaway-schema harness
 *      (NEVER mock.module Drizzle) and are PG-gated: they skip cleanly when no
 *      live Postgres is configured (NEXUS_PG_TESTS=1 + POSTGRES_URL).
 *
 *   3. GET /credentials usage-field removal — `handleListCredentials` no longer
 *      surfaces the removed `usagePercent`/`resetsAt` account fields
 *      (redesign-status-usage-endpoints trimmed them from `Account`).
 */

import {
  describe,
  test,
  it,
  expect,
  spyOn,
  afterEach,
  beforeAll,
  afterAll,
} from "bun:test";
import { createDb } from "@nexus/db";
import type { Db } from "@nexus/db";
import {
  credentials,
  projects,
  projectStatusSnapshots,
  sessions,
} from "@nexus/db";
import type {
  Account5H7D,
  GitStatusObject,
  NextRecommendation,
  SessionStatusResponse,
} from "@nexus/core";
import type { SessionRow } from "../db/sessions";
import * as sessionsDb from "../db/sessions";
import * as execMod from "../utils/exec";
import * as gitObserver from "../services/git-observer";
import * as recommendMod from "./recommend";
import * as readerMod from "../services/credential-pool/reader";
import type { CredentialReadResult } from "../services/credential-pool/reader";
import { handleStatusline } from "./statusline";
import { handleListCredentials } from "./credentials/handlers-crud";
import {
  createIsolatedSchema,
  SESSIONS_PROJECTS_DDL,
  type IsolatedSchema,
} from "../testing/isolated-pg-schema";
import { hasLivePg as hasPg } from "../testing/live-pg";

function makeRow(overrides: Partial<SessionRow>): SessionRow {
  return {
    id: "sess-1",
    projectId: "proj-uuid",
    status: "active",
    model: null,
    cwd: "/x",
    lastActivity: new Date(),
    ...overrides,
  } as unknown as SessionRow;
}

const statusUrl = (qs = ""): URL => new URL(`http://x/statusline${qs}`);

// ───────────────────────────────────────────────────────────────────────────
// Tier 1 — NO-DB dispatch (model derivation + mutual-exclusion guard)
// ───────────────────────────────────────────────────────────────────────────

interface StatuslineBody {
  sessions: Array<{ id: string; model: string | null }>;
}

describe("GET /statusline — model letter derivation", () => {
  let qSpy: ReturnType<typeof spyOn<typeof sessionsDb, "queryActiveSessions">> | undefined;
  let execSpy: ReturnType<typeof spyOn<typeof execMod, "execText">> | undefined;

  afterEach(() => {
    qSpy?.mockRestore();
    execSpy?.mockRestore();
  });

  test("derives the family letter from the row's raw model (claude-opus-4-8 → O)", async () => {
    qSpy = spyOn(sessionsDb, "queryActiveSessions").mockResolvedValue([
      makeRow({ id: "s1", model: "claude-opus-4-8" }),
    ]);
    execSpy = spyOn(execMod, "execText").mockResolvedValue("");

    const res = await handleStatusline({} as Db, statusUrl());
    const body = (await res.json()) as StatuslineBody;
    expect(body.sessions[0]!.model).toBe("O");
  });

  test("model stays null when the row has no stored model", async () => {
    qSpy = spyOn(sessionsDb, "queryActiveSessions").mockResolvedValue([
      makeRow({ id: "s2", model: null }),
    ]);
    execSpy = spyOn(execMod, "execText").mockResolvedValue("");

    const res = await handleStatusline({} as Db, statusUrl());
    const body = (await res.json()) as StatuslineBody;
    expect(body.sessions[0]!.model).toBeNull();
  });
});

describe("GET /statusline — mutual-exclusion guard (no DB)", () => {
  test("both sessionId and accountId present → 400 before any DB access", async () => {
    // `{} as Db` proves the guard short-circuits before touching the DB — a
    // real query against the empty stub would throw, not return 400.
    const res = await handleStatusline(
      {} as Db,
      statusUrl("?sessionId=sess-x&accountId=cred-x"),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("sessionId and accountId are mutually exclusive");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Tier 2 — REAL-DB 4-mode dispatch + joins (PG-gated)
// ───────────────────────────────────────────────────────────────────────────

const STATUSLINE_DDL = `
  ${SESSIONS_PROJECTS_DDL}

  CREATE TABLE "credentials" (
    "id" text PRIMARY KEY NOT NULL,
    "name" text NOT NULL,
    "type" text NOT NULL,
    "value_encrypted" text,
    "encryption_key_id" text DEFAULT 'v1',
    "agent_id" text,
    "status" text DEFAULT 'available' NOT NULL,
    "leased_by" text,
    "leased_at" timestamp,
    "cooldown_until" timestamp,
    "rate_limit_count" integer DEFAULT 0 NOT NULL,
    "fingerprint" text DEFAULT '' NOT NULL,
    "duplicate_group_id" text,
    "is_primary" boolean DEFAULT false NOT NULL,
    "subscription_type" text,
    "rate_limit_tier" text,
    "expires_at" timestamp with time zone,
    "account_email" text,
    "account_name" text,
    "account_uuid" text,
    "org_name" text,
    "org_uuid" text,
    "mcp_providers" text,
    "usage_5h_used" integer,
    "usage_5h_limit" integer,
    "usage_5h_reset_at" timestamp with time zone,
    "usage_7d_used" integer,
    "usage_7d_limit" integer,
    "usage_7d_reset_at" timestamp with time zone,
    "usage_polled_at" timestamp with time zone,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE "project_status_snapshots" (
    "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    "project" text NOT NULL,
    "proposals_unarchived" integer NOT NULL,
    "beads_ready_unlinked" integer NOT NULL,
    "beads_blocked_unlinked" integer NOT NULL,
    "created_at" timestamp with time zone NOT NULL DEFAULT now()
  );
`;

// Fixed reset instants so the ISO-8601 wire assertions are deterministic.
const FIVE_H_RESET = new Date("2026-07-14T18:00:00.000Z");
const SEVEN_D_RESET = new Date("2026-07-20T00:00:00.000Z");

describe.skipIf(!hasPg)("GET /statusline — 4-mode dispatch (requires live PG)", () => {
  let iso: IsolatedSchema;
  let db: Db;
  let projectUuid: string;
  const savedVmUrl = process.env.VM_URL;

  beforeAll(async () => {
    // VM disabled → readSessionCostTokens returns the zero/null EMPTY breakdown,
    // so cost-usage composition is deterministic without a live VictoriaMetrics.
    delete process.env.VM_URL;

    iso = await createIsolatedSchema(STATUSLINE_DDL, "statusline");
    db = iso.db;

    await db.insert(credentials).values({
      id: "cred-1",
      name: "personal",
      type: "anthropic",
      fingerprint: "fp-cred-1",
      isPrimary: true,
      usage5hUsed: 10,
      usage5hLimit: 100,
      usage5hResetAt: FIVE_H_RESET,
      usage7dUsed: 200,
      usage7dLimit: 1000,
      usage7dResetAt: SEVEN_D_RESET,
    });

    const [proj] = await db
      .insert(projects)
      .values({ name: "proj-nx", primaryAgentId: "agent-1" })
      .returning();
    projectUuid = proj!.id;

    await db.insert(projectStatusSnapshots).values({
      project: "proj-nx",
      proposalsUnarchived: 3,
      beadsReadyUnlinked: 2,
      beadsBlockedUnlinked: 1,
    });

    const now = new Date();
    await db.insert(sessions).values({
      id: "sess-known",
      projectId: projectUuid,
      machine: "test-machine",
      status: "active",
      startedAt: now,
      lastActivity: now,
      cwd: "/tmp/work",
      pid: 4242,
      model: "claude-opus-4-8",
      credentialId: "cred-1",
    });
  });

  afterAll(async () => {
    await iso.drop();
    if (savedVmUrl === undefined) delete process.env.VM_URL;
    else process.env.VM_URL = savedVmUrl;
  });

  // ── accountId mode ────────────────────────────────────────────────────────

  it("accountId mode: 200 with the Account5H7D shape for a known account", async () => {
    const res = await handleStatusline(db, statusUrl("?accountId=cred-1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { account: Account5H7D };
    expect(body.account).toEqual({
      accountId: "cred-1",
      fiveHour: { used: 10, limit: 100, resetsAt: FIVE_H_RESET.toISOString() },
      sevenDay: { used: 200, limit: 1000, resetsAt: SEVEN_D_RESET.toISOString() },
    });
    // The removed top-level usage fields must not resurface on the wire.
    expect(body.account).not.toHaveProperty("usagePercent");
    expect(body.account).not.toHaveProperty("resetsAt");
  });

  it("accountId mode: 404 for an unknown account", async () => {
    const res = await handleStatusline(db, statusUrl("?accountId=nope"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unknown account");
  });

  // ── sessionId mode ────────────────────────────────────────────────────────

  it("sessionId mode: 200 composed SessionStatusResponse for a known session", async () => {
    const gitFixture: GitStatusObject = {
      branch: "feat",
      headSha: "abc1234def",
      detached: false,
      dirty: { modified: 2, untracked: 1, deleted: 0, renamed: 0 },
      ahead: 3,
      behind: 1,
      observedAt: new Date().toISOString(),
    };
    const nextFixture: NextRecommendation = {
      recommendations: [
        { id: "r1", title: "Ship it", score: 9, reason: "ready", type: "task" },
      ],
      context: { project: "proj-nx", active_spec: null, session_count: 1 },
    };
    const gitSpy = spyOn(gitObserver, "getObservedGitState").mockReturnValue(
      gitFixture,
    );
    const recSpy = spyOn(recommendMod, "getRecommendation").mockResolvedValue(
      nextFixture,
    );
    try {
      const res = await handleStatusline(db, statusUrl("?sessionId=sess-known"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { session: SessionStatusResponse };
      const s = body.session;

      expect(s.sessionId).toBe("sess-known");
      // model: single-letter family tag from the raw stored model.
      expect(s.model).toBe("O");
      // 5H/7D resolved via sessions.credentialId → credentials row.
      expect(s.fiveHour).toEqual({
        used: 10,
        limit: 100,
        resetsAt: FIVE_H_RESET.toISOString(),
      });
      expect(s.sevenDay).toEqual({
        used: 200,
        limit: 1000,
        resetsAt: SEVEN_D_RESET.toISOString(),
      });
      // cost-usage composition: VM disabled → EMPTY breakdown mapped onto `usage`.
      expect(s.usage).toEqual({
        cost_usd: null,
        input: 0,
        output: 0,
        cache_read: 0,
        cache_creation: 0,
      });
      // session→project join: sessions.projectId → projects.name → latest snapshot.
      expect(s.project).toEqual({
        beadsReadyUnlinked: 2,
        beadsBlockedUnlinked: 1,
        proposalsUnarchived: 3,
        git: gitFixture,
      });
      // next: the composed GET /recommend payload, unchanged.
      expect(s.next).toEqual(nextFixture);
    } finally {
      gitSpy.mockRestore();
      recSpy.mockRestore();
    }
  });

  it("sessionId mode: 404 for an unknown session", async () => {
    const res = await handleStatusline(db, statusUrl("?sessionId=ghost"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unknown session");
  });

  // ── neither mode (additive overview) ──────────────────────────────────────

  it("neither mode: preserves legacy overview fields AND adds accounts[]", async () => {
    // Stub the git shell-out so the overview's cached git read is deterministic.
    const execSpy = spyOn(execMod, "execText").mockResolvedValue("");
    try {
      const res = await handleStatusline(db, statusUrl());
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        sessions: Array<{ id: string }>;
        git: unknown;
        machine: { mem_percent: number };
        uptime_seconds: number;
        daemon_count: number;
        accounts: Account5H7D[];
      };

      // Legacy overview fields are preserved unchanged.
      expect(Array.isArray(body.sessions)).toBe(true);
      expect(body.sessions.some((s) => s.id === "sess-known")).toBe(true);
      expect(body).toHaveProperty("git");
      expect(typeof body.machine.mem_percent).toBe("number");
      expect(typeof body.uptime_seconds).toBe("number");
      expect(typeof body.daemon_count).toBe("number");

      // NEW additive field: all-accounts 5H/7D usage.
      expect(Array.isArray(body.accounts)).toBe(true);
      const acct = body.accounts.find((a) => a.accountId === "cred-1");
      expect(acct).toBeDefined();
      expect(acct!.fiveHour).toEqual({
        used: 10,
        limit: 100,
        resetsAt: FIVE_H_RESET.toISOString(),
      });
    } finally {
      execSpy.mockRestore();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Tier 3 — GET /credentials usage-field removal
// ───────────────────────────────────────────────────────────────────────────

describe("GET /credentials — usage-field removal", () => {
  afterEach(() => {
    // spyOn auto-tracked; restore explicitly to avoid cross-test leakage.
  });

  it("does not surface the removed usagePercent/resetsAt account fields", async () => {
    // Pool is uninitialized in this test process → handleListCredentials falls
    // through to the filesystem reader, which we stub to a deterministic result
    // so the assertion pins the SERVED wire shape (not the ~/.claude host state).
    const fixture: CredentialReadResult = {
      credentials: [
        {
          id: "cred-1",
          name: "personal",
          fingerprint: "f".repeat(64),
          account: "leo@home.com",
          created_at: new Date().toISOString(),
          status: "active",
          isActive: true,
          rateLimit429Count: 0,
          subscriptionType: "max",
          rateLimitTier: "default_claude_max_20x",
          accountEmail: "leo@home.com",
          accountName: null,
          orgName: null,
          expiresAt: null,
          lastSwapAt: null,
        },
      ],
      activeFingerprint: "f".repeat(64),
    } as unknown as CredentialReadResult;

    const readerSpy = spyOn(readerMod, "readCredentials").mockResolvedValue(
      fixture,
    );
    try {
      const res = await handleListCredentials();
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        credentials: Array<Record<string, unknown>>;
      };
      expect(body.credentials.length).toBeGreaterThan(0);
      for (const row of body.credentials) {
        expect(row).not.toHaveProperty("usagePercent");
        expect(row).not.toHaveProperty("resetsAt");
      }
    } finally {
      readerSpy.mockRestore();
    }
  });
});
