/**
 * Session-context store + GET/PATCH route-handler tests.
 *
 * Coverage backfill for the already-implemented handlers in
 * `routes/session-context.ts` (the API batch landed the store + routes; this
 * suite pins the fresh/stale/validation behaviour). Drives the exported pure
 * handlers directly — `handleGetSessionContext` / `handlePatchSessionContext`
 * carry all the store logic, and neither touches `logger`, so no `mock.module`
 * is needed (avoiding the process-global forward-leak class documented for the
 * agent suite).
 *
 * `resetSessionContextStore()` clears the module-level Map between tests;
 * `spyOn(Date, "now")` drives the TTL boundary (the store timestamps writes and
 * measures staleness off the same `Date.now()`).
 *
 * Covers the spec § session-context-api scenarios: fresh round trip, stale
 * entry treated as absent, invalid body rejected + not written, unknown
 * session, and the optional `contextWindowSize` field.
 *
 * Spec: openspec/changes/add-session-context-api/
 */

import { describe, expect, it, beforeEach, afterEach, spyOn } from "bun:test";
import type { Db } from "@nexus/db";

import {
  handleGetSessionContext,
  handlePatchSessionContext,
  getFreshContextEntry,
  resetSessionContextStore,
  applyStatuslineSnapshot,
} from "./session-context";
// Restorable spy target for the ccSessionId-lookup suite below
// (fix-cc-session-id-bridge, nx-22xz8) — session-context.ts imports
// `getSessionByCcSessionId` named from this module; spying on the module
// namespace intercepts that live binding (same pattern dispatcher.test.ts
// uses for `updateSessionModel`).
import * as sessionsDb from "../db/sessions";

/**
 * Minimal chainable stub satisfying the `db.select().from().where().limit()`
 * shape `getSessionById` (`../db/sessions`) issues. Passed directly as the
 * `db` param rather than via `mock.module("../db/sessions", ...)` — a
 * non-spreading module-level override there is process-global and forward-
 * leaks into sibling suites importing the same module (the nx-jlx1c class
 * documented in `split-routes.test.ts`: an earlier `getSessionById: () =>
 * null` override broke `session-cost-read.test.ts`'s unrelated assertions).
 * A plain object cast avoids that class entirely.
 */
function fakeDb(row: { model: string | null } | null): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(row ? [row] : []),
        }),
      }),
    }),
  } as unknown as Db;
}

const TTL_MS = 600 * 1_000;

function patchRequest(id: string, body: unknown): Request {
  return new Request(`http://127.0.0.1/sessions/${id}/context`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function getRequest(id: string): Request {
  return new Request(`http://127.0.0.1/sessions/${id}/context`, {
    method: "GET",
  });
}

// Controllable clock: the store reads `Date.now()` on both write (updatedAt)
// and read (freshness), so a single spy governs the TTL boundary.
let nowMs = 1_000_000;
let dateNowSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  resetSessionContextStore();
  nowMs = 1_000_000;
  dateNowSpy = spyOn(Date, "now").mockImplementation(() => nowMs);
});

afterEach(() => {
  dateNowSpy.mockRestore();
  resetSessionContextStore();
});

describe("session-context — fresh entry round trip", () => {
  it("PATCH writes usedPercentage + contextWindowSize; GET returns 200 with that data", async () => {
    const patchRes = await handlePatchSessionContext(
      patchRequest("abc", { usedPercentage: 42, contextWindowSize: 200000 }),
      "abc",
    );
    expect(patchRes.status).toBe(204);

    const getRes = await handleGetSessionContext(getRequest("abc"), "abc");
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as Record<string, unknown>;
    expect(body.sessionId).toBe("abc");
    expect(body.usedPercentage).toBe(42);
    expect(body.contextWindowSize).toBe(200000);
  });
});

describe("session-context — stale entry treated as absent", () => {
  it("GET after the 600s TTL returns 404 no-context-data", async () => {
    const patchRes = await handlePatchSessionContext(
      patchRequest("abc", { usedPercentage: 42, contextWindowSize: 200000 }),
      "abc",
    );
    expect(patchRes.status).toBe(204);

    // Advance the clock just past the TTL so the entry is now stale.
    nowMs += TTL_MS + 1;

    const getRes = await handleGetSessionContext(getRequest("abc"), "abc");
    expect(getRes.status).toBe(404);
    const body = (await getRes.json()) as Record<string, unknown>;
    expect(body.error).toBe("no context data for session");
  });
});

