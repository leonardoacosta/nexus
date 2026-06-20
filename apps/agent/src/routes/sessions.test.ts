/**
 * Session route integration tests.
 *
 * These tests require a live PostgreSQL connection AND mutate it (INSERT into
 * sessions, etc.), so they are OPT-IN: skipped unless `NEXUS_PG_TESTS=1` is set
 * (see ../testing/live-pg.ts). This guarantees they NEVER run against an
 * unspecified/prod `POSTGRES_URL` — e.g. the pre-push deploy gate, which sets
 * `POSTGRES_URL` to the production homelab DB but does NOT set NEXUS_PG_TESTS.
 *
 * To run locally against a THROWAWAY test database:
 *   1. Start a PostgreSQL instance (see docker-compose.test.yml at project root)
 *   2. Run `pnpm db:push` in packages/db to create tables
 *   3. export POSTGRES_URL=postgres://nexus:nexus@localhost:5433/nexus_test
 *   4. export NEXUS_PG_TESTS=1
 *   5. bun test apps/agent/src/routes/sessions.test.ts
 */

import {
  describe,
  expect,
  it,
  beforeAll,
  afterAll,
  mock,
} from "bun:test";

import { hasLivePg as hasPg } from "../testing/live-pg";
import { installExecMock } from "../testing/mock-exec";

// ── pgrep mock (process-watcher reconcile test only) ───────────────────────
//
// `reconcileOnce` shells out to `pgrep -af claude`. We intercept ONLY pgrep
// so the freshness/reconcile assertion is deterministic regardless of what
// `claude` processes happen to be running on the test host. Everything else
// (no other exec callers in this file's code paths) is irrelevant.

let pgrepStubLines: string[] = [];
function setPgrepStub(lines: string[]): void {
  pgrepStubLines = lines;
}

// RESTORABLE spyOn (nx-509z5 class) so the real `../utils/exec` is handed back
// to sibling suites (utils/exec.test.ts) that load later. ExecError/
// ExecTimeoutError stay REAL — see testing/mock-exec.ts.
const execMockHandle = installExecMock({
  execText: async (cmd: string, args: string[]) => {
    if (cmd === "pgrep" && args[0] === "-af" && args[1] === "claude") {
      return pgrepStubLines.join("\n");
    }
    return "";
  },
  execJson: async () => ({}),
});

afterAll(() => execMockHandle.restore());

import { createSessionHandlers } from "./sessions";
import { reconcileOnce } from "../services/process-watcher";
import { openDatabase } from "../db/database";
import type { Db } from "@nexus/db";
import { sessions, projects } from "@nexus/db";
import { eq, like } from "drizzle-orm";

// ── Seed helpers ───────────────────────────────────────────────────────────

const TEST_IDS = ["test-sess-001", "test-sess-002", "test-sess-003"];
const TEST_PROJECT_NAME = "__nx_sessions_test_alpha__";

/** Create the alpha test project (idempotent) and return its uuid. */
async function ensureTestProject(db: Db): Promise<string> {
  const existing = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.name, TEST_PROJECT_NAME))
    .limit(1);
  if (existing[0]) return existing[0].id;

  const [row] = await db
    .insert(projects)
    .values({
      name: TEST_PROJECT_NAME,
      primaryAgentId: "test-machine",
    })
    .returning({ id: projects.id });
  return row!.id;
}

async function seedSessions(db: Db): Promise<string> {
  // Ensure clean state before seeding (idempotent across describe blocks).
  await teardown(db);
  const projectId = await ensureTestProject(db);
  const now = new Date();
  await db.insert(sessions).values([
    {
      id: "test-sess-001",
      projectId,
      machine: "test-machine",
      status: "active",
      startedAt: now,
      lastActivity: now,
      cwd: "/tmp/alpha",
      pid: 1001,
    },
    {
      id: "test-sess-002",
      projectId,
      machine: "test-machine",
      status: "idle",
      startedAt: now,
      lastActivity: now,
      cwd: "/tmp/alpha2",
      pid: 1002,
    },
    {
      id: "test-sess-003",
      projectId: null,
      machine: "test-machine",
      status: "ended",
      startedAt: now,
      lastActivity: now,
      endedAt: now,
      cwd: "/tmp/beta",
      pid: 1003,
    },
  ]);
  return projectId;
}

