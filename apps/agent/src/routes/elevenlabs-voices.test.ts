/**
 * ElevenLabs voice list cache tests:
 *   - PATCH-with-apiKey invalidates the cached voice list
 *   - DELETE invalidates the cached voice list
 *   - LRU cap (32) evicts the oldest entry on insert past cap
 *
 * Spec: openspec/changes/harden-elevenlabs-credential-p2-p3-gcf/
 */

import { describe, expect, it, beforeEach, mock } from "bun:test";
import type { Db } from "@nexus/db";

// ─── Mocks (must be installed BEFORE importing the SUT) ───────────────────

const fetchWithTimeoutMock = mock(
  async (_url: string, _init: unknown) => new Response(null, { status: 200 }),
);
mock.module("@nexus/core/fetch", () => ({
  fetchWithTimeout: fetchWithTimeoutMock,
}));

// `getAgentId` must be re-mockable per-test for the LRU cap scenario.
const getAgentIdMock = mock(() => "test-agent");
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
  getAgentId: getAgentIdMock,
}));

// ─── SUT imports (after mocks) ────────────────────────────────────────────

import {
  handleListVoices,
  resetVoiceCache,
  invalidateVoiceCache,
} from "./elevenlabs-voices";
import {
  handlePatchCredentials,
  handleDeleteCredentials,
} from "./elevenlabs-credentials";
import {
  setElevenlabsRuntime,
  resetElevenlabsRuntime,
} from "../credentials/elevenlabs-runtime";
import { encrypt } from "../credentials/encryption";

// ─── Helpers ──────────────────────────────────────────────────────────────

interface FakeRow {
  id: string;
  agentId: string;
  valueEncrypted: string | null;
  encryptionKeyId: string | null;
  voiceId: string | null;
  voiceName: string | null;
  lastTestOkAt: Date | null;
  lastTestStatusCode: number | null;
  createdAt: Date;
  updatedAt: Date;
}

