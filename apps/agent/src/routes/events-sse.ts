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
import { createLogger } from "@nexus/core/node";
import {
  lifecycleBus,
  type LifecycleEnvelope,
} from "../services/lifecycle-bus";

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
  let keepalive: ReturnType<typeof setInterval> | null = null;
  let busHandler: ((envelope: LifecycleEnvelope) => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      // Send an initial keepalive comment.
      controller.enqueue(encoder.encode(": keepalive\n\n"));

      // Send a connected event.
      const connectEvent = JSON.stringify({
        type: "connected",
        timestamp: new Date().toISOString(),
      });
      controller.enqueue(encoder.encode(`data: ${connectEvent}\n\n`));

      // Keepalive every 30 seconds.
      keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          if (keepalive) clearInterval(keepalive);
        }
      }, 30_000);

      // Subscribe to lifecycle bus — push all events as SSE frames.
      // Hook events flow through here too — handleHooks emits HookEventReceived
      // after persistence, see add-hooks-sse-fanout (apply-2026-04-27-001).
      // Process-watcher reconciliation emits `RemoteSessionStarted` /
      // `RemoteSessionEnded` after each create/close — those frames carry
      // the discriminator fields menu bar / dashboard clients need to
      // update without a follow-up GET. See
      // openspec/changes/fix-agent-cc-session-tracking task 2.7.
      busHandler = (envelope: LifecycleEnvelope) => {
        try {
          const data = JSON.stringify(envelope);
          controller.enqueue(encoder.encode(`event: ${envelope.event}\ndata: ${data}\n\n`));
        } catch {
          // Stream closed — will be cleaned up in cancel()
        }
      };
      lifecycleBus.onAny(busHandler);
    },
    cancel() {
      // Client disconnected — cleanup subscriptions.
      if (keepalive) clearInterval(keepalive);
      if (busHandler) lifecycleBus.offAny(busHandler);
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
