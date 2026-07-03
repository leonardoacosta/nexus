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
 * Wire a lifecycle-bus wildcard subscriber that pushes every envelope into
 * `controller` as an SSE frame, with self-cleaning teardown.
 *
 * This is the leak-fix seam: the `busHandler` catch calls `cleanup()` the first
 * time an `enqueue` throws. That covers the abnormal-close case where the
 * stream errored/closed but the ReadableStream `cancel()` callback never fired
 * (a client drop that Bun does not surface as a cancel) — without this the dead
 * subscriber would stay registered on the global bus forever and every later
 * emit would re-throw. `cleanup()` is idempotent (the `closed` guard) so it is
 * safe to call from the enqueue-failure path AND a later `cancel()`.
 *
 * `onClose` runs once, inside `cleanup`, for caller-owned teardown (clearing the
 * keepalive interval). Extracted from `handleEventsStream` so the exact
 * production wiring is unit-testable against a real ReadableStream controller.
 *
 * Hook events flow through here too — handleHooks emits HookEventReceived after
 * persistence (add-hooks-sse-fanout). Process-watcher reconciliation emits
 * `RemoteSessionStarted` / `RemoteSessionEnded` carrying the discriminator
 * fields menu bar / dashboard clients need to update without a follow-up GET
 * (fix-agent-cc-session-tracking task 2.7).
 */
export function subscribeStreamToBus(
  controller: Pick<ReadableStreamDefaultController<Uint8Array>, "enqueue">,
  onClose?: () => void,
): { cleanup: () => void; busHandler: (envelope: LifecycleEnvelope) => void } {
  const encoder = new TextEncoder();
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    lifecycleBus.offAny(busHandler);
    onClose?.();
  };
  const busHandler = (envelope: LifecycleEnvelope) => {
    try {
      const data = JSON.stringify(envelope);
      controller.enqueue(encoder.encode(`event: ${envelope.event}\ndata: ${data}\n\n`));
    } catch {
      // Stream closed abnormally without cancel() — self-clean so we do not
      // leak a dead subscriber on the global bus.
      cleanup();
    }
  };
  lifecycleBus.onAny(busHandler);
  return { cleanup, busHandler };
}

/**
 * SSE endpoint for real-time event streaming.
 *
 * Uses ReadableStream to push events as SSE frames.
 * Clients connect with: `new EventSource('/events/stream')`.
 */
export function handleEventsStream(): Response {
  let keepalive: ReturnType<typeof setInterval> | null = null;
  let cleanup: () => void = () => {};

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

      // Subscribe to lifecycle bus (self-cleaning). onClose clears keepalive.
      ({ cleanup } = subscribeStreamToBus(controller, () => {
        if (keepalive) clearInterval(keepalive);
      }));

      // Keepalive every 30 seconds.
      keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          cleanup();
        }
      }, 30_000);
    },
    cancel() {
      cleanup();
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
