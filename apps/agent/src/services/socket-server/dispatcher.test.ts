/**
 * Socket dispatcher tests — NotificationRow.project preservation (task 2.5).
 *
 * Verifies that the `project` field on a socket `notification` event is
 * forwarded to the `NotificationRow` passed into `sendTtsNotification`,
 * and that omitting the field produces `project === null` (no default
 * substitution — see fix-tts-announce-project-prefix spec).
 */

import { describe, expect, test, mock, beforeEach } from "bun:test";
import type { SocketEvent } from "../../types/socket-events";
import type { WatcherEvent } from "@nexus/core";
import type { SessionManager } from "../../session-manager";

// ─── Module mocks (must register before importing dispatcher) ────────────────

const sendTtsNotificationMock = mock((_row: unknown) => Promise.resolve(true));
mock.module("../../notifications/channels/tts", () => ({
  sendTtsNotification: sendTtsNotificationMock,
}));

const recordNotificationMock = mock(() => {});
mock.module("../command-handler", () => ({
  recordNotification: recordNotificationMock,
  handleCommand: () => ({ error: "not implemented" }),
}));

// ─── Minimal SessionManager stub ─────────────────────────────────────────────

function createMockSessionManager(): SessionManager {
  return {
    handleWatcherEvent(_event: WatcherEvent) {},
    getAll: () => [],
    getActive: () => [],
    getById: () => null,
    sweepIdle: () => {},
    stop: () => {},
    init: async () => {},
  } as unknown as SessionManager;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("socket-server dispatcher: NotificationRow.project preservation (task 2.5)", () => {
  let dispatch: (event: SocketEvent) => void;

  beforeEach(async () => {
    const { createSocketEventDispatcher } = await import("./dispatcher");
    const { LifecycleBus } = await import("../lifecycle-bus");
    dispatch = createSocketEventDispatcher({
      sessionManager: createMockSessionManager(),
      lifecycleBus: new LifecycleBus(),
    });
    sendTtsNotificationMock.mockClear();
    recordNotificationMock.mockClear();
  });

  test("forwards project field from socket event to NotificationRow", () => {
    const event: SocketEvent = {
      event: "notification",
      message: "build complete",
      project: "nova",
    } as unknown as SocketEvent;

    dispatch(event);

    expect(sendTtsNotificationMock).toHaveBeenCalledTimes(1);
    const [row] = sendTtsNotificationMock.mock.calls[0]! as [
      { project: string | null; body: string },
    ];
    expect(row.project).toBe("nova");
    expect(row.body).toBe("build complete");
  });

  test("sets NotificationRow.project to null when socket event omits the field", () => {
    const event: SocketEvent = {
      event: "notification",
      message: "build complete",
    } as unknown as SocketEvent;

    dispatch(event);

    expect(sendTtsNotificationMock).toHaveBeenCalledTimes(1);
    const [row] = sendTtsNotificationMock.mock.calls[0]! as [
      { project: string | null; body: string },
    ];
    expect(row.project).toBeNull();
  });
});
