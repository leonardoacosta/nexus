/**
 * ElevenLabs credential route handler tests.
 *
 * Mirrors the unit-test pattern of `routes/credentials.test.ts`: stubs the
 * encryption resolver, mocks `fetchWithTimeout`, mocks `getAgentId`, and
 * substitutes a fake DB that satisfies the relational query API surface
 * the handlers use (`db.query.elevenlabsCredentials.findFirst`,
 * `db.update`, `db.insert`, `db.delete`).
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

// ─── SUT imports (after mocks) ────────────────────────────────────────────

import {
  handleGetCredentials,
  handlePatchCredentials,
  handleDeleteCredentials,
  initElevenlabsCredentialRoutes,
  resetElevenlabsCredentialRoutes,
} from "./elevenlabs-credentials";
import {
  handleListVoices,
  resetVoiceCache,
} from "./elevenlabs-voices";
import { encrypt } from "../credentials/encryption";

// ─── Fake DB ──────────────────────────────────────────────────────────────

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
  init: { method: string; headers?: Record<string, string>; body?: unknown },
): Request {
  return new Request(url, {
    method: init.method,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

const STUB_KEY = Buffer.alloc(32, 7);

// ─── Tests ────────────────────────────────────────────────────────────────

describe("GET /elevenlabs/credentials — masking", () => {
  beforeEach(() => {
    resetElevenlabsCredentialRoutes();
    initElevenlabsCredentialRoutes(STUB_KEY);
  });

  it("response body NEVER contains the plaintext key or value_encrypted column", async () => {
    const plaintext = "secret-key-123";
    const ciphertext = encrypt(plaintext, STUB_KEY);
    const { db } = makeFakeDb([
      {
        id: "row-1",
        agentId: "test-agent",
        valueEncrypted: ciphertext,
        encryptionKeyId: "v1",
        voiceId: "voice-A",
        voiceName: "Alice",
        lastTestOkAt: null,
        lastTestStatusCode: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const res = await handleGetCredentials(
      db,
      makeRequest("http://127.0.0.1/elevenlabs/credentials", { method: "GET" }),
    );
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain(plaintext);
    expect(text).not.toContain(ciphertext);
    expect(text).not.toContain("value_encrypted");
    expect(text).not.toContain("valueEncrypted");

    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body.hasKey).toBe(true);
    expect(body.voiceId).toBe("voice-A");
    expect(body.agentId).toBe("test-agent");
  });

  it("returns hasKey=false when no row exists", async () => {
    const { db } = makeFakeDb([]);
    const res = await handleGetCredentials(
      db,
      makeRequest("http://127.0.0.1/elevenlabs/credentials", { method: "GET" }),
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.hasKey).toBe(false);
    expect(body.voiceId).toBeNull();
  });
});

describe("PATCH /elevenlabs/credentials — encryption-key gate", () => {
  it("returns 400 when encryption key is not configured", async () => {
    resetElevenlabsCredentialRoutes(); // no key installed
    const { db } = makeFakeDb([]);
    const res = await handlePatchCredentials(
      db,
      makeRequest("http://127.0.0.1/elevenlabs/credentials", {
        method: "PATCH",
        body: { apiKey: "anything" },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, string>;
    expect(body.error).toBe("encryption key not configured");
  });

  it("inserts when no row exists and key is configured", async () => {
    resetElevenlabsCredentialRoutes();
    initElevenlabsCredentialRoutes(STUB_KEY);
    const { db, rows } = makeFakeDb([]);
    const res = await handlePatchCredentials(
      db,
      makeRequest("http://127.0.0.1/elevenlabs/credentials", {
        method: "PATCH",
        body: { apiKey: "new-key", voiceId: "voice-X" },
      }),
    );
    expect(res.status).toBe(200);
    expect(rows.length).toBe(1);
    expect(rows[0]!.valueEncrypted).toBeTruthy();
    expect(rows[0]!.voiceId).toBe("voice-X");
  });
});

describe("DELETE /elevenlabs/credentials", () => {
  beforeEach(() => {
    resetElevenlabsCredentialRoutes();
    initElevenlabsCredentialRoutes(STUB_KEY);
  });

  it("removes the row and returns 204", async () => {
    const { db, rows } = makeFakeDb([
      {
        id: "row-1",
        agentId: "test-agent",
        valueEncrypted: "ciphertext",
        encryptionKeyId: "v1",
        voiceId: null,
        voiceName: null,
        lastTestOkAt: null,
        lastTestStatusCode: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    const res = await handleDeleteCredentials(
      db,
      makeRequest("http://127.0.0.1/elevenlabs/credentials", {
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(204);
    expect(rows.length).toBe(0);
  });
});

describe("GET /elevenlabs/voices — cache hit/miss", () => {
  beforeEach(() => {
    resetElevenlabsCredentialRoutes();
    initElevenlabsCredentialRoutes(STUB_KEY);
    resetVoiceCache();
    fetchWithTimeoutMock.mockClear();
  });

  it("hits upstream once on cache miss, returns cached on second call within TTL", async () => {
    const ciphertext = encrypt("api-key-abc", STUB_KEY);
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
        new Response(
          JSON.stringify({
            voices: [
              { voice_id: "v1", name: "Voice One", labels: { lang: "en" } },
              { voice_id: "v2", name: "Voice Two" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const req = makeRequest("http://127.0.0.1/elevenlabs/voices", {
      method: "GET",
    });

    const r1 = await handleListVoices(db, req);
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { voices: unknown[] };
    expect(b1.voices.length).toBe(2);
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);

    // Second call within TTL — must NOT hit upstream again.
    const r2 = await handleListVoices(db, req);
    expect(r2.status).toBe(200);
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
  });
});
