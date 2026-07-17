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
