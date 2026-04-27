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

import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";

// ─── Stub @nexus/db so manager + buffer imports don't reach for PG ────────

mock.module("@nexus/db", () => ({
  eq: mock(() => ({})),
  and: mock(() => ({})),
  notifications: {},
  credentials: {},
  elevenlabsCredentials: {},
}));

mock.module("./buffer", () => ({
  insertNotification: mock(async () => {}),
  queryNotificationsByStatus: mock(async () => []),
  markNotificationDelivered: mock(async () => {}),
  markNotificationExpired: mock(async () => {}),
}));

// ─── Stub the ElevenLabs HTTP layer with a deterministic 60-byte mp3 ──────

const fakeMp3 = new Uint8Array(60);
for (let i = 0; i < 60; i++) fakeMp3[i] = (i * 11 + 3) & 0xff;

mock.module("@nexus/core/fetch", () => ({
  fetchWithTimeout: mock(async () =>
    new Response(fakeMp3, {
      status: 200,
      headers: { "Content-Type": "audio/mpeg" },
    }),
  ),
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

// ─── Now load real modules — including the real lifecycleBus ──────────────

const { lifecycleBus } = await import("../services/lifecycle-bus");
const { NotificationManager } = await import("./manager");
const { setRoutingRules } = await import("./router");

const stubDb = {} as unknown as Parameters<typeof NotificationManager>[0];

describe("integration — POST → manager → lifecycleBus carries audioBase64", () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.ELEVENLABS_API_KEY;
    process.env.ELEVENLABS_API_KEY = "test-key";
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
    setRoutingRules([]);
  });

  it("emits NotificationFired with decodable audioBase64 within 5s of send", async () => {
    const manager = new NotificationManager(stubDb);

    const arrival = new Promise<{
      payload: Record<string, unknown>;
    }>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for NotificationFired")),
        5_000,
      );
      const handler = (envelope: {
        payload: Record<string, unknown>;
      }): void => {
        if ((envelope.payload as { id: string }).id !== "integ-1") return;
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
