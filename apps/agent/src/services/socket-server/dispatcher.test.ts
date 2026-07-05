/**
 * Socket dispatcher tests — NotificationFired event project preservation.
 *
 * After `remove-notification-channels` (P4) the dispatcher no longer calls
 * `sendTtsNotification` — the agent emits a `NotificationFired` lifecycle
 * event with the text payload and the Mac listener does the synthesis. We
 * verify here that the `project` field flows through to the bus envelope.
 */

import { describe, expect, test, mock, beforeEach } from "bun:test";
import type { SocketEvent } from "../../types/socket-events";
import type { WatcherEvent } from "@nexus/core";
import type { SessionManager } from "../../session-manager";
import type { LifecycleEnvelope } from "../lifecycle-bus";

// ─── Module mocks (must register before importing dispatcher) ────────────────

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
    updateLinkage: () => {},
    patch: () => {},
  } as unknown as SessionManager;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("socket-server dispatcher: NotificationFired event project preservation", () => {
  let dispatch: (event: SocketEvent) => void;
  let received: LifecycleEnvelope<"NotificationFired">[];

  beforeEach(async () => {
    const { createSocketEventDispatcher } = await import("./dispatcher");
    const { LifecycleBus } = await import("../lifecycle-bus");
    const bus = new LifecycleBus();
    received = [];
    bus.on("NotificationFired", (env) => received.push(env));
    dispatch = createSocketEventDispatcher({
      sessionManager: createMockSessionManager(),
      lifecycleBus: bus,
    });
    recordNotificationMock.mockClear();
  });

  test("forwards project field from socket event to NotificationFired payload", () => {
    const event: SocketEvent = {
      event: "notification",
      message: "build complete",
      project: "nova",
    } as unknown as SocketEvent;

    dispatch(event);

    expect(received).toHaveLength(1);
    expect(received[0]!.payload.project).toBe("nova");
    expect(received[0]!.payload.body).toBe("build complete");
  });

  test("sets NotificationFired.project to undefined when socket event omits the field", () => {
    const event: SocketEvent = {
      event: "notification",
      message: "build complete",
    } as unknown as SocketEvent;

    dispatch(event);

    expect(received).toHaveLength(1);
    expect(received[0]!.payload.project).toBeUndefined();
  });

  // ── [4.3] Residual hook: TTS side-effect preserved ────────────────────────
  //
  // read-cc-telemetry-from-influxdb retired the metric/cost/token CAPTURE path
  // but MUST keep the welded side-effects. A Notification hook event still fans
  // out a NotificationFired envelope carrying the "tts" channel — the signal the
  // Mac listener synthesises. This pins that the read-path migration did not
  // sever the TTS side-effect.
  test("notification event still fires the TTS side-effect (channel carries tts)", () => {
    const event: SocketEvent = {
      event: "notification",
      message: "spec applied",
      channels: ["tts", "desktop"],
      project: "nx",
    } as unknown as SocketEvent;

    dispatch(event);

    expect(received).toHaveLength(1);
    expect(received[0]!.payload.channel.split(",")).toContain("tts");
    expect(received[0]!.payload.body).toBe("spec applied");
  });
});