describe("session-context — invalid PATCH body rejected", () => {
  it("non-numeric usedPercentage returns 400 and writes nothing", async () => {
    const patchRes = await handlePatchSessionContext(
      patchRequest("abc", { usedPercentage: "not-a-number" }),
      "abc",
    );
    expect(patchRes.status).toBe(400);

    // Nothing was written — a subsequent GET still 404s.
    const getRes = await handleGetSessionContext(getRequest("abc"), "abc");
    expect(getRes.status).toBe(404);
    const body = (await getRes.json()) as Record<string, unknown>;
    expect(body.error).toBe("no context data for session");
  });
});

describe("session-context — unknown session", () => {
  it("GET for a session that was never PATCHed returns 404", async () => {
    const getRes = await handleGetSessionContext(getRequest("never-set"), "never-set");
    expect(getRes.status).toBe(404);
    const body = (await getRes.json()) as Record<string, unknown>;
    expect(body.error).toBe("no context data for session");
  });
});

describe("session-context — optional contextWindowSize omitted", () => {
  it("PATCH with only usedPercentage succeeds; GET returns contextWindowSize: null", async () => {
    const patchRes = await handlePatchSessionContext(
      patchRequest("abc", { usedPercentage: 10 }),
      "abc",
    );
    expect(patchRes.status).toBe(204);

    const getRes = await handleGetSessionContext(getRequest("abc"), "abc");
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as Record<string, unknown>;
    expect(body.usedPercentage).toBe(10);
    expect(body.contextWindowSize).toBeNull();
  });
});

describe("session-context — getFreshContextEntry accessor (nx-qayeb.1)", () => {
  it("returns the usage + window for a fresh entry", async () => {
    await handlePatchSessionContext(
      patchRequest("fresh", { usedPercentage: 33, contextWindowSize: 200000 }),
      "fresh",
    );
    const entry = getFreshContextEntry("fresh");
    expect(entry).toEqual({ usedPercentage: 33, contextWindowSize: 200000 });
  });

  it("returns null for a stale entry (past CACHE_TTL_MS)", async () => {
    await handlePatchSessionContext(
      patchRequest("stale", { usedPercentage: 33 }),
      "stale",
    );
    // Advance past the TTL so the entry is now stale.
    nowMs += TTL_MS + 1;
    expect(getFreshContextEntry("stale")).toBeNull();
  });

  it("returns null for an absent entry", () => {
    expect(getFreshContextEntry("never-written")).toBeNull();
  });

  it("carries contextWindowSize: null through when it was omitted on PATCH", async () => {
    await handlePatchSessionContext(
      patchRequest("no-size", { usedPercentage: 7 }),
      "no-size",
    );
    expect(getFreshContextEntry("no-size")).toEqual({
      usedPercentage: 7,
      contextWindowSize: null,
    });
  });

  it("agrees with handleGetSessionContext's fresh/stale boundary (single-sourced check)", async () => {
    await handlePatchSessionContext(
      patchRequest("boundary", { usedPercentage: 50 }),
      "boundary",
    );
    // Just fresh: accessor returns a value AND the GET route returns 200.
    expect(getFreshContextEntry("boundary")).not.toBeNull();
    const okRes = await handleGetSessionContext(getRequest("boundary"), "boundary");
    expect(okRes.status).toBe(200);

    // Cross the TTL: accessor returns null AND the GET route returns 404.
    nowMs += TTL_MS + 1;
    expect(getFreshContextEntry("boundary")).toBeNull();
    const staleRes = await handleGetSessionContext(getRequest("boundary"), "boundary");
    expect(staleRes.status).toBe(404);
  });
});

describe("session-context — GET model field (add-session-context-model-field)", () => {
  it("derives the single-letter family tag from a session row with a model", async () => {
    const patchRes = await handlePatchSessionContext(
      patchRequest("abc", { usedPercentage: 42 }),
      "abc",
    );
    expect(patchRes.status).toBe(204);

    const getRes = await handleGetSessionContext(
      getRequest("abc"),
      "abc",
      fakeDb({ model: "claude-opus-4-8" }),
    );
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as Record<string, unknown>;
    expect(body.model).toBe("O");
  });

  it("returns model: null when the row's model column is null", async () => {
    await handlePatchSessionContext(
      patchRequest("abc", { usedPercentage: 42 }),
      "abc",
    );

    const getRes = await handleGetSessionContext(
      getRequest("abc"),
      "abc",
      fakeDb({ model: null }),
    );
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as Record<string, unknown>;
    expect(body.model).toBeNull();
  });

  it("returns model: null when getSessionById finds no row", async () => {
    await handlePatchSessionContext(
      patchRequest("abc", { usedPercentage: 42 }),
      "abc",
    );

    const getRes = await handleGetSessionContext(
      getRequest("abc"),
      "abc",
      fakeDb(null),
    );
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as Record<string, unknown>;
    expect(body.model).toBeNull();
  });

  it("returns model: null when db is omitted entirely, without changing status or existing fields", async () => {
    await handlePatchSessionContext(
      patchRequest("abc", { usedPercentage: 42, contextWindowSize: 200000 }),
      "abc",
    );

    const getRes = await handleGetSessionContext(getRequest("abc"), "abc");
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as Record<string, unknown>;
    expect(body.model).toBeNull();
    expect(body.sessionId).toBe("abc");
    expect(body.usedPercentage).toBe(42);
    expect(body.contextWindowSize).toBe(200000);
  });
});

