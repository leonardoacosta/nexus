/**
 * GET /events — Server-Sent Events endpoint for audit events.
 *
 * For the Bun agent, this is a simple query endpoint (not a live SSE
 * stream) that returns recent audit/session events. This matches the
 * Rust agent's GET /events which also returns a JSON array, not an
 * SSE stream. The SSE streaming pattern can be added later when the
 * internal event bus is wired up.
 *
 * Query params:
 *   ?type=<event_type>  — filter by event type
 *   ?target=<target>    — filter by target
 *   ?limit=<N>          — max results (default 100)
 */

import type { Db } from "@nexus/db";
import { sessionEvents } from "@nexus/db";
import { desc, eq } from "drizzle-orm";
import { createLogger } from "@nexus/core";

const log = createLogger("agent:routes:events");

// ---------------------------------------------------------------------------
// GET /events — return recent events (JSON array)
// ---------------------------------------------------------------------------

export async function handleGetEvents(
  db: Db,
  url: URL,
): Promise<Response> {
  const typeFilter = url.searchParams.get("type");
  const targetFilter = url.searchParams.get("target");
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Math.min(parseInt(limitParam, 10) || 100, 1000) : 100;

  try {
    let rows;

    if (typeFilter) {
      rows = await db
        .select()
        .from(sessionEvents)
        .where(eq(sessionEvents.eventType, typeFilter))
        .orderBy(desc(sessionEvents.timestamp))
        .limit(limit);
    } else {
      rows = await db
        .select()
        .from(sessionEvents)
        .orderBy(desc(sessionEvents.timestamp))
        .limit(limit);
    }

    // Apply target filter in JS (sessionEvents schema does not have a target column).
    const filtered = targetFilter
      ? rows.filter((r) => {
          try {
            const meta = r.metadata ? JSON.parse(r.metadata) : null;
            return meta && meta.target === targetFilter;
          } catch {
            return false;
          }
        })
      : rows;

    return new Response(JSON.stringify(filtered), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    log.error({ err }, "events query failed");
    return new Response(
      JSON.stringify({ error: "internal error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}

// ---------------------------------------------------------------------------
// GET /events/stream — Server-Sent Events stream (future)
// ---------------------------------------------------------------------------

/**
 * SSE endpoint for real-time event streaming.
 *
 * Uses ReadableStream to push events as SSE frames.
 * Clients connect with: `new EventSource('/events/stream')`.
 */
export function handleEventsStream(): Response {
  const stream = new ReadableStream({
    start(controller) {
      // Send an initial keepalive comment.
      controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));

      // Send a connected event.
      const connectEvent = JSON.stringify({
        type: "connected",
        timestamp: new Date().toISOString(),
      });
      controller.enqueue(
        new TextEncoder().encode(`data: ${connectEvent}\n\n`),
      );

      // Keepalive every 30 seconds.
      const keepalive = setInterval(() => {
        try {
          controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
        } catch {
          clearInterval(keepalive);
        }
      }, 30_000);

      // The stream stays open until the client disconnects.
      // Event subscriptions would be wired here when the internal
      // event bus is implemented.
    },
    cancel() {
      // Client disconnected — cleanup subscriptions.
      log.debug("SSE client disconnected");
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
