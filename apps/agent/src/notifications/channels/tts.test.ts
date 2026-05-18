/**
 * Unit tests for the signal-only TTS channel.
 *
 * Post swift-owns-elevenlabs-synth, the channel no longer issues any HTTP
 * call to ElevenLabs and no longer returns audioBase64 bytes. Synthesis is
 * the Mac listener's responsibility (NexusShared.ElevenLabsClient +
 * AVAudioPlayer). The previous test suite — which exercised the ElevenLabs
 * fetch, fallback paths, and audioBase64 result shape — is intentionally
 * replaced by this narrower contract.
 *
 * Coverage:
 *   - returns { success: true } unconditionally for any notification
 *   - never calls fetch (i.e. the agent stays signal-only)
 *   - scrubFetchError continues to redact xi-api-key headers
 */

import { describe, expect, it, mock } from "bun:test";

import { sendTtsNotification, scrubFetchError } from "./tts";
import type { NotificationRow } from "../buffer";

function makeRow(overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: "n-1",
    channel: "tts",
    title: "title",
    body: "hello world",
    project: null,
    agentId: null,
    priority: "normal",
    status: "queued",
    sentAt: null,
    createdAt: new Date(),
    ...overrides,
  } as NotificationRow;
}

describe("sendTtsNotification (signal-only)", () => {
  it("returns success regardless of input", async () => {
    const result = await sendTtsNotification(makeRow());
    expect(result.success).toBe(true);
  });

  it("never issues a fetch call", async () => {
    const fetchSpy = mock();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as never;
    try {
      await sendTtsNotification(makeRow({ project: "tc" }));
      expect(fetchSpy).toHaveBeenCalledTimes(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not return audioBase64 (deleted by spec)", async () => {
    const result = (await sendTtsNotification(makeRow())) as Record<string, unknown>;
    expect(result.audioBase64).toBeUndefined();
  });
});

describe("scrubFetchError", () => {
  it("strips xi-api-key from error objects", () => {
    const err = Object.assign(new Error("boom"), {
      headers: { "xi-api-key": "SECRET", "content-type": "application/json" },
    });
    const scrubbed = scrubFetchError(err) as { headers?: Record<string, unknown> };
    expect(scrubbed.headers).toBeDefined();
    expect((scrubbed.headers as Record<string, unknown>)?.["xi-api-key"]).toBeUndefined();
    expect((scrubbed.headers as Record<string, unknown>)?.["content-type"]).toBe(
      "application/json",
    );
  });

  it("handles cycle-safe traversal", () => {
    const obj: Record<string, unknown> = { name: "outer" };
    obj.self = obj;
    const result = scrubFetchError(obj) as Record<string, unknown>;
    expect(result.name).toBe("outer");
    expect(result.self).toBe("[Circular]");
  });
});
