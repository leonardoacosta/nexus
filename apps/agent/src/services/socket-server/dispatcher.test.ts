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
  beforeAll,
  afterAll,
  spyOn,
} from "bun:test";
import type { SocketEvent } from "../../types/socket-events";
import type { WatcherEvent } from "@nexus/core";
import type { Db } from "@nexus/db";
import { createDb, sessions as sessionsTable } from "@nexus/db";
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
// Restorable spy target for the session_start pane-correlation suite below —
// dispatcher.ts imports `fetchPaneTranslationMap` named from this module.
import * as paneTranslationNs from "./pane-translation";
// Restorable spy target for the tool_use_end/user_prompt wiring suite below
// (nx-9qsmb.5) — dispatcher.ts imports `processHookEvent` named from this
// module, same live-binding spy pattern as the two imports above.
import * as processHookEventNs from "../process-hook-event";
import { __testing as dispatcherTesting } from "./dispatcher";
import { hasLivePg } from "../../testing/live-pg";
// Restorable spy targets for the reactive rate-limit swap suite below
// (wire-reactive-rate-limit-swap, task 4.1) — dispatcher.ts imports these
// named from their respective modules, same live-binding spy pattern as the
// three imports above.
import * as swapFlowNs from "../credential-swap-flow";
import * as sendTextNs from "../../routes/commands-send-text";
import * as credentialWatcherNs from "../../credentials/credential-watcher";
import type { CredentialPool } from "../../credentials/pool";

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

// ─── notification-trigger event wiring (nx-z0vm4) ────────────────────────────
//
// Regression pin for the second dead layer found in nx-z0vm4: the switch in
// `dispatchEventInner` had NO cases for tool_use_fail / permission_request /
// hook_failure, and `evaluateAndDispatch` was reached ONLY from
// `dispatchStopNotification` (session_stop / api_error). So even after these 3
// event types were added to `VALID_EVENTS` (passing `isSocketEvent`), they fell
// through to `default: "socket: unknown event type"` and produced ZERO
// notifications — the `add-hooks-notification-triggers` feature was dead in
// production. These tests drive the real dispatcher and assert
// `evaluateAndDispatch` is reached with the correct eventType key + mapped
// payload for each of the 3 events.
describe("socket-server dispatcher: notification-trigger event wiring (nx-z0vm4)", () => {
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

  test("routes a tool_use_fail event to evaluateAndDispatch with its payload", async () => {
    const event: SocketEvent = {
      event: "tool_use_fail",
      session_id: "sess-tuf",
      project: "nx",
      tool: "Bash",
      error: "command failed with exit 1",
      command: "false",
    } as unknown as SocketEvent;

    dispatch(event);
    await Promise.resolve();

    expect(evalSpy).toHaveBeenCalledTimes(1);
    const [, , eventType, payload] = evalSpy.mock.calls[0]!;
    expect(eventType).toBe("tool_use_fail");
    expect(payload).toMatchObject({
      event: "tool_use_fail",
      session_id: "sess-tuf",
      tool: "Bash",
      error: "command failed with exit 1",
      command: "false",
    });
  });

  test("routes a permission_request event to evaluateAndDispatch with its payload", async () => {
    const event: SocketEvent = {
      event: "permission_request",
      session_id: "sess-perm",
      project: "nx",
      tool: "Write",
    } as unknown as SocketEvent;

    dispatch(event);
    await Promise.resolve();

    expect(evalSpy).toHaveBeenCalledTimes(1);
    const [, , eventType, payload] = evalSpy.mock.calls[0]!;
    expect(eventType).toBe("permission_request");
    expect(payload).toMatchObject({
      event: "permission_request",
      session_id: "sess-perm",
      tool: "Write",
    });
  });

  test("routes a hook_failure event to evaluateAndDispatch with its payload", async () => {
    const event: SocketEvent = {
      event: "hook_failure",
      session_id: "sess-hook",
      project: "nx",
      handler: "PostToolUse",
      error: "hook exited 1",
      exit_code: 1,
    } as unknown as SocketEvent;

    dispatch(event);
    await Promise.resolve();

    expect(evalSpy).toHaveBeenCalledTimes(1);
    const [, , eventType, payload] = evalSpy.mock.calls[0]!;
    expect(eventType).toBe("hook_failure");
    expect(payload).toMatchObject({
      event: "hook_failure",
      session_id: "sess-hook",
      handler: "PostToolUse",
      error: "hook exited 1",
      exit_code: 1,
    });
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

// ─── session_start ccSessionId bridge threading (fix-cc-session-id-bridge, nx-22xz8) ──
//
// A prior version of this fix issued a separate follow-up `updateSessionCcSessionId`
// UPDATE from the dispatcher after `sessionManager.handleWatcherEvent(...)`. That
// raced the (unawaited) row-creating INSERT inside `writeThroughSafe` and silently
// no-op'd in production. The fix now threads `cc_session_id` straight into the
// `WatcherEvent` so it lands in the SAME insert that creates the row — these tests
// pin that threading at the dispatcher boundary (session-manager.test.ts pins the
// row-creation half).

describe("socket-server dispatcher: session_start ccSessionId bridge threading", () => {
  let dispatch: (event: SocketEvent) => void;
  let receivedEvents: WatcherEvent[];

  beforeEach(async () => {
    const { createSocketEventDispatcher } = await import("./dispatcher");
    const { LifecycleBus } = await import("../lifecycle-bus");
    receivedEvents = [];
    const sessionManager = {
      ...createMockSessionManager(),
      handleWatcherEvent(event: WatcherEvent) {
        receivedEvents.push(event);
      },
    } as unknown as SessionManager;
    dispatch = createSocketEventDispatcher({
      sessionManager,
      lifecycleBus: new LifecycleBus(),
    });
  });

  test("threads cc_session_id from the socket event onto the WatcherEvent passed to handleWatcherEvent", () => {
    const event: SocketEvent = {
      event: "session_start",
      session_id: "nx-internal-id-1",
      cc_session_id: "cc-raw-session-xyz",
    };
    dispatch(event);
    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0]).toMatchObject({
      type: "session_start",
      session_id: "nx-internal-id-1",
      cc_session_id: "cc-raw-session-xyz",
    });
  });

  test("passes cc_session_id as undefined when the socket event omits it", () => {
    const event: SocketEvent = {
      event: "session_start",
      session_id: "nx-internal-id-2",
    };
    dispatch(event);
    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0]!.type === "session_start" && receivedEvents[0]!.cc_session_id).toBeUndefined();
  });
});