async function teardown(db: Db): Promise<void> {
  for (const id of TEST_IDS) {
    await db.delete(sessions).where(eq(sessions.id, id));
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe.skipIf(!hasPg)("GET /sessions (requires live PG)", () => {
  let db: Db;
  let handlers: ReturnType<typeof createSessionHandlers>;

  beforeAll(async () => {
    db = openDatabase();
    await seedSessions(db);
    handlers = createSessionHandlers(db);
  });

  afterAll(async () => {
    await teardown(db);
  });

  it("returns sessions array", async () => {
    const res = await handlers.getSessions(new URL("http://localhost/sessions"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(2); // at least active + idle seeded
  });

  it("returns empty array when no sessions match a nonexistent project", async () => {
    const res = await handlers.getSessions(
      new URL("http://localhost/sessions?project=__nonexistent__"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body).toHaveLength(0);
  });
});

describe.skipIf(!hasPg)("GET /sessions?project= (requires live PG)", () => {
  let db: Db;
  let handlers: ReturnType<typeof createSessionHandlers>;
  let projectId: string;

  beforeAll(async () => {
    db = openDatabase();
    projectId = await seedSessions(db);
    handlers = createSessionHandlers(db);
  });

  afterAll(async () => {
    await teardown(db);
  });

  it("filters by projectId (the current source contract)", async () => {
    // Source dropped `sessions.project` (text name) for `sessions.projectId`
    // (uuid FK); the route filters on projectId only. Asserting the live
    // contract here so this test stops drifting from the implementation.
    const res = await handlers.getSessions(
      new URL(`http://localhost/sessions?project=${projectId}`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ projectId: string | null }>;
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(body.every((s) => s.projectId === projectId)).toBe(true);
  });

  it("returns empty array for non-matching project", async () => {
    const res = await handlers.getSessions(
      new URL("http://localhost/sessions?project=__no_such_project__"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body).toHaveLength(0);
  });
});

describe.skipIf(!hasPg)("GET /sessions?status= (requires live PG)", () => {
  let db: Db;
  let handlers: ReturnType<typeof createSessionHandlers>;

  beforeAll(async () => {
    db = openDatabase();
    await seedSessions(db);
    handlers = createSessionHandlers(db);
  });

  afterAll(async () => {
    await teardown(db);
  });

  it("filters by status", async () => {
    const res = await handlers.getSessions(
      new URL("http://localhost/sessions?status=active"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ status: string }>;
    expect(body.every((s) => s.status === "active")).toBe(true);
  });

  it("combines project and status filters", async () => {
    const existing = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.name, TEST_PROJECT_NAME))
      .limit(1);
    const projectId = existing[0]!.id;
    const res = await handlers.getSessions(
      new URL(
        `http://localhost/sessions?project=${projectId}&status=active`,
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      projectId: string | null;
      status: string;
    }>;
    expect(
      body.every((s) => s.projectId === projectId && s.status === "active"),
    ).toBe(true);
  });
});

describe.skipIf(!hasPg)("GET /sessions/{id} (requires live PG)", () => {
  let db: Db;
  let handlers: ReturnType<typeof createSessionHandlers>;

  beforeAll(async () => {
    db = openDatabase();
    await seedSessions(db);
    handlers = createSessionHandlers(db);
  });

  afterAll(async () => {
    await teardown(db);
  });

  it("returns a single session by ID", async () => {
    const res = await handlers.getSessionById("test-sess-001");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe("test-sess-001");
  });

  it("returns 404 for unknown session ID", async () => {
    const res = await handlers.getSessionById("__nonexistent-id__");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("session not found");
  });
});

describe.skipIf(!hasPg)("GET /sessions?status=invalid (requires live PG)", () => {
  let db: Db;
  let handlers: ReturnType<typeof createSessionHandlers>;

  beforeAll(() => {
    db = openDatabase();
    handlers = createSessionHandlers(db);
  });

  it("returns 400 for invalid status value", async () => {
    const res = await handlers.getSessions(
      new URL("http://localhost/sessions?status=invalid"),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("invalid status filter");
  });

  it("returns 400 for another invalid status value", async () => {
    const res = await handlers.getSessions(
      new URL("http://localhost/sessions?status=running"),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("invalid status filter");
  });
});

// ── nx-z66n8 heartbeat regression surface ──────────────────────────────────
//
// The dashboard-empty incident: a live `claude` PID stops emitting CC hook
// events; without a process-aliveness heartbeat the row's `lastActivity`
// goes stale and falls out of the Swift dashboard's freshness window even
// though the session is alive. process-watcher.reconcileOnce MUST refresh
// `lastActivity` for live managed PIDs (touchHeartbeatByPids). This test
// pins that end-to-end: known PID → reconcile → GET /sessions returns the
// row with a freshly-bumped lastActivity.

const FRESHNESS_WINDOW_MS = 300_000; // Swift dashboard staleness cutoff (300s)

describe.skipIf(!hasPg)(
  "process-watcher reconcile keeps a live PID fresh in GET /sessions (nx-z66n8)",
  () => {
    let db: Db;
    let handlers: ReturnType<typeof createSessionHandlers>;
    const KNOWN_PID = 987654;
    const ROW_ID = "nx-z66n8-fresh-row";

    beforeAll(async () => {
      db = openDatabase();
      await db.delete(sessions).where(eq(sessions.id, ROW_ID));
      await db.delete(sessions).where(like(sessions.id, "cc-987654-%"));

      // Insert a watcher-managed row whose lastActivity is deliberately
      // STALE — older than the dashboard freshness window. Without a
      // reconcile heartbeat it would be dropped by the client.
      const stale = new Date(Date.now() - 10 * 60_000); // 10 min ago
      await db.insert(sessions).values({
        id: ROW_ID,
        projectId: null,
        machine: "local",
        status: "active",
        startedAt: stale,
        lastActivity: stale,
        endedAt: null,
        pid: KNOWN_PID,
        cwd: "/tmp/nx-z66n8",
        model: "claude",
        sessionType: "managed",
      });

      handlers = createSessionHandlers(db);
    });

    afterAll(async () => {
      await db.delete(sessions).where(eq(sessions.id, ROW_ID));
      await db.delete(sessions).where(like(sessions.id, "cc-987654-%"));
    });

    it("reconcile bumps lastActivity into the freshness window and the row is served", async () => {
      // Sanity: before reconcile the row is stale (outside the window).
      const before = await db
        .select({ lastActivity: sessions.lastActivity })
        .from(sessions)
        .where(eq(sessions.id, ROW_ID));
      const beforeAge = Date.now() - before[0]!.lastActivity.getTime();
      expect(beforeAge).toBeGreaterThan(FRESHNESS_WINDOW_MS);

      // pgrep reports KNOWN_PID as a live `claude` process.
      setPgrepStub([`${KNOWN_PID} claude --nx-z66n8-regression`]);
      const result = await reconcileOnce(db);
      // Already-managed live PID: not closed, not recreated — heartbeated.
      expect(result.closed).toBe(0);
      expect(result.created).toBe(0);

      // The row's lastActivity is now fresh (well inside the window).
      const after = await db
        .select({ lastActivity: sessions.lastActivity })
        .from(sessions)
        .where(eq(sessions.id, ROW_ID));
      const afterAge = Date.now() - after[0]!.lastActivity.getTime();
      expect(afterAge).toBeLessThan(FRESHNESS_WINDOW_MS);

      // And GET /sessions surfaces it (createSessionHandlers caches for 1s;
      // a fresh handler instance avoids any prior-suite cache bleed).
      const freshHandlers = createSessionHandlers(db);
      const res = await freshHandlers.getSessions(
        new URL("http://localhost/sessions"),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{
        id: string;
        lastActivity: string;
      }>;
      const served = body.find((s) => s.id === ROW_ID);
      expect(served).toBeDefined();
      const servedAge = Date.now() - new Date(served!.lastActivity).getTime();
      expect(servedAge).toBeLessThan(FRESHNESS_WINDOW_MS);
    });
  },
);
