<!-- beads:epic:nx-jiqt9 -->
<!-- beads:feature:nx-yfqk1 -->

# Tasks

## DB Batch

(none — no schema or migration work)

## API Batch

- [x] Add `parseCursor(token: string): {created_at: Date, id: string} | null` helper to `apps/agent/src/routes/analytics.ts` (validates base64url, JSON shape, ISO-8601, non-future timestamp; returns null on malformed input so caller can emit 400 with specific error message)
- [x] Add `encodeCursor(row: {created_at: Date, id: string}): string` helper symmetric to parseCursor
- [x] Update `handleAnalyticsNotifications(db, url)` to read `limit` (default 50, max 500) + `cursor` query params, validate them, reject malformed with 400
- [x] Update SQL query to use keyset WHERE clause: `(created_at, id) < (cursor.created_at, cursor.id)` ordered `(createdAt DESC, id DESC)`, `LIMIT N+1` to detect has_more
- [x] Compute `next_cursor` from the last returned row if `has_more`, else null; trim the extra row before serialising
- [x] Add `audio_available: boolean` to row payload via `audioExists(id)` (already exported from `apps/agent/src/notifications/audio-store.ts`)
- [x] Add `voice_used: string | null` to row payload — read from `notificationsTable.voiceUsed` (snake_case column `voice_used`)
- [x] Update `AnalyticsNotificationRow` type in `packages/core/src/types/notification.ts` with `voice_used: string | null` and `audio_available: boolean`; add envelope type `AnalyticsNotificationsResponse = {rows: AnalyticsNotificationRow[]; next_cursor: string | null; has_more: boolean; count: number; filters: {hours: number; project: string | null; status: string | null}}`
- [x] Update the JSDoc block above `handleAnalyticsNotifications` to document new query params (`limit`, `cursor`) and the new envelope shape

## UI Batch

(none — backend-only)

## E2E Batch

- [ ] Extend `apps/agent/src/routes/analytics.test.ts` with pagination scenarios: limit boundaries (default-when-absent, `limit=500` accepted, `limit=0` → 400, `limit=501` → 400), single-page (next_cursor null), multi-page round-trip (seed 130 rows; fetch 3 pages; assert no row id appears in >1 page and total matches 130), combined filter + cursor (cursor preserves `?project=oo&status=delivered`)
- [ ] Add cursor-validation scenarios in the same test file: 4 invalid cursor formats (malformed base64, valid base64 of non-JSON, missing field, wrong field type) each assert HTTP 400 and an `error` body field naming the failure mode
- [ ] Add row-payload scenarios asserting `audio_available + voice_used`: (a) row with `audio_path` set and file present → `audio_available: true`, `voice_used: "<id>"`; (b) row with `audio_path = NULL` → `audio_available: false`, `voice_used: null`; (c) row with `audio_path` set but file pruned → `audio_available: false`, `voice_used` echoes column
- [ ] Backward-compat note: GET without any new params now returns the new envelope shape (`hours` moved into `filters`). Swift dashboard `NetworkClient` decoder MUST be updated in a follow-up before this proposal archives.
