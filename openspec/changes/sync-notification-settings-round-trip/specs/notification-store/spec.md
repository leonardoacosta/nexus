## MODIFIED Requirements

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
