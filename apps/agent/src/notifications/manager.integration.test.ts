/**
 * Integration test — full router → manager → lifecycleBus pipe.
 *
 * Spec: restore-tts-mac-audio-dispatch §2.4
 *
 * Builds the full agent-side path with a real lifecycleBus subscription
 * (no mocking of the bus itself) and asserts that within 5s of triggering
 * delivery, a `NotificationFired` envelope arrives carrying `audioBase64`
 * decoded back to the synthesized byte payload.
 *
 * The DB layer is stubbed because notifications routing does not depend on
 * persistence for this assertion. The TTS channel's HTTP layer is stubbed
 * via `mock.module("@nexus/core/fetch")` so we never call out to ElevenLabs.
 */

import {
  describe,
  expect,
  it,
  mock,
  spyOn,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
} from "bun:test";
import * as coreBarrel from "@nexus/core";
import { installNexusDbMock } from "../testing/mock-nexus-db";
import { installCoreNodeMock } from "../testing/mock-core-node";
import { installBufferMock, type BufferMockHandle } from "./testing-mocks";
import type {
  LifecycleEnvelope,
  NotificationFiredPayload,
} from "../services/lifecycle-bus";

// ─── Shared mocks (nx-509z5) ──────────────────────────────────────────────
// @nexus/db + @nexus/core/node spread the REAL barrel (complete + safe under
// last-writer-wins). The @nexus/db spread fixes the old partial stub that
// omitted projectVoiceOverrides (router.ts threw `Export not found`). ./buffer
// and fetchWithTimeout are SPIED in beforeAll / restored in afterAll — only
// active for THIS suite's tests. The bus is NOT mocked — this suite needs the
// REAL lifecycleBus to receive NotificationFired.

installNexusDbMock();
installCoreNodeMock();

// ─── Stub the ElevenLabs HTTP layer with a deterministic 60-byte mp3 ──────
// spyOn the REAL @nexus/core barrel's fetchWithTimeout (router.ts imports it
// from "@nexus/core") rather than mock.module — spyOn is RESTORABLE and scoped
// to beforeAll/afterAll, so the real HTTP layer is handed back to
// reliability-regression.test.ts (which mocks globalThis.fetch to hang) and
// router.test.ts's round-trip (own fetch mock).

const fakeMp3 = new Uint8Array(60);
for (let i = 0; i < 60; i++) fakeMp3[i] = (i * 11 + 3) & 0xff;

let fetchWithTimeoutSpy: ReturnType<typeof spyOn>;
let bufferMock: BufferMockHandle;

beforeAll(() => {
  bufferMock = installBufferMock();
  fetchWithTimeoutSpy = spyOn(coreBarrel, "fetchWithTimeout").mockImplementation(
    async () =>
      new Response(fakeMp3, {
        status: 200,
        headers: { "Content-Type": "audio/mpeg" },
      }),
  );
});

afterAll(() => {
  fetchWithTimeoutSpy.mockRestore();
  bufferMock.restore();
});

// ─── Now load real modules — including the real lifecycleBus ──────────────

const { lifecycleBus } = await import("../services/lifecycle-bus");
const { NotificationManager } = await import("./manager");
const { setRoutingRules } = await import("./router");
const { PresenceContext } = await import("./presence-context");

const stubDb = {} as unknown as ConstructorParameters<typeof NotificationManager>[0];

describe("integration — POST → manager → lifecycleBus carries audioBase64", () => {
  let originalKey: string | undefined;
  let originalVoiceId: string | undefined;

  beforeEach(() => {
    originalKey = process.env.ELEVENLABS_API_KEY;
    process.env.ELEVENLABS_API_KEY = "test-key";
    // The TTS handler only renders audioBase64 when resolveVoiceId() yields a
    // non-null id. With no DB handle wired (stubDb) the lookup falls through to
    // ELEVENLABS_DEFAULT_VOICE_ID — set it so the synth happy path runs and the
    // envelope carries audioBase64 (otherwise it degrades to signal-only).
    originalVoiceId = process.env.ELEVENLABS_DEFAULT_VOICE_ID;
    process.env.ELEVENLABS_DEFAULT_VOICE_ID = "test-voice";
    setRoutingRules([
      {
        project: "nx",
        channels: ["tts"],
        meeting_behavior: "allow",
      },
    ]);
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.ELEVENLABS_API_KEY;
    } else {
      process.env.ELEVENLABS_API_KEY = originalKey;
    }
    if (originalVoiceId === undefined) {
      delete process.env.ELEVENLABS_DEFAULT_VOICE_ID;
    } else {
      process.env.ELEVENLABS_DEFAULT_VOICE_ID = originalVoiceId;
    }
    setRoutingRules([]);
  });

  it("emits NotificationFired with decodable audioBase64 within 5s of send", async () => {
    const manager = new NotificationManager(stubDb);

    const arrival = new Promise<{
      payload: NotificationFiredPayload;
    }>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for NotificationFired")),
        5_000,
      );
      const handler = (
        envelope: LifecycleEnvelope<"NotificationFired">,
      ): void => {
        if (envelope.payload.id !== "integ-1") return;
        clearTimeout(timer);
        lifecycleBus.off("NotificationFired", handler);
        resolve({ payload: envelope.payload });
      };
      lifecycleBus.on("NotificationFired", handler);
    });

    await manager.send({
      id: "integ-1",
      title: "Build complete",
      body: "wave done",
      channel: "tts",
      priority: "normal",
      project: "nx",
      agentId: null,
      createdAt: new Date(),
    } as never);

    const { payload } = await arrival;

    expect(payload.id).toBe("integ-1");
    expect(payload.channel).toBe("tts");
    expect(typeof payload.audioBase64).toBe("string");

    const decoded = Buffer.from(
      (payload.audioBase64 as string) ?? "",
      "base64",
    );
    expect(decoded.byteLength).toBe(60);
    expect(decoded[0]).toBe(fakeMp3[0]);
    expect(decoded[59]).toBe(fakeMp3[59]);
  });
});

