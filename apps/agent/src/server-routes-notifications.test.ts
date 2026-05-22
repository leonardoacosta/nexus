/**
 * Dispatch-level tests for /notifications/settings (apply-4-findings task 2.11).
 *
 * Sibling `routes/notification-settings.test.ts` exercises the handler
 * functions directly with a fake DB. This file is a thinner "wiring" test:
 * it goes through `createRequestHandler` so we lock in that the dispatcher
 * actually routes `GET` and `PATCH` to the handlers, AND that the
 * `LEGACY_DISPATCH_ROUTES` table advertises both methods on `/version`.
 *
 * If anyone later removes the dispatch blocks or the LEGACY_DISPATCH_ROUTES
 * entries, the corresponding test below fails — guarding against the
 * regression that originally motivated this spec (the routes existed as
 * handler functions but the dispatcher never reached them, so the dashboard
 * saw no capability and showed a stale-binary banner).
 *
 * Run:
 *   cd apps/agent && bun test src/server-routes-notifications.test.ts
 */

import { describe, expect, it, mock } from "bun:test";

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
  parseConfig: () => ({ ok: false as const, error: "stub" }),
  getAgentsConfigPath: () => "/tmp/nonexistent-agents.toml",
}));

import type { Db } from "@nexus/db";
import type { Server as BunServer } from "bun";
import { createRequestHandler } from "./server-request-handler";
import { ServerState } from "./server-websocket";
import type { WsData } from "./terminal/stream-manager";

// ─── Fake DB (same shape used by routes/notification-settings.test.ts) ────

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

function makeFakeDb(initial?: FakeRow): Db {
  const rows: FakeRow[] = [initial ?? defaultRow()];

  return {
    query: {
      notificationSettings: {
        findFirst: async () => rows[0],
      },
    },
    update: () => ({
      set: (patch: Partial<FakeRow>) => ({
        where: () => ({
          returning: async () => {
            if (rows[0]) {
              Object.assign(rows[0], patch);
              return [rows[0]];
            }
            return [];
          },
        }),
      }),
    }),
  } as unknown as Db;
}

// `handleRequest` accepts a Bun.Server reference for the WS-upgrade fast
// path; the HTTP-only routes we exercise never touch it. `as unknown as`
// is the conventional escape hatch.
const fakeServer = {} as unknown as BunServer<WsData>;

function makeRequest(
  method: "GET" | "PATCH",
  path = "/notifications/settings",
  body?: unknown,
): Request {
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return new Request(`http://127.0.0.1:7400${path}`, init);
}

async function dispatch(
  db: Db | undefined,
  request: Request,
): Promise<Response> {
  const handler = createRequestHandler(ServerState.create(), db);
  const result = await handler(request, fakeServer);
  if (result === undefined) {
    throw new Error("dispatcher returned undefined (WS upgrade path?)");
  }
  return result;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("dispatch: GET /notifications/settings", () => {
  it("returns 200 with the wire shape when DB is provided", async () => {
    const res = await dispatch(makeFakeDb(), makeRequest("GET"));
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

  it("falls through to 404 when DB is not provided (route is DB-gated)", async () => {
    // Locks in the existing convention: every DB-backed route lives inside
    // `if (db) { ... }`. If someone moves the dispatch block out of that
    // block they must update this test.
    const res = await dispatch(undefined, makeRequest("GET"));
    expect(res.status).toBe(404);
  });
});

describe("dispatch: PATCH /notifications/settings", () => {
  it("returns 200 echoing the patched value", async () => {
    const res = await dispatch(
      makeFakeDb(),
      makeRequest("PATCH", "/notifications/settings", { tts_enabled: false }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.tts_enabled).toBe(false);
    // Untouched fields keep their default values.
    expect(body.banner_enabled).toBe(true);
    expect(body.ducking_mode).toBe("full");
  });

  it("propagates 400 for invalid body through the dispatcher", async () => {
    const res = await dispatch(
      makeFakeDb(),
      makeRequest("PATCH", "/notifications/settings", { foo: "bar" }),
    );
    expect(res.status).toBe(400);
  });
});

describe("dispatch: /version capabilities include both routes", () => {
  it("advertises GET /notifications/settings and PATCH /notifications/settings", async () => {
    // /version does NOT require a DB — it reads off LEGACY_DISPATCH_ROUTES.
    const res = await dispatch(undefined, makeRequest("GET", "/version"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { capabilities: string[] };
    expect(body.capabilities).toContain("GET /notifications/settings");
    expect(body.capabilities).toContain("PATCH /notifications/settings");
  });
});