// ─── session_start pane-based correlation (reconcile-session-id-universes, tasks 2.1/2.2/3.2) ──
//
// `correlateSessionStart` is fire-and-forget from the dispatcher's perspective
// (invoked via `.catch()`, never awaited by `dispatchEventInner` — see the
// comment at its call site in dispatcher.ts). These tests drive it through the
// real `dispatch()` entry point and flush pending work with a single
// macrotask tick (`await flush()`) rather than exporting the fire-and-forget
// helper itself: Node/Bun's event loop always fully drains the microtask
// queue before a queued `setTimeout` callback runs, so one `setTimeout(0)`
// flush is sufficient regardless of how many `await` hops the internal chain
// has (pane translation -> DB lookup -> update) — no fragile fixed count of
// `await Promise.resolve()` calls to get right.
//
// `fetchPaneTranslationMap` is spied via the module namespace (the same
// restorable pattern this file already uses for `updateSessionModel` /
// `evaluateAndDispatch` above) so no real `tmux` shell-out is attempted.
//
// `findUnlinkedSessionByTmuxTarget`'s own SQL semantics — excluding rows that
// already carry a `cc_session_id`, and picking the most-recently-active row
// when multiple share a `tmux_target` — are NOT re-tested here with a mocked
// db chain: a hand-rolled stub can only echo back whatever rows the test
// hands it, so it cannot genuinely exercise a WHERE-clause/ORDER BY. Those
// two properties are covered by the live-PG suite further below instead
// (mirroring `process-watcher.test.ts`'s own convention for this exact class
// of DB-query-shape behavior). These tests cover the DISPATCHER's branching:
// given the lookup resolves to a match (or doesn't), is the right DB call
// made and is `handleWatcherEvent` skipped or not.

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Minimal chainable stub satisfying the
 * `db.select({ id, pid }).from(sessions).where(...).orderBy(...).limit(5)`
 * shape `findUnlinkedSessionByTmuxTarget` issues. Always returns the same
 * fixed `rows` array regardless of the predicate — see the suite-level
 * comment above for why the WHERE/ORDER BY semantics are tested against
 * live PG instead of through this stub.
 *
 * `pid` defaults to the current test process's own pid (guaranteed alive
 * for the run's duration) when a row omits it — these dispatcher-branching
 * tests exercise the match-found/no-match control flow, not the pid-liveness
 * gate itself (that's the live-PG suite's job below), so a fixture row
 * should read as "alive" unless a test deliberately overrides `pid` to
 * exercise the dead-pid path.
 */
function createFakeSessionsLookupDb(rows: Array<{ id: string; pid?: number }>): Db {
  const withPid = rows.map((r) => ({ id: r.id, pid: r.pid ?? process.pid }));
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => Promise.resolve(withPid),
          }),
        }),
      }),
    }),
  } as unknown as Db;
}

