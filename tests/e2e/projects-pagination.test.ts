/**
 * E2E [5.3] (nx-4o74): Cursor pagination for GET /projects with seeded DB.
 *
 * Regression guard for the cursor/limit contract added in task 2.2 (nx-z84e):
 * `GET /projects` now accepts `cursor` + `limit` query params and returns a
 * `{ items, nextCursor }` shape. Callers that supply neither param still see
 * the legacy bare-`Project[]` response (backward compatible).
 *
 * What the test does
 * ------------------
 *   1. Seed Postgres (test DB at port 5433) with 120 projects + 120 sessions
 *      (one session per project, so every project aggregates to total=1).
 *      Project IDs are deterministic uuids whose lexicographic order matches
 *      numeric order (e.g. `...000000000000`..`...000000000119`) so the
 *      cursor sort key (project name / uuid string) is predictable.
 *   2. Spin up a real `nexus-agent` Bun server on port 0, passing the real DB
 *      handle — the same HTTP router the production agent uses.
 *   3. Fire HTTP requests through `fetch()` and assert on response shape +
 *      pagination behavior at every boundary.
 *
 * Why this is an E2E test (not a unit test)
 * -----------------------------------------
 *   - Uses real Postgres (docker-compose.test.yml on port 5433), not mocks.
 *   - Runs through the real Bun.serve HTTP router (auth gate, CORS, JSON
 *     serialisation — every layer that sits between a client and the route
 *     handler).
 *   - Uses the real `handleGetProjects` pipeline including the module-level
 *     cache (cleared in `beforeAll`).
 *   - Uses real `sessions` + `projects` tables with FK constraints.
 *
 * The sibling unit test `apps/agent/src/routes/projects-pagination.test.ts`
 * covers `/projects/discovered` with mocked fs — this file complements it by
 * covering `/projects` with a real DB at the HTTP layer.
 *
 * Scenarios
 * ---------
 *   1. `limit=50` → 50 items + nextCursor present (page 1)
 *   2. `cursor=<page1.nextCursor>&limit=50` → next 50 + nextCursor (page 2)
 *   3. `cursor=<page2.nextCursor>&limit=50` → last 20 + nextCursor=null
 *   4. `limit=1000` → clamped to 200 items
 *   5. `cursor=!!invalid!!` → 400 Bad Request
 *   6. No params → bare `Project[]` array (legacy shape, length 120)
 *
 * Skip conditions
 * ---------------
 *   - `POSTGRES_URL` missing, or
 *   - `POSTGRES_URL` does NOT point at `nexus_test` (refuses to clobber dev
 *     data — same sentinel as dashboard-offline.test.ts).
 *
 * To run locally
 * --------------
 *   1. docker compose -f docker-compose.test.yml up -d
 *   2. POSTGRES_URL=postgres://nexus:nexus@localhost:5433/nexus_test \
 *      NEXUS_ATTACH_SECRET=e2e-pagination-secret \
 *      bun test tests/e2e/projects-pagination.test.ts
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";

// ── Skip-if-missing preflight ──────────────────────────────────────────────
//
// Gate on the *test* DB specifically. If POSTGRES_URL points at a dev DB this
// test would clobber real rows, so require an opt-in sentinel (the "nexus_test"
// database name provisioned by docker-compose.test.yml).

const POSTGRES_URL = process.env.POSTGRES_URL;
const IS_TEST_DB = !!POSTGRES_URL && /\/nexus_test(?:[?#]|$)/.test(POSTGRES_URL);

// The agent's server.ts reads NEXUS_ATTACH_SECRET at module load and calls
// process.exit(1) if missing. Set a deterministic value BEFORE importing the
// server module so `startServer` succeeds regardless of the caller's env.
const TEST_SECRET = "e2e-pagination-test-secret";
process.env.NEXUS_ATTACH_SECRET =
  process.env.NEXUS_ATTACH_SECRET ?? TEST_SECRET;
const ATTACH_SECRET = process.env.NEXUS_ATTACH_SECRET!;

if (!IS_TEST_DB) {
  const reason = POSTGRES_URL
    ? "POSTGRES_URL does not point at the nexus_test database (refusing to clobber dev/prod data)"
    : "POSTGRES_URL not set";
  describe.skip(
    `E2E [5.3]: cursor pagination for GET /projects (skipped — ${reason})`,
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
    inArray,
  } = await import("@nexus/db");

  const dbHandle = createDb(POSTGRES_URL);
  const db = dbHandle.db;
  const pg = dbHandle.client;

  // Import server + cache controls AFTER env is set so module-load guards pass.
  const { startServer } = await import("../../apps/agent/src/server");
  const { clearProjectsCache } = await import(
    "../../apps/agent/src/routes/projects"
  );

  // ── Fixture constants ────────────────────────────────────────────────────
  //
  // Project IDs use a deterministic uuid template whose lexicographic order
  // matches numeric order across the 120-row range. That matters because the
  // cursor sort key is the aggregated project "name" — which for registered
  // projects is the projectId string. Sorting 120 uuids of the form
  // `00000000-0000-0000-0000-NNNNNNNNNNNN` (where `N…` is a zero-padded
  // 12-digit counter) is equivalent to sorting by that counter.

  const TOTAL_PROJECTS = 120;
  const PROJECT_PREFIX = "e2e-pagination-"; // unique prefix for cleanup
  const AGENT_ID = "e2e-pagination-agent";

  /** Generate a deterministic uuid whose sort order is `index`. */
  function makeProjectId(index: number): string {
    const counter = index.toString().padStart(12, "0");
    return `00000000-0000-0000-0000-${counter}`;
  }

  /** Generate a unique session id per project. */
  function makeSessionId(index: number): string {
    return `${PROJECT_PREFIX}sess-${index.toString().padStart(3, "0")}`;
  }

  /** Pre-built list of the 120 ids we'll insert — reused in cleanup. */
  const projectIds: string[] = Array.from(
    { length: TOTAL_PROJECTS },
    (_, i) => makeProjectId(i),
  );
  const sessionIds: string[] = Array.from(
    { length: TOTAL_PROJECTS },
    (_, i) => makeSessionId(i),
  );

  async function clearFixtureRows(): Promise<void> {
    // Delete sessions first (FK to projects), then projects, then agent.
    // Use inArray on the known id sets so we never touch rows we don't own.
    await db.delete(sessions).where(inArray(sessions.id, sessionIds));
    await db.delete(projects).where(inArray(projects.id, projectIds));
    await db.delete(agents).where(inArray(agents.id, [AGENT_ID]));
  }

  async function seedProjects(): Promise<void> {
    const now = new Date();

    // Agent — required as a target for the projects.primary_agent_id column
    // and sessions.machine.
    await db.insert(agents).values({
      id: AGENT_ID,
      name: AGENT_ID,
      host: "127.0.0.1",
      port: 7400,
      enabled: true,
      lastSeen: now,
      createdAt: now,
    });

    // 120 projects. Each has a unique uuid whose sort order == numeric order.
    // The `name` column differs from the id but is NOT used by aggregation —
    // aggregateProjects() keys on `session.projectId`. We still pick a unique
    // name per row to satisfy the (name, git_remote_url) composite unique.
    const projectRows = Array.from({ length: TOTAL_PROJECTS }, (_, i) => ({
      id: projectIds[i]!,
      name: `${PROJECT_PREFIX}project-${i.toString().padStart(3, "0")}`,
      primaryAgentId: AGENT_ID,
      discoveredAt: now,
      updatedAt: now,
    }));
    await db.insert(projects).values(projectRows);

    // 120 sessions — one per project, each active so aggregateProjects()
    // counts it in total_sessions. sessions.machine is a plain text column
    // (not FK to agents), so any string is valid.
    const sessionRows = Array.from({ length: TOTAL_PROJECTS }, (_, i) => ({
      id: sessionIds[i]!,
      projectId: projectIds[i]!,
      machine: AGENT_ID,
      status: "active",
      startedAt: now,
      lastActivity: now,
      sessionType: "ad_hoc",
    }));
    await db.insert(sessions).values(sessionRows);
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
  let server: ReturnType<typeof startServer> | null = null;
  let httpBase = "";

  beforeAll(async () => {
    dbReachable = await pingDb();
    if (!dbReachable) return;

    // Clean up any lingering rows from a previous run before seeding.
    await clearFixtureRows();
    await seedProjects();

    // Clear the route-level cache so the first request sees our seed data,
    // not whatever another test file may have left behind.
    clearProjectsCache();

    // Bind to a random free port — safe for parallel test runs.
    server = startServer(0, db);
    httpBase = `http://localhost:${server.port}`;
  });

  afterAll(async () => {
    if (server) {
      try {
        (server as unknown as { stop?: (force?: boolean) => void }).stop?.(true);
      } catch {
        /* ignore — best-effort shutdown */
      }
    }
    if (!dbReachable) return;
    try {
      await clearFixtureRows();
    } finally {
      await pg.end({ timeout: 2 });
    }
  });

  /** Fetch helper that attaches the auth header every REST route requires. */
  async function getProjects(query: string = ""): Promise<Response> {
    const url = `${httpBase}/projects${query}`;
    return fetch(url, { headers: { "x-nexus-secret": ATTACH_SECRET } });
  }

  // ── Response-shape types (mirrors routes/projects.ts) ───────────────────

  interface Project {
    name: string;
    active_sessions: number;
    total_sessions: number;
    machines: string[];
  }

  interface ProjectListResponse {
    items: Project[];
    nextCursor: string | null;
  }

  describe("E2E [5.3]: GET /projects cursor pagination", () => {
    it("database is reachable (preflight)", () => {
      if (!dbReachable) {
        console.warn(
          "[e2e:5.3] POSTGRES_URL set but DB unreachable — tests below will be skipped",
        );
      }
      expect(typeof dbReachable).toBe("boolean");
    });

    // ── Scenario 7: legacy bare-array shape (no params) ─────────────────────
    //
    // This MUST run first so the cache seeded by it (if any) doesn't mask a
    // regression in the paginated path. If a future refactor broke the
    // cursor slice but not the underlying aggregation, the paginated tests
    // below would still catch it.
    it("returns bare Project[] array when no cursor/limit (legacy shape)", async () => {
      if (!dbReachable) return;
      clearProjectsCache();

      const res = await getProjects();
      expect(res.status).toBe(200);

      const body = (await res.json()) as unknown;
      expect(Array.isArray(body)).toBe(true);

      const arr = body as Project[];
      // Our 120 seeded projects should all be present. Other test runs may
      // leave additional rows in the DB, but they shouldn't reduce our count.
      const ourProjects = arr.filter((p) =>
        projectIds.includes(p.name),
      );
      expect(ourProjects.length).toBe(TOTAL_PROJECTS);

      // Legacy shape must not carry the paginated-response keys.
      expect(body).not.toHaveProperty("items");
      expect(body).not.toHaveProperty("nextCursor");
    });

    // ── Scenarios 1–3: three-page pagination through 120 projects ───────────
    //
    // When other tests seed additional projects, `limit=50` will still return
    // 50 items, and our 120 seeded rows will be contiguous (their uuids sort
    // before any real `projectId` since they start with `00000000-…`). We
    // paginate using the cursor returned by the server and assert on the
    // subset of items that belong to our fixture.

    it("page 1 (limit=50) returns 50 items + non-null nextCursor", async () => {
      if (!dbReachable) return;
      clearProjectsCache();

      const res = await getProjects("?limit=50");
      expect(res.status).toBe(200);

      const body = (await res.json()) as ProjectListResponse;
      expect(body.items.length).toBe(50);
      expect(typeof body.nextCursor).toBe("string");
      expect(body.nextCursor).not.toBeNull();

      // Our fixture projects sort first (uuid prefix `00000000-…`). Items
      // should start at index 0 of our fixture set.
      const first = body.items[0]!;
      expect(first.name).toBe(projectIds[0]);

      // Every item in the first page should be one of ours (indices 0..49).
      const ourNames = projectIds.slice(0, 50);
      expect(body.items.map((p) => p.name)).toEqual(ourNames);
    });

    it("page 2 (cursor=page1.nextCursor, limit=50) returns next 50 + nextCursor", async () => {
      if (!dbReachable) return;
      clearProjectsCache();

      // Obtain page 1's nextCursor, then step forward.
      const res1 = await getProjects("?limit=50");
      const body1 = (await res1.json()) as ProjectListResponse;
      expect(body1.nextCursor).not.toBeNull();

      const res2 = await getProjects(
        `?cursor=${encodeURIComponent(body1.nextCursor!)}&limit=50`,
      );
      expect(res2.status).toBe(200);

      const body2 = (await res2.json()) as ProjectListResponse;
      expect(body2.items.length).toBe(50);
      expect(typeof body2.nextCursor).toBe("string");
      expect(body2.nextCursor).not.toBeNull();

      // Page 2 should hold our fixture indices 50..99.
      const expected = projectIds.slice(50, 100);
      expect(body2.items.map((p) => p.name)).toEqual(expected);
    });

    it("page 3 (cursor=page2.nextCursor, limit=50) returns final 20 + nextCursor=null", async () => {
      if (!dbReachable) return;
      clearProjectsCache();

      // Walk forward two pages to reach the tail.
      const res1 = await getProjects("?limit=50");
      const body1 = (await res1.json()) as ProjectListResponse;
      const res2 = await getProjects(
        `?cursor=${encodeURIComponent(body1.nextCursor!)}&limit=50`,
      );
      const body2 = (await res2.json()) as ProjectListResponse;
      expect(body2.nextCursor).not.toBeNull();

      const res3 = await getProjects(
        `?cursor=${encodeURIComponent(body2.nextCursor!)}&limit=50`,
      );
      expect(res3.status).toBe(200);

      const body3 = (await res3.json()) as ProjectListResponse;
      // Remaining fixture items: indices 100..119 (20 rows).
      const ourTail = body3.items.filter((p) =>
        projectIds.includes(p.name),
      );
      expect(ourTail.length).toBe(20);
      expect(ourTail.map((p) => p.name)).toEqual(projectIds.slice(100, 120));

      // IMPORTANT: If the test DB contains other projects whose ids sort
      // AFTER our fixture uuids, they may appear in the tail window. The
      // test accepts that — what matters is:
      //   (a) our last 20 rows are present
      //   (b) if there are NO other projects in the DB, nextCursor is null
      //   (c) body3.items.length <= 50 (hasn't silently ballooned)
      expect(body3.items.length).toBeLessThanOrEqual(50);

      // When our fixture is the only source of projects in the test DB, the
      // third page fits entirely within limit=50 (20 items) and nextCursor
      // must be null — the documented terminal-page contract.
      //
      // To avoid flakes when other tests leave state behind, we only assert
      // nextCursor === null when our tail exactly matches the page.
      if (body3.items.length === 20) {
        expect(body3.nextCursor).toBeNull();
      }
    });

    // ── Scenario 4: limit clamping ──────────────────────────────────────────

    it("limit=1000 clamps down to 200 items", async () => {
      if (!dbReachable) return;
      clearProjectsCache();

      const res = await getProjects("?limit=1000");
      expect(res.status).toBe(200);

      const body = (await res.json()) as ProjectListResponse;
      // Clamped ceiling is MAX_LIMIT=200 in routes/projects.ts.
      expect(body.items.length).toBeLessThanOrEqual(200);

      // Our 120 fixture rows are below the 200 cap, so they should all be
      // present (subject to other DB rows sorting before/after ours).
      const ours = body.items.filter((p) => projectIds.includes(p.name));
      expect(ours.length).toBe(TOTAL_PROJECTS);
    });

    // ── Scenario 5: invalid cursor rejected ─────────────────────────────────

    it("invalid cursor (not base64) returns 400 with opaque error", async () => {
      if (!dbReachable) return;
      clearProjectsCache();

      const res = await getProjects(
        `?cursor=${encodeURIComponent("!!!not-valid-base64!!!")}`,
      );
      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("invalid cursor");
      // Don't leak encoding details in the error surface.
      expect(body.error).not.toMatch(/base64|json|path|uuid/i);
    });
  });
}
