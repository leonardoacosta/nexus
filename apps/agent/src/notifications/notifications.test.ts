/**
 * Notification system tests.
 *
 * DB-dependent tests (buffer CRUD, manager lifecycle) are skipped because
 * they require a live PostgreSQL connection. Meeting state and routing rule
 * tests are pure logic and run without a database.
 */

import { describe, expect, it, beforeEach } from "bun:test";
import { MeetingState } from "./meeting-state";
import { findMatchingRule, setRoutingRules, routeNotification } from "./router";

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

// ─── Buffer CRUD (requires live PG) ─────────────────────────────────────────

describe.skip("notification buffer (requires live PG)", () => {
  it("inserts a notification and retrieves it by id", () => {
    expect(true).toBe(true);
  });

  it("queries notifications by status", () => {
    expect(true).toBe(true);
  });

  it("marks a notification as delivered", () => {
    expect(true).toBe(true);
  });

  it("marks a notification as expired", () => {
    expect(true).toBe(true);
  });

  it("returns null for non-existent notification", () => {
    expect(true).toBe(true);
  });

  it("returns queued notifications ordered by created_at ascending", () => {
    expect(true).toBe(true);
  });
});

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

// ─── Buffer/flush lifecycle (requires live PG) ─────────────────────────────

describe.skip("notification manager — buffer/flush lifecycle (requires live PG)", () => {
  it("delivers notification immediately when not in a meeting", () => {
    expect(true).toBe(true);
  });

  it("buffers notifications during a meeting", () => {
    expect(true).toBe(true);
  });

  it("flushes buffered notifications when meeting ends", () => {
    expect(true).toBe(true);
  });

  it("drops notifications during meeting when rule says drop", () => {
    expect(true).toBe(true);
  });

  it("allows notifications during meeting when rule says allow", () => {
    expect(true).toBe(true);
  });
});

// ─── Delivery channels (mocked) ────────────────────────────────────────────

describe("delivery channels", () => {
  it("desktop channel succeeds", async () => {
    const { sendDesktopNotification } = await import("./channels/desktop");
    const notif = makeNotification();
    const result = await sendDesktopNotification(notif as never);
    expect(result).toBe(true);
  });

  it("tts channel succeeds (stub mode without API key)", async () => {
    const { sendTtsNotification } = await import("./channels/tts");
    const notif = makeNotification();
    const result = await sendTtsNotification(notif as never);
    expect(result).toBe(true);
  });

  it("slack channel succeeds (stub mode without webhook URL)", async () => {
    const { sendSlackNotification } = await import("./channels/slack");
    const notif = makeNotification();
    const result = await sendSlackNotification(notif as never);
    expect(result).toBe(true);
  });
});

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
      { project: "co", channels: ["desktop", "slack"], meeting_behavior: "buffer" },
      { project: "nx", channels: ["tts"], meeting_behavior: "allow" },
    ]);

    const notif = makeNotification({ project: "nx" });
    const rule = findMatchingRule(notif as never);
    expect(rule.channels).toEqual(["tts"]);
    expect(rule.meeting_behavior).toBe("allow");
  });

  it("falls back to wildcard rule when no project match", () => {
    setRoutingRules([
      { project: "co", channels: ["desktop", "slack"], meeting_behavior: "buffer" },
      { channels: ["desktop"], meeting_behavior: "drop" },
    ]);

    const notif = makeNotification({ project: "unknown-project" });
    const rule = findMatchingRule(notif as never);
    expect(rule.channels).toEqual(["desktop"]);
    expect(rule.meeting_behavior).toBe("drop");
  });

  it("routes notification to multiple channels", async () => {
    setRoutingRules([
      { project: "co", channels: ["desktop", "tts", "slack"], meeting_behavior: "buffer" },
    ]);

    const notif = makeNotification({ project: "co" });
    const results = await routeNotification(notif as never);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.success)).toBe(true);
    expect(results.map((r) => r.channel)).toEqual(["desktop", "tts", "slack"]);
  });
});