describe("socket-server dispatcher: session_start pane-based correlation", () => {
  let receivedWatcherEvents: WatcherEvent[];
  let sessionManager: SessionManager;
  let paneMapSpy:
    | ReturnType<typeof spyOn<typeof paneTranslationNs, "fetchPaneTranslationMap">>
    | undefined;
  let updateCcSpy: ReturnType<typeof spyOn<typeof sessionsDb, "updateSessionCcSessionId">>;

  beforeEach(() => {
    receivedWatcherEvents = [];
    sessionManager = {
      ...createMockSessionManager(),
      handleWatcherEvent(event: WatcherEvent) {
        receivedWatcherEvents.push(event);
      },
    } as unknown as SessionManager;
    updateCcSpy = spyOn(sessionsDb, "updateSessionCcSessionId").mockResolvedValue(1);
  });

  afterEach(() => {
    paneMapSpy?.mockRestore();
    paneMapSpy = undefined;
    updateCcSpy.mockRestore();
  });

  async function buildDispatch(db?: Db): Promise<(event: SocketEvent) => void> {
    const { createSocketEventDispatcher } = await import("./dispatcher");
    const { LifecycleBus } = await import("../lifecycle-bus");
    return createSocketEventDispatcher({
      sessionManager,
      lifecycleBus: new LifecycleBus(),
      db,
    });
  }

  const startEvent: SocketEvent = {
    event: "session_start",
    session_id: "cc-real-uuid-1",
    tmux_target: "%7",
  } as unknown as SocketEvent;

  test("match found: updateSessionCcSessionId is called with the matched row's id + event session_id, handleWatcherEvent is NOT called", async () => {
    paneMapSpy = spyOn(paneTranslationNs, "fetchPaneTranslationMap").mockResolvedValue(
      new Map([["%7", "main:0.2"]]),
    );
    const fakeDb = createFakeSessionsLookupDb([{ id: "watcher-row-1" }]);
    const dispatch = await buildDispatch(fakeDb);

    dispatch(startEvent);
    await flush();

    expect(updateCcSpy).toHaveBeenCalledTimes(1);
    expect(updateCcSpy).toHaveBeenCalledWith(fakeDb, "watcher-row-1", "cc-real-uuid-1");
    expect(receivedWatcherEvents).toHaveLength(0);
  });

  test("no match: DB lookup returns no rows — falls back to handleWatcherEvent, does not call updateSessionCcSessionId", async () => {
    paneMapSpy = spyOn(paneTranslationNs, "fetchPaneTranslationMap").mockResolvedValue(
      new Map([["%7", "main:0.2"]]),
    );
    const dispatch = await buildDispatch(createFakeSessionsLookupDb([]));

    dispatch(startEvent);
    await flush();

    expect(updateCcSpy).not.toHaveBeenCalled();
    expect(receivedWatcherEvents).toHaveLength(1);
    expect(receivedWatcherEvents[0]).toMatchObject({
      type: "session_start",
      session_id: "cc-real-uuid-1",
    });
  });

  test("no match: event has no tmux_target — falls back to handleWatcherEvent without attempting pane translation", async () => {
    paneMapSpy = spyOn(paneTranslationNs, "fetchPaneTranslationMap").mockResolvedValue(new Map());
    const dispatch = await buildDispatch(
      createFakeSessionsLookupDb([{ id: "should-not-be-used" }]),
    );

    const eventNoTarget: SocketEvent = {
      event: "session_start",
      session_id: "cc-real-uuid-2",
    } as unknown as SocketEvent;

    dispatch(eventNoTarget);
    await flush();

    expect(paneMapSpy).not.toHaveBeenCalled();
    expect(updateCcSpy).not.toHaveBeenCalled();
    expect(receivedWatcherEvents).toHaveLength(1);
  });

  test("no match: tmux_target not present in the translated pane map — falls back to handleWatcherEvent", async () => {
    paneMapSpy = spyOn(paneTranslationNs, "fetchPaneTranslationMap").mockResolvedValue(
      new Map([["%other-pane", "main:0.9"]]),
    );
    const dispatch = await buildDispatch(
      createFakeSessionsLookupDb([{ id: "should-not-be-used" }]),
    );

    dispatch(startEvent);
    await flush();

    expect(updateCcSpy).not.toHaveBeenCalled();
    expect(receivedWatcherEvents).toHaveLength(1);
  });

  test("regression guard: a pane-translation lookup failure falls back to handleWatcherEvent instead of leaving the session unhandled", async () => {
    paneMapSpy = spyOn(paneTranslationNs, "fetchPaneTranslationMap").mockRejectedValue(
      new Error("tmux unreachable"),
    );
    const dispatch = await buildDispatch(createFakeSessionsLookupDb([{ id: "irrelevant" }]));

    dispatch(startEvent);
    await flush();

    expect(updateCcSpy).not.toHaveBeenCalled();
    expect(receivedWatcherEvents).toHaveLength(1);
  });

  test("no db configured on deps: falls back to handleWatcherEvent without attempting pane translation", async () => {
    paneMapSpy = spyOn(paneTranslationNs, "fetchPaneTranslationMap").mockResolvedValue(new Map());
    const dispatch = await buildDispatch(undefined);

    dispatch(startEvent);
    await flush();

    expect(paneMapSpy).not.toHaveBeenCalled();
    expect(receivedWatcherEvents).toHaveLength(1);
  });

  // ── [2.3 correction] processHookEvent sequenced off the resolved target id ─
  //
  // Regression pin for the bug found during live verification of 2.1/2.2:
  // `bindSessionCredential` and `processHookEvent` used to fire independently
  // off `event.session_id`, unconditionally. When correlation succeeded, no
  // row with `id = event.session_id` existed — those two silently no-op'd
  // (0 rows matched, no error), defeating model/cwd/git-origin enrichment for
  // exactly the sessions this fix was meant to help. `processHookEvent`'s
  // `session_start` branch calls `updateSessionModel(db, input.sessionId,
  // model)` first (process-hook-event.ts) when the event payload carries a
  // `model` — that's the spy target already used elsewhere in this file
  // (`sessionsDb.updateSessionModel`), reused here as the observable effect.
  test("match found: processHookEvent's model persist targets the MATCHED row's id, not the raw event session_id", async () => {
    paneMapSpy = spyOn(paneTranslationNs, "fetchPaneTranslationMap").mockResolvedValue(
      new Map([["%7", "main:0.2"]]),
    );
    const fakeDb = createFakeSessionsLookupDb([{ id: "watcher-row-1" }]);
    const updateModelSpy = spyOn(sessionsDb, "updateSessionModel").mockResolvedValue(1);
    try {
      const dispatch = await buildDispatch(fakeDb);

      dispatch({ ...startEvent, model: "claude-opus-4-8" } as unknown as SocketEvent);
      await flush();

      expect(updateModelSpy).toHaveBeenCalledTimes(1);
      expect(updateModelSpy).toHaveBeenCalledWith(fakeDb, "watcher-row-1", "claude-opus-4-8");
    } finally {
      updateModelSpy.mockRestore();
    }
  });

  test("no match: processHookEvent's model persist targets event.session_id exactly as before (regression guard)", async () => {
    paneMapSpy = spyOn(paneTranslationNs, "fetchPaneTranslationMap").mockResolvedValue(
      new Map([["%7", "main:0.2"]]),
    );
    const fakeDb = createFakeSessionsLookupDb([]);
    const updateModelSpy = spyOn(sessionsDb, "updateSessionModel").mockResolvedValue(1);
    try {
      const dispatch = await buildDispatch(fakeDb);

      dispatch({ ...startEvent, model: "claude-opus-4-8" } as unknown as SocketEvent);
      await flush();

      expect(updateModelSpy).toHaveBeenCalledTimes(1);
      expect(updateModelSpy).toHaveBeenCalledWith(fakeDb, "cc-real-uuid-1", "claude-opus-4-8");
    } finally {
      updateModelSpy.mockRestore();
    }
  });

  test("match found: bindSessionCredential looks up the session by the MATCHED row's id, not the raw event session_id", async () => {
    paneMapSpy = spyOn(paneTranslationNs, "fetchPaneTranslationMap").mockResolvedValue(
      new Map([["%7", "main:0.2"]]),
    );
    const fakeDb = createFakeSessionsLookupDb([{ id: "watcher-row-1" }]);
    const getByIdCalls: string[] = [];
    sessionManager = {
      ...sessionManager,
      getById: (id: string) => {
        getByIdCalls.push(id);
        return null;
      },
    } as unknown as SessionManager;
    const dispatch = await buildDispatch(fakeDb);

    dispatch({
      ...startEvent,
      credential_fingerprint: "fp-abc",
    } as unknown as SocketEvent);
    await flush();

    expect(getByIdCalls).toEqual(["watcher-row-1"]);
  });
});

