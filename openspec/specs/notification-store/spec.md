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

The notification manager MUST deliver to all configured channels concurrently using `Promise.allSettled`. A single channel failure MUST NOT prevent delivery to other channels. The manager MUST return a `{ delivered: string[]; failed: string[] }` result distinguishing partial success from total failure.

**Updated 2026-04-24:** Delivery persistence in the DB MUST remain independent of user-visible settings. When `tts_enabled=false`, the TTS channel STILL calls ElevenLabs and STILL emits `NotificationFired` with `audioBase64`. The listener — not the agent — decides whether to play. Rationale: the audit trail in the notifications table must reflect what the system CAN deliver, not what the user currently chooses to hear. Suppression is a render-layer concern.

#### Scenario: TTS disabled at listener, still persists at agent

- **GIVEN** `tts_enabled=false` is the current setting
- **AND** a TTS notification is POSTed to `/notifications/send`
- **WHEN** the channel dispatches
- **THEN** the agent calls ElevenLabs, captures audio, emits `NotificationFired` with `audioBase64`
- **AND** the notifications table row is marked `delivered`
- **AND** the Mac listener receives the event but skips `afplay` (listener-side suppression)

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

### Requirement: TTS channel restores ElevenLabs call and attaches audio to the lifecycle event

When `sendTtsNotification` is invoked with `ELEVENLABS_API_KEY` set, the channel MUST synthesize speech via ElevenLabs and attach the resulting mp3 bytes (base64-encoded) to the `NotificationFired` lifecycle event so downstream listeners (the Mac-side notifier, future iOS/iPad listeners) can render the audio natively. The channel MUST NOT gate the ElevenLabs call behind a secondary opt-in flag (the prior `NEXUS_TTS_USE_ELEVENLABS` env var is removed). The agent MUST NOT attempt to play the audio on the homelab host — the agent runs headless and has no audio sink.

When `ELEVENLABS_API_KEY` is unset, the channel MUST still mark the notification as delivered and emit `NotificationFired` with `audioBase64` absent, so listeners with their own TTS fallback (future: Slack bridge, mobile `AVSpeechSynthesizer`) still fire.

#### Scenario: ElevenLabs called, mp3 bytes surface in NotificationFired

- **GIVEN** `ELEVENLABS_API_KEY` is set
- **AND** a notification with `project: "cc"`, `body: "build complete"` is queued
- **WHEN** the TTS channel dispatches
- **THEN** a POST is made to `https://api.elevenlabs.io/v1/text-to-speech/<voiceId>` with `text: "cc: build complete"`
- **AND** the response body (mp3 bytes) is captured
- **AND** `lifecycleBus.emit("NotificationFired", …)` is called with `audioBase64` set to the base64 encoding of those bytes

#### Scenario: No API key, text-only fire

- **GIVEN** `ELEVENLABS_API_KEY` is not set
- **AND** a notification with `channel: "tts"` is queued
- **WHEN** the TTS channel dispatches
- **THEN** no HTTP request is made to ElevenLabs
- **AND** the notification is marked `delivered`
- **AND** `NotificationFired` is emitted with `audioBase64` undefined

#### Scenario: ElevenLabs HTTP error does not emit audio

- **GIVEN** `ELEVENLABS_API_KEY` is set but the key is rejected (HTTP 401)
- **WHEN** the TTS channel dispatches
- **THEN** the error is captured to Sentry via the existing `captureException` path
- **AND** the notification is marked as failed on that channel
- **AND** `NotificationFired` MUST NOT be emitted for the failed TTS channel

### Requirement: NotificationFired payload MUST carry optional audio bytes

The `NotificationFiredPayload` type in `apps/agent/src/services/lifecycle-bus.ts` MUST include an optional `audioBase64?: string` field alongside the existing fields. When present, the value MUST be the base64 encoding of the raw mp3 bytes received from ElevenLabs. The field MUST be optional and subscribers MUST tolerate events where it is absent (text-only notifications).

#### Scenario: Payload type surface includes audioBase64

- **WHEN** a TypeScript consumer imports `NotificationFiredPayload` from `@nexus/agent`
- **THEN** the type MUST expose `audioBase64?: string` alongside `id`, `title`, `body`, `channel`, `project`, and `message`

#### Scenario: SSE subscriber receives the field

- **GIVEN** a client connected to `/events/stream` with `x-nexus-secret`
- **WHEN** a `NotificationFired` frame is emitted with `audioBase64` set
- **THEN** the SSE `data:` line MUST contain the full JSON envelope including `audioBase64`

