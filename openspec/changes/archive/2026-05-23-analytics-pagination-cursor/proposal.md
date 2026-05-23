# Change: analytics-pagination-cursor

## Why

The Swift dashboard needs to browse notification history beyond the current 500-row hard limit on `GET /analytics/notifications`. The endpoint blocks long-history queries (auditing per-project voice rollouts, debugging meeting-buffer drops over weeks) because it returns at most 500 rows with no continuation token. Adding keyset cursor pagination unlocks deep history while keeping per-request payload bounded, and the dashboard's pagination UX depends on a stable sort that survives identical-timestamp rows.

## What Changes

- Replace the response envelope with `{rows, next_cursor, has_more, count, filters}` (breaking — top-level `hours` folds into `filters`).
- Add keyset cursor pagination using `base64url(JSON.stringify({created_at, id}))` with stable `(created_at, id) DESC` sort. `id` is `text` (string) per the notifications schema.
- Add `limit` query param (default 50, max 500); reject `limit > 500` or `limit <= 0` with HTTP 400.
- Add structured cursor validation: malformed base64 / missing fields / wrong types return HTTP 400 with structured error JSON.
- Add `voice_used: string | null` and `audio_available: boolean` to every row payload (voice column already exists; `audio_available` derived from `audioPath IS NOT NULL` AND `audioExists(id)`).

## Context

- depends on: (none)
- touches: `apps/agent/src/routes/analytics.ts`, `apps/agent/src/routes/analytics.test.ts`, `packages/core/src/types/notification.ts`, `apps/agent/src/notifications/audio-store.ts`

## Impact

- **Capability**: notification-store
- **Breaking**: yes — response envelope shape changes (`hours` moves into `filters`; row payload gains 2 fields; clients pinning the legacy shape will need to adapt)
- **Migrations**: no (column `voice_used` shipped in `0035_add_notification_audio`; no schema work required)
- **Files changed**: ~4 (analytics handler + test, core type, audio-store import only)