// ─── findUnlinkedSessionByTmuxTarget — SQL query semantics (live PG) ─────────
//
// See the suite-level comment above: the dispatcher-level correlation tests
// mock `db` entirely, so they can't exercise the actual WHERE/ORDER BY
// semantics that make this query correct. These run against a real scratch
// Postgres schema — mirroring `process-watcher.test.ts`'s own live-PG
// convention (same `sessions` DDL, same opt-in `NEXUS_PG_TESTS` gate via
// `hasLivePg`) — and skip cleanly when Postgres isn't configured for testing.

const DISPATCHER_TEST_SCHEMA = `nx_dispatch_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const SESSIONS_DDL = `
  CREATE TABLE "sessions" (
    "id" text PRIMARY KEY NOT NULL,
    "project_id" uuid,
    "machine" text NOT NULL,
    "status" text DEFAULT 'active' NOT NULL,
    "started_at" timestamp NOT NULL,
    "last_activity" timestamp NOT NULL,
    "ended_at" timestamp,
    "stop_reason" text,
    "error_details" text,
    "pid" integer,
    "cwd" text,
    "branch" text,
    "session_type" text,
    "model" text,
    "rate_limit_utilization" real,
    "rate_limit_reset_at" timestamp,
    "idle_since" timestamp,
    "cc_session_id" text,
    "tmux_session" text,
    "tmux_target" text,
    "spec" text,
    "credential_id" text,
    "credential_fingerprint" text,
    "git_provider" text,
    "git_owner_repo" text,
    "agent_state" text,
    "parent_session_id" text,
    "child_role" text
  );
