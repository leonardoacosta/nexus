## MODIFIED Requirements

### Requirement: speak_from_socket Returns Result with Timeout
`speak_from_socket()` MUST return `Result<bool>` and apply a 5-second timeout on the HTTP call.
Callers MUST be able to detect delivery failures.

#### Scenario: successful delivery returns Ok(true)
- **WHEN** the TTS HTTP call completes with status 2xx within 5 seconds
- **THEN** `speak_from_socket` returns `Ok(true)`

#### Scenario: HTTP error returns Err
- **WHEN** the TTS API returns a 5xx status
- **THEN** `speak_from_socket` returns `Err(...)` and a Sentry error event is captured

#### Scenario: timeout returns Err
- **WHEN** the TTS API does not respond within 5 seconds
- **THEN** `speak_from_socket` returns `Err(Elapsed)` without blocking other notifications

### Requirement: Bounded Notification Buffer
`insertNotification()` MUST enforce a maximum buffer size of 1000 entries with LRU eviction.

#### Scenario: buffer evicts oldest entry at capacity
- **WHEN** the buffer contains 1000 entries and a new notification arrives
- **THEN** the oldest entry is evicted and the new entry is inserted

#### Scenario: buffer under capacity accepts all entries
- **WHEN** fewer than 1000 entries are present
- **THEN** all inserts succeed without eviction

### Requirement: Meeting State Machine Guards
`MeetingState.start()` and `end()` MUST throw on invalid transitions.

#### Scenario: double start throws
- **WHEN** `start()` is called while already in meeting
- **THEN** `InvalidStateError` is thrown

#### Scenario: end when not in meeting throws
- **WHEN** `end()` is called while not in meeting
- **THEN** `InvalidStateError` is thrown

#### Scenario: valid start-end cycle succeeds
- **WHEN** `start()` is called when idle, then `end()` is called
- **THEN** both calls succeed without error

### Requirement: Sentry Integration in TypeScript Delivery Channels
Desktop, TTS, and Slack delivery channels MUST call `Sentry.captureException` in their catch blocks.

#### Scenario: desktop delivery failure captured
- **WHEN** the desktop notification API throws
- **THEN** `Sentry.captureException(err)` is called

### Requirement: Unknown Channel Handler Logged
When `CHANNEL_HANDLERS[channel]` is undefined, `router.ts` MUST call `logger.warn`.

#### Scenario: unknown channel emits warning
- **WHEN** a notification arrives for an unregistered channel name
- **THEN** `logger.warn({ channel }, "unknown notification channel")` is called
