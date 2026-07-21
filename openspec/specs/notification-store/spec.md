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
When `sendTtsNotification` is invoked with ElevenLabs credentials available and the resolved project voice is bare or `elevenlabs:`-qualified, the channel MUST synthesize speech via ElevenLabs and attach the resulting mp3 bytes (base64-encoded) to the `NotificationFired` lifecycle event so downstream listeners (the Mac-side notifier, future iOS/iPad listeners) can render the audio natively.
- The channel MUST NOT gate the ElevenLabs call behind a secondary opt-in flag (the prior `NEXUS_TTS_USE_ELEVENLABS` env var is removed).
- The agent MUST NOT attempt to play the audio on the homelab host — the agent runs headless and has no audio sink.
- When the resolved project voice is qualified with a provider other than `elevenlabs` (e.g. `kokoro:af_heart`), the channel MUST NOT call ElevenLabs and MUST emit `NotificationFired` with `audioBase64` absent — synthesis for local providers is owned by the Mac listener (`mac-tts-listener`), not the headless agent.
- When ElevenLabs credentials are unset, the channel MUST still mark the notification as delivered and emit `NotificationFired` with `audioBase64` absent, so listeners with their own TTS fallback (future: Slack bridge, mobile `AVSpeechSynthesizer`) still fire.

#### Scenario: ElevenLabs called, mp3 bytes surface in NotificationFired

- **GIVEN** `ELEVENLABS_API_KEY` is set
- **AND** a notification with `project: "cc"`, `body: "build complete"` is queued
- **AND** the resolved voice for `cc` is a bare ElevenLabs voice id
- **WHEN** the TTS channel dispatches
- **THEN** a POST is made to `https://api.elevenlabs.io/v1/text-to-speech/<voiceId>` with `text: "cc: build complete"`
- **AND** the response body (mp3 bytes) is captured
- **AND** `lifecycleBus.emit("NotificationFired", …)` is called with `audioBase64` set to the base64 encoding of those bytes

#### Scenario: Kokoro-qualified voice emits signal-only

- **GIVEN** ElevenLabs credentials are available
- **AND** the resolved project voice is `kokoro:af_heart`
- **WHEN** the TTS channel dispatches
- **THEN** no HTTP request is made to ElevenLabs
- **AND** the notification is marked `delivered`
- **AND** `NotificationFired` is emitted with `audioBase64` undefined

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

A DB table `notification_settings` MUST exist with columns: `id` (int, sentinel 1),
`tts_enabled` (boolean), `banner_enabled` (boolean), `ducking_mode` (enum `full`/`half`/`mute`),
`signal_only` (boolean), `meeting_mode` (boolean), `suppression_minutes` (integer),
`updated_at` (timestamp). The table MUST be seeded with a default row
`(1, true, true, 'full', false, false, 0, now)` as part of the migration. The agent MUST treat
this as a singleton — PATCH always targets `id=1`, GET always returns `id=1`.

#### Scenario: Migration seeds the default row

- **WHEN** the migration runs against a fresh database
- **THEN** `SELECT * FROM notification_settings` returns exactly one row
- **AND** that row has `tts_enabled=true`, `banner_enabled=true`, `ducking_mode='full'`,
  `signal_only=false`, `meeting_mode=false`, `suppression_minutes=0`

#### Scenario: PATCH targets the sentinel

- **GIVEN** the table has the seed row
- **WHEN** a PATCH request to `/notifications/settings` with `{"tts_enabled": false}` succeeds
- **THEN** `SELECT tts_enabled FROM notification_settings WHERE id=1` returns `false`
- **AND** every other column is unchanged

#### Scenario: New columns round-trip independently

- **GIVEN** the table has the seed row
- **WHEN** a PATCH request with `{"signal_only": true, "meeting_mode": true,
  "suppression_minutes": 15}` succeeds
