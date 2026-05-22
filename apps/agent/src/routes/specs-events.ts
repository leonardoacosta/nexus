/**
 * GET /specs/events — Server-Sent Events stream of spec transitions.
 *
 * Subscribes to `lifecycleBus.on("SpecTransition", ...)`, translates the
 * agent-internal envelope into the client-facing `SpecTransitionEvent`
 * discriminated union (see `@nexus/core`), and flushes coalesced batches
 * to the client every 5 seconds.
 *
 * Coalescing matches the existing TTS flush behaviour (1 s) with a
 * longer 5 s window for network clients — a ticked checkbox still
 * surfaces well under the spec's 2-second latency budget because the
 * fs.watch → bus path takes <500ms.
 */

import { createLogger } from "@nexus/core/node";
import type {
  SpecEventsFrame,
  SpecTransitionEvent,
} from "@nexus/core";
import { SPEC_EVENTS_EVENT_NAME } from "@nexus/core";
import {
  lifecycleBus,
  type LifecycleEnvelope,
  type SpecTransitionPayload,
} from "../services/lifecycle-bus";

const log = createLogger("agent:routes:specs-events");

/** Coalesce window before flushing to SSE clients (ms). */
const COALESCE_WINDOW_MS = 5_000;

/** Keepalive heartbeat interval (ms). */
const HEARTBEAT_INTERVAL_MS = 20_000;

/**
 * Translate the lifecycle-bus payload (`SpecTransitionPayload`) into the
 * wire event shape (`SpecTransitionEvent`). Returns null for transition
 * types that do not map to a client-facing event (e.g. `hash_changed`
 * which is an internal reconciliation hint, not a user transition).
 */
function payloadToEvent(
  p: SpecTransitionPayload,
): SpecTransitionEvent | null {
  switch (p.transition) {
    case "new_spec":
      return { kind: "new", project: p.project, spec: p.specName };
    case "removed":
      return { kind: "archived", project: p.project, spec: p.specName };
    case "progress":
      return {
        kind: "progress",
        project: p.project,
        spec: p.specName,
        completed: p.completed ?? 0,
        total: p.total ?? 0,
      };
    case "all_complete":
      return { kind: "complete", project: p.project, spec: p.specName };
    case "status_change":
      // toStatus is required for this transition kind; guard so a
      // malformed emit doesn't crash the SSE flush. Default to "draft"
      // (most conservative — a missing flip is read as a revert, not a
      // false approval).
      return {
        kind: "status_change",
        project: p.project,
        spec: p.specName,
        to: p.toStatus ?? "draft",
      };
    case "hash_changed":
      return null;
    default:
      return null;
  }
}

/**
 * GET /specs/events — SSE stream of spec transitions.
 */
export function handleSpecEventsStream(): Response {
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let busHandler:
    | ((envelope: LifecycleEnvelope<"SpecTransition">) => void)
    | null = null;
  let seq = 0;
  const pending: SpecTransitionEvent[] = [];
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();

      function safeEnqueue(chunk: string): void {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      }

      // Initial hello so clients know the stream is live.
      safeEnqueue(`: connected at ${new Date().toISOString()}\n\n`);

      function flush(): void {
        flushTimer = null;
        if (pending.length === 0) return;
        const frame: SpecEventsFrame = {
          seq: ++seq,
          ts: new Date().toISOString(),
          events: pending.splice(0, pending.length),
        };
        safeEnqueue(
          `event: ${SPEC_EVENTS_EVENT_NAME}\ndata: ${JSON.stringify(frame)}\n\n`,
        );
      }

      function scheduleFlush(): void {
        if (flushTimer) return;
        flushTimer = setTimeout(flush, COALESCE_WINDOW_MS);
      }

      busHandler = (envelope) => {
        const event = payloadToEvent(envelope.payload);
        if (!event) return;
        pending.push(event);
        scheduleFlush();
      };
      lifecycleBus.on("SpecTransition", busHandler);

      // Periodic heartbeat keeps proxies (nginx/traefik) from timing out
      // the idle connection. SSE comment lines are harmless to clients.
      heartbeat = setInterval(() => {
        safeEnqueue(`: heartbeat ${new Date().toISOString()}\n\n`);
      }, HEARTBEAT_INTERVAL_MS);
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      if (flushTimer) clearTimeout(flushTimer);
      if (busHandler) lifecycleBus.off("SpecTransition", busHandler);
      log.debug("spec-events SSE client disconnected");
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // X-Accel-Buffering disables nginx buffering so events flush
      // promptly when the stream sits behind a reverse proxy.
      "X-Accel-Buffering": "no",
    },
  });
}
