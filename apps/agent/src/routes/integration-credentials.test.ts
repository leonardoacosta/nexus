/**
 * Generic integration-credential route handler tests.
 *
 * Coverage backfill for the already-implemented handlers in
 * `routes/integration-credentials.ts`. Substitutes a fake DB satisfying the
 * relational query surface the handlers use
 * (`db.query.integrationCredentials.findFirst`, `db.update`, `db.insert`,
 * `db.delete`), mocks `getAgentId`, and drives the real encryption helpers via
 * a stub `NEXUS_ENCRYPTION_KEY` env var — same shape as
 * `elevenlabs-credentials.test.ts`.
 *
 * Covers the spec § "HTTP endpoints ... generic CRUD + test" scenarios:
 * encrypted round trip + mask, unknown-provider 404 (no DB query), metadata
 * validation failure, missing encryption key, and DELETE→GET emptiness.
 *
 * Spec: openspec/changes/add-integration-registry/
 */

import { describe, expect, it, beforeEach, afterAll, afterEach, mock, spyOn } from "bun:test";
import type { Db } from "@nexus/db";
import * as coreNode from "@nexus/core/node";

// ─── Mocks (must be installed BEFORE importing the SUT) ───────────────────
// mock.module is PROCESS-GLOBAL; spread the real barrel so sibling suites keep
// every other @nexus/core/node export.

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
  handleListProviderVoices,
} from "./integration-credentials";
import { decrypt } from "../credentials/encryption";

// The SUT reads the key fresh from NEXUS_ENCRYPTION_KEY via
// `tryLoadEncryptionKey()`. STUB_KEY is a 32-byte buffer; its hex form is the
// 64-char string loadEncryptionKey accepts, decoding back to the same bytes.
const STUB_KEY = Buffer.alloc(32, 7);
const savedEnvKey = process.env.NEXUS_ENCRYPTION_KEY;

function setKey(key: Buffer | undefined): void {
  if (key) process.env.NEXUS_ENCRYPTION_KEY = key.toString("hex");
  else delete process.env.NEXUS_ENCRYPTION_KEY;
}

// The kokoro fixtures below deliberately use `http://127.0.0.1:8880` — the
// realistic same-host local-dev deployment. `harden-kokoro-baseurl`'s
// loopback guard rejects it, so these suites opt out via the escape hatch that
// proposal pre-authorized (§ Decision). Set per-describe and cleared in
// afterEach so it never leaks into `registry.test.ts`, whose forbidden-host
// cases must still reject.
const savedLoopbackFlag = process.env.NEXUS_KOKORO_ALLOW_LOOPBACK;

function setKokoroLoopback(on: boolean): void {
  if (on) process.env.NEXUS_KOKORO_ALLOW_LOOPBACK = "1";
  else delete process.env.NEXUS_KOKORO_ALLOW_LOOPBACK;
}

afterAll(() => {
  if (savedEnvKey === undefined) delete process.env.NEXUS_ENCRYPTION_KEY;
  else process.env.NEXUS_ENCRYPTION_KEY = savedEnvKey;
  if (savedLoopbackFlag === undefined) delete process.env.NEXUS_KOKORO_ALLOW_LOOPBACK;
  else process.env.NEXUS_KOKORO_ALLOW_LOOPBACK = savedLoopbackFlag;
  // Undo the getAgentId stub — mock.module is process-global and
  // last-writer-wins, so leaving "test-agent" in place leaks into any
  // sibling suite that runs after this file and calls the real getAgentId()
  // (nx-9qsmb.11: broke apps/agent/src/db/agent-registry.test.ts on CI).
  mock.module("@nexus/core/node", () => coreNode);
});

// ─── Fake DB ──────────────────────────────────────────────────────────────