`;

describe.skipIf(!hasLivePg)(
  "findUnlinkedSessionByTmuxTarget — SQL query semantics (requires live PG)",
  () => {
    let adminClient: ReturnType<typeof createDb>["client"];
    let scopedClient: ReturnType<typeof createDb>["client"];
    let db: Db;

    beforeAll(async () => {
      const url = process.env.POSTGRES_URL!;
      const adminHandle = createDb(url);
      adminClient = adminHandle.client;
      await adminClient.unsafe(`CREATE SCHEMA "${DISPATCHER_TEST_SCHEMA}"`);
      await adminClient.unsafe(`SET search_path TO "${DISPATCHER_TEST_SCHEMA}", public`);
      await adminClient.unsafe(SESSIONS_DDL);

      const scopedHandle = createDb(url, {
        connection: { search_path: `"${DISPATCHER_TEST_SCHEMA}",public` },
      });
      scopedClient = scopedHandle.client;
      db = scopedHandle.db;
    });

    afterAll(async () => {
      try {
        await scopedClient.end({ timeout: 5 });
      } finally {
        try {
          await adminClient.unsafe(`DROP SCHEMA IF EXISTS "${DISPATCHER_TEST_SCHEMA}" CASCADE`);
        } finally {
          await adminClient.end({ timeout: 5 });
        }
      }
    });

    beforeEach(async () => {
      await scopedClient.unsafe(`DELETE FROM "${DISPATCHER_TEST_SCHEMA}"."sessions"`);
    });

    // A pid that is guaranteed to never be alive on this machine: the kernel
    // caps pid_max well below this value (Linux default 4194304), so
    // `existsSync(/proc/{pid})` reliably returns false without racing any
    // real process's lifecycle.
    const DEAD_PID = 999_999_999;

    async function insertRow(row: {
      id: string;
      status?: string;
      tmuxTarget?: string | null;
      ccSessionId?: string | null;
      lastActivity: Date;
      /**
       * Defaults to the CURRENT test process's own pid — guaranteed alive
       * for the duration of the test run — so pre-existing "should match"
       * tests continue to exercise a live candidate now that
       * `findUnlinkedSessionByTmuxTarget` requires one. Pass `DEAD_PID`
       * explicitly for liveness-focused negative cases.
       */
      pid?: number;
    }): Promise<void> {
      await db.insert(sessionsTable).values({
        id: row.id,
        machine: "local",
        status: row.status ?? "active",
        startedAt: row.lastActivity,
        lastActivity: row.lastActivity,
        tmuxTarget: row.tmuxTarget ?? null,
        ccSessionId: row.ccSessionId ?? null,
        pid: row.pid ?? process.pid,
      });
    }

    test("finds the row whose tmux_target matches and is not yet linked", async () => {
      await insertRow({ id: "row-match", tmuxTarget: "main:0.1", lastActivity: new Date() });

      const result = await dispatcherTesting.findUnlinkedSessionByTmuxTarget(db, "main:0.1");

      expect(result).toEqual({ id: "row-match" });
    });

    test("a row that already carries a cc_session_id is excluded from matching", async () => {
      await insertRow({
        id: "row-linked",
        tmuxTarget: "main:0.2",
        ccSessionId: "already-linked-uuid",
        lastActivity: new Date(),
      });

      const result = await dispatcherTesting.findUnlinkedSessionByTmuxTarget(db, "main:0.2");

      expect(result).toBeNull();
    });

    test("a row with an empty-string cc_session_id is still considered unlinked", async () => {
      await insertRow({
        id: "row-empty-cc",
        tmuxTarget: "main:0.3",
        ccSessionId: "",
        lastActivity: new Date(),
      });

      const result = await dispatcherTesting.findUnlinkedSessionByTmuxTarget(db, "main:0.3");

      expect(result).toEqual({ id: "row-empty-cc" });
    });

    test("a row with status outside active/idle (e.g. ended) is excluded", async () => {
      await insertRow({
        id: "row-ended",
        status: "ended",
        tmuxTarget: "main:0.4",
        lastActivity: new Date(),
      });

      const result = await dispatcherTesting.findUnlinkedSessionByTmuxTarget(db, "main:0.4");

      expect(result).toBeNull();
    });

    test("an idle-status row still matches (not just active)", async () => {
      await insertRow({
        id: "row-idle",
        status: "idle",
        tmuxTarget: "main:0.5",
        lastActivity: new Date(),
      });

      const result = await dispatcherTesting.findUnlinkedSessionByTmuxTarget(db, "main:0.5");

      expect(result).toEqual({ id: "row-idle" });
    });

    test("multiple rows sharing the same tmux_target resolve to the most-recently-active one", async () => {
      const older = new Date(Date.now() - 60_000);
      const newer = new Date();
      await insertRow({ id: "row-older", tmuxTarget: "main:0.6", lastActivity: older });
      await insertRow({ id: "row-newer", tmuxTarget: "main:0.6", lastActivity: newer });

      const result = await dispatcherTesting.findUnlinkedSessionByTmuxTarget(db, "main:0.6");

      expect(result).toEqual({ id: "row-newer" });
    });

    test("no row shares the tmux_target returns null", async () => {
      await insertRow({ id: "row-other", tmuxTarget: "main:9.9", lastActivity: new Date() });

      const result = await dispatcherTesting.findUnlinkedSessionByTmuxTarget(db, "main:0.1");

      expect(result).toBeNull();
    });

    // ─── Liveness gate (dispatcher-pid-liveness fix) ─────────────────────────
    //
    // Guards against the confirmed-live bug: a row can still show
    // `status IN (active, idle)` in the DB after its owning process has
    // actually ended (a race between the old session's own end-of-life
    // status transition and a new session's session_start correlation
    // query), silently binding a brand-new session's cc_session_id onto a
    // dead, unrelated row. `findUnlinkedSessionByTmuxTarget` must reject any
    // candidate whose pid isn't currently alive.

    test("a matching row whose pid is dead is skipped (not returned)", async () => {
      await insertRow({
        id: "row-dead-pid",
        tmuxTarget: "main:0.7",
        lastActivity: new Date(),
        pid: DEAD_PID,
      });

      const result = await dispatcherTesting.findUnlinkedSessionByTmuxTarget(db, "main:0.7");

      expect(result).toBeNull();
    });

    test("a matching row whose pid is alive is returned", async () => {
      await insertRow({
        id: "row-alive-pid",
        tmuxTarget: "main:0.8",
        lastActivity: new Date(),
        pid: process.pid,
      });

      const result = await dispatcherTesting.findUnlinkedSessionByTmuxTarget(db, "main:0.8");

      expect(result).toEqual({ id: "row-alive-pid" });
    });

    test("when the freshest candidate's pid is dead, an older-but-alive candidate is returned instead", async () => {
      const older = new Date(Date.now() - 60_000);
      const newer = new Date();
      // Freshest by last_activity, but its process has actually ended.
      await insertRow({
        id: "row-newer-dead",
        tmuxTarget: "main:0.9",
        lastActivity: newer,
        pid: DEAD_PID,
      });
      // Older by last_activity, but still genuinely alive.
      await insertRow({
        id: "row-older-alive",
        tmuxTarget: "main:0.9",
        lastActivity: older,
        pid: process.pid,
      });

      const result = await dispatcherTesting.findUnlinkedSessionByTmuxTarget(db, "main:0.9");

      expect(result).toEqual({ id: "row-older-alive" });
    });

    test("when every matching candidate's pid is dead, returns null", async () => {
      await insertRow({
        id: "row-all-dead-1",
        tmuxTarget: "main:0.10",
        lastActivity: new Date(),
        pid: DEAD_PID,
      });
      await insertRow({
        id: "row-all-dead-2",
        tmuxTarget: "main:0.10",
        lastActivity: new Date(Date.now() - 1_000),
        pid: DEAD_PID,
      });

      const result = await dispatcherTesting.findUnlinkedSessionByTmuxTarget(db, "main:0.10");

      expect(result).toBeNull();
    });
  },
);

// ─── tool_use_end / user_prompt wiring (nx-9qsmb.5, Option B) ────────────────
//
// Both were newly recognized by VALID_EVENTS (nx-9qsmb.4) but had no
// dispatcher case — they hit `default: "unknown event type"` and did
// nothing. Option B wires exactly these two (the highest-frequency events
// during a live session) through the shared `processHookEvent` spine so
// nx-qayeb.1's context-usage collector runs on tool-call/turn cadence
// instead of only at session boundaries. The other 13 newly-recognized
// types deliberately stay unwired (see socket-events.ts's VALID_EVENTS
// comment) — this suite only covers the two Option B actually wires.

describe("socket-server dispatcher: tool_use_end / user_prompt wiring (nx-9qsmb.5)", () => {
  let dispatch: (event: SocketEvent) => void;
  let processSpy: ReturnType<
    typeof spyOn<typeof processHookEventNs, "processHookEvent">
  >;

  beforeEach(async () => {
    const { createSocketEventDispatcher } = await import("./dispatcher");
    const { LifecycleBus } = await import("../lifecycle-bus");

    processSpy = spyOn(
      processHookEventNs,
      "processHookEvent",
    ).mockImplementation(async () => ({ driftOk: true, enrichmentOk: true }));

    dispatch = createSocketEventDispatcher({
      sessionManager: createMockSessionManager(),
      lifecycleBus: new LifecycleBus(),
      db: {} as unknown as Db,
      getNotificationManager: () => ({}) as unknown as NotificationManager,
    });
  });

  afterEach(() => {
    processSpy.mockRestore();
  });

  test("routes a tool_use_end event to processHookEvent with its transcript_path", async () => {
    const event: SocketEvent = {
      event: "tool_use_end",
      session_id: "sess-tue",
      tool: "Write",
      success: true,
      duration_ms: 42,
      transcript_path: "/tmp/fake-transcript.jsonl",
    } as unknown as SocketEvent;

    dispatch(event);
    await Promise.resolve();

    expect(processSpy).toHaveBeenCalledTimes(1);
    const [input] = processSpy.mock.calls[0]!;
    expect(input.eventType).toBe("tool_use_end");
    expect(input.sessionId).toBe("sess-tue");
    expect(input.source).toBe("socket");
    expect(input.payload).toMatchObject({
      tool: "Write",
      transcript_path: "/tmp/fake-transcript.jsonl",
    });
  });

  test("routes a user_prompt event to processHookEvent with its transcript_path", async () => {
    const event: SocketEvent = {
      event: "user_prompt",
      session_id: "sess-up",
      transcript_path: "/tmp/fake-transcript-2.jsonl",
    } as unknown as SocketEvent;

    dispatch(event);
    await Promise.resolve();

    expect(processSpy).toHaveBeenCalledTimes(1);
    const [input] = processSpy.mock.calls[0]!;
    expect(input.eventType).toBe("user_prompt");
    expect(input.sessionId).toBe("sess-up");
    expect(input.payload).toMatchObject({
      transcript_path: "/tmp/fake-transcript-2.jsonl",
    });
  });

  test("does not call processHookEvent for tool_use_end with no session_id", async () => {
    const event: SocketEvent = {
      event: "tool_use_end",
      tool: "Write",
    } as unknown as SocketEvent;

    dispatch(event);
    await Promise.resolve();

    expect(processSpy).not.toHaveBeenCalled();
  });
});

// ─── Reactive rate-limit swap detection (wire-reactive-rate-limit-swap, 4.1) ─
//
// Exercises `isRateLimitNotification` + `tryReactiveRateLimitSwap`'s branching
// through the real dispatcher entry point: phrase match, structured
// utilization >= 1.0, passthrough when no credential pool is wired, and
// passthrough when no eligible swap candidate exists (both of the latter fall
// through to the exhaustion ladder in proactive-swap.ts, which owns that
// case). `performCredentialSwap` and `sendTextToSession` are spied at their
// exact import path (dispatcher.ts's own relative import) rather than
// `mock.module`, per the process-global contamination guard this file
// already follows elsewhere — the real detection/branching logic in
// dispatcher.ts runs unmocked; only the swap's side effects and the tmux
// dispatch are stubbed. `isDebounced`/`armDebounce` are the REAL functions
// (reset between tests) — their own contract is covered directly by
// credential-swap-flow.test.ts.

function createFakeCredentialsLookupDb(
  rows: Array<{ id: string; fingerprint: string }>,
): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve(rows),
        }),
      }),
    }),
  } as unknown as Db;
}

describe("socket-server dispatcher: reactive rate-limit swap detection", () => {
  let received: LifecycleEnvelope<"NotificationFired">[];
  let performSwapSpy: ReturnType<
    typeof spyOn<typeof swapFlowNs, "performCredentialSwap">
  >;
  let sendTextSpy: ReturnType<typeof spyOn<typeof sendTextNs, "sendTextToSession">>;
  let activeSnapshotSpy: ReturnType<
    typeof spyOn<typeof credentialWatcherNs, "getActiveCredentialSnapshot">
  >;
  const fakePool = {} as unknown as CredentialPool;

  beforeEach(() => {
    swapFlowNs.__resetDebounceForTests();
    received = [];

    performSwapSpy = spyOn(
      swapFlowNs,
      "performCredentialSwap",
    ).mockResolvedValue({
      ok: true,
      result: {
        parked: { id: "cred-1", fingerprint: "fp-active", accountName: "A" },
        activated: { id: "cred-2", fingerprint: "fp-b", accountName: "B" },
      },
    } as unknown as Awaited<ReturnType<typeof swapFlowNs.performCredentialSwap>>);

    sendTextSpy = spyOn(sendTextNs, "sendTextToSession").mockResolvedValue({
      ok: true,
      tmuxTarget: "%1",
    });

    activeSnapshotSpy = spyOn(
      credentialWatcherNs,
      "getActiveCredentialSnapshot",
    ).mockReturnValue({
      fingerprint: "fp-active",
      resolvedPath: null,
      observedAt: new Date().toISOString(),
    });
  });

  afterEach(() => {
    performSwapSpy.mockRestore();
    sendTextSpy.mockRestore();
    activeSnapshotSpy.mockRestore();
    swapFlowNs.__resetDebounceForTests();
  });

  async function buildDispatch(
    db: Db | undefined,
    getCredentialPool?: () => CredentialPool | null,
  ): Promise<(event: SocketEvent) => void> {
    const { createSocketEventDispatcher } = await import("./dispatcher");
    const { LifecycleBus } = await import("../lifecycle-bus");
    const bus = new LifecycleBus();
    bus.on("NotificationFired", (env) => received.push(env));
    return createSocketEventDispatcher({
      sessionManager: createMockSessionManager(),
      lifecycleBus: bus,
      db,
      getCredentialPool,
    });
  }

  test("phrase hit ('hit your limit') with an eligible candidate swaps and suppresses the raw notification", async () => {
    const db = createFakeCredentialsLookupDb([{ id: "cred-2", fingerprint: "fp-b" }]);
    const dispatch = await buildDispatch(db, () => fakePool);

    dispatch({
      event: "notification",
      message: "You hit your limit for this session — try again later",
      session_id: "sess-phrase",
      channels: ["tts", "desktop"],
    } as unknown as SocketEvent);
    await flush();

    expect(performSwapSpy).toHaveBeenCalledTimes(1);
    expect(performSwapSpy.mock.calls[0]![0]).toMatchObject({
      targetId: "cred-2",
      reason: "reactive",
      sessionId: "sess-phrase",
    });
    expect(sendTextSpy).toHaveBeenCalledWith("sess-phrase", "continue");
    expect(received).toHaveLength(0); // raw notification suppressed
  });

  test("structured utilization >= 1.0 (no phrase) swaps and suppresses the raw notification", async () => {
    const db = createFakeCredentialsLookupDb([{ id: "cred-2", fingerprint: "fp-b" }]);
    const dispatch = await buildDispatch(db, () => fakePool);

    dispatch({
      event: "notification",
      message: "usage update",
      session_id: "sess-util",
      rate_limit_event: { utilization: 1.0 },
    } as unknown as SocketEvent);
    await flush();

    expect(performSwapSpy).toHaveBeenCalledTimes(1);
    expect(performSwapSpy.mock.calls[0]![0]).toMatchObject({
      targetId: "cred-2",
      reason: "reactive",
      sessionId: "sess-util",
    });
    expect(received).toHaveLength(0);
  });

  test("passthrough: no credential pool wired — notification delivers unchanged", async () => {
    const db = createFakeCredentialsLookupDb([{ id: "cred-2", fingerprint: "fp-b" }]);
    const dispatch = await buildDispatch(db, undefined);

    dispatch({
      event: "notification",
      message: "you hit your limit",
      session_id: "sess-nopool",
    } as unknown as SocketEvent);
    await flush();

    expect(performSwapSpy).not.toHaveBeenCalled();
    expect(received).toHaveLength(1);
    expect(received[0]!.payload.body).toBe("you hit your limit");
  });

  test("passthrough: no eligible candidate — notification delivers unchanged, exhaustion ladder owns it", async () => {
    const db = createFakeCredentialsLookupDb([]); // no primary/available rows
    const dispatch = await buildDispatch(db, () => fakePool);

    dispatch({
      event: "notification",
      message: "you hit your limit",
      session_id: "sess-nocandidate",
    } as unknown as SocketEvent);
    await flush();

    expect(performSwapSpy).not.toHaveBeenCalled();
    expect(sendTextSpy).not.toHaveBeenCalled();
    expect(received).toHaveLength(1);
    expect(received[0]!.payload.body).toBe("you hit your limit");
  });

  test("auto-continue missing-target failure: swap still stands, raw notification stays suppressed (WARN, no crash/fallback)", async () => {
    const db = createFakeCredentialsLookupDb([{ id: "cred-2", fingerprint: "fp-b" }]);
    sendTextSpy.mockResolvedValue({
      ok: false,
      status: 409,
      error: "session has no tmuxTarget: sess-missing-target",
    });
    const dispatch = await buildDispatch(db, () => fakePool);

    dispatch({
      event: "notification",
      message: "you hit your limit",
      session_id: "sess-missing-target",
    } as unknown as SocketEvent);
    await flush();

    expect(performSwapSpy).toHaveBeenCalledTimes(1);
    expect(sendTextSpy).toHaveBeenCalledWith("sess-missing-target", "continue");
    // The swap already ran; a failed auto-continue does not fall back to
    // delivering the raw "you hit your limit" notification.
    expect(received).toHaveLength(0);
  });
});