### Requirement: Socket-server path remains consistent with audio-optionality

The legacy socket-based notification dispatcher at `apps/agent/src/services/socket-server/dispatcher.ts` MUST continue to emit `NotificationFired` for backward compatibility with the retired `/tmp/nexus-agent.sock` pattern. Since the socket path never had audio capture, it MUST explicitly omit `audioBase64` from the emission (or set it to `undefined`). This documents that the field is present-iff-via-HTTP-TTS-channel and avoids stale fields lingering from prior refactors.

#### Scenario: Socket dispatcher emits without audio

- **GIVEN** a legacy socket event triggers `NotificationFired` from the dispatcher
- **WHEN** the payload is constructed
- **THEN** `audioBase64` is explicitly undefined or omitted
- **AND** the listener skips audio playback on receipt

### Requirement: Notification settings MUST persist as a single-row table

A DB table `notification_settings` MUST exist with columns: `id` (int, sentinel 1), `tts_enabled` (boolean), `banner_enabled` (boolean), `ducking_mode` (enum `full`/`half`/`mute`), `updated_at` (timestamp). The table MUST be seeded with a default row `(1, true, true, 'full', now)` as part of the migration. The agent MUST treat this as a singleton — PATCH always targets `id=1`, GET always returns `id=1`.

#### Scenario: Migration seeds the default row

- **WHEN** the migration runs against a fresh database
- **THEN** `SELECT * FROM notification_settings` returns exactly one row
- **AND** that row has `tts_enabled=true`, `banner_enabled=true`, `ducking_mode='full'`

#### Scenario: PATCH targets the sentinel

- **GIVEN** the table has the seed row
- **WHEN** a PATCH request to `/notifications/settings` with `{"tts_enabled": false}` succeeds
- **THEN** `SELECT tts_enabled FROM notification_settings WHERE id=1` returns `false`
- **AND** `banner_enabled` and `ducking_mode` are unchanged

### Requirement: Settings endpoints MUST be authed and schema-validated

Both `GET /notifications/settings` and `PATCH /notifications/settings` MUST require the `x-nexus-secret` header and return `401 Unauthorized` when missing or mismatched. PATCH MUST reject payloads containing fields outside `{tts_enabled, banner_enabled, ducking_mode}` with `400 Bad Request`. PATCH MUST validate `ducking_mode` against the enum `{full, half, mute}` and reject other values with `400`.

#### Scenario: Auth gate

- **GIVEN** a request to `GET /notifications/settings` without the `x-nexus-secret` header
- **WHEN** the agent processes the request
- **THEN** the response is `401 Unauthorized`

#### Scenario: Unknown field rejected

- **GIVEN** a PATCH body `{"evil_field": "bad"}`
- **WHEN** the agent processes the request
- **THEN** the response is `400 Bad Request`
- **AND** the body MUST NOT be persisted

#### Scenario: Invalid ducking mode rejected

- **GIVEN** a PATCH body `{"ducking_mode": "mid"}`
- **WHEN** the agent processes the request
- **THEN** the response is `400 Bad Request`
- **AND** `ducking_mode` retains its prior value

### Requirement: PATCH MUST broadcast SettingsChanged lifecycle event

After a successful PATCH that mutates at least one field, the handler MUST emit `lifecycleBus.emit("SettingsChanged", {ttsEnabled, bannerEnabled, duckingMode})` with the post-update values (all three, not just the mutated ones) so subscribers can reconcile without re-fetching. The emission MUST occur AFTER the DB commit — subscribers must not race ahead of durable state.

#### Scenario: Toggle fires SettingsChanged

- **GIVEN** a subscriber connected to `/events/stream`
- **AND** the current state is `(tts=true, banner=true, ducking=full)`
- **WHEN** a PATCH flips `banner_enabled` to `false`
- **THEN** the subscriber receives a `SettingsChanged` event within 1 second
- **AND** the payload contains `{ttsEnabled: true, bannerEnabled: false, duckingMode: "full"}`

#### Scenario: No-op PATCH MUST NOT broadcast

- **GIVEN** the current state is `(tts=true, banner=true, ducking=full)`
- **WHEN** a PATCH request arrives with `{"tts_enabled": true}` (unchanged)
- **THEN** the handler returns 200 with the current state
- **AND** `SettingsChanged` MUST NOT be emitted

