# notification-store Delta

## ADDED Requirements

### Requirement: notification-audio-cache
The agent MUST persist synthesised MP3 bytes for every notification that successfully produces voice output. Storage path: `~/.config/nexus/audio/<notification_id>.mp3`. The `notifications` table MUST gain an `audio_path text` column populated when the file is written. Cron MUST prune files older than 30 days during its existing weekly sweep. Files missing on disk MUST cause `audioAvailable` to compute false at request time, regardless of the column value.

#### Scenario: TTS dispatch writes mp3
- **Given** a notification arrives and ElevenLabs synthesis succeeds with 48KB of MP3 bytes
- **When** the dispatcher emits the row
- **Then** `~/.config/nexus/audio/<id>.mp3` exists with byte-identical content; the notifications row's `audio_path` is set to that path

#### Scenario: TTS disabled — no file
- **Given** `notification_settings.tts_enabled = false`
- **When** a notification arrives
- **Then** no MP3 is synthesised, no file is written, the row's `audio_path` remains NULL

#### Scenario: file missing post-prune
- **Given** a 45-day-old notification row with `audio_path` set, but the file was pruned by cron
- **When** `GET /notifications` is called
- **Then** the row's `audioAvailable` is `false` (computed via stat, not just the column)

### Requirement: notification-audio-endpoint
The agent MUST expose `GET /notifications/:id/audio` returning the cached MP3 with `Content-Type: audio/mpeg`. The endpoint MUST support `Range:` requests for progressive playback. Behavior matrix:

- Row exists AND file exists: `200` (or `206` for range) with mp3 body
- Row exists AND `audio_path IS NULL`: `404 { error: "no audio for this notification" }`
- Row exists AND `audio_path` set but file missing: `410 { error: "audio file pruned by retention" }`
- Row missing: `404 { error: "notification not found" }`

#### Scenario: stream cached audio
- **Given** notification `notif-abc` has `~/.config/nexus/audio/notif-abc.mp3` (48KB)
- **When** `GET /notifications/notif-abc/audio` is called
- **Then** the response is `200` with `Content-Type: audio/mpeg`, `Content-Length: 49152`, body matches the file byte-for-byte

#### Scenario: range request
- **Given** the same row
- **When** `GET /notifications/notif-abc/audio` is called with header `Range: bytes=0-1023`
- **Then** the response is `206` with `Content-Range: bytes 0-1023/49152` and the first 1024 bytes

#### Scenario: pruned file
- **Given** a row where `audio_path` is set but the underlying file was deleted by retention
- **When** the endpoint is called
- **Then** the response is `410 { error: "audio file pruned by retention" }`

### Requirement: project-voice-overrides
The agent MUST contain a `project_voice_overrides` table mapping project slugs to ElevenLabs voice ids. Columns: `project text PK`, `voice_id text NOT NULL`, `updated_at timestamptz NOT NULL DEFAULT now()`. The agent MUST expose three endpoints: `GET /notifications/voices` (returns all rows as a map), `PUT /notifications/voices/:project` (body `{ voice_id }`, upsert), `DELETE /notifications/voices/:project` (remove row). On every PUT or DELETE, the agent MUST emit a `VoiceOverrideChanged` event on the `/notifications/events` SSE stream so subscribers refresh their cached map.

#### Scenario: insert new override
- **Given** the table is empty
- **When** `PUT /notifications/voices/nx` is called with body `{ voice_id: "voice-XYZ" }`
- **Then** the response is `200 { project: "nx", voice_id: "voice-XYZ", updated_at }`; a row exists; an SSE `VoiceOverrideChanged { project: "nx" }` event fires

#### Scenario: update existing override
- **Given** a row `(nx, voice-OLD, ...)` exists
- **When** the same endpoint is called with `{ voice_id: "voice-NEW" }`
- **Then** the row is updated in place; `updated_at` is refreshed; an SSE event fires

#### Scenario: list all
- **Given** rows `(nx, voice-A), (oo, voice-B), (tc, voice-C)` exist
- **When** `GET /notifications/voices` is called
- **Then** the response is `200 { nx: "voice-A", oo: "voice-B", tc: "voice-C" }`

#### Scenario: delete override
- **Given** a row for `nx` exists
- **When** `DELETE /notifications/voices/nx` is called
- **Then** the response is `204`; the row is gone; an SSE event fires

#### Scenario: delete non-existent
- **When** `DELETE /notifications/voices/no-such-project` is called against an empty table
- **Then** the response is `204` (idempotent — no error); no SSE event fires

### Requirement: notification-list-audio-and-voice
The `GET /notifications` response MUST include two additional optional fields per row: `audioAvailable: boolean` (true when `audio_path` is set AND the file is present at request time) and `voiceUsed: string | null` (the resolved voice id used during synthesis, or null when TTS was disabled or skipped). Older clients that ignore these fields MUST continue to decode the response without error.

#### Scenario: row with audio
- **Given** a notification was synthesised with voice `voice-XYZ` and the file is on disk
- **When** `GET /notifications` is called
- **Then** the row contains `audioAvailable: true, voiceUsed: "voice-XYZ"`

#### Scenario: row without audio
- **Given** a notification was emitted but TTS was disabled
- **When** the endpoint is called
- **Then** the row contains `audioAvailable: false, voiceUsed: null`
