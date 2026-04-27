/**
 * Notification settings route handler tests.
 *
 * Mirrors the unit-test pattern of `routes/elevenlabs-credentials.test.ts`:
 * mocks the logger, substitutes a fake DB that satisfies the relational
 * query API surface (`db.query.notificationSettings.findFirst`,
 * `db.update().set().where().returning()`), and asserts on the public HTTP
 * shape + the lifecycle-bus emission.
 *
 * No live PostgreSQL is required. Run:
 *   cd apps/agent && bun test src/routes/notification-settings.test.ts
 */

import { describe, expect, it, beforeEach, mock } from "bun:test";
import type { Db } from "@nexus/db";

// ─── Mocks (must be installed BEFORE importing the SUT) ───────────────────

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
}));

// ─── SUT imports (after mocks) ────────────────────────────────────────────

import {
  handleGetNotificationSettings,
  handlePatchNotificationSettings,
} from "./notification-settings";
import { lifecycleBus } from "../services/lifecycle-bus";
import type { SettingsChangedPayload } from "../services/lifecycle-bus";

// ─── Fake DB ──────────────────────────────────────────────────────────────

interface FakeRow {
  id: number;
  ttsEnabled: boolean;
  bannerEnabled: boolean;
  duckingMode: "full" | "half" | "mute";
  updatedAt: Date;
}

function defaultRow(): FakeRow {
  return {
    id: 1,
    ttsEnabled: true,
    bannerEnabled: true,
    duckingMode: "full",
    updatedAt: new Date("2026-04-26T00:00:00.000Z"),
  };
}

function makeFakeDb(initial?: FakeRow): { db: Db; rows: FakeRow[] } {
  const rows: FakeRow[] = [initial ?? defaultRow()];

  const db = {
    query: {
      notificationSettings: {
        findFirst: mock(async () => rows[0]),
      },
    },
    update: mock(() => ({
      set: mock((patch: Partial<FakeRow>) => ({
        where: mock(() => ({
          returning: mock(async () => {
            if (rows[0]) {
              Object.assign(rows[0], patch);
              return [rows[0]];
            }
            return [];
          }),
        })),
      })),
    })),
  } as unknown as Db;

  return { db, rows };
}

