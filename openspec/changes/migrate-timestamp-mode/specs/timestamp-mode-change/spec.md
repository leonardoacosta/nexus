# Spec: timestamp-mode-change

## MODIFIED Requirements

### Requirement: Drizzle timestamp columns MUST use native Date mode
All timestamp columns in the Drizzle schema MUST use `mode: "date"` to return native JavaScript `Date` objects from queries and accept `Date` objects for inserts/updates.

#### Scenario: Schema columns declare date mode
- **Given** any timestamp column in `packages/db/src/schema/*.ts`
- **When** the column is defined with a `timestamp()` call
- **Then** it uses `{ mode: "date" }` (not `{ mode: "string" }`)

#### Scenario: DB queries return Date objects
- **Given** a query against the `sessions` table
- **When** the query returns a row with `startedAt`
- **Then** `typeof row.startedAt` is `object` and `row.startedAt instanceof Date` is `true`

#### Scenario: DB inserts accept Date objects
- **Given** a new session row being inserted
- **When** the code sets `startedAt: new Date()`
- **Then** the insert succeeds without `.toISOString()` conversion

### Requirement: Core type interfaces MUST use Date for DB-backed timestamps
Type interfaces in `packages/core/src/types/` that represent DB rows MUST declare timestamp fields as `Date` (or `Date | null` for nullable columns).

#### Scenario: Session type uses Date fields
- **Given** the `Session` interface in `packages/core/src/types/session.ts`
- **When** a consumer reads `session.startedAt`
- **Then** the TypeScript type is `Date` (not `string`)

#### Scenario: Non-DB types retain string timestamps
- **Given** the `WatcherEvent` type in `packages/core/src/types/ipc.ts`
- **When** a consumer reads `event.timestamp`
- **Then** the TypeScript type remains `string` (from Rust watcher stdout)

### Requirement: Consuming code MUST use Date objects directly
All application code that reads timestamps from DB queries or writes timestamps to DB MUST use `Date` objects without manual string conversion.

#### Scenario: Agent session manager uses Date for comparisons
- **Given** the session reaper in `apps/agent/src/session-manager.ts`
- **When** it checks if a session has been idle too long
- **Then** it uses `session.lastActivity.getTime()` directly (not `new Date(session.lastActivity).getTime()`)

#### Scenario: Agent DB helpers write Date objects
- **Given** the `updateSessionStatus` function in `apps/agent/src/db/sessions.ts`
- **When** it sets `lastActivity` for an update
- **Then** it passes `new Date()` (not `new Date().toISOString()`)

#### Scenario: Credential pool uses Date for cooldown comparisons
- **Given** the credential pool comparing cooldown timestamps
- **When** it checks if a cooldown has expired
- **Then** it compares `Date` objects directly (not ISO string comparisons)

### Requirement: API boundary serialization MUST be preserved
HTTP API responses that include timestamps MUST continue to serialize as ISO-8601 strings for backward compatibility with external consumers (TUI, Next.js frontend).

#### Scenario: JSON.stringify preserves ISO format
- **Given** a session row with `startedAt` as a `Date` object
- **When** the HTTP response serializes it via `JSON.stringify`
- **Then** the JSON output contains the timestamp as an ISO-8601 string (JavaScript default behavior)

### Requirement: Tests MUST use Date objects for mock data
Test files that construct mock DB rows MUST use `Date` objects for timestamp fields.

#### Scenario: Session test helpers use Date
- **Given** a test helper building a mock session
- **When** it sets `startedAt`
- **Then** it uses `new Date(Date.now() - 3600_000)` (not `new Date(...).toISOString()`)
