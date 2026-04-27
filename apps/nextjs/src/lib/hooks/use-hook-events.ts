"use client";

/**
 * use-hook-events.ts
 *
 * Shared React hook that subscribes to the same-origin SSE proxy at
 * `/api/notifications/stream` (forwarded from the agent's `/events/stream`)
 * and invokes a caller-supplied callback when an envelope matches the
 * caller-supplied predicate. Used by the session-detail and project-detail
 * pages to trigger live refetches when `HookEventReceived` events arrive.
 *
 * Design mirrors `apps/nextjs/src/app/specs/spec-events-transport.ts`:
 *  - Exponential backoff reconnect (1s → 2s → 4s → 8s → 16s → 30s cap)
 *  - Cleanup on unmount: close EventSource, clear timers
 *  - Subscriber filtering is client-side per the hooks-endpoint spec
 *
 * The agent emits SSE frames with named event lines, e.g.
 *   event: HookEventReceived
 *   data: {"event":"HookEventReceived","payload":{...},"source":"local",...}
 *
 * This hook subscribes by listening on `message` (default) plus the named
 * event so it works whether the proxy preserves the named-event line or
 * coalesces frames into the default `message` channel.
 *
 * Spec: openspec/changes/add-hooks-sse-fanout/specs/hooks-endpoint/spec.md
 */

import { useEffect, useRef } from "react";

const BACKOFF_SEQUENCE_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

/**
 * SSE envelope shape — mirrors `LifecycleEnvelope` in the agent's
 * `apps/agent/src/services/lifecycle-bus.ts`. Kept as a local interface to
 * avoid importing agent-internal types into the dashboard bundle.
 */
export interface LifecycleEnvelope<TPayload = unknown> {
  event: string;
  payload: TPayload;
  source?: string;
  seq?: number;
  ts?: string;
  origin?: string;
}

export interface UseHookEventsOptions {
  /**
   * Endpoint to subscribe to. Defaults to the dashboard's same-origin SSE
   * proxy. Tests pass a unique URL to assert reconnect behavior.
   */
  url?: string;
  /**
   * Optional gate. When `false`, the hook does not open a connection.
   * Useful when the agent is unreachable and the page already shows a
   * banner — avoids a tight reconnect loop against a 503 endpoint.
   */
  enabled?: boolean;
  /** Override the EventSource constructor — used by tests. */
  eventSourceCtor?: typeof EventSource;
}

export type HookEventPredicate = (envelope: LifecycleEnvelope) => boolean;
export type HookEventCallback = (envelope: LifecycleEnvelope) => void;

/**
 * Subscribe to the SSE stream and invoke `onMatch(envelope)` whenever
 * `predicate(envelope)` returns true. The hook auto-mounts on render and
 * tears down on unmount.
 *
 * `predicate` and `onMatch` are read through refs so callers don't need to
 * memoize them — re-renders with new function identities won't re-open the
 * EventSource. The `url` and `enabled` options DO trigger re-subscribe.
 */
export function useHookEvents(
  predicate: HookEventPredicate,
  onMatch: HookEventCallback,
  options: UseHookEventsOptions = {},
): void {
  const { url = "/api/notifications/stream", enabled = true, eventSourceCtor } =
    options;

  const predicateRef = useRef(predicate);
  const onMatchRef = useRef(onMatch);
  predicateRef.current = predicate;
  onMatchRef.current = onMatch;

  useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined") return;
    const Ctor = eventSourceCtor ?? window.EventSource;
    if (!Ctor) return;

    let attempts = 0;
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const handleFrame = (evt: MessageEvent) => {
      try {
        const env = JSON.parse(evt.data) as LifecycleEnvelope;
        if (!env || typeof env.event !== "string") return;
        if (predicateRef.current(env)) {
          onMatchRef.current(env);
        }
      } catch {
        // Malformed frame — skip silently. The next valid frame will
        // refresh state.
      }
    };

    const clearReconnectTimer = () => {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const scheduleReconnect = () => {
      if (cancelled) return;
      const idx = Math.min(attempts, BACKOFF_SEQUENCE_MS.length - 1);
      const delay = BACKOFF_SEQUENCE_MS[idx] ?? 30_000;
      attempts += 1;
      clearReconnectTimer();
      reconnectTimer = setTimeout(connect, delay);
    };

    const connect = () => {
      clearReconnectTimer();
      if (cancelled) return;
      // Close any lingering socket before reopening.
      es?.close();

      const next = new Ctor(url);
      es = next;

      next.addEventListener("open", () => {
        attempts = 0;
      });

      // The agent emits named events (`event: HookEventReceived\n…`). The
      // EventSource API delivers these via `addEventListener("<name>")`.
      // We listen on both the generic `message` channel AND the specific
      // names so the hook works whether the proxy preserves the name line
      // or collapses to the default channel. Predicate filtering by
      // `env.event` makes double-delivery harmless — but in practice
      // browsers route a named frame to the named listener only.
      next.addEventListener("message", handleFrame);
      next.addEventListener("HookEventReceived", handleFrame as EventListener);

      next.addEventListener("error", () => {
        // EventSource auto-reconnects natively, but we drive backoff
        // explicitly so the timing is observable + testable.
        next.close();
        if (es === next) es = null;
        scheduleReconnect();
      });
    };

    connect();

    return () => {
      cancelled = true;
      clearReconnectTimer();
      es?.close();
      es = null;
    };
  }, [url, enabled, eventSourceCtor]);
}

/**
 * Predicate factory: build a `HookEventReceived` filter scoped to a single
 * session id. Exported so callers don't open-code the envelope shape.
 */
export function isHookEventForSession(sessionId: string): HookEventPredicate {
  return (env) => {
    if (env.event !== "HookEventReceived") return false;
    const p = env.payload as { sessionId?: unknown } | undefined;
    return !!p && p.sessionId === sessionId;
  };
}

/**
 * Predicate factory: build a `HookEventReceived` filter scoped to a single
 * project name. The project field is optional in the payload, so an event
 * without `project` never matches.
 */
export function isHookEventForProject(project: string): HookEventPredicate {
  return (env) => {
    if (env.event !== "HookEventReceived") return false;
    const p = env.payload as { project?: unknown } | undefined;
    return !!p && p.project === project;
  };
}
