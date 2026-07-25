/**
 * Notification system tests — meeting state + project-aware routing (pure
 * logic, no database).
 *
 * The two `describe.skip("… requires live PG")` blocks that used to sit here
 * held 11 always-true placeholder bodies — permanently skipped, asserting
 * nothing, and reading as coverage. Removed by `tts-degradation-test-coverage`
 * task 1.3 after confirming (or writing) real coverage for every named
 * behavior:
 *
 *   Buffer CRUD    → `buffer.test.ts` (fake-db drizzle-chain assertions).
 *                    insert / mark-delivered / mark-expired / get-by-id-null
 *                    already existed; get-by-id-hit, query-by-status, and the
 *                    created_at-ascending ordering were WRITTEN there, since
 *                    `queryNotificationsByStatus` had no test at all.
 *   Meeting gate   → `manager-meeting-behavior.test.ts` (WRITTEN — the
 *                    drop/allow branches at `manager.ts:334-352` were
 *                    uncovered), plus `rules-engine.test.ts` Rule 2 and
 *                    `manager-presence.test.ts` for the presence-aware hold.
 *   Buffer/flush   → `manager.integration.test.ts` (meeting hold + coalesced
 *                    flush) and `held-queue.test.ts` (durable hold, flushDue).
 */

import { describe, expect, it, beforeEach } from "bun:test";
import { MeetingState } from "./meeting-state";
import { findMatchingRule, setRoutingRules, routeNotificationParallel } from "./router";

/** Helper to build a notification-like object for routing tests. */
function makeNotification(overrides: Record<string, unknown> = {}) {
  return {
    id: "notif-001",
    channel: "desktop",
    title: "Test Notification",
    body: "This is a test notification body",
    project: null as string | null,
    priority: "normal",
    status: "queued",
    createdAt: new Date(),
    sentAt: null as Date | null,
    ...overrides,
  };
}

// ─── Meeting state (pure logic) ─────────────────────────────────────────────

describe("meeting state", () => {
  it("starts inactive", () => {
    const state = new MeetingState();
    expect(state.active).toBe(false);
    expect(state.startedAt).toBeNull();
  });

  it("toggles meeting on and off", () => {
    const state = new MeetingState();

    state.start();
    expect(state.active).toBe(true);
    expect(state.startedAt).not.toBeNull();

    state.end();
    expect(state.active).toBe(false);
    expect(state.startedAt).toBeNull();
  });

  it("returns status object", () => {
    const state = new MeetingState();
    const status = state.status();
    expect(status).toEqual({ active: false, started_at: null });

    state.start();
    const activeStatus = state.status();
    expect(activeStatus.active).toBe(true);
    expect(typeof activeStatus.started_at).toBe("string");
  });
});

// ─── Delivery channels ────────────────────────────────────────────
//
// After `remove-notification-channels` (P4) both `desktop` and `tts`
// channels are pure signal handlers — the agent emits NotificationFired and
// the Mac listener does the actual rendering / synthesis. The old per-channel
// tests (which exercised the ElevenLabs HTTP path + terminal-notifier) are
// retired here; the router contract is covered by router.test.ts.

// ─── Project-aware routing (pure logic) ─────────────────────────────────────

describe("project-aware routing", () => {
  beforeEach(() => {
    setRoutingRules([]);
  });

  it("uses default rule when no project rules are set", () => {
    const notif = makeNotification({ project: "some-project" });
    const rule = findMatchingRule(notif as never);
    expect(rule.channels).toEqual(["desktop"]);
    expect(rule.meeting_behavior).toBe("buffer");
  });

  it("matches project-specific rule", () => {
    setRoutingRules([
      { project: "co", channels: ["desktop"], meeting_behavior: "buffer" },
      { project: "nx", channels: ["tts"], meeting_behavior: "allow" },
    ]);

    const notif = makeNotification({ project: "nx" });
    const rule = findMatchingRule(notif as never);
    expect(rule.channels).toEqual(["tts"]);
    expect(rule.meeting_behavior).toBe("allow");
  });

  it("falls back to wildcard rule when no project match", () => {
    setRoutingRules([
      { project: "co", channels: ["desktop"], meeting_behavior: "buffer" },
      { channels: ["desktop"], meeting_behavior: "drop" },
    ]);

    const notif = makeNotification({ project: "unknown-project" });
    const rule = findMatchingRule(notif as never);
    expect(rule.channels).toEqual(["desktop"]);
    expect(rule.meeting_behavior).toBe("drop");
  });

  it("routes notification to multiple channels", async () => {
    // Force the TTS handler down its signal-only branch so this test
    // doesn't reach out to ElevenLabs when an env-var leaks in from a
    // sibling test running in the same bun process.
    const originalKey = process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    try {
      setRoutingRules([
        { project: "co", channels: ["desktop", "tts"], meeting_behavior: "buffer" },
      ]);

      const notif = makeNotification({ project: "co" });
      const { delivered, failed } = await routeNotificationParallel(notif as never);
      // Both channels succeed (desktop signal-only; tts degrades to signal-only
      // with no ELEVENLABS_API_KEY) → both delivered, none failed.
      expect(failed).toHaveLength(0);
      expect(delivered).toHaveLength(2);
      expect(delivered.map((d) => d.channel)).toEqual(["desktop", "tts"]);
    } finally {
      if (originalKey !== undefined) process.env.ELEVENLABS_API_KEY = originalKey;
    }
  });
});
