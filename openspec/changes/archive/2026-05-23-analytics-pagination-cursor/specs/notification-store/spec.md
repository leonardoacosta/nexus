## MODIFIED Requirements

### Requirement: GET /analytics/notifications response envelope

The `GET /analytics/notifications` endpoint MUST return the envelope `{rows, next_cursor, has_more, count, filters}` where:

- `rows`: array of `AnalyticsNotificationRow` (newest first).
- `next_cursor`: opaque base64url token to fetch the next page, or `null` when the page is the last one.
- `has_more`: boolean — `true` iff a `next_cursor` was returned.
- `count`: integer — `rows.length` for the current page.
- `filters`: object — echoes the effective filters `{hours, project, status}`.

The legacy top-level `hours` key MUST be removed (folded into `filters.hours`). Empty result sets MUST return HTTP 200 with `rows: []`, `next_cursor: null`, `has_more: false`, `count: 0` — never 404.

#### Scenario: Empty result set returns canonical empty envelope

- **GIVEN** no notifications match the requested filters
- **WHEN** `GET /analytics/notifications?hours=24` is called
- **THEN** the response is HTTP 200 with body `{rows: [], next_cursor: null, has_more: false, count: 0, filters: {hours: 24, project: null, status: null}}`

#### Scenario: Single-page result returns null cursor

- **GIVEN** 10 notifications exist within the requested window
- **WHEN** `GET /analytics/notifications?hours=24&limit=50` is called
- **THEN** `rows.length` is 10, `count` is 10, `has_more` is `false`, `next_cursor` is `null`

#### Scenario: Multi-page result returns populated cursor

- **GIVEN** 120 notifications exist within the requested window
- **WHEN** `GET /analytics/notifications?hours=24&limit=50` is called
- **THEN** `rows.length` is 50, `has_more` is `true`, `next_cursor` is a non-empty base64url string decoding to `{created_at, id}` of the 50th row

### Requirement: AnalyticsNotificationRow includes audio_available + voice_used

Every row in the `GET /analytics/notifications` response MUST include `voice_used: string | null` (direct read from the `notifications.voice_used` column) and `audio_available: boolean` (true iff both `notifications.audio_path IS NOT NULL` AND `audioExists(id)` returns true at request time). These fields MUST be present even when null/false so consumers can rely on field existence.

#### Scenario: Row with cached audio reports voice + available

- **GIVEN** a notification has `audio_path` set and the file exists on disk
- **AND** the row was synthesised by the `Rachel` voice
- **WHEN** the row is returned in the analytics response
- **THEN** `voice_used` equals `"Rachel"` and `audio_available` is `true`

#### Scenario: Row without audio reports null + false

- **GIVEN** a notification has `audio_path = NULL` (TTS never synthesised this row)
- **WHEN** the row is returned
- **THEN** `voice_used` is `null` and `audio_available` is `false`

#### Scenario: TTS-disabled row with pruned audio file

- **GIVEN** `audio_path` is set but the file was pruned by the retention sweep (audioExists returns false)
- **WHEN** the row is returned
- **THEN** `audio_available` is `false` regardless of the column value, and `voice_used` echoes the configured voice id (audit trail of intent)

## ADDED Requirements

### Requirement: Keyset cursor pagination

The endpoint MUST support keyset pagination via an opaque `cursor` query parameter encoding `base64url(JSON.stringify({created_at: ISO_8601_string, id: string}))`. The SQL query MUST filter with the lexicographic predicate `(created_at, id) < (cursor.created_at, cursor.id)` ordered `(created_at DESC, id DESC)` so pages remain stable across rows sharing a `created_at` timestamp. The server MUST request `LIMIT + 1` rows to detect `has_more` without an extra `COUNT(*)`; the extra row MUST be trimmed before serialisation and its predecessor's `(created_at, id)` used to encode `next_cursor`.

#### Scenario: Round-trip across three pages returns no duplicates

- **GIVEN** 130 notifications exist within the window
- **WHEN** the client calls `GET /analytics/notifications?limit=50`, then `?limit=50&cursor=<page1.next_cursor>`, then `?limit=50&cursor=<page2.next_cursor>`
- **THEN** page sizes are 50, 50, 30; `has_more` is true, true, false; no row id appears in more than one page

#### Scenario: Identical-timestamp rows paginate stably

- **GIVEN** 5 notifications share the exact same `created_at` and span a page boundary
- **WHEN** consecutive pages are fetched
- **THEN** the boundary cursor's `(created_at, id)` tuple uniquely orders the rows and no identical-timestamp row is dropped or duplicated

### Requirement: Limit parameter bounds

The `limit` query parameter MUST default to 50 when absent, MUST be rejected with HTTP 400 when `<= 0` or `> 500`, and MUST cap the per-page row count when valid.

#### Scenario: Default limit applied when absent

- **WHEN** `GET /analytics/notifications` is called without `limit`
- **THEN** at most 50 rows are returned

#### Scenario: limit=0 rejected

- **WHEN** `GET /analytics/notifications?limit=0` is called
- **THEN** the response is HTTP 400 with `{error: "limit must be between 1 and 500"}`

#### Scenario: limit=501 rejected

- **WHEN** `GET /analytics/notifications?limit=501` is called
- **THEN** the response is HTTP 400 with `{error: "limit must be between 1 and 500"}`

### Requirement: Cursor validation

The endpoint MUST validate the `cursor` parameter as well-formed base64url decoding to a JSON object with the shape `{created_at: string (ISO-8601), id: string}`. Any structural failure MUST return HTTP 400 with a structured error JSON body containing an `error` field describing the failure mode. The server MUST NOT trust cursor contents to bound the SQL query without parsing/validating both fields.

#### Scenario: Malformed base64 rejected

- **WHEN** `GET /analytics/notifications?cursor=not-base64!!` is called
- **THEN** the response is HTTP 400 with body `{error: "cursor: malformed base64"}`

#### Scenario: Cursor missing required field rejected

- **GIVEN** a cursor decoded to JSON `{"id": "abc"}` (no `created_at`)
- **WHEN** the endpoint is called with that cursor
- **THEN** the response is HTTP 400 with body containing `error: "cursor: missing field 'created_at'"`

#### Scenario: Cursor with wrong field type rejected

- **GIVEN** a cursor decoded to `{"created_at": 1234567890, "id": "abc"}` (numeric instead of ISO string)
- **WHEN** the endpoint is called
- **THEN** the response is HTTP 400 with `error: "cursor: created_at must be ISO-8601 string"`

#### Scenario: Cursor with future timestamp rejected

- **GIVEN** a cursor `{created_at: <now + 1h>, id: "x"}`
- **WHEN** the endpoint is called
- **THEN** the response is HTTP 400 with `error: "cursor: created_at must not be in the future"`