function makeRequest(
  method: "GET" | "PATCH",
  body?: unknown,
): Request {
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return new Request("http://127.0.0.1:7400/notifications/settings", init);
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("GET /notifications/settings", () => {
  it("returns the id=1 row in wire format", async () => {
    const { db } = makeFakeDb();
    const res = await handleGetNotificationSettings(db, makeRequest("GET"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: 1,
      tts_enabled: true,
      banner_enabled: true,
      ducking_mode: "full",
    });
    expect(typeof body.updated_at).toBe("string");
  });

  it("returns 404 when the sentinel row is missing", async () => {
    // Build a DB whose findFirst yields undefined.
    const db = {
      query: {
        notificationSettings: {
          findFirst: mock(async () => undefined),
        },
      },
    } as unknown as Db;
    const res = await handleGetNotificationSettings(db, makeRequest("GET"));

    expect(res.status).toBe(404);
  });
});

describe("PATCH /notifications/settings — validation", () => {
  it("rejects malformed JSON with 400", async () => {
    const { db } = makeFakeDb();
    const req = new Request("http://127.0.0.1:7400/notifications/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    const res = await handlePatchNotificationSettings(db, req);
    expect(res.status).toBe(400);
  });

  it("rejects non-object body (array) with 400", async () => {
    const { db } = makeFakeDb();
    const res = await handlePatchNotificationSettings(
      db,
      makeRequest("PATCH", []),
    );
    expect(res.status).toBe(400);
  });

  it("rejects null body with 400", async () => {
    const { db } = makeFakeDb();
    const res = await handlePatchNotificationSettings(
      db,
      makeRequest("PATCH", null),
    );
    expect(res.status).toBe(400);
  });

  it("rejects unknown fields with 400", async () => {
    const { db } = makeFakeDb();
    const res = await handlePatchNotificationSettings(
      db,
      makeRequest("PATCH", { foo: "bar" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe("unknown field");
    expect(body.detail).toContain("foo");
  });

  it("rejects invalid ducking_mode enum value with 400", async () => {
    const { db } = makeFakeDb();
    const res = await handlePatchNotificationSettings(
      db,
      makeRequest("PATCH", { ducking_mode: "invalid" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("ducking_mode");
  });

  it("rejects non-boolean tts_enabled with 400", async () => {
    const { db } = makeFakeDb();
    const res = await handlePatchNotificationSettings(
      db,
      makeRequest("PATCH", { tts_enabled: "yes" }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects non-boolean banner_enabled with 400", async () => {
    const { db } = makeFakeDb();
    const res = await handlePatchNotificationSettings(
      db,
      makeRequest("PATCH", { banner_enabled: 1 }),
    );
    expect(res.status).toBe(400);
  });

  it("accepts each valid ducking_mode value", async () => {
    for (const mode of ["full", "half", "mute"] as const) {
      const { db } = makeFakeDb();
      const res = await handlePatchNotificationSettings(
        db,
        makeRequest("PATCH", { ducking_mode: mode }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ducking_mode: string };
      expect(body.ducking_mode).toBe(mode);
    }
  });
});

describe("PATCH /notifications/settings — partial update semantics", () => {
  it("partial update of tts_enabled leaves banner_enabled and ducking_mode unchanged", async () => {
    const initial: FakeRow = {
      id: 1,
      ttsEnabled: true,
      bannerEnabled: true,
      duckingMode: "half",
      updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    };
    const { db, rows } = makeFakeDb(initial);

    const res = await handlePatchNotificationSettings(
      db,
      makeRequest("PATCH", { tts_enabled: false }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.tts_enabled).toBe(false);
    // Untouched fields must reflect the original values.
    expect(body.banner_enabled).toBe(true);
    expect(body.ducking_mode).toBe("half");

    // The underlying row reflects the same partial update.
    expect(rows[0]!.ttsEnabled).toBe(false);
    expect(rows[0]!.bannerEnabled).toBe(true);
    expect(rows[0]!.duckingMode).toBe("half");
  });

  it("empty PATCH {} succeeds and returns the row", async () => {
    const { db } = makeFakeDb();
    const res = await handlePatchNotificationSettings(
      db,
      makeRequest("PATCH", {}),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe(1);
  });

  it("returns 404 when sentinel row is missing post-update", async () => {
    // DB whose returning() yields an empty array (no row with id=1).
    const db = {
      query: {
        notificationSettings: {
          findFirst: mock(async () => undefined),
        },
      },
      update: mock(() => ({
        set: mock(() => ({
          where: mock(() => ({
            returning: mock(async () => []),
          })),
        })),
      })),
    } as unknown as Db;

    const res = await handlePatchNotificationSettings(
      db,
      makeRequest("PATCH", { tts_enabled: false }),
    );
    expect(res.status).toBe(404);
  });
});

describe("PATCH /notifications/settings — lifecycle bus emission", () => {
  let received: SettingsChangedPayload[] = [];
  const handler = (envelope: { payload: SettingsChangedPayload }) => {
    received.push(envelope.payload);
  };

  beforeEach(() => {
    received = [];
    lifecycleBus.removeAllListeners();
    lifecycleBus.on("SettingsChanged", handler);
  });

  it("emits SettingsChanged with post-update values on success", async () => {
    const { db } = makeFakeDb();
    const res = await handlePatchNotificationSettings(
      db,
      makeRequest("PATCH", {
        tts_enabled: false,
        ducking_mode: "mute",
      }),
    );
    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      ttsEnabled: false,
      bannerEnabled: true,
      duckingMode: "mute",
    });
  });

  it("does NOT emit SettingsChanged on validation failure", async () => {
    const { db } = makeFakeDb();
    const res = await handlePatchNotificationSettings(
      db,
      makeRequest("PATCH", { ducking_mode: "invalid" }),
    );
    expect(res.status).toBe(400);
    expect(received).toHaveLength(0);
  });
});
