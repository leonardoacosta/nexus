/**
 * Socket dispatcher tests — NotificationFired event project preservation.
 *
 * After `remove-notification-channels` (P4) the dispatcher no longer calls
 * `sendTtsNotification` — the agent emits a `NotificationFired` lifecycle
 * event with the text payload and the Mac listener does the synthesis. We
 * verify here that the `project` field flows through to the bus envelope.
 */

import {
  describe,
  expect,
  test,
  mock,
  beforeEach,
  afterEach,
  spyOn,
} from "bun:test";
import type { SocketEvent } from "../../types/socket-events";
import type { WatcherEvent } from "@nexus/core";
import type { Db } from "@nexus/db";
// Restorable spy target for the session_heartbeat model-persist suite below —
// dispatcher.ts imports `updateSessionModel` named from this module.
import * as sessionsDb from "../../db/sessions";
import type { SessionManager } from "../../session-manager";
import type { LifecycleEnvelope } from "../lifecycle-bus";
import type { NotificationManager } from "../../notifications/manager";
// Restorable spy target for the api_error routing suite below — never
// `mock.module` a shared module like hook-trigger.ts (contamination class,
// see reference_bun_mock_module_contamination memory / nx-509z5 precedent).
import * as hookTrigger from "../../notifications/hook-trigger";

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

// ─── session_stop api_error routing (nx-7tfim) ───────────────────────────────
//
// Regression pin for the wiring gap found while removing the dead mid-session
// api_error emit path: `dispatchStopNotification` used to ALWAYS call
// `evaluateAndDispatch(..., "session_stop", ...)`, so a stop_reason ===
// "api_error" crash stop hit `sessionStopRule` — which explicitly excludes
// api_error from CRASH_STOP_REASONS — and produced ZERO notifications.
// `apiErrorRule` (registered under the synthetic `api_error` key) was
// unreachable in production. These tests drive the real dispatcher (not
// `evaluateAndDispatch` directly) and assert the eventType key it is called
// with, proving the routing decision itself — not just the rule body.
describe("socket-server dispatcher: session_stop api_error routing (nx-7tfim)", () => {
  let dispatch: (event: SocketEvent) => void;
  let evalSpy: ReturnType<typeof spyOn<typeof hookTrigger, "evaluateAndDispatch">>;

  beforeEach(async () => {
    const { createSocketEventDispatcher } = await import("./dispatcher");
    const { LifecycleBus } = await import("../lifecycle-bus");

    evalSpy = spyOn(hookTrigger, "evaluateAndDispatch").mockImplementation(
      async () => {},
    );

    dispatch = createSocketEventDispatcher({
      sessionManager: createMockSessionManager(),
      lifecycleBus: new LifecycleBus(),
      db: {} as unknown as Db,
      getNotificationManager: () => ({}) as unknown as NotificationManager,
    });
  });

  afterEach(() => {
    evalSpy.mockRestore();
  });

  test("routes a stop_reason='api_error' stop to the synthetic api_error eventType key", async () => {
    const event: SocketEvent = {
      event: "session_stop",
      session_id: "sess-api-err",
      stop_reason: "api_error",
      error_details: "API Error: 529 Overloaded",
    } as unknown as SocketEvent;

    dispatch(event);
    await Promise.resolve();

    expect(evalSpy).toHaveBeenCalledTimes(1);
    const [, , eventType, payload] = evalSpy.mock.calls[0]!;
    expect(eventType).toBe("api_error");
    expect(payload).toMatchObject({
      stop_reason: "api_error",
      session_id: "sess-api-err",
      error_details: "API Error: 529 Overloaded",
    });
  });

  test("keeps routing a non-api_error crash stop through the session_stop eventType key", async () => {
    const event: SocketEvent = {
      event: "session_stop",
      session_id: "sess-oom",
      stop_reason: "oom",
    } as unknown as SocketEvent;

    dispatch(event);
    await Promise.resolve();

    expect(evalSpy).toHaveBeenCalledTimes(1);
    const [, , eventType] = evalSpy.mock.calls[0]!;
    expect(eventType).toBe("session_stop");
  });
});

