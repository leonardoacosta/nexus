/**
 * Unit tests for hook-event-throttle.
 *
 * Validates the coalescing buffer behavior in isolation by binding a
 * `LifecycleBus` instance directly (no singleton dependency).
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  LifecycleBus,
  type LifecycleEnvelope,
  type HookEventReceivedPayload,
} from "./lifecycle-bus";
import {
  createHookEventThrottle,
  THROTTLE_WINDOW_MS,
  THROTTLED_EVENT_TYPES,
  type HookEventThrottle,
} from "./hook-event-throttle";

// Use a tighter window for tests so suite stays fast (~50ms vs 500ms prod).
const TEST_WINDOW_MS = 50;

describe("hook-event-throttle", () => {
  let bus: LifecycleBus;
  let received: LifecycleEnvelope<"HookEventReceived">[];
  let throttle: HookEventThrottle;

  beforeEach(() => {
    bus = new LifecycleBus();
    received = [];
    bus.on("HookEventReceived", (env) => received.push(env));
    throttle = createHookEventThrottle(bus, { windowMs: TEST_WINDOW_MS });
  });

  // ── Constants ───────────────────────────────────────────────────────────

  test("THROTTLE_WINDOW_MS production default is 500ms", () => {
    expect(THROTTLE_WINDOW_MS).toBe(500);
  });

  test("THROTTLED_EVENT_TYPES includes tool_use_start and tool_use_end", () => {
    expect(THROTTLED_EVENT_TYPES.has("tool_use_start")).toBe(true);
    expect(THROTTLED_EVENT_TYPES.has("tool_use_end")).toBe(true);
  });

  // ── Pass-through (non-throttled types) ──────────────────────────────────

  test("non-throttled types return { throttled: false } and do not buffer", () => {
    const payload: HookEventReceivedPayload = {
      eventType: "session_start",
      sessionId: "s1",
      eventId: 1,
    };
    const result = throttle.enqueue(payload);
    expect(result.throttled).toBe(false);
    expect(throttle.pendingCount()).toBe(0);
    // Caller is responsible for emitting — throttle did NOT emit.
    expect(received).toHaveLength(0);
  });

  // ── Coalescing burst ────────────────────────────────────────────────────

  test("burst of throttled events coalesces to one emit with count=N", async () => {
    const base: HookEventReceivedPayload = {
      eventType: "tool_use_end",
      sessionId: "s1",
      eventId: 0,
    };

    // Fire 5 events in quick succession with ascending event ids.
    for (let i = 1; i <= 5; i++) {
      throttle.enqueue({ ...base, eventId: i });
    }

    expect(throttle.pendingCount()).toBe(1);
    expect(received).toHaveLength(0);

    // Wait past the window — buffer should flush exactly once.
    await Bun.sleep(TEST_WINDOW_MS + 30);

    expect(received).toHaveLength(1);
    expect(received[0]!.payload.count).toBe(5);
    expect(received[0]!.payload.eventId).toBe(5);
    expect(received[0]!.payload.eventType).toBe("tool_use_end");
    expect(received[0]!.payload.sessionId).toBe("s1");
  });

  // ── Single event flushes with count=1 ───────────────────────────────────

  test("single throttled event flushes with count=1 after window", async () => {
    throttle.enqueue({
      eventType: "tool_use_end",
      sessionId: "s1",
      eventId: 42,
    });

    await Bun.sleep(TEST_WINDOW_MS + 30);

    expect(received).toHaveLength(1);
    expect(received[0]!.payload.count).toBe(1);
    expect(received[0]!.payload.eventId).toBe(42);
  });

  // ── Per-session isolation ───────────────────────────────────────────────

  test("per-session keys isolate bursts (session A and B coalesce independently)", async () => {
    for (let i = 1; i <= 3; i++) {
      throttle.enqueue({
        eventType: "tool_use_end",
        sessionId: "A",
        eventId: i,
      });
    }
    for (let i = 100; i <= 105; i++) {
      throttle.enqueue({
        eventType: "tool_use_end",
        sessionId: "B",
        eventId: i,
      });
    }

    expect(throttle.pendingCount()).toBe(2);

    await Bun.sleep(TEST_WINDOW_MS + 30);

    expect(received).toHaveLength(2);
    const bySession = new Map(received.map((r) => [r.payload.sessionId, r]));
    expect(bySession.get("A")!.payload.count).toBe(3);
    expect(bySession.get("A")!.payload.eventId).toBe(3);
    expect(bySession.get("B")!.payload.count).toBe(6);
    expect(bySession.get("B")!.payload.eventId).toBe(105);
  });

  // ── Per-event-type isolation ────────────────────────────────────────────

  test("per-event-type keys isolate bursts within the same session", async () => {
    throttle.enqueue({
      eventType: "tool_use_start",
      sessionId: "s1",
      eventId: 1,
    });
    throttle.enqueue({
      eventType: "tool_use_start",
      sessionId: "s1",
      eventId: 2,
    });
    throttle.enqueue({
      eventType: "tool_use_end",
      sessionId: "s1",
      eventId: 3,
    });

    expect(throttle.pendingCount()).toBe(2);

    await Bun.sleep(TEST_WINDOW_MS + 30);

    expect(received).toHaveLength(2);
    const byType = new Map(received.map((r) => [r.payload.eventType, r]));
    expect(byType.get("tool_use_start")!.payload.count).toBe(2);
    expect(byType.get("tool_use_end")!.payload.count).toBe(1);
  });

  // ── Window expiry resets ────────────────────────────────────────────────

  test("after window flushes, next event starts a fresh window", async () => {
    throttle.enqueue({
      eventType: "tool_use_end",
      sessionId: "s1",
      eventId: 1,
    });
    await Bun.sleep(TEST_WINDOW_MS + 30);
    expect(received).toHaveLength(1);
    expect(received[0]!.payload.count).toBe(1);

    // Second burst — independent window.
    throttle.enqueue({
      eventType: "tool_use_end",
      sessionId: "s1",
      eventId: 2,
    });
    throttle.enqueue({
      eventType: "tool_use_end",
      sessionId: "s1",
      eventId: 3,
    });
    await Bun.sleep(TEST_WINDOW_MS + 30);

    expect(received).toHaveLength(2);
    expect(received[1]!.payload.count).toBe(2);
    expect(received[1]!.payload.eventId).toBe(3);
  });

  // ── flush() forces immediate drain ──────────────────────────────────────

  test("flush() drains all pending buffers immediately", () => {
    throttle.enqueue({
      eventType: "tool_use_end",
      sessionId: "s1",
      eventId: 1,
    });
    throttle.enqueue({
      eventType: "tool_use_start",
      sessionId: "s2",
      eventId: 2,
    });

    expect(received).toHaveLength(0);
    throttle.flush();
    expect(received).toHaveLength(2);
    expect(throttle.pendingCount()).toBe(0);
  });

  // ── clear() drops buffers without emitting ──────────────────────────────

  test("clear() drops pending buffers without emitting", async () => {
    throttle.enqueue({
      eventType: "tool_use_end",
      sessionId: "s1",
      eventId: 1,
    });
    expect(throttle.pendingCount()).toBe(1);

    throttle.clear();
    expect(throttle.pendingCount()).toBe(0);

    // Sleep past the window; the cleared timer must not fire.
    await Bun.sleep(TEST_WINDOW_MS + 30);
    expect(received).toHaveLength(0);
  });

  // ── Custom throttledTypes set ───────────────────────────────────────────

  test("custom throttledTypes set respects override", async () => {
    const altBus = new LifecycleBus();
    const altReceived: LifecycleEnvelope<"HookEventReceived">[] = [];
    altBus.on("HookEventReceived", (e) => altReceived.push(e));
    const altThrottle = createHookEventThrottle(altBus, {
      windowMs: TEST_WINDOW_MS,
      throttledTypes: new Set(["custom_high_freq"]),
    });

    // tool_use_end is no longer throttled in this configuration.
    expect(
      altThrottle.enqueue({
        eventType: "tool_use_end",
        sessionId: "s1",
        eventId: 1,
      }).throttled,
    ).toBe(false);

    // custom_high_freq IS throttled.
    expect(
      altThrottle.enqueue({
        eventType: "custom_high_freq",
        sessionId: "s1",
        eventId: 2,
      }).throttled,
    ).toBe(true);

    await Bun.sleep(TEST_WINDOW_MS + 30);
    expect(altReceived).toHaveLength(1);
    expect(altReceived[0]!.payload.eventType).toBe("custom_high_freq");
  });
});