- **THEN** `SELECT signal_only, meeting_mode, suppression_minutes FROM notification_settings
  WHERE id=1` returns `(true, true, 15)`
- **AND** `tts_enabled`, `banner_enabled`, `ducking_mode` are unchanged

### Requirement: Settings endpoints MUST be authed and schema-validated

Both `GET /notifications/settings` and `PATCH /notifications/settings` MUST require the
`x-nexus-secret` header and return `401 Unauthorized` when missing or mismatched. PATCH MUST
reject payloads containing fields outside the allow-list
`{tts_enabled, banner_enabled, ducking_mode, presence_aware_routing, unknown_noncritical_mode,
unknown_critical_mode, bedtime_sources, rate_throttle_enabled, rate_throttle_max_per_window,
rate_throttle_window_minutes, quiet_hours_enabled, quiet_hours_start_hour, quiet_hours_end_hour,
signal_only, meeting_mode, suppression_minutes}` with `400 Bad Request`. PATCH MUST validate
`ducking_mode` against the enum `{full, half, mute}`, `suppression_minutes` as a non-negative
integer, and reject other values with `400`.

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

#### Scenario: Negative suppression_minutes rejected

- **GIVEN** a PATCH body `{"suppression_minutes": -5}`
- **WHEN** the agent processes the request
- **THEN** the response is `400 Bad Request`
- **AND** `suppression_minutes` retains its prior value

### Requirement: PATCH MUST broadcast SettingsChanged lifecycle event

After a successful PATCH that mutates at least one field, the handler MUST emit
`lifecycleBus.emit("SettingsChanged", {ttsEnabled, bannerEnabled, duckingMode, signalOnly,
meetingMode, suppressionMinutes})` with the post-update values (the full row, not just the
mutated fields) so subscribers can reconcile without re-fetching. The emission MUST occur AFTER
the DB commit — subscribers must not race ahead of durable state.

#### Scenario: Toggle fires SettingsChanged

- **GIVEN** a subscriber connected to `/events/stream`
- **AND** the current state is `(tts=true, banner=true, ducking=full, signalOnly=false,
  meetingMode=false, suppressionMinutes=0)`
- **WHEN** a PATCH flips `banner_enabled` to `false`
- **THEN** the subscriber receives a `SettingsChanged` event within 1 second
- **AND** the payload contains the full post-update row including the unchanged
  `signalOnly`/`meetingMode`/`suppressionMinutes` values

#### Scenario: No-op PATCH MUST NOT broadcast

- **GIVEN** the current state is `(tts=true, banner=true, ducking=full)`
- **WHEN** a PATCH request arrives with `{"tts_enabled": true}` (unchanged)
- **THEN** the handler returns 200 with the current state
- **AND** `SettingsChanged` MUST NOT be emitted

### Requirement: NotificationFired payload MUST carry structured items and a log path

The `NotificationFired` lifecycle payload MUST be extended with an optional
`items` string array (a bullet list of findings) and an optional `logPath`
(an absolute filesystem path to the originating run log). The Swift
`NotificationEvent` mirror in NexusShared MUST be extended with the same two
optional fields so the cross-platform shape stays in sync. Both fields MUST
be optional and back-compatible: existing emitters that omit them MUST
continue to render exactly as before.

#### Scenario: Reaper completion carries items and logPath

- **WHEN** the reaper job emits its completion notification
- **THEN** the `NotificationFired` payload includes `items` (the per-finding
  bullet lines) and `logPath` (the absolute path to the reaper run log)

#### Scenario: Legacy emitter omits the new fields

- **GIVEN** an existing notification emitter that sets only `title` and
  `body`
- **WHEN** it emits `NotificationFired`
- **THEN** `items` and `logPath` are absent and the notification renders
  identically to its pre-change behavior

### Requirement: The notification renderer MUST render items as a bullet list

The Mac listener notification renderer MUST render a non-empty `items` array
as a bullet list in the delivered notification rather than concatenating the
findings into a single banner line.