interface FakeRow {
  id: string;
  provider: string;
  agentId: string;
  valueEncrypted: string | null;
  encryptionKeyId: string | null;
  metadata: Record<string, unknown>;
  lastTestOkAt: Date | null;
  lastTestStatusCode: number | null;
  createdAt: Date;
  updatedAt: Date;
}

function makeFakeDb(initial: FakeRow[] = []): {
  db: Db;
  rows: FakeRow[];
  findFirst: ReturnType<typeof mock>;
} {
  const rows: FakeRow[] = [...initial];
  const findFirst = mock(async () => rows[0] ?? undefined);

  const db = {
    query: {
      integrationCredentials: { findFirst },
    },
    insert: mock(() => ({
      values: mock(async (row: Partial<FakeRow>) => {
        rows.push({
          id: row.id ?? "row-1",
          provider: row.provider ?? "telegram",
          agentId: row.agentId ?? "test-agent",
          valueEncrypted: row.valueEncrypted ?? null,
          encryptionKeyId: row.encryptionKeyId ?? "v1",
          metadata: row.metadata ?? {},
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

  return { db, rows, findFirst };
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

// ─── Tests ────────────────────────────────────────────────────────────────

describe("integration-credentials — encrypted round trip + mask", () => {
  beforeEach(() => setKey(STUB_KEY));

  it("PATCH persists decryptable ciphertext; GET exposes hasSecret without leaking the secret", async () => {
    const secret = "telegram-bot-token-AAA";
    const { db, rows } = makeFakeDb([]);

    const patchRes = await handlePatchCredentials(
      db,
      makeRequest("http://127.0.0.1/integrations/telegram/credentials", {
        method: "PATCH",
        body: { secret, metadata: { chatId: "111" } },
      }),
      "telegram",
    );
    expect(patchRes.status).toBe(200);

    // Ciphertext persisted and decryptable back to the input secret.
    expect(rows.length).toBe(1);
    expect(rows[0]!.valueEncrypted).toBeTruthy();
    expect(rows[0]!.valueEncrypted).not.toBe(secret);
    expect(decrypt(rows[0]!.valueEncrypted!, STUB_KEY)).toBe(secret);
    expect(rows[0]!.metadata).toEqual({ chatId: "111" });

    // GET never leaks the plaintext or the ciphertext column.
    const getRes = await handleGetCredentials(
      db,
      makeRequest("http://127.0.0.1/integrations/telegram/credentials", {
        method: "GET",
      }),
      "telegram",
    );
    const text = await getRes.text();
    expect(getRes.status).toBe(200);
    expect(text).not.toContain(secret);
    expect(text).not.toContain(rows[0]!.valueEncrypted);
    expect(text).not.toContain("value_encrypted");
    expect(text).not.toContain("valueEncrypted");

    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body.hasSecret).toBe(true);
    expect(body.metadata).toEqual({ chatId: "111" });
    expect(body.agentId).toBe("test-agent");
  });
});

describe("integration-credentials — unknown provider is a 404 before any DB query", () => {
  beforeEach(() => setKey(STUB_KEY));

  it("GET/PATCH/DELETE/test all return 404 {error:'unknown provider'} without touching the DB", async () => {
    const { db, findFirst } = makeFakeDb([]);
    const url = "http://127.0.0.1/integrations/nope/credentials";

    const results = await Promise.all([
      handleGetCredentials(db, makeRequest(url, { method: "GET" }), "nope"),
      handlePatchCredentials(
        db,
        makeRequest(url, { method: "PATCH", body: { secret: "x" } }),
        "nope",
      ),
      handleDeleteCredentials(
        db,
        makeRequest(url, { method: "DELETE" }),
        "nope",
      ),
      handleTestConnection(
        db,
        makeRequest(`${url}/test`, { method: "POST" }),
        "nope",
      ),
    ]);

    for (const res of results) {
      expect(res.status).toBe(404);
      const body = (await res.json()) as Record<string, string>;
      expect(body.error).toBe("unknown provider");
    }
    // 404 fires ahead of any relational read.
    expect(findFirst).not.toHaveBeenCalled();
  });
});

describe("integration-credentials — metadata validation failure", () => {
  beforeEach(() => setKey(STUB_KEY));

  it("PATCH telegram with empty chatId returns 400 and writes no row", async () => {
    const { db, rows } = makeFakeDb([]);
    const res = await handlePatchCredentials(
      db,
      makeRequest("http://127.0.0.1/integrations/telegram/credentials", {
        method: "PATCH",
        body: { metadata: { chatId: "" } },
      }),
      "telegram",
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid metadata");
    expect(rows.length).toBe(0);
  });
});

describe("integration-credentials — missing encryption key", () => {
  beforeEach(() => setKey(undefined));

  it("PATCH with a secret returns 400 'encryption key not configured' and writes no row", async () => {
    const { db, rows } = makeFakeDb([]);
    const res = await handlePatchCredentials(
      db,
      makeRequest("http://127.0.0.1/integrations/telegram/credentials", {
        method: "PATCH",
        body: { secret: "would-be-token", metadata: { chatId: "111" } },
      }),
      "telegram",
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, string>;
    expect(body.error).toBe("encryption key not configured");
    expect(rows.length).toBe(0);
  });
});

describe("integration-credentials — DELETE removes the row", () => {
  beforeEach(() => setKey(STUB_KEY));

  it("DELETE returns 204; subsequent GET reports hasSecret=false", async () => {
    const { db, rows } = makeFakeDb([
      {
        id: "row-1",
        provider: "telegram",
        agentId: "test-agent",
        valueEncrypted: "ciphertext",
        encryptionKeyId: "v1",
        metadata: { chatId: "111" },
        lastTestOkAt: null,
        lastTestStatusCode: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const delRes = await handleDeleteCredentials(
      db,
      makeRequest("http://127.0.0.1/integrations/telegram/credentials", {
        method: "DELETE",
      }),
      "telegram",
    );
    expect(delRes.status).toBe(204);
    expect(rows.length).toBe(0);

    const getRes = await handleGetCredentials(
      db,
      makeRequest("http://127.0.0.1/integrations/telegram/credentials", {
        method: "GET",
      }),
      "telegram",
    );
    const body = (await getRes.json()) as Record<string, unknown>;
    expect(body.hasSecret).toBe(false);
    expect(body.metadata).toEqual({});
  });
});

// ─── [4.1] kokoro secretless test path (add-kokoro-integration-provider) ───
//
// `kokoro` is the first `requiresSecret: false` provider (registry.ts):
// `handleTestConnection` skips the `value_encrypted`/decrypt gate entirely
// and invokes `testProbe("", row.metadata ?? {})` when a row exists at all.
// The probe hits `${baseUrl}/v1/audio/voices` via `fetchWithTimeout`
// (registry.ts) — `globalThis.fetch` is spied (restorable, not
// `mock.module`) so the probe never touches the network.

describe("integration-credentials — kokoro secretless test path", () => {
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

  beforeEach(() => {
    setKey(STUB_KEY);
    setKokoroLoopback(true);
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    setKokoroLoopback(false);
    fetchSpy.mockRestore();
  });

  it("kokoro row with metadata + no secret: probe runs and persists last_test_status_code", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 200 }));

    const { db, rows } = makeFakeDb([
      {
        id: "row-kokoro",
        provider: "kokoro",
        agentId: "test-agent",
        valueEncrypted: null,
        encryptionKeyId: null,
        metadata: { baseUrl: "http://127.0.0.1:8880" },
        lastTestOkAt: null,
        lastTestStatusCode: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const res = await handleTestConnection(
      db,
      makeRequest("http://127.0.0.1/integrations/kokoro/credentials/test", {
        method: "POST",
      }),
      "kokoro",
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.statusCode).toBe(200);
    // Persisted regardless of the outcome — the secretless branch always
    // writes lastTestStatusCode (and lastTestOkAt only when ok).
    expect(rows[0]!.lastTestStatusCode).toBe(200);
    expect(rows[0]!.lastTestOkAt).not.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("kokoro with no row at all: returns 400 'no credential stored', no probe attempted", async () => {
    const { db } = makeFakeDb([]);

    const res = await handleTestConnection(
      db,
      makeRequest("http://127.0.0.1/integrations/kokoro/credentials/test", {
        method: "POST",
      }),
      "kokoro",
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, string>;
    expect(body.error).toBe("no credential stored");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("telegram (requiresSecret unset -> true) without a secret: still 400 'no credential stored', unchanged by the kokoro branch", async () => {
    const { db } = makeFakeDb([
      {
        id: "row-telegram",
        provider: "telegram",
        agentId: "test-agent",
        valueEncrypted: null,
        encryptionKeyId: "v1",
        metadata: { chatId: "111" },
        lastTestOkAt: null,
        lastTestStatusCode: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const res = await handleTestConnection(
      db,
      makeRequest("http://127.0.0.1/integrations/telegram/credentials/test", {
        method: "POST",
      }),
      "telegram",
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, string>;
    expect(body.error).toBe("no credential stored");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("PATCH kokoro with a non-URL baseUrl: 400 invalid metadata, no write", async () => {
    const { db, rows } = makeFakeDb([]);

    const res = await handlePatchCredentials(
      db,
      makeRequest("http://127.0.0.1/integrations/kokoro/credentials", {
        method: "PATCH",
        body: { metadata: { baseUrl: "not-a-url" } },
      }),
      "kokoro",
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid metadata");
    expect(rows.length).toBe(0);
  });
});

// ─── [4.2] GET /integrations/:provider/voices (provider-qualified-project-voices) ──
//
// `handleListProviderVoices` proxies the descriptor's optional `listVoices`.
// A descriptor with no `listVoices` (telegram) 404s before any DB access —
// same shape as the unknown-provider guard above, but keyed off the
// capability rather than registry membership. Kokoro (secretless) skips the
// decrypt gate; a kokoro provider with no stored row 400s.

describe("integration-credentials — GET /integrations/:provider/voices", () => {
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

  beforeEach(() => {
    setKey(STUB_KEY);
    setKokoroLoopback(true);
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    setKokoroLoopback(false);
    fetchSpy.mockRestore();
  });

  it("kokoro: proxies the descriptor's listVoices result", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ voices: [{ id: "af_heart" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const { db } = makeFakeDb([
      {
        id: "row-kokoro",
        provider: "kokoro",
        agentId: "test-agent",
        valueEncrypted: null,
        encryptionKeyId: null,
        metadata: { baseUrl: "http://127.0.0.1:8880" },
        lastTestOkAt: null,
        lastTestStatusCode: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const res = await handleListProviderVoices(
      db,
      makeRequest("http://127.0.0.1/integrations/kokoro/voices", {
        method: "GET",
      }),
      "kokoro",
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.statusCode).toBe(200);
    expect(body.voices).toEqual([{ id: "af_heart" }]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("telegram: has no listVoices — 404 before any DB access", async () => {
    const { db, findFirst } = makeFakeDb([]);

    const res = await handleListProviderVoices(
      db,
      makeRequest("http://127.0.0.1/integrations/telegram/voices", {
        method: "GET",
      }),
      "telegram",
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, string>;
    expect(body.error).toBe("unknown provider");
    expect(findFirst).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("kokoro with no stored row: 400, no probe attempted", async () => {
    const { db } = makeFakeDb([]);

    const res = await handleListProviderVoices(
      db,
      makeRequest("http://127.0.0.1/integrations/kokoro/voices", {
        method: "GET",
      }),
      "kokoro",
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, string>;
    expect(body.error).toBe("no credential stored");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
