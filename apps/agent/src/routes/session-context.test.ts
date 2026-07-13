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

import {
  handleGetSessionContext,
  handlePatchSessionContext,
  resetSessionContextStore,
} from "./session-context";

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

    const getRes = handleGetSessionContext(getRequest("abc"), "abc");
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

    const getRes = handleGetSessionContext(getRequest("abc"), "abc");
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
    const getRes = handleGetSessionContext(getRequest("abc"), "abc");
    expect(getRes.status).toBe(404);
    const body = (await getRes.json()) as Record<string, unknown>;
    expect(body.error).toBe("no context data for session");
  });
});

describe("session-context — unknown session", () => {
  it("GET for a session that was never PATCHed returns 404", async () => {
    const getRes = handleGetSessionContext(getRequest("never-set"), "never-set");
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

    const getRes = handleGetSessionContext(getRequest("abc"), "abc");
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as Record<string, unknown>;
    expect(body.usedPercentage).toBe(10);
    expect(body.contextWindowSize).toBeNull();
  });
});
