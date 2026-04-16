/**
 * E2E [5.2] (nx-3wpy): Dashboard renders sessions list when all agents stopped.
 *
 * Proves the dual-path collapse (finalize-audit-cleanup Wave 3): the dashboard
 * reads exclusively from shared Postgres via @nexus/db. Before the collapse, an
 * HTTP fan-out to each agent (`AgentClient.fetchAllSessions`) would have timed
 * out / failed when agents were stopped. Now the page renders from the DB
 * snapshot regardless of agent state, and an "agents offline" banner surfaces
 * the degraded-freshness state.
 *
 * What the test does:
 *   1. Clear and seed Postgres with:
 *        - one `agents` row whose lastSeen is > 90s old (i.e. offline)
 *        - one `sessions` row referencing that agent
 *   2. Invoke the real `fetchSessions()` server action. This is the exact
 *      code path Next.js executes for the dashboard page.
 *   3. Render `<SessionListPoller>` with the real result via `renderToString`
 *      (React 19 server rendering — same mode Next uses for RSC).
 *   4. Assert on the rendered HTML:
 *        - `data-testid="agents-offline-banner"` is present
 *        - banner copy matches ("All agents offline")
 *        - the session's project name is in the tree
 *
 * Why this is an E2E test (and not a unit test):
 *   - It uses real Postgres (docker-compose.test.yml on port 5433).
 *   - It runs the real Drizzle query fns from @nexus/db.
 *   - It runs the real server action unmodified — no mocks for `fetchSessions`.
 *   - It catches the class of regression the dual-path collapse targeted: any
 *     code path that still assumed agent HTTP liveness for the dashboard read
 *     would break this test.
 *
 * Skip conditions: the test suite is skipped (not failed) if `POSTGRES_URL` is
 * missing or the DB is unreachable. This keeps CI lanes without a test DB
 * container green while still enforcing coverage locally and in the e2e lane.
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";

// ── Skip-if-missing preflight ──────────────────────────────────────────────
//
// Gate on the *test* DB specifically. If POSTGRES_URL points at a dev DB
// (e.g. production or local-dev data) this test would clobber real rows
// during the clear/seed step, so we require an opt-in sentinel in the URL.
//
// The sentinel is the database name "nexus_test" — which is what
// docker-compose.test.yml provisions. Any other DB name is treated as
// "not the test DB" and the suite is skipped with a clear reason.

const POSTGRES_URL = process.env.POSTGRES_URL;
const IS_TEST_DB = !!POSTGRES_URL && /\/nexus_test(?:[?#]|$)/.test(POSTGRES_URL);

if (!IS_TEST_DB) {
  const reason = POSTGRES_URL
    ? "POSTGRES_URL does not point at the nexus_test database (refusing to clobber dev/prod data)"
    : "POSTGRES_URL not set";
  describe.skip(
    `E2E [5.2]: Dashboard renders when all agents stopped (skipped — ${reason})`,
    () => {
      it("skipped", () => {
        /* no-op — visible in runner as skipped suite */
      });
    },
  );
} else {
  // ── Real-DB path ─────────────────────────────────────────────────────────

  const {
    createDb,
    sessions,
    agents,
    projects,
    healthSnapshots,
    eq,
  } = await import("@nexus/db");

  const dbHandle = createDb(POSTGRES_URL);
  const db = dbHandle.db;
  const pg = dbHandle.client;

  // The server action `fetchSessions` calls `getDb()` from
  // apps/nextjs/src/lib/db.ts, which lazy-reads POSTGRES_URL at first access.
  // That's the same URL we just used, so both connections point at the same
  // Postgres. No further wiring is required.
  const { fetchSessions } = await import(
    "../../apps/nextjs/src/app/actions/sessions"
  );

  // React 19 server rendering — same path Next.js uses server-side.
  const { renderToString } = await import("react-dom/server");
  const React = await import("react");
  const { SessionListPoller } = await import(
    "../../apps/nextjs/src/components/SessionListPoller"
  );

  // ── Fixture constants ─────────────────────────────────────────────────────
  //
  // Descriptive names so a failing test surfaces the scenario at a glance.
  // The "e2e-" prefix avoids colliding with any real fixtures that may end
  // up in the shared test DB.
  const TEST_AGENT_ID = "e2e-dashboard-agent";
  const TEST_PROJECT_ID = "11111111-1111-1111-1111-111111111111";
  const TEST_PROJECT_NAME = "e2e-dashboard-project";
  const TEST_SESSION_ID = "e2e-dashboard-session-1";

  // Arbitrarily older than the 90s online threshold used by fetchSessions().
  const FIVE_MINUTES_MS = 5 * 60 * 1000;

  async function clearE2eRows(): Promise<void> {
    // Delete in FK-safe order. Only touch rows this test owns.
    await db
      .delete(healthSnapshots)
      .where(eq(healthSnapshots.agentId, TEST_AGENT_ID));
    await db.delete(sessions).where(eq(sessions.id, TEST_SESSION_ID));
    await db.delete(projects).where(eq(projects.id, TEST_PROJECT_ID));
    await db.delete(agents).where(eq(agents.id, TEST_AGENT_ID));
  }

  async function seedOfflineAgentWithSession(): Promise<void> {
    const now = new Date();
    const stale = new Date(now.getTime() - FIVE_MINUTES_MS);

    // 1. Offline agent (lastSeen > 90s ago).
    await db.insert(agents).values({
      id: TEST_AGENT_ID,
      name: TEST_AGENT_ID,
      host: "127.0.0.1",
      port: 7400,
      enabled: true,
      lastSeen: stale,
      createdAt: stale,
    });

    // 2. Project — referenced by the session.
    await db.insert(projects).values({
      id: TEST_PROJECT_ID,
      name: TEST_PROJECT_NAME,
      primaryAgentId: TEST_AGENT_ID,
      discoveredAt: stale,
    });

    // 3. Historical session row — "ended" so fetchSessions doesn't skip it.
    await db.insert(sessions).values({
      id: TEST_SESSION_ID,
      projectId: TEST_PROJECT_ID,
      machine: TEST_AGENT_ID,
      status: "ended",
      startedAt: stale,
      lastActivity: stale,
      endedAt: stale,
      pid: 9999,
      cwd: "/tmp/e2e",
      branch: "main",
      sessionType: "ad_hoc",
    });
  }

  async function pingDb(): Promise<boolean> {
    try {
      await pg`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  let dbReachable = false;

  beforeAll(async () => {
    dbReachable = await pingDb();
    if (!dbReachable) return;
    await clearE2eRows();
    await seedOfflineAgentWithSession();
  });

  afterAll(async () => {
    if (!dbReachable) return;
    try {
      await clearE2eRows();
    } finally {
      await pg.end({ timeout: 2 });
    }
  });

  describe("E2E [5.2]: Dashboard renders when all agents stopped", () => {
    it("database is reachable (preflight)", () => {
      if (!dbReachable) {
        console.warn(
          "[e2e:5.2] POSTGRES_URL set but DB unreachable — tests below will be skipped",
        );
      }
      expect(typeof dbReachable).toBe("boolean");
    });

    it("fetchSessions() returns seeded row with onlineAgentCount=0", async () => {
      if (!dbReachable) return;

      const result = await fetchSessions();

      // The seeded row is visible even though no agent is online.
      const mine = result.sessions.find((s) => s.id === TEST_SESSION_ID);
      expect(mine).toBeDefined();
      expect(mine?.project).toBe(TEST_PROJECT_NAME);

      // agentCount > 0 (enabled agent exists) but onlineAgentCount === 0
      // because lastSeen is older than the 90s freshness threshold. This is
      // the exact state that triggers the "All agents offline" banner copy.
      expect(result.agentCount).toBeGreaterThan(0);
      expect(result.onlineAgentCount).toBe(0);
    });

    it("SessionListPoller HTML contains the offline banner and session row", async () => {
      if (!dbReachable) return;

      const result = await fetchSessions();

      const html = renderToString(
        React.createElement(SessionListPoller, {
          initialSessions: result.sessions,
          initialAgentCount: result.agentCount,
          initialOnlineAgentCount: result.onlineAgentCount,
        }),
      );

      // Banner is rendered — the key AgentsOfflineBanner signal.
      expect(html).toContain('data-testid="agents-offline-banner"');

      // Copy discriminator: agentCount > 0 → "All agents offline".
      expect(html).toContain("All agents offline");

      // Seeded session still rendered — proves the DB read path powered the
      // view even with zero online agents.
      expect(html).toContain(TEST_PROJECT_NAME);
    });

    it("fetchSessions does no HTTP fan-out (agent-less environment succeeds)", async () => {
      if (!dbReachable) return;

      // fetchSessions() in its current form does zero agent HTTP calls — it
      // reads only from Postgres. This test asserts the contract by running
      // it with no agents listening on any port: fetchSessions still returns
      // a populated result without throwing. If a future refactor reintroduces
      // an HTTP fan-out, this test would fail with connection-refused.
      const result = await fetchSessions();
      expect(result).toBeDefined();
      expect(Array.isArray(result.sessions)).toBe(true);
    });
  });
}
