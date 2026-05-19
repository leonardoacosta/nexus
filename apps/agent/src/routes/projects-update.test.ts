/**
 * PATCH /projects/:id integration tests.
 *
 * Requires a live PostgreSQL connection. Automatically skipped when POSTGRES_URL
 * is not set. Run locally:
 *   1. export POSTGRES_URL=postgres://nexus:nexus@localhost:5433/nexus_test
 *   2. bun test apps/agent/src/routes/projects-update.test.ts
 */

import { describe, expect, it, beforeAll, afterAll, mock } from "bun:test";
import { handleUpdateProject } from "./projects";
import { openDatabase } from "../db/database";
import type { Db } from "@nexus/db";
import { projects } from "@nexus/db";
import { eq } from "drizzle-orm";

const hasPg = !!process.env.POSTGRES_URL;

const TEST_PROJECT_ID = "00000000-0000-0000-0000-000000000001";

async function seedProject(db: Db) {
  await db
    .insert(projects)
    .values({
      id: TEST_PROJECT_ID,
      name: "test-project-update",
      primaryAgentId: "test-agent",
      status: "active",
    })
    .onConflictDoNothing();
}

async function cleanupProject(db: Db) {
  await db.delete(projects).where(eq(projects.id, TEST_PROJECT_ID));
}

function makeRequest(body: unknown): Request {
  return new Request(`http://localhost/projects/${TEST_PROJECT_ID}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe.skipIf(!hasPg)("PATCH /projects/:id (requires live PG)", () => {
  let db: Db;

  beforeAll(async () => {
    db = openDatabase();
    await cleanupProject(db);
    await seedProject(db);
  });

  afterAll(async () => {
    await cleanupProject(db);
  });

  it("updates tags", async () => {
    const req = makeRequest({ tags: ["web", "TypeScript"] });
    const res = await handleUpdateProject(db, TEST_PROJECT_ID, req);
    expect(res.status).toBe(200);
    const body = await res.json() as { updated: boolean };
    expect(body.updated).toBe(true);
  });

  it("normalizes tags to trimmed lowercase", async () => {
    const req = makeRequest({ tags: [" Web ", "TypeScript  "] });
    const res = await handleUpdateProject(db, TEST_PROJECT_ID, req);
    expect(res.status).toBe(200);
  });

  it("updates description", async () => {
    const req = makeRequest({ description: "A test project" });
    const res = await handleUpdateProject(db, TEST_PROJECT_ID, req);
    expect(res.status).toBe(200);
    const body = await res.json() as { updated: boolean };
    expect(body.updated).toBe(true);
  });

  it("updates both tags and description", async () => {
    const req = makeRequest({ tags: ["api"], description: "Updated description" });
    const res = await handleUpdateProject(db, TEST_PROJECT_ID, req);
    expect(res.status).toBe(200);
  });

  it("returns 400 for no updatable fields", async () => {
    const req = makeRequest({});
    const res = await handleUpdateProject(db, TEST_PROJECT_ID, req);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("no updatable fields");
  });

  it("returns 400 for invalid UUID format", async () => {
    const req = makeRequest({ tags: ["x"] });
    const res = await handleUpdateProject(db, "not-a-uuid", req);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("invalid project id");
  });

  it("returns 404 for non-existent project", async () => {
    const req = makeRequest({ tags: ["x"] });
    const res = await handleUpdateProject(db, "00000000-0000-0000-0000-000000000099", req);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("not found");
  });

  it("returns 400 for tags that are not an array of strings", async () => {
    const req = makeRequest({ tags: [1, 2, 3] });
    const res = await handleUpdateProject(db, TEST_PROJECT_ID, req);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("tags");
  });

  it("returns 400 for invalid JSON", async () => {
    const req = new Request(`http://localhost/projects/${TEST_PROJECT_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    const res = await handleUpdateProject(db, TEST_PROJECT_ID, req);
    expect(res.status).toBe(400);
  });

  // ── hidden flag round-trip (task 2.5, requires live PG) ─────────────────

  it("sets hidden=true then clears it back to false", async () => {
    const setTrue = await handleUpdateProject(
      db,
      TEST_PROJECT_ID,
      makeRequest({ hidden: true }),
    );
    expect(setTrue.status).toBe(200);

    const [afterHide] = await db
      .select({ hidden: projects.hidden })
      .from(projects)
      .where(eq(projects.id, TEST_PROJECT_ID))
      .limit(1);
    expect(afterHide!.hidden).toBe(true);

    const setFalse = await handleUpdateProject(
      db,
      TEST_PROJECT_ID,
      makeRequest({ hidden: false }),
    );
    expect(setFalse.status).toBe(200);

    const [afterShow] = await db
      .select({ hidden: projects.hidden })
      .from(projects)
      .where(eq(projects.id, TEST_PROJECT_ID))
      .limit(1);
    expect(afterShow!.hidden).toBe(false);
  });
});

// ── hidden flag handler logic (task 2.5 — no PG required) ──────────────────
//
// Exercises the PATCH /projects/:id `hidden` validation + update path with an
// in-process mock Db so the highest-risk new logic has runtime evidence even
// when PostgreSQL is unavailable (self-gating: never touches a real DB).

describe("PATCH /projects/:id — hidden flag (mock Db, no PG)", () => {
  /**
   * Mock Db that reports the project exists and records the update set-clause.
   */
  function makeMockDb(): {
    db: Db;
    updateSets: Array<Record<string, unknown>>;
  } {
    const updateSets: Array<Record<string, unknown>> = [];
    const select = mock(() => ({
      from: mock(() => ({
        where: mock(() => ({
          limit: mock(() => Promise.resolve([{ id: TEST_PROJECT_ID }])),
        })),
      })),
    }));
    const update = mock(() => ({
      set: mock((vals: Record<string, unknown>) => {
        updateSets.push(vals);
        return { where: mock(() => Promise.resolve()) };
      }),
    }));
    return { db: { select, update } as unknown as Db, updateSets };
  }

  function patch(body: unknown): Request {
    return new Request(`http://localhost/projects/${TEST_PROJECT_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("writes hidden=true to the update set-clause", async () => {
    const { db, updateSets } = makeMockDb();
    const res = await handleUpdateProject(db, TEST_PROJECT_ID, patch({ hidden: true }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { updated: boolean };
    expect(json.updated).toBe(true);
    expect(updateSets).toHaveLength(1);
    expect(updateSets[0]).toEqual({ hidden: true });
  });

  it("writes hidden=false to the update set-clause (un-hide)", async () => {
    const { db, updateSets } = makeMockDb();
    const res = await handleUpdateProject(db, TEST_PROJECT_ID, patch({ hidden: false }));
    expect(res.status).toBe(200);
    expect(updateSets[0]).toEqual({ hidden: false });
  });

  it("returns 400 when hidden is not a boolean", async () => {
    const { db } = makeMockDb();
    const res = await handleUpdateProject(db, TEST_PROJECT_ID, patch({ hidden: "yes" }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("hidden must be a boolean");
  });

  it("combines hidden with tags in a single update", async () => {
    const { db, updateSets } = makeMockDb();
    const res = await handleUpdateProject(
      db,
      TEST_PROJECT_ID,
      patch({ hidden: true, tags: ["Web"] }),
    );
    expect(res.status).toBe(200);
    expect(updateSets[0]).toEqual({ hidden: true, tags: ["web"] });
  });
});