#### Scenario: Findings rendered as bullets

- **GIVEN** a `NotificationFired` payload whose `items` contains three
  findings
- **WHEN** the Mac listener renders the notification
- **THEN** the three findings are presented as a bullet list, not as one
  run-on banner line

### Requirement: Clicking a notification with a logPath MUST open the run log

The renderer MUST open the referenced log file via the OS default handler
when a delivered notification carries a `logPath` and the user activates it.
This replaces the current raw-`osascript` banner whose click attribution
incorrectly opened the scripts folder; the fix SHALL live in the renderer so
all nx notifications that supply a `logPath` benefit.

#### Scenario: Click opens the run log

- **GIVEN** a delivered notification with `logPath` set to an existing file
- **WHEN** the user clicks/activates the notification
- **THEN** the OS opens that log file (not the scripts folder, not the app)

#### Scenario: No logPath falls back to default activation

- **GIVEN** a delivered notification with no `logPath`
- **WHEN** the user clicks/activates it
- **THEN** the renderer performs its default activation behavior and does not
  error

### Requirement: Bloat warnings MUST retain a dedicated spoken TTS

A bloat-radar warning MUST be delivered as a dedicated spoken TTS message,
separate from the routine completion summary, so it is not lost in the
digest.

#### Scenario: Dedicated bloat TTS spoken

- **GIVEN** the reaper run produced one or more bloat findings
- **WHEN** the completion notifications are dispatched
- **THEN** a dedicated TTS message announcing the bloat warning is spoken in
  addition to the routine completion summary and its bullet-list desktop
  notification

### Requirement: Notification Engine Reliability Guards

The notification engine SHALL reject invalid meeting state transitions and MUST bound the notification buffer so that buffer growth is capped under load.

#### Scenario: Invalid meeting transition rejected

- **WHEN** the meeting state machine receives a transition that is not permitted from its current state
- **THEN** the transition is rejected and logged, the current state is preserved, and no notification is emitted for the invalid transition

#### Scenario: Notification buffer overflow bounded

- **WHEN** the notification buffer reaches its configured maximum size and a new notification arrives
- **THEN** the buffer applies its overflow policy (drop or evict) so total buffered entries never exceed the maximum, and the overflow event is recorded

### Requirement: Channel Delivery Failure Visibility

External channel awaits SHALL be bounded by a timeout and the routing handler MUST surface a missing channel handler instead of silently skipping it.

#### Scenario: Hung channel times out

- **WHEN** an external channel API await in the router does not resolve within the configured timeout
- **THEN** the await is aborted via timeout, the failure is logged and captured, and delivery to other channels continues uninterrupted

#### Scenario: Missing channel handler surfaced

- **WHEN** the routing handler is asked to deliver to a channel that has no registered handler
- **THEN** the handler logs and captures the missing-handler condition rather than silently skipping it, so the lost delivery is observable

### Requirement: Notification titles SHALL compose project code and session name

Notification titles SHALL be composed as `<project> · <session>` (middot-separated) when both
a project code and a session name are present, so the recipient can identify both the project
and the specific session at a glance. The composition SHALL degrade gracefully: session name
alone, then project code alone, then the notification's own title, then a default of `Nexus`.

The rule SHALL be applied consistently across every delivery surface: the iOS APNS push
(server-built by the agent), the macOS desktop banner (client-built from the `NotificationFired`
event), and the iOS in-app stored-notification list. Because the APNS push title is built by the
agent and the banner / in-app titles are built by the Swift clients, the rule is expressed once
in TypeScript and once in Swift; both expressions SHALL produce identical output for the same
inputs.

#### Scenario: Both project and session present
- **WHEN** a session-originated notification fires with project `oo` and session name `fix-login-flow`
- **THEN** the notification title is `oo · fix-login-flow`
- **AND** the same title appears on the iOS push, the macOS banner, and the iOS in-app list

