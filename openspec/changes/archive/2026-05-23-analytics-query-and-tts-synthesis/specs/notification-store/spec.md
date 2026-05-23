# Delta: notification-store — Analytics Query and TTS Synthesis

## ADDED Requirements

### Requirement: GET /analytics/notifications MUST expose paginated history

The agent MUST expose `GET /analytics/notifications` which queries the `notifications` table and returns paginated rows including `id`, `message`, `channel`, `project`, `delivered`, `suppressed`, and the `created_at` timestamp. The endpoint MUST accept the optional query parameters `hours=N` (window in hours, default 24, MUST reject non-positive values with 400), `project=X` (case-sensitive exact match, optional), and `status=Y` (one of `delivered`, `suppressed`, `failed`, optional). Authentication MUST follow the same `x-nexus-secret` gate as the rest of the analytics surface.

#### Scenario: Default 24 h window returns rows with timestamps and delivery state

- **GIVEN** five notifications have been persisted in the last hour across two projects
- **WHEN** `GET /analytics/notifications` is called with a valid `x-nexus-secret`
- **THEN** the response is `200 OK` with a JSON array of five rows
- **AND** each row contains `id`, `message`, `channel`, `project`, `delivered`, `suppressed`, and `created_at`

#### Scenario: Filter by project and status narrows the result set

- **GIVEN** ten notifications: six delivered to project `oo`, four suppressed for project `tc`
- **WHEN** `GET /analytics/notifications?project=oo&status=delivered` is called
- **THEN** the response contains exactly the six delivered rows for project `oo`
- **AND** no rows from project `tc` appear

#### Scenario: Invalid hours rejected with 400

- **WHEN** `GET /analytics/notifications?hours=-1` is called
- **THEN** the response is `400 Bad Request` with a JSON `error` field naming the invalid parameter

## MODIFIED Requirements

### Requirement: TTS channel restores ElevenLabs call and attaches audio to the lifecycle event

The TTS channel MUST synthesize speech via ElevenLabs when `sendTtsNotification` is invoked with `ELEVENLABS_API_KEY` set, MUST persist the raw mp3 bytes to `~/.config/nexus/audio/<id>.mp3` via the existing audio-store helper, and MUST attach the base64-encoded mp3 to the `NotificationFired` lifecycle event so downstream listeners (the Mac-side notifier, future iOS/iPad listeners) can render audio natively. The channel MUST NOT gate the ElevenLabs call behind a secondary opt-in flag (the prior `NEXUS_TTS_USE_ELEVENLABS` env var remains removed). The agent MUST NOT attempt to play the audio on the homelab host — the agent runs headless and has no audio sink.

When `ELEVENLABS_API_KEY` is unset, the channel MUST still mark the notification as delivered and emit `NotificationFired` with `audioBase64` absent, so listeners with their own TTS fallback (future: Slack bridge, mobile `AVSpeechSynthesizer`) still fire. The agent MUST NOT collapse the TTS channel into a signal-only stub at any point — synthesis is the default behaviour, key-absent is the only "no audio" branch.

Retention and pruning of `~/.config/nexus/audio/` mp3 files is explicitly out of scope for this change and tracked as a follow-up design decision.

#### Scenario: ElevenLabs called, mp3 bytes surface in NotificationFired and persist on disk

- **GIVEN** `ELEVENLABS_API_KEY` is set
- **AND** a notification with `project: "cc"`, `body: "build complete"` is queued
- **WHEN** the TTS channel dispatches
- **THEN** a POST is made to `https://api.elevenlabs.io/v1/text-to-speech/<voiceId>` with `text: "cc: build complete"`
- **AND** the response body (mp3 bytes) is captured
- **AND** the bytes are written to `~/.config/nexus/audio/<notification-id>.mp3`
- **AND** `lifecycleBus.emit("NotificationFired", …)` is called with `audioBase64` set to the base64 encoding of those bytes

#### Scenario: No API key, text-only fire

- **GIVEN** `ELEVENLABS_API_KEY` is not set
- **AND** a notification with `channel: "tts"` is queued
- **WHEN** the TTS channel dispatches
- **THEN** no HTTP request is made to ElevenLabs
- **AND** no file is written under `~/.config/nexus/audio/`
- **AND** the notification is marked `delivered`
- **AND** `NotificationFired` is emitted with `audioBase64` undefined

#### Scenario: ElevenLabs HTTP error does not emit audio

- **GIVEN** `ELEVENLABS_API_KEY` is set but the key is rejected (HTTP 401)
- **WHEN** the TTS channel dispatches
- **THEN** the error is captured to Sentry via the existing `captureException` path
- **AND** the notification is marked as failed on that channel
- **AND** `NotificationFired` MUST NOT be emitted for the failed TTS channel