// ─── Service-originated notifications share the send() gating pipeline ─────
// route-service-notifications-through-manager, task 2.1. The 5 bypass sites
// (proactive-swap, reaper-job, deploy-staleness, data-integrity-scan,
// credential-swap-flow) now call `sendServiceNotification()` instead of
// emitting `NotificationFired` straight onto the bus, so the meeting-hold and
// quiet-hours gates that already applied to HTTP-originated notifications MUST
// apply to them identically. Service payloads carry NO `project`, which is the
// shape most likely to slip past a gate (project-less rows deliberately skip
// rate-throttling — manager.ts:236 — so hold/quiet-hours are the only gates
// left standing).

/** Mirrors manager-presence.test.ts's stub, plus the held payload capture. */
function makeHeldQueueStub() {
  const calls: {
    id: string;
    holdUntil: Date;
    payload: { title: string; body?: string; project?: string };
  }[] = [];
  return {
    calls,
    queue: {
      hold: mock(
        async (input: {
          id: string;
          holdUntil: Date;
          payload: { title: string; body?: string; project?: string };
        }) => {
          calls.push({
            id: input.id,
            holdUntil: input.holdUntil,
            payload: input.payload,
          });
        },
      ),
      scheduleFlush: mock(() => {}),
      loadPending: mock(async () => []),
      flush: mock(async () => null),
      flushDue: mock(async () => []),
      hydrate: mock(async () => []),
      shutdown: mock(() => {}),
    },
  };
}

function makeQuietHoursStub(opts: {
  enabled: boolean;
  startHour: number;
  endHour: number;
}) {
  return {
    settings: mock(async () => ({
      enabled: opts.enabled,
      startHour: opts.startHour,
      endHour: opts.endHour,
    })),
  };
}

/** The minimal id/title/body/channel shape the 5 bypass sites already build. */
function makeServicePayload(
  id: string,
  overrides: Partial<NotificationFiredPayload> = {},
): NotificationFiredPayload {
  return {
    id,
    title: "Reaper: 3 bloat findings",
    body: "docs/apply pruned to 12 runs",
    channel: "tts",
    ...overrides,
  };
}

describe("integration — sendServiceNotification shares send()'s gating", () => {
  beforeEach(() => {
    // No project rules: a project-less service row falls through to
    // findMatchingRule's "respect the caller's explicit channel" branch.
    setRoutingRules([]);
  });

  afterEach(() => {
    setRoutingRules([]);
  });

  it("holds a project-less service notification during a meeting and flushes it via the coalesced-summary path", async () => {
    // Live console is an in-meeting Mac → presence Rule 2 holds.
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

    const row = await mgr.sendServiceNotification(
      makeServicePayload("svc-hold-1"),
    );

    // Service shape: no project, and the row is NOT delivered — it is held.
    expect(row.project).toBeNull();
    expect(row.status).toBe("queued");
    expect(hq.calls.map((c) => c.id)).toContain("svc-hold-1");

    const held = hq.calls.find((c) => c.id === "svc-hold-1")!;
    expect(held.payload.title).toBe("Reaper: 3 bloat findings");
    expect(held.holdUntil.getTime()).toBeGreaterThan(Date.now());

    // Flush through the existing coalesced-summary path — same call the
    // HeldQueue makes when the hold window expires.
    const summary = await mgr.flushHeldBatch([
      {
        id: held.id,
        userId: "leo",
        payload: held.payload,
        holdUntil: held.holdUntil,
        reason: "rule-2-meeting",
        createdAt: new Date(),
        releasedAt: new Date(),
      },
    ] as never);

    expect(summary).not.toBeNull();
    // Single hold keeps its own title; project-less stays project-less.
    expect(summary!.title).toBe("Reaper: 3 bloat findings");
    expect(summary!.project).toBeNull();
    // Mac active, not bedtime → the summary speaks.
    expect(summary!.channel).toBe("tts");
  });

  it("suppresses a service notification during quiet hours exactly as an HTTP-originated one", async () => {
    const h = new Date().getHours();
    const quietHours = makeQuietHoursStub({
      enabled: true,
      startHour: h,
      endHour: (h + 1) % 24,
    });
    const mgr = new NotificationManager(
      stubDb,
      undefined,
      undefined,
      undefined,
      undefined,
      quietHours,
    );

    // HTTP-originated control (the already-covered behavior).
    const httpRow = await mgr.send({
      id: "qh-http-1",
      title: "Build complete",
      body: "wave done",
      channel: "tts",
      priority: "normal",
      project: null,
      agentId: null,
      createdAt: new Date(),
    } as never);
    expect(httpRow.channel).toBe("desktop");

    // Service-originated: same gate, same outcome.
    const svcRow = await mgr.sendServiceNotification(
      makeServicePayload("qh-svc-1"),
    );
    expect(svcRow.project).toBeNull();
    expect(svcRow.channel).toBe("desktop");
  });

  it("does not suppress a service notification outside the quiet-hours window", async () => {
    const h = new Date().getHours();
    const quietHours = makeQuietHoursStub({
      enabled: true,
      startHour: (h + 2) % 24,
      endHour: (h + 3) % 24,
    });
    const mgr = new NotificationManager(
      stubDb,
      undefined,
      undefined,
      undefined,
      undefined,
      quietHours,
    );

    const row = await mgr.sendServiceNotification(
      makeServicePayload("qh-svc-2"),
    );
    expect(row.channel).toBe("tts");
  });
});
