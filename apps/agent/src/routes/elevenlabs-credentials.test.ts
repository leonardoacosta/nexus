/**
 * ElevenLabs credential route handler tests.
 *
 * Mocks `fetchWithTimeout` + `getAgentId`, substitutes a fake DB that
 * satisfies the relational query API surface the handlers use
 * (`db.query.elevenlabsCredentials.findFirst`, `db.update`, `db.insert`,
 * `db.delete`), and drives the real encryption helpers via a stub
 * `NEXUS_ENCRYPTION_KEY` env var.
 *
 * Covers the task-2.7 invariants: mask (GET + test never leak the key),
 * encryption-key gate (400), insert, delete, decrypt failure, no-credential
 * gate, Zod validation, and voice-list cache hit/miss.
 *
 * Spec: openspec/changes/add-elevenlabs-credential/
 */

import { describe, expect, it, beforeEach, afterAll, mock, spyOn } from "bun:test";
import type { Db } from "@nexus/db";
import * as coreNode from "@nexus/core/node";
import * as coreFetch from "@nexus/core/fetch";

// ─── Mocks (must be installed BEFORE importing the SUT) ───────────────────
// mock.module is PROCESS-GLOBAL; spread the real barrel so sibling suites keep
// every other @nexus/core/node export (nx-jlx1c).

// fetchWithTimeout is spied via RESTORABLE `spyOn` (NOT mock.module): a global
// mock.module override leaked into credential-usage-poller.test.ts (loads
// later, calls the REAL fetchWithTimeout which routes through the test's
// globalThis.fetch stub) — the leaked stub returned an empty 200 so the poller
// tick recorded 0 successes. `mockRestore()` in afterAll hands the real function
// back to that sibling suite (nx-jlx1c).
const fetchWithTimeoutMock = spyOn(coreFetch, "fetchWithTimeout").mockImplementation(
  (async (_url: string, _init: unknown) =>
    new Response(null, { status: 200 })) as typeof coreFetch.fetchWithTimeout,
);

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

// ─── SUT imports (after mocks) ────────────────────────────────────────────

import {
  handleGetCredentials,
  handlePatchCredentials,
  handleDeleteCredentials,
  handleTestConnection,
} from "./elevenlabs-credentials";
import { handleListVoices, resetVoiceCache } from "./elevenlabs-voices";
import { encrypt } from "../credentials/encryption";

// The SUT reads the key fresh from NEXUS_ENCRYPTION_KEY via
// `tryLoadEncryptionKey()`. STUB_KEY is a 32-byte buffer; its hex form is the
// 64-char string loadEncryptionKey accepts, decoding back to the same bytes.
const STUB_KEY = Buffer.alloc(32, 7);
const STUB_KEY_HEX = STUB_KEY.toString("hex");
const savedEnvKey = process.env.NEXUS_ENCRYPTION_KEY;

/** Install (or clear) the stub encryption key in the env. */
function initElevenlabsCredentialRoutes(key: Buffer | undefined): void {
  if (key) process.env.NEXUS_ENCRYPTION_KEY = key.toString("hex");
  else delete process.env.NEXUS_ENCRYPTION_KEY;
}
function resetElevenlabsCredentialRoutes(): void {
  delete process.env.NEXUS_ENCRYPTION_KEY;
}

afterAll(() => {
  fetchWithTimeoutMock.mockRestore();
  if (savedEnvKey === undefined) delete process.env.NEXUS_ENCRYPTION_KEY;
  else process.env.NEXUS_ENCRYPTION_KEY = savedEnvKey;
  // Undo the getAgentId stub — mock.module is process-global and
  // last-writer-wins, so leaving "test-agent" in place leaks into any
  // sibling suite that runs after this file and calls the real getAgentId()
  // (nx-9qsmb.11: broke apps/agent/src/db/agent-registry.test.ts on CI).
  mock.module("@nexus/core/node", () => coreNode);
});

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

describe("POST /elevenlabs/credentials/test — non-leakage + decrypt failure + missing row", () => {
  beforeEach(() => {
    resetElevenlabsCredentialRoutes();
    initElevenlabsCredentialRoutes(STUB_KEY);
    fetchWithTimeoutMock.mockClear();
  });

  it("response body never echoes the decrypted apiKey, even on a 200 with subscription data", async () => {
    const plaintext = "xi-secret-AAA";
    const ciphertext = encrypt(plaintext, STUB_KEY);
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
            subscription: {
              tier: "pro",
              character_count: 100,
              character_limit: 10000,
              next_character_count_reset_unix: 1_900_000_000,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const res = await handleTestConnection(
      db,
      makeRequest("http://127.0.0.1/elevenlabs/credentials/test", {
        method: "POST",
      }),
    );
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain(plaintext);
    expect(text).not.toContain(ciphertext);
    expect(text).not.toContain("value_encrypted");
    expect(text).not.toContain("valueEncrypted");

    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.statusCode).toBe(200);
    expect(body.subscription).toMatchObject({
      tier: "pro",
      characterCount: 100,
      characterLimit: 10000,
    });
  });

  it("returns 500 + 'could not decrypt stored credential' when decrypt throws, without calling upstream", async () => {
    const corrupted = Buffer.from("garbage").toString("base64");
    const { db } = makeFakeDb([
      {
        id: "row-1",
        agentId: "test-agent",
        valueEncrypted: corrupted,
        encryptionKeyId: "v1",
        voiceId: null,
        voiceName: null,
        lastTestOkAt: null,
        lastTestStatusCode: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const res = await handleTestConnection(
      db,
      makeRequest("http://127.0.0.1/elevenlabs/credentials/test", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, string>;
    expect(body.error).toBe("could not decrypt stored credential");
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  });

  it("returns 400 + 'no credential stored' when no row exists", async () => {
    const { db } = makeFakeDb([]);
    const res = await handleTestConnection(
      db,
      makeRequest("http://127.0.0.1/elevenlabs/credentials/test", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, string>;
    expect(body.error).toBe("no credential stored");
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  });
});

describe("PATCH /elevenlabs/credentials — Zod validation", () => {
  beforeEach(() => {
    resetElevenlabsCredentialRoutes();
    initElevenlabsCredentialRoutes(STUB_KEY);
  });

  it("rejects empty-string apiKey with 400 and 'invalid input'", async () => {
    const { db, rows } = makeFakeDb([]);
    const res = await handlePatchCredentials(
      db,
      makeRequest("http://127.0.0.1/elevenlabs/credentials", {
        method: "PATCH",
        body: { apiKey: "" },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; detail: unknown };
    expect(body.error).toBe("invalid input");
    expect(Array.isArray(body.detail)).toBe(true);
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

    const r2 = await handleListVoices(db, req);
    expect(r2.status).toBe(200);
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
  });
});
