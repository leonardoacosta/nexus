/**
 * TTS notification channel tests — project prefix behavior.
 *
 * Verifies that sendTtsNotification prepends `<project>: ` to the body when
 * notification.project is a non-empty string, and sends the raw body otherwise.
 *
 * Parallel task ownership (spec: fix-tts-announce-project-prefix):
 *   [2.1] non-empty project prepends prefix
 *   [2.2] null project → no prefix
 *   [2.3] empty-string project → no prefix
 *   [2.4] stub branch (no API key) parity
 *
 * Each it(...) block is owned by one task; do not modify siblings.
 */

import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import type { NotificationRow } from "../buffer";

// ─── Shared mocks ───────────────────────────────────────────────────────────

const fetchWithTimeoutMock = mock(async (_url: string, _init: unknown) => {
  return new Response(null, { status: 200 });
});

mock.module("@nexus/core/fetch", () => ({
  fetchWithTimeout: fetchWithTimeoutMock,
}));

const loggerInfoMock = mock((..._args: unknown[]) => {});

mock.module("@nexus/core/node", () => ({
  logger: {
    info: loggerInfoMock,
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

// ─── Fixture helper ─────────────────────────────────────────────────────────

function makeNotification(overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: "tts-test-1",
    title: "Test",
    body: "build complete",
    channel: "tts",
    priority: "normal",
    status: "queued",
    project: null,
    agentId: null,
    createdAt: new Date(),
    sentAt: null,
    ...overrides,
  } as NotificationRow;
}

// ─── sendTtsNotification ────────────────────────────────────────────────────

describe("sendTtsNotification", () => {
  let originalApiKey: string | undefined;

  beforeEach(() => {
    fetchWithTimeoutMock.mockClear();
    loggerInfoMock.mockClear();
    originalApiKey = process.env.ELEVENLABS_API_KEY;
    process.env.ELEVENLABS_API_KEY = "test-key";
  });

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.ELEVENLABS_API_KEY;
    } else {
      process.env.ELEVENLABS_API_KEY = originalApiKey;
    }
  });

  // ─── Task 2.1 ─────────────────────────────────────────────────────────────
  it('prepends "<project>:" prefix when project is non-empty string', async () => {
    const { sendTtsNotification } = await import("./tts");

    const notif = makeNotification({
      id: "tts-2.1",
      project: "nova",
      body: "build complete",
    });

    await sendTtsNotification(notif);

    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchWithTimeoutMock.mock.calls[0] as [
      string,
      { body: string },
    ];
    expect(url).toContain("https://api.elevenlabs.io/v1/text-to-speech/");
    const parsed = JSON.parse(init.body) as { text: string };
    expect(parsed.text).toBe("nova: build complete");
  });

  // ─── Task 2.2 ─────────────────────────────────────────────────────────────
  it("emits bare body with no prefix when project is null", async () => {
    const { sendTtsNotification } = await import("./tts");

    const notif = makeNotification({
      id: "t-null",
      project: null,
      body: "deploy succeeded",
    });

    await sendTtsNotification(notif);

    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchWithTimeoutMock.mock.calls[0] as [
      string,
      { body: string },
    ];
    const parsed = JSON.parse(init.body) as { text: string };
    expect(parsed.text).toBe("deploy succeeded");
    expect(parsed.text).not.toContain("nexus");
    expect(parsed.text).not.toContain("unknown");
    expect(parsed.text).not.toContain("null");
    expect(parsed.text).not.toContain(":");
  });

  // ─── Task 2.3 ─────────────────────────────────────────────────────────────
  it("treats empty string project as absent (no prefix, no colon artifact)", async () => {
    const { sendTtsNotification } = await import("./tts");

    const notif = makeNotification({
      id: "tts-2.3",
      project: "",
      body: "something happened",
    });

    await sendTtsNotification(notif);

    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchWithTimeoutMock.mock.calls[0] as [
      string,
      { body: string },
    ];
    const parsed = JSON.parse(init.body) as { text: string };
    expect(parsed.text).toBe("something happened");
    expect(parsed.text).not.toContain(": ");
  });

  // ─── Task 2.4 ─────────────────────────────────────────────────────────────
  it("stub branch logs composed text when ELEVENLABS_API_KEY is unset", async () => {
    delete process.env.ELEVENLABS_API_KEY;

    const { sendTtsNotification } = await import("./tts");

    const notif = makeNotification({
      id: "tts-2.4",
      project: "nx",
      body: "tests green",
    });

    const result = await sendTtsNotification(notif);

    expect(result).toEqual({ success: true });
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
    expect(loggerInfoMock).toHaveBeenCalled();
    const [firstArg] = loggerInfoMock.mock.calls[0] as [
      { id: string; body: string },
    ];
    expect(firstArg).toEqual({ id: "tts-2.4", body: "nx: tests green" });
  });
});

// ─── Graceful fallback (nx-4p8n follow-up: ElevenLabs failure → local TTS) ──
//
// When ELEVENLABS_API_KEY is set but the API rejects the call (401, 429,
// network error, etc.) the channel must NOT throw. It must return
// `{ success: true }` with no audioBase64 so `NotificationFired` still
// fires and the Mac `nexus-notifier` can fall back to `say`.

describe("sendTtsNotification — ElevenLabs failure fallback", () => {
  let originalApiKey: string | undefined;

  beforeEach(() => {
    fetchWithTimeoutMock.mockClear();
    loggerInfoMock.mockClear();
    originalApiKey = process.env.ELEVENLABS_API_KEY;
    process.env.ELEVENLABS_API_KEY = "test-key";
  });

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.ELEVENLABS_API_KEY;
    } else {
      process.env.ELEVENLABS_API_KEY = originalApiKey;
    }
  });

  it("returns signal-only success on HTTP 401 (invalid/expired API key)", async () => {
    fetchWithTimeoutMock.mockImplementationOnce(
      async () => new Response(null, { status: 401 }),
    );

    const { sendTtsNotification } = await import("./tts");

    const result = await sendTtsNotification(
      makeNotification({ id: "tts-fb-401", body: "ship it" }),
    );

    expect(result.success).toBe(true);
    expect(result.audioBase64).toBeUndefined();
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
  });

  it("returns signal-only success on HTTP 429 (quota exhausted)", async () => {
    fetchWithTimeoutMock.mockImplementationOnce(
      async () => new Response(null, { status: 429 }),
    );

    const { sendTtsNotification } = await import("./tts");

    const result = await sendTtsNotification(
      makeNotification({ id: "tts-fb-429", body: "throttled" }),
    );

    expect(result.success).toBe(true);
    expect(result.audioBase64).toBeUndefined();
  });

  it("returns signal-only success when fetch throws (network/timeout)", async () => {
    fetchWithTimeoutMock.mockImplementationOnce(async () => {
      throw new Error("ETIMEDOUT");
    });

    const { sendTtsNotification } = await import("./tts");

    const result = await sendTtsNotification(
      makeNotification({ id: "tts-fb-timeout", body: "offline" }),
    );

    expect(result.success).toBe(true);
    expect(result.audioBase64).toBeUndefined();
  });
});
