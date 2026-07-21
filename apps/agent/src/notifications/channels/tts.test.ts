/**
 * TTS channel provider-qualified voice routing (provider-qualified-project-voices).
 *
 * Spec: openspec/changes/provider-qualified-project-voices/ task 4.1.
 *
 * `sendTtsNotification` runs the resolved voice id through `parseQualifiedVoice`
 * (task 2.3): a `kokoro:`-qualified project override is owned by the Mac
 * listener's provider chain, so the agent MUST skip synthesis and emit
 * signal-only (`audioBase64` absent) — no ElevenLabs HTTP request at all. A
 * bare voice id (no provider prefix, implicitly `elevenlabs`) pre-renders
 * exactly as before.
 *
 * Mocks `@nexus/core/node` (logger) per the repo-wide `mock.module` pattern
 * (spread the real barrel — nx-jlx1c) and stubs `globalThis.fetch` so no real
 * HTTP round-trip happens. `NEXUS_CONFIG_DIR` is routed to a tmp dir so any
 * persisted mp3 lands in isolation.
 */

import { describe, expect, it, beforeEach, afterAll, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Db } from "@nexus/db";
import * as coreNode from "@nexus/core/node";

// mock.module is PROCESS-GLOBAL; spread the real barrel so sibling suites keep
// every other @nexus/core/node export (nx-jlx1c).
mock.module("@nexus/core/node", () => ({
  ...coreNode,
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

import { sendTtsNotification, setTtsDbHandle } from "./tts";
import type { NotificationRow } from "../buffer";

const tmpConfigDir = mkdtempSync(join(tmpdir(), "nx-tts-channel-"));
const originalConfigDir = process.env.NEXUS_CONFIG_DIR;
const originalApiKey = process.env.ELEVENLABS_API_KEY;
const originalDefaultVoice = process.env.ELEVENLABS_DEFAULT_VOICE_ID;
const originalFetch = globalThis.fetch;

process.env.NEXUS_CONFIG_DIR = tmpConfigDir;

afterAll(() => {
  setTtsDbHandle(null);
  globalThis.fetch = originalFetch;
  if (originalConfigDir === undefined) delete process.env.NEXUS_CONFIG_DIR;
  else process.env.NEXUS_CONFIG_DIR = originalConfigDir;
  if (originalApiKey === undefined) delete process.env.ELEVENLABS_API_KEY;
  else process.env.ELEVENLABS_API_KEY = originalApiKey;
  if (originalDefaultVoice === undefined)
    delete process.env.ELEVENLABS_DEFAULT_VOICE_ID;
  else process.env.ELEVENLABS_DEFAULT_VOICE_ID = originalDefaultVoice;
  try {
    rmSync(tmpConfigDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

/** Fake Db yielding no ElevenLabs credential row + a fixed project-voice override. */
function fakeDbWithVoiceOverride(voiceId: string | null): Db {
  return {
    query: {
      elevenlabsCredentials: {
        findFirst: mock(async () => undefined),
      },
    },
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (voiceId === null ? [] : [{ voiceId }]),
        }),
      }),
    }),
  } as unknown as Db;
}

function makeNotification(
  overrides: Record<string, unknown> = {},
): NotificationRow {
  return {
    id: `tts-channel-test-${Date.now()}-${Math.random()}`,
    channel: "tts",
    title: "TTS Channel Test",
    body: "test body",
    project: "tts-qualify-test",
    priority: "normal",
    status: "queued",
    createdAt: new Date(),
    sentAt: null,
    ...overrides,
  } as unknown as NotificationRow;
}

beforeEach(() => {
  process.env.ELEVENLABS_API_KEY = "test-elevenlabs-key";
  delete process.env.ELEVENLABS_DEFAULT_VOICE_ID;
});

describe("sendTtsNotification — provider-qualified voice routing", () => {
  it("kokoro-qualified project voice: signal-only, no ElevenLabs request", async () => {
    setTtsDbHandle(fakeDbWithVoiceOverride("kokoro:af_heart"));

    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      throw new Error(
        `sendTtsNotification must not call fetch for a kokoro-qualified voice, got: ${url}`,
      );
    }) as unknown as typeof globalThis.fetch;

    const result = await sendTtsNotification(makeNotification());

    expect(result.success).toBe(true);
    expect(result.audioBase64).toBeUndefined();
    expect(result.voiceUsed).toBeUndefined();
  });

  it("bare voice id: pre-renders unchanged (ElevenLabs called, audioBase64 present)", async () => {
    setTtsDbHandle(fakeDbWithVoiceOverride("voice-BARE-123"));

    const FAKE_MP3 = new Uint8Array([0x49, 0x44, 0x33, 0x04]);
    const calls: string[] = [];
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.includes("elevenlabs.io")) {
        calls.push(url);
        return new Response(FAKE_MP3, {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        });
      }
      throw new Error(`unexpected fetch in tts.test.ts: ${url}`);
    }) as unknown as typeof globalThis.fetch;

    const result = await sendTtsNotification(makeNotification());

    expect(result.success).toBe(true);
    expect(typeof result.audioBase64).toBe("string");
    expect(result.audioBase64!.length).toBeGreaterThan(0);
    expect(result.voiceUsed).toBe("voice-BARE-123");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("voice-BARE-123");
  });

  it("elevenlabs-qualified voice id (explicit prefix): pre-renders with the bare voice, unaffected by the prefix", async () => {
    setTtsDbHandle(fakeDbWithVoiceOverride("elevenlabs:voice-EXPLICIT"));

    const FAKE_MP3 = new Uint8Array([0x49, 0x44, 0x33, 0x04]);
    const calls: string[] = [];
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.includes("elevenlabs.io")) {
        calls.push(url);
        return new Response(FAKE_MP3, {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        });
      }
      throw new Error(`unexpected fetch in tts.test.ts: ${url}`);
    }) as unknown as typeof globalThis.fetch;

    const result = await sendTtsNotification(makeNotification());

    expect(result.success).toBe(true);
    expect(typeof result.audioBase64).toBe("string");
    expect(result.voiceUsed).toBe("voice-EXPLICIT");
    expect(calls[0]).toContain("voice-EXPLICIT");
  });
});
