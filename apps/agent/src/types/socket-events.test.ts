import { describe, test, expect } from "bun:test";
import { isSocketEvent } from "./socket-events";

/**
 * Regression guard for nx-z0vm4.
 *
 * The `add-hooks-notification-triggers` feature (archived 2026-04-27) added
 * notification rules for `tool_use_fail`, `permission_request`, and
 * `hook_failure` in `notifications/hook-rules.ts`, but the three event types
 * were never added to `VALID_EVENTS` in `socket-events.ts`. As a result
 * `isSocketEvent` rejected every one of them and the socket server dropped
 * them with "socket: unrecognised JSON (not event or command)" — the entire
 * feature was silently dead in production from 2026-04-27 until 2026-07-14.
 *
 * These assertions FAIL against the pre-fix `VALID_EVENTS` (the three names
 * absent) and pass once they are present. This is exactly the silent-drop
 * class that needs a permanent guard.
 */
describe("isSocketEvent — notification-trigger events (nx-z0vm4)", () => {
  // The CC hook wire form uses `event_type`; isSocketEvent normalizes it to
  // `event` before checking the VALID_EVENTS set.
  const NOTIFICATION_TRIGGER_EVENTS = [
    "tool_use_fail",
    "permission_request",
    "hook_failure",
  ] as const;

  for (const eventType of NOTIFICATION_TRIGGER_EVENTS) {
    test(`accepts "${eventType}" via the CC event_type wire field`, () => {
      expect(isSocketEvent({ event_type: eventType, session_id: "s1" })).toBe(
        true,
      );
    });

    test(`accepts "${eventType}" via the normalized event field`, () => {
      expect(isSocketEvent({ event: eventType, session_id: "s1" })).toBe(true);
    });
  }

  test("concrete tool_use_fail payload is accepted (was dropped pre-fix)", () => {
    const payload = {
      event_type: "tool_use_fail",
      session_id: "s1",
      project: "nx",
      tool: "Bash",
      error: "command failed with exit 1",
      command: "false",
    };
    expect(isSocketEvent(payload)).toBe(true);
  });

  test("still rejects a genuinely unknown event type", () => {
    expect(isSocketEvent({ event_type: "not_a_real_event" })).toBe(false);
  });

  test("still rejects non-objects and missing discriminant", () => {
    expect(isSocketEvent(null)).toBe(false);
    expect(isSocketEvent("tool_use_fail")).toBe(false);
    expect(isSocketEvent({ session_id: "s1" })).toBe(false);
  });
});