### Requirement: Duplicate Notification Suppression

The notification route handler MUST suppress duplicate notifications where `hash(message + "|" + (project || "") + "|" + channel)` matches an entry inserted within the last 5 seconds. The dedup key MUST include the `project` field so that the same banner text dispatched to two different projects in the same window is NOT collapsed into one suppression. Suppressed requests MUST return HTTP 200 with body `{ "suppressed": true }` without re-delivering. Expired entries MUST be evicted on each incoming request or on a periodic sweep.

#### Scenario: duplicate within 5 seconds suppressed

- **WHEN** the same `message`, `project`, and `channel` are submitted twice within 5 seconds
- **THEN** the second request returns HTTP 200 with `{ "suppressed": true }` and no delivery occurs

#### Scenario: same message after TTL expires is delivered

- **WHEN** the same `message`, `project`, and `channel` are submitted again after the 5-second TTL has elapsed
- **THEN** the second request is delivered normally

#### Scenario: same message for two different projects within 5s MUST NOT be suppressed

- **GIVEN** a notification with `message: "build complete"`, `channel: "tts"`, `project: "oo"` is delivered
- **WHEN** a second notification with `message: "build complete"`, `channel: "tts"`, `project: "tc"` is submitted within 5 seconds
- **THEN** the second request is delivered normally
- **AND** neither row is marked `suppressed`

### Requirement: PATCH MUST broadcast SettingsChanged lifecycle event

The settings PATCH handler MUST emit `lifecycleBus.emit("SettingsChanged", {ttsEnabled, bannerEnabled, duckingMode})` after a successful PATCH that mutates at least one field, with the post-update values (all three, not just the mutated ones) so subscribers can reconcile without re-fetching. The emission MUST occur AFTER the DB commit — subscribers must not race ahead of durable state. When the incoming patch is a no-op (every field present in the patch already matches the current row), the handler MUST short-circuit: it MUST return 200 with the unchanged row, MUST NOT bump `updated_at`, and MUST NOT emit `SettingsChanged`.

#### Scenario: Toggle fires SettingsChanged

- **GIVEN** a subscriber connected to `/events/stream`
- **AND** the current state is `(tts=true, banner=true, ducking=full)`
- **WHEN** a PATCH flips `banner_enabled` to `false`
- **THEN** the subscriber receives a `SettingsChanged` event within 1 second
- **AND** the payload contains `{ttsEnabled: true, bannerEnabled: false, duckingMode: "full"}`
- **AND** `updated_at` is bumped to the commit time

#### Scenario: No-op PATCH MUST NOT broadcast and MUST NOT bump updated_at

- **GIVEN** the current state is `(tts=true, banner=true, ducking=full, updated_at=T0)`
- **WHEN** a PATCH request arrives with `{"tts_enabled": true}` (unchanged)
- **THEN** the handler returns 200 with the current state
- **AND** `SettingsChanged` MUST NOT be emitted
- **AND** `SELECT updated_at FROM notification_settings WHERE id=1` still returns `T0`

### Requirement: Notification settings MUST persist as a single-row table

A DB table `notification_settings` MUST exist with columns: `id` (int, sentinel 1), `tts_enabled` (boolean), `banner_enabled` (boolean), `ducking_mode` (enum `full`/`half`/`mute`), `updated_at` (timestamp). The table MUST be seeded with a default row `(1, true, true, 'full', now)` on fresh database creation AND the agent MUST run an idempotent seed at boot (`INSERT … ON CONFLICT (id) DO NOTHING`) so the sentinel row is guaranteed to exist even if the original migration was rolled back, skipped, or truncated by an out-of-band operator. The agent MUST treat this row as a singleton — PATCH always targets `id=1`, GET always returns `id=1`.

#### Scenario: Migration seeds the default row

- **WHEN** the migration runs against a fresh database
- **THEN** `SELECT * FROM notification_settings` returns exactly one row
- **AND** that row has `tts_enabled=true`, `banner_enabled=true`, `ducking_mode='full'`

#### Scenario: Boot-time idempotent seed restores the sentinel after truncation

- **GIVEN** an operator manually ran `TRUNCATE notification_settings` while the agent was stopped
- **WHEN** the agent boots
- **THEN** the boot-time seed inserts `(1, true, true, 'full', now())`
- **AND** subsequent GET / PATCH requests behave as if the table had never been truncated

#### Scenario: PATCH targets the sentinel

- **GIVEN** the table has the seed row
- **WHEN** a PATCH request to `/notifications/settings` with `{"tts_enabled": false}` succeeds
- **THEN** `SELECT tts_enabled FROM notification_settings WHERE id=1` returns `false`
- **AND** `banner_enabled` and `ducking_mode` are unchanged
