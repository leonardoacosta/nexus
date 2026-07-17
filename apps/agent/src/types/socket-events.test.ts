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

/**
 * Regression guard for nx-9qsmb.4 — second recurrence of the nx-z0vm4 class.
 *
 * A live `journalctl --user -u nexus-agent` audit (2026-07-17) caught
 * `user_prompt` and `instructions_loaded` events being dropped as
 * "unrecognised JSON" in real time. Auditing every `event_type` string
 * `cc/scripts/hooks/telemetry.sh`'s `nx_send` call sites actually emit (both
 * the direct `json_event ... "<type>" ...` sites and the generic
 * `SIMPLE_EVENTS["<type>"]` dispatch) found 15 total missing from
 * `VALID_EVENTS`, not just the two caught live. This list is the source of
 * truth those call sites were audited against — if `telemetry.sh` grows a
 * new `nx_send`-reachable `event_type`, add it here too, or it silently
 * rejoins the dead-on-arrival list (the exact failure this guard exists to
 * catch). See `socket-events.ts`'s `VALID_EVENTS` comment for the fuller
 * cross-repo note, including the caveat that passing `isSocketEvent` alone
 * does not guarantee real downstream handling — most of these still hit
 * `dispatcher.ts`'s `default: "unknown event type"` branch until wired.
 */
describe("isSocketEvent — telemetry.sh event_type audit (nx-9qsmb.4)", () => {
  const AUDITED_TELEMETRY_EVENTS = [
    "tool_use_end",
    "command_start",
    "command_metadata",
    "agent_return",
    "user_prompt",
    "teammate_idle",
    "task_completed",
    "instructions_loaded",
    "config_change",
    "worktree_create",
    "worktree_remove",
    "session_terminate",
    "pre_compact",
    "post_compact",
    "command_end",
  ] as const;

  for (const eventType of AUDITED_TELEMETRY_EVENTS) {
    test(`accepts "${eventType}" via the CC event_type wire field`, () => {
      expect(isSocketEvent({ event_type: eventType, session_id: "s1" })).toBe(
        true,
      );
    });
  }

  test("concrete user_prompt payload is accepted (was dropped pre-fix, caught live in journalctl)", () => {
    const payload = {
      event_type: "user_prompt",
      session_id: "s1",
      service: "cc-hooks",
      hook_event_name: "UserPromptSubmit",
    };
    expect(isSocketEvent(payload)).toBe(true);
  });

  test("concrete instructions_loaded payload is accepted (was dropped pre-fix, caught live in journalctl)", () => {
    const payload = {
      event_type: "instructions_loaded",
      session_id: "s1",
      service: "cc-hooks",
    };
    expect(isSocketEvent(payload)).toBe(true);
  });
});
