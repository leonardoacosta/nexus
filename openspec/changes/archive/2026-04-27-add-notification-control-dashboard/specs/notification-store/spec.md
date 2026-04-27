# notification-store — Spec Delta

## ADDED Requirements

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

## MODIFIED Requirements

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
