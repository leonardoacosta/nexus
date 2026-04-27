/**
 * Hook-event throttle — coalescing buffer for high-frequency hook events.
 *
 * Some hook event types (`tool_use_start`, `tool_use_end`) fire many times
 * per second during active CC sessions. Emitting each one onto the lifecycle
 * bus floods every SSE subscriber and serves no UI purpose — the dashboards
 * only need to know "something happened recently" granularity.
 *
 * This module buffers throttled event types per `(eventType, sessionId)` key
 * and flushes the latest payload after `THROTTLE_WINDOW_MS` of quiet, with a
 * `count` field indicating how many events were suppressed in the window.
 *
 * Non-throttled event types pass through immediately — `enqueue` returns
 * `{ throttled: false }` and the caller emits directly on the bus.
 *
 * See: openspec/changes/add-hooks-sse-fanout/specs/hooks-endpoint/spec.md
 */

import type {
  HookEventReceivedPayload,
  LifecycleBus,
} from "./lifecycle-bus";

/**
 * Window in milliseconds. Exported so tests can override via direct mutation
 * is NOT supported — instead tests pass a custom window via the factory
 * function below. The const captures the production default for human
 * reference and the bus-bound singleton (`enqueueHookEvent`) consumes it.
 */
export const THROTTLE_WINDOW_MS = 500;

/**
 * Event types that participate in throttling. Lifecycle/diagnostic events
 * (`session_start`, `notification`, etc.) bypass the buffer — they're rare
 * enough that immediate fan-out has zero cost.
 */
export const THROTTLED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "tool_use_start",
  "tool_use_end",
]);

interface BufferEntry {
  count: number;
  /** Latest payload — flush will use this verbatim plus the count. */
  lastPayload: HookEventReceivedPayload;
  timer: ReturnType<typeof setTimeout>;
}

export interface EnqueueResult {
  /**
   * `true` when the throttle owns emission (timer will fire later).
   * `false` when the caller MUST emit directly on the lifecycle bus.
   */
  throttled: boolean;
}

export interface HookEventThrottle {
  enqueue(payload: HookEventReceivedPayload): EnqueueResult;
  /** Flush all pending buffers immediately (test/shutdown hook). */
  flush(): void;
  /** Clear all pending timers without emitting (test cleanup). */
  clear(): void;
  /** Inspect pending buffers (test only). */
  pendingCount(): number;
}

export interface HookEventThrottleOptions {
  windowMs?: number;
  throttledTypes?: ReadonlySet<string>;
}

/**
 * Build a throttle bound to a specific lifecycle bus instance.
 *
 * Production wiring (`handleHooks`) uses the singleton `lifecycleBus` —
 * tests construct their own `LifecycleBus` and pass it in directly.
 */
export function createHookEventThrottle(
  bus: Pick<LifecycleBus, "emit">,
  opts: HookEventThrottleOptions = {},
): HookEventThrottle {
  const windowMs = opts.windowMs ?? THROTTLE_WINDOW_MS;
  const throttledTypes = opts.throttledTypes ?? THROTTLED_EVENT_TYPES;
  const buffers = new Map<string, BufferEntry>();

  function key(p: HookEventReceivedPayload): string {
    return `${p.eventType}:${p.sessionId}`;
  }

  function flushKey(k: string): void {
    const entry = buffers.get(k);
    if (!entry) return;
    clearTimeout(entry.timer);
    buffers.delete(k);
    bus.emit("HookEventReceived", {
      ...entry.lastPayload,
      count: entry.count,
    });
  }

  function enqueue(payload: HookEventReceivedPayload): EnqueueResult {
    if (!throttledTypes.has(payload.eventType)) {
      return { throttled: false };
    }
    const k = key(payload);
    const existing = buffers.get(k);
    if (existing) {
      existing.count += 1;
      existing.lastPayload = payload;
      // Reset the window — we coalesce the active burst until quiet.
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => flushKey(k), windowMs);
    } else {
      const entry: BufferEntry = {
        count: 1,
        lastPayload: payload,
        timer: setTimeout(() => flushKey(k), windowMs),
      };
      buffers.set(k, entry);
    }
    return { throttled: true };
  }

  function flush(): void {
    const keys = Array.from(buffers.keys());
    for (const k of keys) flushKey(k);
  }

  function clear(): void {
    for (const entry of buffers.values()) clearTimeout(entry.timer);
    buffers.clear();
  }

  return {
    enqueue,
    flush,
    clear,
    pendingCount: () => buffers.size,
  };
}

// ---------------------------------------------------------------------------
// Singleton — bound to the lifecycle bus singleton
// ---------------------------------------------------------------------------

import { lifecycleBus } from "./lifecycle-bus";

export const hookEventThrottle = createHookEventThrottle(lifecycleBus);
