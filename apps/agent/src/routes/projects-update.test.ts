/**
 * PATCH /projects/:id integration tests.
 *
 * Requires a live PostgreSQL connection. Automatically skipped when POSTGRES_URL
 * is not set. Run locally:
 *   1. export POSTGRES_URL=postgres://nexus:nexus@localhost:5433/nexus_test
 *   2. bun test apps/agent/src/routes/projects-update.test.ts
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
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
});
