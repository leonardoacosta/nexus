/**
 * Session shape regression tests.
 *
 * Guards against silent type drift between the DB `sessions` table and the
 * domain `Session` type. Any addition to the DB schema that isn't accounted
 * for (either picked into Session or explicitly excluded) must be justified
 * here, forcing a conscious review.
 *
 * Strategy:
 *   - A runtime fixture mirrors the DB column set (packages/db/src/schema/sessions.ts).
 *   - We assert every column is either surfaced on Session or explicitly omitted.
 *   - A snapshot of all expected Session keys catches any silent addition or removal.
 */

import { describe, it, expect } from "bun:test";
import type { Session, SessionRuntimeFields } from "./session";

// ---------------------------------------------------------------------------
// Fixtures — update when the DB schema or domain type changes.
// ---------------------------------------------------------------------------

/**
 * All columns in `sessions` table (packages/db/src/schema/sessions.ts),
 * keyed by their camelCase Drizzle property name.
 */
const DB_COLUMN_KEYS = new Set([
  "id",
  "projectId",
  "machine",
  "status",
  "startedAt",
  "lastActivity",
  "endedAt",
  "pid",
  "cwd",
  "branch",
  "sessionType",
  "model",
  "rateLimitUtilization",
  "totalCostUsd",
  "rateLimitResetAt",
  "idleSince",
  "ccSessionId",
  "tmuxSession",
  "tmuxTarget",
  "spec",
  "credentialId",
  "credentialFingerprint",
]);

/**
 * DB columns intentionally NOT surfaced on the domain `Session`.
 * Each entry must have a documented reason.
 */
const DB_COLUMNS_OMITTED_FROM_DOMAIN = new Set([
  "lastActivity",    // Renamed to `lastHeartbeat` in SessionRuntimeFields.
  "rateLimitResetAt", // Internal rate-limit bookkeeping — not surfaced.
  "idleSince",       // Internal idle tracking — not surfaced.
]);

/**
 * Runtime fields present on `Session` that have no DB column backing.
 * These are populated by the mapper at query time (JOINs / derivation).
 */
const RUNTIME_FIELD_KEYS = new Set<keyof SessionRuntimeFields>([
  "lastHeartbeat",
  "project",
  "command",
  "agent",
  "rateLimitType",
]);

/**
 * All expected keys of the domain `Session` type.
 * Derived from: (DB_COLUMN_KEYS - omitted) ∪ RUNTIME_FIELD_KEYS.
 */
const EXPECTED_SESSION_KEYS: ReadonlySet<string> = (() => {
  const all = new Set<string>();
  for (const k of DB_COLUMN_KEYS) {
    if (!DB_COLUMNS_OMITTED_FROM_DOMAIN.has(k)) all.add(k);
  }
  for (const k of RUNTIME_FIELD_KEYS) {
    all.add(k);
  }
  return all;
})();

// ---------------------------------------------------------------------------
// Compile-time guard: Session must be structurally compatible.
// If `Session` gains or loses keys, this type-level check will fail to compile.
// ---------------------------------------------------------------------------
type _AllSessionKeysAreExpected = Exclude<
  keyof Session,
  | "id" | "projectId" | "machine" | "status" | "startedAt" | "endedAt"
  | "pid" | "cwd" | "branch" | "sessionType" | "model" | "rateLimitUtilization"
  | "totalCostUsd" | "ccSessionId" | "tmuxSession" | "tmuxTarget" | "spec"
  | "credentialId" | "credentialFingerprint"
  | "lastHeartbeat" | "project" | "command" | "agent" | "rateLimitType"
> extends never
  ? true
  : "Session has unexpected keys — update session.test.ts fixtures";
const _typeGuard: _AllSessionKeysAreExpected = true;
void _typeGuard;

// ---------------------------------------------------------------------------
// Runtime tests
// ---------------------------------------------------------------------------

describe("Session shape", () => {
  it("every DB column is either surfaced on Session or explicitly omitted", () => {
    for (const col of DB_COLUMN_KEYS) {
      const accounted =
        EXPECTED_SESSION_KEYS.has(col) || DB_COLUMNS_OMITTED_FROM_DOMAIN.has(col);
      expect(
        accounted,
        `DB column "${col}" is neither picked into Session nor listed in DB_COLUMNS_OMITTED_FROM_DOMAIN — was the schema updated?`,
      ).toBe(true);
    }
  });

  it("no runtime field accidentally shadows a DB column name", () => {
    for (const rtKey of RUNTIME_FIELD_KEYS) {
      const shadows = DB_COLUMN_KEYS.has(rtKey as string);
      expect(
        shadows,
        `Runtime field "${rtKey}" shadows a DB column — rename or document the intentional overlap`,
      ).toBe(false);
    }
  });

  it("snapshot of all expected Session keys — update consciously when schema or domain changes", () => {
    expect(Array.from(EXPECTED_SESSION_KEYS).sort()).toEqual([
      "agent",
      "branch",
      "ccSessionId",
      "command",
      "credentialFingerprint",
      "credentialId",
      "cwd",
      "endedAt",
      "id",
      "lastHeartbeat",
      "machine",
      "model",
      "pid",
      "project",
      "projectId",
      "rateLimitType",
      "rateLimitUtilization",
      "sessionType",
      "spec",
      "startedAt",
      "status",
      "tmuxSession",
      "tmuxTarget",
      "totalCostUsd",
    ]);
  });

  it("omitted DB columns still exist in the schema — stale entries indicate a dropped column", () => {
    for (const omitted of DB_COLUMNS_OMITTED_FROM_DOMAIN) {
      expect(
        DB_COLUMN_KEYS.has(omitted),
        `Omitted column "${omitted}" no longer exists in DB_COLUMN_KEYS — remove it from DB_COLUMNS_OMITTED_FROM_DOMAIN`,
      ).toBe(true);
    }
  });
});
