# Proposal: narrow-actions-to-readonly-db

## Change ID
narrow-actions-to-readonly-db

## Summary
Convert the five dashboard read sites in `apps/nextjs/src/app/` from `getDb()` (full `Db`) to `getReadOnlyDb()` (narrowed `ReadOnlyDb`), then collapse the public `getDb()` export to an internal-only helper so that the only public API from `apps/nextjs/src/lib/db.ts` enforces read-only at compile time. Completes the type-narrowing intent of Wave 3's `pick-db-writer-boundary`.

## Context
Wave 3 shipped `pick-db-writer-boundary` (archived `2026-04-18-pick-db-writer-boundary`), which introduced `ReadOnlyDb` at `@nexus/db/readonly` and the dual factory at `apps/nextjs/src/lib/db.ts` (`getDb()` / `getReadOnlyDb()`). Only `lib/get-client.ts` adopted `getReadOnlyDb()`. Five read sites in the dashboard still call `getDb()`, defeating the type-narrowing goal and keeping an unnecessary public write-surface export alive.

Affected files:
- `apps/nextjs/src/app/actions/health.ts`
- `apps/nextjs/src/app/actions/projects.ts`
- `apps/nextjs/src/app/actions/sessions.ts`
- `apps/nextjs/src/app/actions/settings.ts`
- `apps/nextjs/src/app/api/projects/route.ts`
- `apps/nextjs/src/lib/db.ts` (factory collapse)

Related: `2026-04-18-pick-db-writer-boundary` (this spec completes its intent), `2026-04-18-add-revalidation-to-server-actions` (most recent dashboard work).

**Investigation result (confirmed before drafting):** All five call sites perform exclusively `.select()` queries — including joins and subqueries (e.g. `innerJoin` with a subquery in `health.ts`, `leftJoin` in `projects.ts` and `sessions.ts`). No `.insert`, `.update`, `.delete`, `.execute`, or `.transaction` call appears in any of the five files. The factory's docstring caveat about "callers relying on the full Drizzle query builder surface" does not apply — `.select()` with joins is fully available on `ReadOnlyDb`. The migration is purely mechanical.

Additionally, `lib/db.ts` already has a private `_getDb(): Db` helper. The collapse step removes the public `getDb()` export; no rename of the internal helper is required.

## Motivation
Wave 3 created the type narrowing but only ONE consumer used it. The remaining five sites compile against the full `Db` type — meaning a future code change could add `.insert(...)` to a Server Action without the type system catching it. The ESLint rule blocks the *type import* (`Db`), not a *value chain* through `getDb()`. This spec closes that gap by making the only exported DB accessor return `ReadOnlyDb`, so the type system enforces the write-prohibition structurally rather than via a lint rule.

This resolves audit findings B7 + IM-3 and unblocks the B14 dual-factory complexity collapse.

## Requirements

### Requirement: Read-only enforcement at consumer layer
Every Server Action and route handler in `apps/nextjs/src/app/` that reads from the database MUST type its DB handle as `ReadOnlyDb` (from `@nexus/db/readonly`). The full `Db` type SHALL NOT be reachable from any consumer outside the factory at `apps/nextjs/src/lib/db.ts`.

### Requirement: Single public read API
The factory at `apps/nextjs/src/lib/db.ts` SHALL export ONLY `getReadOnlyDb()`. The full-Db function (`getDb()`) SHALL be removed as a public export; the existing private `_getDb()` helper continues to serve as the internal singleton accessor used by `getReadOnlyDb()`.

## Scope

**In scope:**
- Migrate the five `getDb()` call sites to `getReadOnlyDb()`
- Remove the `export function getDb()` from `apps/nextjs/src/lib/db.ts` (the underlying `_getDb()` private helper remains)
- Update the factory JSDoc comment to reflect the collapsed API
- Add a compile-time unit test asserting `getDb` is not exported from `lib/db.ts`

**Out of scope:**
- ESLint rule changes (the existing rule already covers the `Db` type import)
- Changes to the `ReadOnlyDb` type definition or `asReadOnly()` in `@nexus/db`
- Agent-side anything
- UI component changes
- Anything in `nexus-agent` or `nexus-tui`

## Impact
6 files changed, approximately 10 line changes total. No type changes to `ReadOnlyDb`. No new dependencies. Pure refactor — no runtime behavior changes.

## Risks

**Risk:** A call site uses an operation excluded from `ReadOnlyDb` (`.transaction`, `.execute`, a write method we missed).
**Mitigation:** `pnpm tsc --noEmit` MUST pass after migration; any new type error is treated as a real write site requiring investigation before merging. Pre-migration investigation (above) found zero write operations across all five files.

**Risk:** A future join or complex read query hits a method gap in `ReadOnlyDb`.
**Mitigation:** `ReadOnlyDb` excludes only write operations; `.select()` with joins, subqueries, CTEs, and `sql` tagged templates are unaffected. If a missing read method surfaces, the fix is to extend `ReadOnlyDb` in `@nexus/db` — that is a separate, additive change.

**Risk:** Removing `getDb()` export breaks an import we did not find via grep.
**Mitigation:** `pnpm tsc --noEmit` will surface any missed consumer as an unresolved-export error at compile time. The task list includes a mandatory typecheck step (task 1.6) before the collapse step (task 1.7).
