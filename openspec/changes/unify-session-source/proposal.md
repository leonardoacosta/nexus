# Proposal: Unify Session Source of Truth — Postgres-Backed with Read-Through Cache

## Change ID
`unify-session-source`

## Summary
Make Postgres the single source of truth for sessions, replacing the dual in-memory Map + DB tracking with a write-through/read-through cache pattern where writes always go to Postgres first and the in-memory Map serves as a hot cache.

## Context
- Extends: `apps/agent/src/session-manager.ts`, `apps/agent/src/db/sessions.ts`
- Related: Architecture review (2026-04-09) finding 6, `add-app-context` spec (provides context for session state)

## Motivation
Sessions currently exist in two places: `session-manager.ts` holds a `Map<string, Session>` populated by watcher events (in-memory, no persistence), and `db/sessions.ts` handles Postgres persistence via Drizzle. These are two sources of truth with no sync guarantee. If the agent crashes between an in-memory add and a DB write, the session is lost. If a DB session isn't loaded on restart, it's invisible. The credential pool already uses a write-through pattern — sessions should follow the same approach.

## Requirements

### Req-1: Write-through persistence
All session mutations (start, heartbeat, status change, end) write to Postgres first via `db/sessions.ts`, then update the in-memory cache. If the DB write fails, the mutation fails (no silent inconsistency).

### Req-2: Read-through cache
Session reads (list, get by ID, filter by project/status) check the in-memory Map first. On cache miss, query Postgres. The cache is populated on startup by loading active sessions from DB (`ended_at IS NULL`).

### Req-3: Startup recovery
On agent start, load all active sessions from Postgres into the in-memory Map. Validate each by checking if the PID still exists (`/proc/{pid}`). Mark dead PIDs as ended in both cache and DB.

### Req-4: Cache invalidation
When a session is ended (via kill, unregister, or sweep), remove from cache and update DB atomically. The sweep loop checks the cache, not the DB, for performance.

## Scope
- **IN**: Session write-through, read-through cache, startup recovery, cache invalidation
- **OUT**: Changing session data model, adding new session fields, modifying the lifecycle bus events

## Impact
| Area | Change |
|------|--------|
| `apps/agent/src/session-manager.ts` | Refactored to write-through/read-through with DB dependency |
| `apps/agent/src/db/sessions.ts` | May need new queries (upsert, bulk load active) |
| `apps/agent/src/index.ts` | Pass DB to session manager at startup |
| Net | ~100 LOC changed, ~50 LOC added |

## Risks
| Risk | Mitigation |
|------|-----------|
| DB latency on session write path | Writes are rare (start/heartbeat/end) — latency acceptable. Heartbeats can batch. |
| Startup delay loading all active sessions | Bounded by active session count (typically <50). Single query. |
| Test complexity increases with DB dependency | Use mock DB in tests (already established pattern in credential tests) |
