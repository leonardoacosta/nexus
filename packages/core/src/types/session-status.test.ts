/**
 * SessionStatus / SessionType enum drift regression tests.
 *
 * The DB `sessions.status` and `sessions.session_type` columns are unconstrained
 * text. The runtime narrowing helpers (`narrowSessionStatus`, `narrowSessionType`)
 * are the guard layer. These tests assert:
 *
 *   1. Every value we expect the DB to contain narrows successfully (no throw).
 *   2. Unknown / bogus values throw, so callers get an early failure instead of
 *      silently propagating invalid data.
 *
 * If the DB gains a new status/type value (e.g. a new agent version starts
 * writing "paused"), add it to KNOWN_DB_STATUSES / KNOWN_DB_TYPES AND to the
 * `SessionStatus` / `SessionType` union in session.ts. Failing to update both
 * will cause narrowSessionStatus to throw at query time.
 */

import { describe, it, expect } from "bun:test";
import {
  narrowSessionStatus,
  narrowSessionType,
  type SessionStatus,
  type SessionType,
} from "./session";

// ---------------------------------------------------------------------------
// Fixtures — update when agents start writing new enum values.
// ---------------------------------------------------------------------------

/**
 * Values that real agents insert into `sessions.status`.
 * Cross-check with: INSERT statements in the codebase, seed data, and any
 * agent version producing these strings.
 */
const KNOWN_DB_STATUSES: ReadonlyArray<string> = [
  "active",
  "idle",
  "ended",
  "stale",
  "errored",
];

/**
 * Values that real agents insert into `sessions.session_type`.
 * `null` is handled separately (defaults to "ad_hoc").
 */
const KNOWN_DB_TYPES: ReadonlyArray<string> = [
  "ad_hoc",
  "managed",
  "pooled",
];

// ---------------------------------------------------------------------------
// Compile-time guards: confirm the fixtures match the declared union types.
// ---------------------------------------------------------------------------

type _StatusFixtureCoverage = typeof KNOWN_DB_STATUSES[number] extends SessionStatus
  ? true
  : "KNOWN_DB_STATUSES contains a value not in the SessionStatus union";
const _s: _StatusFixtureCoverage = true;
void _s;

type _TypeFixtureCoverage = typeof KNOWN_DB_TYPES[number] extends SessionType
  ? true
  : "KNOWN_DB_TYPES contains a value not in the SessionType union";
const _t: _TypeFixtureCoverage = true;
void _t;

// ---------------------------------------------------------------------------
// narrowSessionStatus
// ---------------------------------------------------------------------------

describe("narrowSessionStatus", () => {
  it.each(KNOWN_DB_STATUSES)(
    'narrows known status "%s" successfully',
    (status) => {
      expect(() => narrowSessionStatus(status)).not.toThrow();
      expect(narrowSessionStatus(status)).toBe(status);
    },
  );

  it("throws on an unknown string value", () => {
    expect(() => narrowSessionStatus("totally-bogus-value")).toThrow(
      /Unknown session status/,
    );
  });

  it("throws on null when no default is given", () => {
    expect(() => narrowSessionStatus(null)).toThrow(/Unknown session status/);
  });

  it("throws on undefined when no default is given", () => {
    expect(() => narrowSessionStatus(undefined)).toThrow(/Unknown session status/);
  });

  it("returns the default when value is null and a default is provided", () => {
    expect(narrowSessionStatus(null, "active")).toBe("active");
  });

  it("returns the default when value is an unknown string and a default is provided", () => {
    expect(narrowSessionStatus("mystery-status", "idle")).toBe("idle");
  });

  it("snapshot — update if SessionStatus union changes", () => {
    expect(KNOWN_DB_STATUSES.slice().sort()).toEqual([
      "active",
      "ended",
      "errored",
      "idle",
      "stale",
    ]);
  });
});

// ---------------------------------------------------------------------------
// narrowSessionType
// ---------------------------------------------------------------------------

describe("narrowSessionType", () => {
  it.each(KNOWN_DB_TYPES)(
    'narrows known type "%s" successfully',
    (type) => {
      expect(() => narrowSessionType(type)).not.toThrow();
      expect(narrowSessionType(type)).toBe(type);
    },
  );

  it("defaults to 'ad_hoc' on null (legacy rows with no session_type)", () => {
    expect(narrowSessionType(null)).toBe("ad_hoc");
  });

  it("defaults to 'ad_hoc' on undefined", () => {
    expect(narrowSessionType(undefined)).toBe("ad_hoc");
  });

  it("throws on an unknown non-null string", () => {
    expect(() => narrowSessionType("totally-bogus-type")).toThrow(
      /Unknown session type/,
    );
  });

  it("snapshot — update if SessionType union changes", () => {
    expect(KNOWN_DB_TYPES.slice().sort()).toEqual([
      "ad_hoc",
      "managed",
      "pooled",
    ]);
  });
});
