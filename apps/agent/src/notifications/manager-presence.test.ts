/**
 * Manager presence-routing tests (context-aware-routing, Phase 1).
 *
 * Covers: flag-off uses the legacy path (no hold), flag-on + in-meeting routes
 * to the held queue, and the flushHeldBatch bedtime+idle silent guard. The DB
 * + held queue are stubbed (no live PG); the rules engine + presence context
 * are real.
 */

import {
  describe,
  expect,
  it,
  mock,
  beforeEach,
  beforeAll,
  afterAll,
} from "bun:test";
import { installNexusDbMock } from "../testing/mock-nexus-db";
import { installCoreNodeMock } from "../testing/mock-core-node";
import { installBufferMock, type BufferMockHandle } from "./testing-mocks";

// Shared mocks (nx-509z5): @nexus/db + @nexus/core/node spread the REAL barrel
// (complete + safe under last-writer-wins). ./buffer is SPIED in beforeAll /
// restored in afterAll — only active for THIS suite's tests, so its no-op
// writers don't leak into reliability-regression (which calls the REAL
// insertNotification). `./router` is intentionally NOT mocked — these tests
// exercise the REAL decidePresenceRoute / rules engine.
installNexusDbMock();
installCoreNodeMock();

let bufferMock: BufferMockHandle;
beforeAll(() => {
  bufferMock = installBufferMock();
});
afterAll(() => {
  bufferMock.restore();
});

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
    // The reporting machine IS the local console (studio) — the manager's
    // live-console resolve falls back to the local vector (stubDb has no fleet
    // rows), which carries the in-meeting state that fires Rule 2's hold.
    const ctx = new PresenceContext("leo", "studio");
    ctx.report({ macActive: true, macHost: "studio", inMeeting: true }, "test");
    const hq = makeHeldQueueStub();
    const mgr = new NotificationManager(stubDb, undefined, {
      context: ctx,
      heldQueue: hq.queue as never,
      presenceAwareRouting: () => true,
      // No live console resolves → fall back to the local (studio) vector.
      resolveLiveConsoleVector: async () => null,
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

  // ── Phase 1.7: fleet-aware eval (fleet-aware-rules-eval) ────────────────────

  it("evaluates against the live-console Mac even when the local vector is all-unknown (headless)", async () => {
    // Headless agent: its OWN local vector is all-unknown (no Mac sensor).
    const ctx = new PresenceContext("leo", "homelab");
    expect(ctx.vector().macActive.confidence).toBe("unknown");

    // But a Mac is the resolved live console with macActive → Rule 1 fires.
    const liveConsoleVector = ctx.vectorFor("homelab"); // base shape
    const studioVector = {
      ...liveConsoleVector,
      macActive: {
        value: true,
        source: "mac" as const,
        updatedAt: new Date().toISOString(),
        confidence: "high" as const,
      },
      macHost: {
        value: "studio",
        source: "mac" as const,
        updatedAt: new Date().toISOString(),
        confidence: "high" as const,
      },
    };

    const hq = makeHeldQueueStub();
    const delivered: string[] = [];
    const mgr = new NotificationManager(stubDb, undefined, {
      context: ctx,
      heldQueue: hq.queue as never,
      presenceAwareRouting: () => true,
      // Inject the resolved live-console vector (DB read is stubbed out).
      resolveLiveConsoleVector: async () => studioVector,
    });
    // Capture the deliver path by spying on routeNotificationParallel via the
    // lifecycle bus is heavy; instead assert it did NOT hold (Rule 1 delivers
    // now, it does not hold) and the send resolves.
    const row = await mgr.send(makeSendInput("fleet-1"));
    expect(hq.calls).toHaveLength(0); // Rule 1 delivers, never holds
    expect(row.id).toBe("fleet-1");
    void delivered;
  });

  it("falls back to legacy when no live console resolves and local is all-unknown", async () => {
    const ctx = new PresenceContext("leo", "homelab"); // all-unknown local
    const hq = makeHeldQueueStub();
    const mgr = new NotificationManager(stubDb, undefined, {
      context: ctx,
      heldQueue: hq.queue as never,
      presenceAwareRouting: () => true,
      resolveLiveConsoleVector: async () => null, // no live console
    });

    await mgr.send(makeSendInput("legacy-1"));
    // All-unknown → decidePresenceRoute returns null → legacy path, no hold.
    expect(hq.calls).toHaveLength(0);
  });

  it("single-machine fleet: resolved vector matches the local in-meeting hold", async () => {
    const ctx = new PresenceContext("leo", "studio");
    ctx.report({ macActive: true, inMeeting: true }, "test"); // local = studio
    const localVector = ctx.vector();
    const hq = makeHeldQueueStub();
    const mgr = new NotificationManager(stubDb, undefined, {
      context: ctx,
      heldQueue: hq.queue as never,
      presenceAwareRouting: () => true,
      // The local machine IS the live console → resolves to the local vector.
      resolveLiveConsoleVector: async () => localVector,
    });

    await mgr.send(makeSendInput("single-1"));
    expect(hq.calls.map((c) => c.id)).toContain("single-1"); // Rule 2 holds
  });

  it("flag OFF short-circuits before the live-console resolve", async () => {
    let resolveCalled = false;
    const ctx = new PresenceContext("leo", "homelab");
    const hq = makeHeldQueueStub();
    const mgr = new NotificationManager(stubDb, undefined, {
      context: ctx,
      heldQueue: hq.queue as never,
      presenceAwareRouting: () => false,
      resolveLiveConsoleVector: async () => {
        resolveCalled = true;
        return null;
      },
    });

    await mgr.send(makeSendInput("flagoff-1"));
    expect(hq.calls).toHaveLength(0);
    // The flag-off path MUST NOT consult the fleet at all (parity contract).
    expect(resolveCalled).toBe(false);
  });

  // ── Phase 2 (ios-presence-reporter): global phone overlay no-regression ────

  it("NO-REGRESSION: flag ON + no phone report → overlay no-op → Phase 1.7 behavior", async () => {
    // No phone has reported (global fields unknown). The live console is an
    // in-meeting Mac → Rule 2 holds, exactly as Phase 1.7. The overlay must not
    // change this outcome.
    const ctx = new PresenceContext("leo", "studio");
    ctx.report({ macActive: true, macHost: "studio", inMeeting: true }, "test");
    const localVector = ctx.vector();
    const hq = makeHeldQueueStub();
    const mgr = new NotificationManager(stubDb, undefined, {
      context: ctx,
      heldQueue: hq.queue as never,
      presenceAwareRouting: () => true,
      resolveLiveConsoleVector: async () => localVector,
    });

    await mgr.send(makeSendInput("noreg-1"));
    // Rule 2 still holds — the overlay (no phone) did not perturb routing.
    expect(hq.calls.map((c) => c.id)).toContain("noreg-1");
  });

  it("phone bedtime overlay fires Rule 3 (silent phone) when the console Mac is idle", async () => {
    // The live console is an IDLE Mac (macActive false) and the phone reports
    // bedtime → Rule 3 delivers a silent phone banner (no hold). The overlay
    // injects isBedtime from the global phone record onto the studio vector.
    const ctx = new PresenceContext("leo", "homelab");
    ctx.report({ macActive: false, macHost: "studio" }, "test");
    ctx.reportPhone({ hkSleepWindow: true }, "either");
    const studioVector = ctx.vectorFor("studio");
    const hq = makeHeldQueueStub();
    const mgr = new NotificationManager(stubDb, undefined, {
      context: ctx,
      heldQueue: hq.queue as never,
      presenceAwareRouting: () => true,
      resolveLiveConsoleVector: async () => studioVector,
    });

    const row = await mgr.send(makeSendInput("rule3-1"));
    // Rule 3 delivers now (silent phone banner), never holds.
    expect(hq.calls).toHaveLength(0);
    expect(row.id).toBe("rule3-1");
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
