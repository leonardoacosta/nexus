/**
 * Session route integration tests.
 *
 * These tests require a live PostgreSQL connection. They are automatically
 * skipped when `POSTGRES_URL` is not set in the environment, so they run
 * cleanly in local dev without setup and in CI when a real PG is available.
 *
 * To run locally:
 *   1. Start a PostgreSQL instance (see docker-compose.test.yml at project root)
 *   2. Run `pnpm db:push` in packages/db to create tables
 *   3. export POSTGRES_URL=postgres://nexus:nexus@localhost:5433/nexus_test
 *   4. bun test apps/agent/src/routes/sessions.test.ts
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { createSessionHandlers } from "./sessions";
import { openDatabase } from "../db/database";
import type { Db } from "@nexus/db";
import { sessions } from "@nexus/db";
import { eq } from "drizzle-orm";

const hasPg = !!process.env.POSTGRES_URL;

// ── Seed helpers ───────────────────────────────────────────────────────────

const TEST_IDS = ["test-sess-001", "test-sess-002", "test-sess-003"];

async function seedSessions(db: Db) {
  // Ensure clean state before seeding (idempotent across describe blocks)
  await teardown(db);
  const now = new Date().toISOString();
  await db.insert(sessions).values([
    {
      id: "test-sess-001",
      project: "alpha",
      machine: "test-machine",
      status: "active",
      startedAt: now,
      lastActivity: now,
      cwd: "/tmp/alpha",
      pid: 1001,
    },
    {
      id: "test-sess-002",
      project: "alpha",
      machine: "test-machine",
      status: "idle",
      startedAt: now,
      lastActivity: now,
      cwd: "/tmp/alpha2",
      pid: 1002,
    },
    {
      id: "test-sess-003",
      project: "beta",
      machine: "test-machine",
      status: "ended",
      startedAt: now,
      lastActivity: now,
      endedAt: now,
      cwd: "/tmp/beta",
      pid: 1003,
    },
  ]);
}

async function teardown(db: Db) {
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
    const body = await res.json() as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(2); // at least active + idle seeded
  });

  it("returns empty array when no sessions match a nonexistent project", async () => {
    const res = await handlers.getSessions(
      new URL("http://localhost/sessions?project=__nonexistent__"),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as unknown[];
    expect(body).toHaveLength(0);
  });
});

describe.skipIf(!hasPg)("GET /sessions?project= (requires live PG)", () => {
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

  it("filters by project name", async () => {
    const res = await handlers.getSessions(
      new URL("http://localhost/sessions?project=alpha"),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ project: string }>;
    expect(body.every((s) => s.project === "alpha")).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1);
  });

  it("returns empty array for non-matching project", async () => {
    const res = await handlers.getSessions(
      new URL("http://localhost/sessions?project=__no_such_project__"),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as unknown[];
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
    const body = await res.json() as Array<{ status: string }>;
    expect(body.every((s) => s.status === "active")).toBe(true);
  });

  it("combines project and status filters", async () => {
    const res = await handlers.getSessions(
      new URL("http://localhost/sessions?project=alpha&status=active"),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ project: string; status: string }>;
    expect(body.every((s) => s.project === "alpha" && s.status === "active")).toBe(true);
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
    const body = await res.json() as { id: string };
    expect(body.id).toBe("test-sess-001");
  });

  it("returns 404 for unknown session ID", async () => {
    const res = await handlers.getSessionById("__nonexistent-id__");
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
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
    const body = await res.json() as { error: string };
    expect(body.error).toContain("invalid status filter");
  });

  it("returns 400 for another invalid status value", async () => {
    const res = await handlers.getSessions(
      new URL("http://localhost/sessions?status=running"),
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("invalid status filter");
  });
});
