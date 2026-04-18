/**
 * Contract test for apps/nextjs/src/lib/db.ts — spec: narrow-actions-to-readonly-db (task 2.1)
 *
 * Locks the "Single public read API" requirement: getReadOnlyDb() is the only
 * public export. Re-adding a public getDb() or removing getReadOnlyDb() must
 * fail this test to prevent regression.
 *
 * Two complementary checks:
 *   1. Runtime check — import * as dbModule and assert the export surface.
 *   2. Compile-time check — @ts-expect-error directives assert that accessing
 *      a non-existent `getDb` export is a type error. If getDb is ever
 *      re-exported, tsc emits TS2578 ("Unused '@ts-expect-error' directive")
 *      and typecheck fails.
 *
 * Verify runtime: pnpm --filter @nexus/nextjs test apps/nextjs/src/lib/db.test.ts
 * Verify types:   pnpm --filter @nexus/nextjs exec tsc --noEmit
 */

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Runtime check
// ---------------------------------------------------------------------------

import * as dbModule from "./db";

describe("lib/db.ts — export surface contract", () => {
  it("exports getReadOnlyDb", () => {
    expect(dbModule).toHaveProperty("getReadOnlyDb");
    expect(typeof dbModule.getReadOnlyDb).toBe("function");
  });

  it("does NOT export getDb", () => {
    expect(dbModule).not.toHaveProperty("getDb");
  });

  it("has exactly one export (getReadOnlyDb)", () => {
    const exported = Object.keys(dbModule);
    expect(exported).toEqual(["getReadOnlyDb"]);
  });
});

// ---------------------------------------------------------------------------
// Compile-time check — tsc enforces these even if vitest never runs them.
// If getDb is re-added to db.ts the @ts-expect-error becomes "unused" and
// `tsc --noEmit` emits TS2578, failing typecheck.
// ---------------------------------------------------------------------------

// @ts-expect-error — getDb must NOT be a named export of @/lib/db
import type { getDb } from "./db";

// Nominal export to satisfy isolatedModules (prevents TS1208).
export type {} ;
