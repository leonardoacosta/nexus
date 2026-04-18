## ADDED Requirements

### Requirement: Bounded notification buffer
The notification buffer MUST enforce a maximum size; when the cap is reached, the oldest entries MUST be evicted (FIFO) so the buffer never grows unbounded. Default cap: 1000 entries (`MAX_BUFFER_SIZE`). This requirement is satisfied by the existing implementation in `buffer.ts`.

#### Scenario: Burst of 2000 notifications
- **GIVEN** a buffer with `MAX_BUFFER_SIZE=1000`
- **WHEN** 2000 notifications are inserted in quick succession
- **THEN** the buffer size equals 1000 and the first 1000 inserts are no longer present

### Requirement: Meeting state transition guards
The meeting state machine MUST reject invalid transitions by throwing `InvalidStateError`: `start()` when already in a meeting, `end()` when not in a meeting. This requirement is satisfied by the existing implementation in `meeting-state.ts`.

#### Scenario: Double start
- **GIVEN** a `MeetingState` that has already transitioned to in-meeting
- **WHEN** `start()` is called again
- **THEN** it throws `InvalidStateError`

#### Scenario: End without start
- **GIVEN** a `MeetingState` that is NOT in a meeting
- **WHEN** `end()` is called
- **THEN** it throws `InvalidStateError`

#### Scenario: Start after end succeeds
- **GIVEN** a `MeetingState` that completed a full start → end cycle
- **WHEN** `start()` is called again
- **THEN** it succeeds and `active` returns true

### Requirement: Timeout on external notification delivery
Every external API call in the notification delivery path MUST have a timeout (default 10s, configurable via `NEXUS_NOTIFICATION_TIMEOUT_MS` env var). Exceeding the timeout MUST emit a Sentry `captureException` and return a structured failure (`failed` result), not hang. Applies to both the serial (`routeNotification`) and parallel (`routeNotificationParallel`) routing paths.

#### Scenario: Slack webhook hangs
- **GIVEN** a Slack webhook endpoint that never responds
- **WHEN** a notification is routed to the `slack` channel
- **THEN** the delivery fails within 10s, `Sentry.captureException` is called with the channel name and notification id, and the notification engine is unblocked for the next message

#### Scenario: Timeout respects env var override
- **GIVEN** `NEXUS_NOTIFICATION_TIMEOUT_MS=2000`
- **WHEN** a channel handler does not resolve within 2s
- **THEN** the timeout fires at approximately 2s (not 10s)

### Requirement: Observable missing-handler routing
If a notification specifies a channel for which no handler is registered, the routing layer MUST emit a WARN log AND a Sentry breadcrumb naming the missing channel before dropping the notification.

#### Scenario: Notification to unregistered channel "foo"
- **GIVEN** a notification `{ channel: "foo", ... }` and no "foo" handler registered
- **WHEN** the router processes it (either serial or parallel path)
- **THEN** a WARN log is emitted naming "foo" as missing, AND `Sentry.addBreadcrumb` is called with the missing channel name
