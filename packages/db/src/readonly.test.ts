/**
 * Type-level tests for ReadOnlyDb — wave 3, spec: pick-db-writer-boundary (task 4.2)
 *
 * These tests exercise the TypeScript type system exclusively.
 * There is no runtime test runner for this package; `tsc --noEmit` is the test.
 *
 * How it works:
 *   - Each `@ts-expect-error` directive asserts that the following expression is
 *     a type error.
 *   - If ReadOnlyDb ever stops omitting one of the blocked methods, that
 *     directive becomes "unused" and tsc emits TS2578 ("Unused '@ts-expect-error'
 *     directive"), which fails the typecheck.
 *
 * Verify: `pnpm --filter @nexus/db exec tsc --noEmit`
 */

import type { ReadOnlyDb } from "./readonly";
import { asReadOnly } from "./readonly";

// ---------------------------------------------------------------------------
// Construct a ReadOnlyDb from a dummy Db.
// We use a type assertion via `asReadOnly` so the real runtime cast is
// exercised — not just a bare `as ReadOnlyDb`.
// ---------------------------------------------------------------------------

// A stub satisfying the Db shape at the type level only (no real connection).
// `unknown` cast avoids having to replicate every drizzle internal — we only
// care about the *type narrowing* result, not runtime behaviour.
const fakeDb = {} as Parameters<typeof asReadOnly>[0];
const ro: ReadOnlyDb = asReadOnly(fakeDb);

// ---------------------------------------------------------------------------
// Allowed operations — these MUST compile without error.
// ---------------------------------------------------------------------------

// Reading the select property is always allowed.
void ro.select;

// The query property (relational query API) is always allowed.
void ro.query;

// ---------------------------------------------------------------------------
// Blocked operations — each MUST be a compile-time error.
// If any of these stop erroring, ReadOnlyDb has a regression.
// ---------------------------------------------------------------------------

// @ts-expect-error — insert is not allowed on ReadOnlyDb
void ro.insert;

// @ts-expect-error — update is not allowed on ReadOnlyDb
void ro.update;

// @ts-expect-error — delete is not allowed on ReadOnlyDb
void ro.delete;

// @ts-expect-error — execute (raw SQL) is not allowed on ReadOnlyDb
void ro.execute;

// @ts-expect-error — transaction is not allowed on ReadOnlyDb
void ro.transaction;

// ---------------------------------------------------------------------------
// Nominal export to satisfy `isolatedModules` (prevents TS1208).
// ---------------------------------------------------------------------------

export {};