function makeFakeDb(initial: FakeRow[] = []): { db: Db; rows: FakeRow[] } {
  const rows: FakeRow[] = [...initial];
  const db = {
    query: {
      elevenlabsCredentials: {
        findFirst: mock(async () => rows[0] ?? undefined),
      },
    },
    insert: mock(() => ({
      values: mock(async (row: Partial<FakeRow>) => {
        rows.push({
          id: row.id ?? "row-1",
          agentId: row.agentId ?? "test-agent",
          valueEncrypted: row.valueEncrypted ?? null,
          encryptionKeyId: row.encryptionKeyId ?? "v1",
          voiceId: row.voiceId ?? null,
          voiceName: row.voiceName ?? null,
          lastTestOkAt: row.lastTestOkAt ?? null,
          lastTestStatusCode: row.lastTestStatusCode ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }),
    })),
    update: mock(() => ({
      set: mock((patch: Partial<FakeRow>) => ({
        where: mock(async () => {
          if (rows[0]) Object.assign(rows[0], patch);
        }),
      })),
    })),
    delete: mock(() => ({
      where: mock(async () => {
        rows.length = 0;
      }),
    })),
  } as unknown as Db;
  return { db, rows };
}

function makeRequest(
  url: string,
  init: { method: string; body?: unknown },
): Request {
  return new Request(url, {
    method: init.method,
    headers: { "Content-Type": "application/json" },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

const STUB_KEY = Buffer.alloc(32, 7);

function voicesPayload() {
  return JSON.stringify({
    voices: [
      { voice_id: "v1", name: "Voice One" },
      { voice_id: "v2", name: "Voice Two" },
    ],
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("invalidateVoiceCache — PATCH-with-apiKey", () => {
  beforeEach(() => {
    resetElevenlabsRuntime();
    setElevenlabsRuntime({ encryptionKey: STUB_KEY });
    resetVoiceCache();
    fetchWithTimeoutMock.mockClear();
    getAgentIdMock.mockImplementation(() => "test-agent");
  });

  it("PATCH with apiKey invalidates the cached voice list — next GET fetches upstream", async () => {
    const ciphertext = encrypt("OLD_KEY", STUB_KEY);
    const { db } = makeFakeDb([
      {
        id: "row-1",
        agentId: "test-agent",
        valueEncrypted: ciphertext,
        encryptionKeyId: "v1",
        voiceId: null,
        voiceName: null,
        lastTestOkAt: null,
        lastTestStatusCode: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    // Warm the cache.
    fetchWithTimeoutMock.mockImplementationOnce(
      async () =>
        new Response(voicesPayload(), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    await handleListVoices(
      db,
      makeRequest("http://127.0.0.1/elevenlabs/voices", { method: "GET" }),
    );
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);

    // Sanity: cached-second-call would NOT hit upstream — assert before PATCH.
    await handleListVoices(
      db,
      makeRequest("http://127.0.0.1/elevenlabs/voices", { method: "GET" }),
    );
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);

    // PATCH a new apiKey — should invalidate the cache.
    await handlePatchCredentials(
      db,
      makeRequest("http://127.0.0.1/elevenlabs/credentials", {
        method: "PATCH",
        body: { apiKey: "NEW_KEY" },
      }),
    );

    // Next GET must fetch upstream again.
    fetchWithTimeoutMock.mockImplementationOnce(
      async () =>
        new Response(voicesPayload(), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    await handleListVoices(
      db,
      makeRequest("http://127.0.0.1/elevenlabs/voices", { method: "GET" }),
    );
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
  });

  it("PATCH without apiKey does NOT invalidate the cache", async () => {
    const ciphertext = encrypt("KEY", STUB_KEY);
    const { db } = makeFakeDb([
      {
        id: "row-1",
        agentId: "test-agent",
        valueEncrypted: ciphertext,
        encryptionKeyId: "v1",
        voiceId: null,
        voiceName: null,
        lastTestOkAt: null,
        lastTestStatusCode: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    fetchWithTimeoutMock.mockImplementationOnce(
      async () =>
        new Response(voicesPayload(), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    await handleListVoices(
      db,
      makeRequest("http://127.0.0.1/elevenlabs/voices", { method: "GET" }),
    );
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);

    // PATCH only voiceId — must NOT invalidate.
    await handlePatchCredentials(
      db,
      makeRequest("http://127.0.0.1/elevenlabs/credentials", {
        method: "PATCH",
        body: { voiceId: "voice-X" },
      }),
    );

    await handleListVoices(
      db,
      makeRequest("http://127.0.0.1/elevenlabs/voices", { method: "GET" }),
    );
    // Still 1 — the cache is still warm.
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
  });
});

describe("invalidateVoiceCache — DELETE", () => {
  beforeEach(() => {
    resetElevenlabsRuntime();
    setElevenlabsRuntime({ encryptionKey: STUB_KEY });
    resetVoiceCache();
    fetchWithTimeoutMock.mockClear();
    getAgentIdMock.mockImplementation(() => "test-agent");
  });

  it("DELETE invalidates the cached voice list — next GET hits no-row branch", async () => {
    const ciphertext = encrypt("KEY", STUB_KEY);
    const { db } = makeFakeDb([
      {
        id: "row-1",
        agentId: "test-agent",
        valueEncrypted: ciphertext,
        encryptionKeyId: "v1",
        voiceId: null,
        voiceName: null,
        lastTestOkAt: null,
        lastTestStatusCode: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    // Warm cache.
    fetchWithTimeoutMock.mockImplementationOnce(
      async () =>
        new Response(voicesPayload(), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    await handleListVoices(
      db,
      makeRequest("http://127.0.0.1/elevenlabs/voices", { method: "GET" }),
    );
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);

    // DELETE — invalidates AND removes row.
    await handleDeleteCredentials(
      db,
      makeRequest("http://127.0.0.1/elevenlabs/credentials", {
        method: "DELETE",
      }),
    );

    // Next GET hits the no-row branch (400) instead of returning stale voices.
    const res = await handleListVoices(
      db,
      makeRequest("http://127.0.0.1/elevenlabs/voices", { method: "GET" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, string>;
    expect(body.error).toBe("no credential stored");
  });
});

describe("voice cache LRU cap", () => {
  beforeEach(() => {
    resetElevenlabsRuntime();
    setElevenlabsRuntime({ encryptionKey: STUB_KEY });
    resetVoiceCache();
    fetchWithTimeoutMock.mockClear();
  });

  it("evicts the oldest entry when the 33rd unique agentId is inserted", async () => {
    // Pre-populate 32 entries by directly invoking the cache-population path.
    // We use `invalidateVoiceCache` to drop and `handleListVoices` to insert
    // — but to keep this hermetic we simulate inserts by varying agentId via
    // the `getAgentId` mock and warming the cache through 32 fetches.
    const ciphertext = encrypt("KEY", STUB_KEY);

    function makeRowDb(agentId: string) {
      return makeFakeDb([
        {
          id: `row-${agentId}`,
          agentId,
          valueEncrypted: ciphertext,
          encryptionKeyId: "v1",
          voiceId: null,
          voiceName: null,
          lastTestOkAt: null,
          lastTestStatusCode: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);
    }

    // Warm 32 unique agentIds.
    for (let i = 1; i <= 32; i++) {
      const agentId = `agent-${i}`;
      getAgentIdMock.mockImplementation(() => agentId);
      fetchWithTimeoutMock.mockImplementationOnce(
        async () =>
          new Response(voicesPayload(), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
      const { db } = makeRowDb(agentId);
      await handleListVoices(
        db,
        makeRequest("http://127.0.0.1/elevenlabs/voices", { method: "GET" }),
      );
    }
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(32);

    // Insert agent-33 — should evict agent-1 (oldest).
    getAgentIdMock.mockImplementation(() => "agent-33");
    fetchWithTimeoutMock.mockImplementationOnce(
      async () =>
        new Response(voicesPayload(), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    {
      const { db } = makeRowDb("agent-33");
      await handleListVoices(
        db,
        makeRequest("http://127.0.0.1/elevenlabs/voices", { method: "GET" }),
      );
    }
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(33);

    // Verify agent-1 was evicted: a fresh GET for agent-1 must re-fetch.
    getAgentIdMock.mockImplementation(() => "agent-1");
    fetchWithTimeoutMock.mockImplementationOnce(
      async () =>
        new Response(voicesPayload(), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    {
      const { db } = makeRowDb("agent-1");
      await handleListVoices(
        db,
        makeRequest("http://127.0.0.1/elevenlabs/voices", { method: "GET" }),
      );
    }
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(34);

    // Verify agent-2..agent-33 are still cached: each fresh GET must NOT
    // re-fetch (call count should remain at 34 after a full sweep — except
    // for agent-1, which we just re-warmed and is at the back of the LRU).
    // After re-warming agent-1, agent-2 became the oldest. Test agent-3..33
    // are still cached.
    for (let i = 3; i <= 33; i++) {
      const agentId = `agent-${i}`;
      getAgentIdMock.mockImplementation(() => agentId);
      const { db } = makeRowDb(agentId);
      await handleListVoices(
        db,
        makeRequest("http://127.0.0.1/elevenlabs/voices", { method: "GET" }),
      );
    }
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(34);
  });

  it("invalidateVoiceCache(agentId) is a no-op when the agent is not cached", () => {
    expect(() => invalidateVoiceCache("not-a-real-agent")).not.toThrow();
  });
});
