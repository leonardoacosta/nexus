/**
 * NotificationManager audio-attachment tests.
 *
 * Spec: restore-tts-mac-audio-dispatch §2.3
 *
 * Verifies the manager threads `audioBase64` from the TTS channel result
 * into the `NotificationFired` lifecycle envelope. Other channels emit
 * without audio.
 *
 * The DB layer is mocked because these tests run without a live PG.
 */

import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";

// ─── Stub @nexus/db so manager imports don't try to talk to PG ─────────────

mock.module("@nexus/db", () => ({
  // Drizzle helper exports — only the surface manager + buffer reach for.
  eq: mock(() => ({})),
  and: mock(() => ({})),
  notifications: {},
  credentials: {},
}));

// ─── Stub the buffer's DB writers — manager calls these on deliver ─────────

mock.module("./buffer", () => ({
  insertNotification: mock(async () => {}),
  queryNotificationsByStatus: mock(async () => []),
  markNotificationDelivered: mock(async () => {}),
  markNotificationExpired: mock(async () => {}),
}));

// ─── Stub the router so the manager sees deterministic delivery results ────

const routeNotificationParallelMock = mock(
  async (
    _n: unknown,
  ): Promise<{
    delivered: Array<{ channel: string; audioBase64?: string }>;
    failed: string[];
  }> => ({
    delivered: [],
    failed: [],
  }),
);

mock.module("./router", () => ({
  routeNotificationParallel: routeNotificationParallelMock,
  routeNotification: mock(async () => []),
  findMatchingRule: mock(() => ({
    channels: ["tts"],
    meeting_behavior: "buffer",
  })),
  setRoutingRules: mock(() => {}),
  getRoutingRules: mock(() => []),
}));

// ─── Capture lifecycle emissions ───────────────────────────────────────────

const lifecycleEmitMock = mock((_event: string, _payload: unknown) => ({}));

mock.module("../services/lifecycle-bus", () => ({
  lifecycleBus: {
    emit: lifecycleEmitMock,
    on: mock(() => {}),
    off: mock(() => {}),
    onAny: mock(() => {}),
    offAny: mock(() => {}),
    setOrigin: mock(() => {}),
    injectPeerEvent: mock(() => {}),
    removeAllListeners: mock(() => {}),
  },
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

// ─── Now load the system under test ────────────────────────────────────────

const { NotificationManager } = await import("./manager");

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeNotification(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "audio-emit-1",
    title: "Build complete",
    body: "tests green",
    channel: "tts",
    priority: "normal",
    status: "queued",
    project: "nx",
    agentId: null,
    createdAt: new Date(),
    sentAt: null,
    ...overrides,
  };
}

// Minimal stand-in for the Db type — manager only stores it for buffer calls.
const stubDb = {} as unknown as Parameters<typeof NotificationManager>[0];

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("NotificationManager.deliverNotification — audio attachment", () => {
  beforeEach(() => {
    routeNotificationParallelMock.mockClear();
    lifecycleEmitMock.mockClear();
  });

  afterEach(() => {
    routeNotificationParallelMock.mockClear();
    lifecycleEmitMock.mockClear();
  });

  it("attaches audioBase64 to NotificationFired when TTS channel returns audio", async () => {
    const audio = Buffer.from(new Uint8Array([1, 2, 3, 4, 5])).toString(
      "base64",
    );
    routeNotificationParallelMock.mockImplementationOnce(async () => ({
      delivered: [{ channel: "tts", audioBase64: audio }],
      failed: [],
    }));

    const manager = new NotificationManager(stubDb);
    const notif = makeNotification({ id: "with-audio" });

    // Cast: makeNotification returns the manager's expected shape.
    await manager.send(notif as never);

    expect(lifecycleEmitMock).toHaveBeenCalled();
    const [event, payload] = lifecycleEmitMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(event).toBe("NotificationFired");
    expect(payload.id).toBe("with-audio");
    expect(payload.channel).toBe("tts");
    expect(payload.audioBase64).toBe(audio);
  });

  it("omits audioBase64 when channel returns no audio (e.g. desktop)", async () => {
    routeNotificationParallelMock.mockImplementationOnce(async () => ({
      delivered: [{ channel: "desktop" }],
      failed: [],
    }));

    const manager = new NotificationManager(stubDb);
    const notif = makeNotification({ id: "no-audio", channel: "desktop" });

    await manager.send(notif as never);

    expect(lifecycleEmitMock).toHaveBeenCalled();
    const [event, payload] = lifecycleEmitMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(event).toBe("NotificationFired");
    expect(payload.audioBase64).toBeUndefined();
  });

  it("emits one NotificationFired per delivered channel, with audio attached only to TTS", async () => {
    const audio = Buffer.from(new Uint8Array([9, 8, 7])).toString("base64");
    routeNotificationParallelMock.mockImplementationOnce(async () => ({
      delivered: [
        { channel: "desktop" },
        { channel: "tts", audioBase64: audio },
        { channel: "slack" },
      ],
      failed: [],
    }));

    const manager = new NotificationManager(stubDb);
    const notif = makeNotification({ id: "fanout" });

    await manager.send(notif as never);

    expect(lifecycleEmitMock).toHaveBeenCalledTimes(3);

    const channels = lifecycleEmitMock.mock.calls.map(
      (call) => (call[1] as { channel: string }).channel,
    );
    expect(channels).toEqual(["desktop", "tts", "slack"]);

    const audios = lifecycleEmitMock.mock.calls.map(
      (call) => (call[1] as { audioBase64?: string }).audioBase64,
    );
    expect(audios).toEqual([undefined, audio, undefined]);
  });
});
