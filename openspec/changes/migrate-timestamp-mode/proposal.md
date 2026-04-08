# Proposal: Schema Timestamp Mode Migration

## Change ID
`migrate-timestamp-mode`

## Summary
Change all 17 Drizzle timestamp columns across 8 schema files from `mode: "string"` to `mode: "date"`, then update all consuming code to work with native `Date` objects instead of ISO string literals.

## Context
- Extends: `packages/db/src/schema/` (all 8 schema files with timestamp columns), `packages/core/src/types/` (Session, Credential, Notification, CanonicalProject, HealthMetrics, WatcherEvent), `apps/agent/src/` (session-manager, credentials/pool, db/sessions, db/health, db/agent-registry, db/events, db/retention, notifications/, routes/), `apps/nextjs/src/` (lib/format, lib/agent-client, app/actions/, app/api/projects/)
- Related: `harden-sql-credential-pool` (active, touches credentials), `fix-agent-promise-errors` (active, touches agent code)

## Motivation
Every timestamp column in the Drizzle schema uses `mode: "string"`, which forces all application code to manually convert between `string` and `Date` with `new Date(x).toISOString()` and `new Date(x).getTime()`. This is pervasive -- over 60 call sites across the codebase construct `Date` objects from string timestamps or convert `Date` objects to ISO strings for DB writes. Switching to `mode: "date"` gives native `Date` objects from Drizzle queries, eliminates boilerplate conversion, and makes the type system enforce correct timestamp handling.

## Requirements

### Req-1: Change all schema timestamp modes to "date"
All 17 timestamp columns across 8 schema files must change from `{ mode: "string" }` to `{ mode: "date" }`. This is a Drizzle runtime mode change, not a database column type change, so no SQL migration is needed.

### Req-2: Update core type definitions
The `packages/core/src/types/` interfaces that expose timestamp fields as `string` must change to `Date` (Session, Credential, Notification, CanonicalProject) or `Date | null` where nullable. The IPC `WatcherEvent` type and `HealthMetrics.collectedAt` remain as `string` since they come from non-Drizzle sources (Rust watcher stdout, sysinfo collector).

### Req-3: Update all consuming code in agent
All `new Date().toISOString()` patterns for DB writes become `new Date()`. All `new Date(row.field).getTime()` patterns for comparisons become `row.field.getTime()`. All string comparisons against timestamp columns use `Date` objects.

### Req-4: Update all consuming code in Next.js dashboard
The `formatRelativeTime` function already accepts `string | Date` -- no change needed. API routes and server actions that construct ISO strings for DB fields or parse DB results as strings must use `Date` objects. Test helpers that build mock data with `.toISOString()` timestamps must use `Date` objects instead.

### Req-5: Update all test files
Test files that create mock timestamps as ISO strings for DB-shaped objects must use `Date` objects. Tests that assert timestamp equality via string comparison must use `Date`-aware assertions.

## Scope
- **IN**: All 8 schema files (17 columns), core type interfaces, agent DB helpers, agent routes, credential pool, session manager, health collector/scheduler, notification buffer/manager, Next.js API routes, Next.js server actions, format utilities, all test files touching timestamps
- **OUT**: Rust crate code (uses its own timestamp types), IPC/WatcherEvent types (Rust watcher emits strings over stdout), HealthMetrics interface `collectedAt` field (set by collector before DB insert, not from DB query), TUI client (reads from agent HTTP API, not DB)

## Impact
| Area | Change |
|------|--------|
| `packages/db/src/schema/` | 8 files, 17 columns: `mode: "string"` to `mode: "date"` |
| `packages/core/src/types/` | 4 type files: timestamp fields `string` to `Date` |
| `apps/agent/src/` | ~30 files: remove `.toISOString()` on writes, remove `new Date()` wrapper on reads |
| `apps/nextjs/src/` | ~10 files: same pattern as agent |
| Test files | ~15 test files: update mock data and assertions |
| DB migration | None required -- `mode` is a Drizzle runtime option, not a PostgreSQL column type |

## Risks
| Risk | Mitigation |
|------|-----------|
| Active specs `harden-sql-credential-pool` and `fix-agent-promise-errors` touch overlapping files | Coordinate merge order; this spec should apply after those complete |
| JSON serialization of Date objects in API responses may differ from explicit `.toISOString()` | Verify that `JSON.stringify(new Date())` produces the same ISO format; add explicit `.toISOString()` only at API boundaries if needed |
| Non-Drizzle code paths (agent HTTP handlers, IPC) still emit string timestamps | Clearly scope IPC/HTTP contract types as `string`; only DB-backed types change to `Date` |
| Test count is high (~15 files) increasing risk of missed updates | Run full test suite after each batch; type errors will catch most misses since `string` is not assignable to `Date` |