#### Scenario: Session name only
- **WHEN** a notification fires with a session name but no project code
- **THEN** the title is the session name alone (no leading separator)

#### Scenario: Neither project nor session present
- **WHEN** a notification fires with neither a project code nor a session name
- **THEN** the title falls back to the notification's own title, or `Nexus` if that is also absent

#### Scenario: Body is unaffected
- **WHEN** the composed title changes
- **THEN** the notification body still carries the original message text unchanged

### Requirement: API errors MUST fire a desktop and TTS notification

The system MUST fire a notification on **every** Claude Code API error, covering two sources:

1. **Mid-session (retryable):** when a CC transcript line with `isApiErrorMessage: true`
   (e.g. `API Error: 529 Overloaded`) is observed while the session is still running, the
   tail-watcher MUST emit a `notification` event carrying the error text.
2. **Terminal crash:** when a session stops with `stop_reason="api_error"`, the same
   notification path MUST fire (this case previously fired desktop-only).

In both cases the notification MUST route to BOTH the `desktop` and `tts` channels with
`priority: high` and `severity: error`. The notification body MUST include the project code
and the captured API error text.

The `stop_reason="api_error"` crash case MUST be handled by the new API-error rule, not by
the generic session-stop rule; the session-stop rule MUST continue to handle all non-api
crash reasons (`error`, `crash`, `timeout`, `oom`).

#### Scenario: Mid-session 529 fires a spoken alert

- **GIVEN** a session is running and its transcript receives a line with
  `isApiErrorMessage: true` and content `"API Error: 529 Overloaded"`
- **WHEN** the tail-watcher reads that line
- **THEN** a `notification` event is emitted with the error text and project code
- **AND** the resulting notification routes to both `desktop` and `tts` channels with
  `severity: error`

#### Scenario: Crash-stop api_error now speaks

- **GIVEN** a session stops with `stop_reason="api_error"` and `error_details` present
- **WHEN** the hook rules evaluate the stop event
- **THEN** the API-error rule produces drafts for BOTH `desktop` and `tts` channels
- **AND** the generic session-stop rule produces no draft for `api_error`

#### Scenario: Non-api crash stays desktop-only

- **GIVEN** a session stops with `stop_reason="oom"`
- **WHEN** the hook rules evaluate the stop event
- **THEN** the session-stop rule produces a `desktop` draft as before
- **AND** the API-error rule produces no draft

### Requirement: API-error notification throttling

The system MUST throttle API-error notifications per session so that a sustained API outage
does not produce a stream of overlapping alerts. Repeated API errors for the same session
MUST be suppressed within the existing suppression window. The suppression key MUST be scoped
per session (`api_error:<session_id>`) so that distinct sessions hitting the same outage each
receive their own alert.

#### Scenario: Repeated 529s collapse to one alert

- **GIVEN** a session emits three `API Error: 529 Overloaded` lines within the suppression
  window
- **WHEN** the API-error rule evaluates each
- **THEN** only the first produces a delivered notification
- **AND** the second and third are suppressed by the per-session key

#### Scenario: Two sessions in the same outage both alert

- **GIVEN** two distinct sessions each emit an API error within the same window
- **WHEN** the API-error rule evaluates each
- **THEN** each session produces its own delivered notification (keys do not collide)

### Requirement: Non-critical TTS on the presence-unknown path SHALL respect a configurable quiet-hours window

`NotificationManager` MUST downgrade a `channel: "tts"` notification to `channel: "desktop"`
when `decidePresenceRoute()` returns `null` (presence-aware routing disabled, or the presence
vector has zero known fields) AND the current wall-clock hour falls within the configured
`[quietHoursStartHour, quietHoursEndHour)` window (supporting a window that wraps past
midnight) AND `quietHoursEnabled` is true. This check MUST run at both legacy delivery points:
`send()`'s immediate-delivery branch and `flush()`'s buffered-queue delivery. A
`priority: "high"` notification MUST NEVER be downgraded, regardless of the window. The
presence-aware rules engine's own Rule 1 (active-Mac-beats-bedtime) and Rule 3
(phone-reported bedtime) are unaffected — this gate is a floor for when no presence signal
exists at all, not a replacement for either rule.

