/**
 * Settings route integration tests — POST /agents, DELETE /agents/:id.
 *
 * Requires a live PostgreSQL connection. Automatically skipped when POSTGRES_URL
 * is not set. Run locally:
 *   1. export POSTGRES_URL=postgres://nexus:nexus@localhost:5433/nexus_test
 *   2. bun test apps/agent/src/routes/settings.test.ts
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { handleSaveAgent, handleDeleteAgent } from "./settings";
import { openDatabase } from "../db/database";
import type { Db } from "@nexus/db";
import { agents } from "@nexus/db";
import { eq } from "drizzle-orm";

const hasPg = !!process.env.POSTGRES_URL;

const TEST_AGENT_ID = "test-agent-settings-001";

async function cleanupTestAgent(db: Db) {
  await db.delete(agents).where(eq(agents.id, TEST_AGENT_ID));
}

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe.skipIf(!hasPg)("POST /agents (requires live PG)", () => {
  let db: Db;

  beforeAll(async () => {
    db = openDatabase();
    await cleanupTestAgent(db);
  });

  afterAll(async () => {
    await cleanupTestAgent(db);
  });

  it("creates an agent record", async () => {
    const req = makeRequest({ name: TEST_AGENT_ID, host: "127.0.0.1", port: 7400 });
    const res = await handleSaveAgent(db, req);
    expect(res.status).toBe(200);
    const body = await res.json() as { saved: boolean };
    expect(body.saved).toBe(true);
  });

  it("upserts on repeat call (idempotent)", async () => {
    const req1 = makeRequest({ name: TEST_AGENT_ID, host: "127.0.0.1", port: 7400 });
    await handleSaveAgent(db, req1);
    const req2 = makeRequest({ name: TEST_AGENT_ID, host: "10.0.0.1", port: 7401 });
    const res = await handleSaveAgent(db, req2);
    expect(res.status).toBe(200);
    const body = await res.json() as { saved: boolean };
    expect(body.saved).toBe(true);
  });

  it("returns 400 for missing name", async () => {
    const req = makeRequest({ host: "127.0.0.1", port: 7400 });
    const res = await handleSaveAgent(db, req);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("name");
  });

  it("returns 400 for missing host", async () => {
    const req = makeRequest({ name: "x", port: 7400 });
    const res = await handleSaveAgent(db, req);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("host");
  });

  it("returns 400 for invalid port", async () => {
    const req = makeRequest({ name: "x", host: "127.0.0.1", port: 99999 });
    const res = await handleSaveAgent(db, req);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("port");
  });

  it("returns 400 for invalid JSON", async () => {
    const req = new Request("http://localhost/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    const res = await handleSaveAgent(db, req);
    expect(res.status).toBe(400);
  });
});

describe.skipIf(!hasPg)("DELETE /agents/:id (requires live PG)", () => {
  let db: Db;

  beforeAll(async () => {
    db = openDatabase();
    // Seed an agent to delete.
    await cleanupTestAgent(db);
    const req = makeRequest({ name: TEST_AGENT_ID, host: "127.0.0.1", port: 7400 });
    await handleSaveAgent(db, req);
  });

  afterAll(async () => {
    await cleanupTestAgent(db);
  });

  it("deletes an existing agent", async () => {
    const res = await handleDeleteAgent(db, TEST_AGENT_ID);
    expect(res.status).toBe(200);
    const body = await res.json() as { deleted: boolean };
    expect(body.deleted).toBe(true);
  });

  it("is idempotent — deleting non-existent agent returns 200", async () => {
    const res = await handleDeleteAgent(db, "__nonexistent-agent__");
    expect(res.status).toBe(200);
  });

  it("returns 400 for empty id", async () => {
    const res = await handleDeleteAgent(db, "");
    expect(res.status).toBe(400);
  });
});