// ─── session_heartbeat model persistence (add-session-model-authority) ───────

describe("socket-server dispatcher: session_heartbeat model persistence", () => {
  let dispatch: (event: SocketEvent) => void;
  let updateModelSpy: ReturnType<typeof spyOn<typeof sessionsDb, "updateSessionModel">>;
  const fakeDb = {} as unknown as Db;

  beforeEach(async () => {
    const { createSocketEventDispatcher } = await import("./dispatcher");
    const { LifecycleBus } = await import("../lifecycle-bus");
    // Restorable spy so the sibling suites' real updateSessionModel is intact.
    updateModelSpy = spyOn(sessionsDb, "updateSessionModel").mockResolvedValue(1);
    dispatch = createSocketEventDispatcher({
      sessionManager: createMockSessionManager(),
      lifecycleBus: new LifecycleBus(),
      db: fakeDb,
    });
  });

  afterEach(() => {
    updateModelSpy.mockRestore();
  });

  test("persists the raw model when the heartbeat carries one", () => {
    const event: SocketEvent = {
      event: "session_heartbeat",
      session_id: "s-hb",
      model: "claude-opus-4-8",
    };
    dispatch(event);
    expect(updateModelSpy).toHaveBeenCalledWith(fakeDb, "s-hb", "claude-opus-4-8");
  });

  test("last-write-wins: a later heartbeat model issues a fresh unconditional UPDATE", () => {
    dispatch({ event: "session_heartbeat", session_id: "s-hb", model: "claude-opus-4-8" });
    dispatch({ event: "session_heartbeat", session_id: "s-hb", model: "claude-sonnet-4-6" });
    expect(updateModelSpy).toHaveBeenCalledTimes(2);
    // The most recent call carries the newer value — later write wins.
    expect(updateModelSpy.mock.calls[1]).toEqual([fakeDb, "s-hb", "claude-sonnet-4-6"]);
  });

  test("no-clobber: a heartbeat with no model does NOT call updateSessionModel", () => {
    dispatch({ event: "session_heartbeat", session_id: "s-hb" });
    expect(updateModelSpy).not.toHaveBeenCalled();
  });
});

// ─── session_start ccSessionId bridge persistence (fix-cc-session-id-bridge, nx-22xz8) ──

describe("socket-server dispatcher: session_start ccSessionId bridge persistence", () => {
  let dispatch: (event: SocketEvent) => void;
  let updateCcSessionIdSpy: ReturnType<
    typeof spyOn<typeof sessionsDb, "updateSessionCcSessionId">
  >;
  const fakeDb = {} as unknown as Db;

  beforeEach(async () => {
    const { createSocketEventDispatcher } = await import("./dispatcher");
    const { LifecycleBus } = await import("../lifecycle-bus");
    // Restorable spy so the sibling suites' real updateSessionCcSessionId is
    // intact (same restorable-spy discipline as updateModelSpy above —
    // never mock.module a shared db helper module).
    updateCcSessionIdSpy = spyOn(
      sessionsDb,
      "updateSessionCcSessionId",
    ).mockResolvedValue(1);
    dispatch = createSocketEventDispatcher({
      sessionManager: createMockSessionManager(),
      lifecycleBus: new LifecycleBus(),
      db: fakeDb,
    });
  });

  afterEach(() => {
    updateCcSessionIdSpy.mockRestore();
  });

  test("persists cc_session_id onto the row keyed by the event's own session_id", () => {
    const event: SocketEvent = {
      event: "session_start",
      session_id: "nx-internal-id-1",
      cc_session_id: "cc-raw-session-xyz",
    };
    dispatch(event);
    expect(updateCcSessionIdSpy).toHaveBeenCalledWith(
      fakeDb,
      "nx-internal-id-1",
      "cc-raw-session-xyz",
    );
  });

  test("does NOT call updateSessionCcSessionId when the event omits cc_session_id", () => {
    const event: SocketEvent = {
      event: "session_start",
      session_id: "nx-internal-id-2",
    };
    dispatch(event);
    expect(updateCcSessionIdSpy).not.toHaveBeenCalled();
  });
});
