/**
 * Settings route handlers — agent configuration CRUD.
 *
 * These endpoints mirror the write paths that apps/nextjs used to perform
 * directly via drizzle. The agent is the single source of truth for its
 * agent registry; the dashboard now delegates all writes here.
 */

import type { Db } from "@nexus/db";
import { agents as agentsTable, eq } from "@nexus/db";

// ── POST /agents ─────────────────────────────────────────────────────────────

/**
 * POST /agents — upsert an agent record.
 *
 * Body: `{ name: string, host: string, port: number }`
 *
 * Uses INSERT ... ON CONFLICT DO UPDATE so repeat calls are idempotent.
 * Returns 200 `{ saved: true }` on success, 400 on invalid input.
 */
export async function handleSaveAgent(db: Db, request: Request): Promise<Response> {
  let body: { name?: unknown; host?: unknown; port?: unknown };
  try {
    body = (await request.json()) as { name?: unknown; host?: unknown; port?: unknown };
  } catch {
    return new Response(
      JSON.stringify({ error: "invalid JSON body" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  if (typeof body.name !== "string" || body.name.trim() === "") {
    return new Response(
      JSON.stringify({ error: "name is required and must be a non-empty string" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  if (typeof body.host !== "string" || body.host.trim() === "") {
    return new Response(
      JSON.stringify({ error: "host is required and must be a non-empty string" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  if (typeof body.port !== "number" || !Number.isInteger(body.port) || body.port < 1 || body.port > 65535) {
    return new Response(
      JSON.stringify({ error: "port is required and must be an integer between 1 and 65535" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const name = body.name.trim();
  const host = body.host.trim();
  const port = body.port as number;

  await db
    .insert(agentsTable)
    .values({
      id: name,
      name,
      host,
      port,
      enabled: true,
    })
    .onConflictDoUpdate({
      target: agentsTable.id,
      set: {
        name,
        host,
        port,
        enabled: true,
      },
    });

  return new Response(
    JSON.stringify({ saved: true }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

// ── DELETE /agents/:id ────────────────────────────────────────────────────────

/**
 * DELETE /agents/:id — remove an agent record.
 *
 * Idempotent — deleting a non-existent agent returns 200 (no content to fail over).
 * Returns 200 `{ deleted: true }` always, 400 if the id format is invalid.
 */
export async function handleDeleteAgent(db: Db, id: string): Promise<Response> {
  // Reject empty or suspiciously long ids to avoid gratuitous DB calls.
  if (!id || id.length > 255) {
    return new Response(
      JSON.stringify({ error: "invalid agent id" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  await db.update(agentsTable).set({ deletedAt: new Date() }).where(eq(agentsTable.id, id));

  return new Response(
    JSON.stringify({ deleted: true }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