#### Scenario: Non-critical TTS inside the quiet-hours window with no presence signal is downgraded

- **GIVEN** `quietHoursEnabled=true`, `quietHoursStartHour=0`, `quietHoursEndHour=7`
- **AND** the current wall-clock hour is 3
- **AND** presence-aware routing returns `null` (no known presence signal)
- **WHEN** a `channel: "tts"`, `priority` other than `"high"` notification is sent via the
  legacy delivery path
- **THEN** the notification is delivered with `channel: "desktop"` instead of `"tts"`

#### Scenario: A critical notification is never downgraded

- **GIVEN** the current wall-clock hour is within the configured quiet-hours window
- **WHEN** a `priority: "high"` notification (e.g. crash-stop, api-error) is sent via the
  legacy delivery path
- **THEN** the notification is still delivered with `channel: "tts"` unchanged

#### Scenario: Quiet hours disabled or unconfigured leaves legacy behavior unchanged

- **GIVEN** `quietHoursEnabled=false`, or `NotificationManager` was constructed with no
  `quietHours` wiring at all
- **WHEN** a non-critical `tts` notification is sent via the legacy delivery path at any hour
- **THEN** the notification is still delivered with `channel: "tts"` unchanged

#### Scenario: The quiet-hours window is operator-configurable via the settings route

- **GIVEN** a `PATCH /notifications/settings` request with body
  `{"quiet_hours_start_hour": 23, "quiet_hours_end_hour": 6}`
- **WHEN** the request is processed
- **THEN** the response reflects the updated window
- **AND** subsequent legacy-path deliveries use the new window

### Requirement: Notification channel transports live in dedicated modules

The notification router MUST delegate channel-specific transport logic (TTS/ElevenLabs
synthesis, Telegram Bot API delivery) to dedicated modules under
`apps/agent/src/notifications/channels/`, keeping `router.ts` limited to rule matching,
suppression, dispatch fan-out, and timeout/error handling.

#### Scenario: TTS transport is isolated from routing policy
- **WHEN** a notification is routed to the `tts` channel
- **THEN** ElevenLabs credential resolution, voice-id resolution, and the synthesis call
  execute inside `apps/agent/src/notifications/channels/tts.ts`, not `router.ts`

#### Scenario: Telegram transport is isolated from routing policy
- **WHEN** a notification is routed to the `telegram` channel
- **THEN** Telegram Bot API credential resolution and the `sendMessage` call execute inside
  `apps/agent/src/notifications/channels/telegram.ts`, not `router.ts`

### Requirement: Encrypted channel credentials share one resolver

TTS and Telegram MUST share a single encrypted-credential resolver implementation (DB row
lookup, decrypt, warn-and-fall-back to env) rather than duplicating the scaffold per channel,
and MUST re-query and re-decrypt on every dispatch (no in-memory cache), so a rotated
credential takes effect on the very next notification.

#### Scenario: Rotated credential takes effect without agent restart
- **WHEN** an operator rotates an encrypted channel credential in the database
- **THEN** the very next notification dispatched through that channel resolves the new
  credential value, with no agent restart required

### Requirement: Notification routing has a single dispatch path

The router MUST expose exactly one notification dispatch function
(`routeNotificationParallel`). The legacy serial `routeNotification` dispatch path MUST NOT
exist, so routing logic (rule matching, unspeakable-body suppression, missing-handler
surfacing) cannot drift between two duplicate implementations.

#### Scenario: No serial dispatch path remains
- **WHEN** the notifications module is inspected for exported dispatch functions
- **THEN** `routeNotification` (serial) is not exported by `router.ts`, and `manager.ts` does
  not import it