describe("session-context — store-first model precedence (forward-statusline-model)", () => {
  it("prefers the store's forwarded model over the DB, when both are present", async () => {
    applyStatuslineSnapshot("abc", 42, null, {
      id: "claude-sonnet-4-6",
      display_name: "Sonnet 4.6",
    });

    const getRes = await handleGetSessionContext(
      getRequest("abc"),
      "abc",
      fakeDb({ model: "claude-opus-4-8" }), // would map to "O" if consulted
    );
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as Record<string, unknown>;
    expect(body.model).toBe("S");
  });

  it("falls back to the DB lookup when the store has no model recorded", async () => {
    // PATCH (not applyStatuslineSnapshot) never carries a model.
    const patchRes = await handlePatchSessionContext(
      patchRequest("abc", { usedPercentage: 42 }),
      "abc",
    );
    expect(patchRes.status).toBe(204);

    const getRes = await handleGetSessionContext(
      getRequest("abc"),
      "abc",
      fakeDb({ model: "claude-opus-4-8" }),
    );
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as Record<string, unknown>;
    expect(body.model).toBe("O");
  });

  it("resolves model: null when neither the store nor the DB has one", async () => {
    const patchRes = await handlePatchSessionContext(
      patchRequest("abc", { usedPercentage: 42 }),
      "abc",
    );
    expect(patchRes.status).toBe(204);

    const getRes = await handleGetSessionContext(
      getRequest("abc"),
      "abc",
      fakeDb(null),
    );
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as Record<string, unknown>;
    expect(body.model).toBeNull();
  });

  it("resolves the store's model even when db is omitted entirely", async () => {
    applyStatuslineSnapshot("abc", 42, null, { id: "claude-haiku-4-5" });

    const getRes = await handleGetSessionContext(getRequest("abc"), "abc");
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as Record<string, unknown>;
    expect(body.model).toBe("H");
  });
});

describe("session-context — PATCH model field (accept-model-on-patch)", () => {
  it("PATCH with a model object then GET returns the mapped single-letter family tag", async () => {
    const patchRes = await handlePatchSessionContext(
      patchRequest("abc", {
        usedPercentage: 12.5,
        contextWindowSize: 200000,
        model: { id: "claude-sonnet-5" },
      }),
      "abc",
    );
    expect(patchRes.status).toBe(204);

    const getRes = await handleGetSessionContext(getRequest("abc"), "abc");
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as Record<string, unknown>;
    expect(body.model).toBe("S");
    expect(body.usedPercentage).toBe(12.5);
    expect(body.contextWindowSize).toBe(200000);
  });

  it("PATCH without model still succeeds; GET returns model: null with no DB fallback", async () => {
    const patchRes = await handlePatchSessionContext(
      patchRequest("no-model", { usedPercentage: 30 }),
      "no-model",
    );
    expect(patchRes.status).toBe(204);

    const getRes = await handleGetSessionContext(getRequest("no-model"), "no-model");
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as Record<string, unknown>;
    expect(body.model).toBeNull();
  });
});

describe("session-context — model lookup resolves via ccSessionId, not the primary id (fix-cc-session-id-bridge, nx-22xz8)", () => {
  it("calls getSessionByCcSessionId (not getSessionById) with the route's own id param", async () => {
    const spy = spyOn(sessionsDb, "getSessionByCcSessionId").mockResolvedValue(
      { model: "claude-opus-4-8" } as unknown as sessionsDb.SessionRow,
    );
    const getByIdSpy = spyOn(sessionsDb, "getSessionById");

    try {
      await handlePatchSessionContext(
        patchRequest("cc-raw-session-1", { usedPercentage: 42 }),
        "cc-raw-session-1",
      );

      const getRes = await handleGetSessionContext(
        getRequest("cc-raw-session-1"),
        "cc-raw-session-1",
        {} as unknown as Db,
      );

      expect(getRes.status).toBe(200);
      const body = (await getRes.json()) as Record<string, unknown>;
      expect(body.model).toBe("O");
      expect(spy).toHaveBeenCalledWith({} as unknown as Db, "cc-raw-session-1");
      expect(getByIdSpy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      getByIdSpy.mockRestore();
    }
  });
});
