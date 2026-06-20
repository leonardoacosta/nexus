/**
 * Manager presence-routing tests (context-aware-routing, Phase 1).
 *
 * Covers: flag-off uses the legacy path (no hold), flag-on + in-meeting routes
 * to the held queue, and the flushHeldBatch bedtime+idle silent guard. The DB
 * + held queue are stubbed (no live PG); the rules engine + presence context
 * are real.
 */

import { describe, expect, it, mock, beforeEach } from "bun:test";

mock.module("@nexus/db", () => ({
  eq: mock(() => ({})),
  and: mock(() => ({})),
  sql: mock(() => ({})),
  notifications: {},
  credentials: {},
  presenceHolds: {},
  projectVoiceOverrides: {},
  // cross-machine-delivery (Phase 1.6): manager imports fleetPresence.
  fleetPresence: {},
}));

mock.module("./buffer", () => ({
  insertNotification: mock(async () => {}),
  queryNotificationsByStatus: mock(async () => []),
  markNotificationDelivered: mock(async () => {}),
  markNotificationExpired: mock(async () => {}),
}));

mock.module("@nexus/core/node", () => ({
  logger: {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  },
  createLogger: () => ({
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  }),
  getAgentId: mock(() => "test-agent"),
}));

mock.module("@sentry/node", () => ({
  captureException: mock(() => {}),
  addBreadcrumb: mock(() => {}),
  init: mock(() => {}),
}));

const { NotificationManager } = await import("./manager");
const { PresenceContext } = await import("./presence-context");
const { setRoutingRules } = await import("./router");

const stubDb = {} as never;

function makeHeldQueueStub() {
  const calls: { id: string; holdUntil: Date }[] = [];
  return {
    calls,
    queue: {
      hold: mock(async (input: { id: string; holdUntil: Date }) => {
        calls.push({ id: input.id, holdUntil: input.holdUntil });
      }),
      scheduleFlush: mock(() => {}),
      loadPending: mock(async () => []),
      flush: mock(async () => null),
      flushDue: mock(async () => []),
      hydrate: mock(async () => []),
      shutdown: mock(() => {}),
    },
  };
}

function makeSendInput(id: string) {
  return {
    id,
    title: "Build done",
    body: "wave 1",
    channel: "tts",
    priority: "normal",
    project: "nx",
    agentId: null,
    createdAt: new Date(),
  } as never;
}

describe("manager presence routing", () => {
  beforeEach(() => {
    setRoutingRules([]);
  });

  it("flag OFF → does not hold (legacy path)", async () => {
    const ctx = new PresenceContext("leo");
    ctx.report({ macActive: true, inMeeting: true }, "test");
    const hq = makeHeldQueueStub();
    const mgr = new NotificationManager(stubDb, undefined, {
      context: ctx,
      heldQueue: hq.queue as never,
      presenceAwareRouting: () => false,
    });

    await mgr.send(makeSendInput("off-1"));
    expect(hq.calls).toHaveLength(0);
  });

  it("flag ON + in-meeting → routes to the held queue", async () => {
    const ctx = new PresenceContext("leo");
    ctx.report({ macActive: true, macHost: "studio", inMeeting: true }, "test");
    const hq = makeHeldQueueStub();
    const mgr = new NotificationManager(stubDb, undefined, {
      context: ctx,
      heldQueue: hq.queue as never,
      presenceAwareRouting: () => true,
    });

    await mgr.send(makeSendInput("hold-1"));
    expect(hq.calls.map((c) => c.id)).toContain("hold-1");
  });

  it("flushHeldBatch coalesces multiple holds into one summary", async () => {
    const ctx = new PresenceContext("leo");
    ctx.report({ macActive: true, macHost: "studio", inMeeting: false }, "test");
    const hq = makeHeldQueueStub();
    const mgr = new NotificationManager(stubDb, undefined, {
      context: ctx,
      heldQueue: hq.queue as never,
      presenceAwareRouting: () => true,
    });

    const summary = await mgr.flushHeldBatch([
      { id: "a", userId: "leo", payload: { title: "A" }, holdUntil: new Date(), reason: null, createdAt: new Date(), releasedAt: new Date() },
      { id: "b", userId: "leo", payload: { title: "B" }, holdUntil: new Date(), reason: null, createdAt: new Date(), releasedAt: new Date() },
    ] as never);

    expect(summary).not.toBeNull();
    expect(summary!.title).toContain("2 updates");
    // Mac active + not bedtime → TTS channel (spoken summary).
    expect(summary!.channel).toBe("tts");
  });

  it("flushHeldBatch is silent (banner only) during bedtime with idle Mac", async () => {
    const ctx = new PresenceContext("leo");
    // isBedtime true, macActive false (idle) → silent guard.
    ctx.report({ isBedtime: true, macActive: false }, "test");
    const hq = makeHeldQueueStub();
    const mgr = new NotificationManager(stubDb, undefined, {
      context: ctx,
      heldQueue: hq.queue as never,
      presenceAwareRouting: () => true,
    });

    const summary = await mgr.flushHeldBatch([
      { id: "c", userId: "leo", payload: { title: "C" }, holdUntil: new Date(), reason: null, createdAt: new Date(), releasedAt: new Date() },
    ] as never);

    expect(summary!.channel).toBe("desktop"); // silent — no TTS
  });
});
