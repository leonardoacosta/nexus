# notification-store Specification

## Purpose
TBD - created by archiving change add-sqlite-analytics. Update Purpose after archive.
## Requirements
### Requirement: The system MUST persist notifications to SQLite for searchable history
The receiver service MUST write delivered and suppressed notifications to the `notifications` table, enabling searchable, filterable notification history that survives restarts.

#### Scenario: Delivered notification persisted
Given a TTS notification "Build complete for oo" is delivered
When delivery succeeds
Then a row is inserted with message, type, project="oo", channels=["tts","banner"], delivered=true

#### Scenario: Suppressed notification persisted
Given a notification is suppressed by DND mode
When the suppression check fires
Then a row is inserted with delivered=false and suppressed=true

#### Scenario: Query notification history
Given 50 notifications have been delivered today
When GET /analytics/notifications?hours=24 is called
Then the response contains all 50 notification records with timestamps and delivery status

### Requirement: Parallel Channel Delivery with Partial Success
The notification manager MUST deliver to all configured channels concurrently using
`Promise.allSettled`. A single channel failure MUST NOT prevent delivery to other channels.
The manager MUST return a `{ delivered: string[]; failed: string[] }` result distinguishing
partial success from total failure.

#### Scenario: all channels deliver successfully
- **WHEN** all configured channels accept the notification
- **THEN** all channel names appear in `delivered` and `failed` is empty

#### Scenario: one channel fails others still deliver
- **WHEN** channel B throws during delivery while channels A and C succeed
- **THEN** A and C appear in `delivered`, B appears in `failed`, and the call does not throw

#### Scenario: partial failure reported not as complete failure
- **WHEN** at least one channel succeeds and at least one channel fails
- **THEN** the result has non-empty `delivered` AND non-empty `failed` arrays

### Requirement: Thread-Safe Singleton Reset
The `NotificationManager` singleton in `notifications.ts` MUST be guarded by an async
mutex. All `getInstance()` and `reset()` callers MUST acquire the mutex before reading or
writing the singleton reference, ensuring no torn state under concurrent access.

#### Scenario: concurrent reset calls produce no torn state
- **WHEN** `reset()` is called concurrently from multiple async tasks
- **THEN** exactly one task resets the singleton and subsequent `getInstance()` calls return
  a new consistent instance

#### Scenario: getInstance under concurrent access returns same instance
- **WHEN** `getInstance()` is called concurrently before initialization completes
- **THEN** all callers receive the same `NotificationManager` instance

### Requirement: Duplicate Notification Suppression
The notification route handler MUST suppress duplicate notifications where `hash(message +
"|" + target)` matches an entry inserted within the last 5 seconds. Suppressed requests
MUST return HTTP 200 with body `{ "suppressed": true }` without re-delivering. Expired
entries MUST be evicted on each incoming request or on a periodic sweep.

#### Scenario: duplicate within 5 seconds suppressed
- **WHEN** the same `message` and `target` are submitted twice within 5 seconds
- **THEN** the second request returns HTTP 200 with `{ "suppressed": true }` and no delivery occurs

#### Scenario: same message after TTL expires is delivered
- **WHEN** the same `message` and `target` are submitted again after the 5-second TTL has elapsed
- **THEN** the second request is delivered normally

#### Scenario: different target with same message is not suppressed
- **WHEN** the same `message` is submitted for two different `target` values within 5 seconds
- **THEN** both requests are delivered normally

### Requirement: Buffer Metadata Persistence
The notification buffer in `buffer.ts` MUST persist metadata (entry count, watermark, last
flush timestamp) to a JSON sidecar file (`~/.config/nexus/buffer-meta.json`) on every
mutation. On startup the buffer MUST read and hydrate from the sidecar if present; a
missing or unreadable sidecar MUST be treated as fresh state without error.

#### Scenario: metadata written on mutation
- **WHEN** a notification is inserted into the buffer
- **THEN** `buffer-meta.json` is updated with the current count, watermark, and flush timestamp

#### Scenario: metadata hydrated on restart
- **WHEN** the agent restarts and `buffer-meta.json` is present
- **THEN** the buffer initializes with the persisted count, watermark, and flush timestamp

#### Scenario: missing sidecar starts fresh
- **WHEN** `buffer-meta.json` does not exist on startup
- **THEN** the buffer initializes with zero count and no error is thrown

