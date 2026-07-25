# Mac TTS Listener

## MODIFIED Requirements

### Requirement: Mac Settings panes MUST persist toggles to the server, not just locally

Every UI surface that flips a notification/TTS setting — the Settings panes AND the NotificationDrawer quick toggles — SHALL persist the change to the agent via the settings PATCH so it round-trips through `SettingsChanged` to all peers. A local-only (`@AppStorage`-only) toggle write is a defect: the next inbound reconciliation silently reverts it.

#### Scenario: Drawer TTS quick-toggle persists

- **WHEN** the user flips the TTS toggle in the NotificationDrawer
- **THEN** the agent receives a settings PATCH carrying `tts_enabled`, and a subsequent inbound `SettingsChanged` reflects (not reverts) the user's choice

#### Scenario: Settings pane and drawer toggle are equivalent

- **WHEN** the same setting is flipped from the Settings pane or from the drawer
- **THEN** both paths produce the same PATCH and the same observer behavior

## ADDED Requirements

### Requirement: Synthesis failures never crash the listener

Every failure on the TTS synthesis path — including a malformed or non-URL-safe voice id from a project voice override — SHALL surface as a thrown error that the provider chain catches and degrades from, never as a force-unwrap trap.

#### Scenario: Malformed voice override degrades gracefully

- **WHEN** a project voice override resolves to a voice id that cannot form a valid request URL
- **THEN** the ElevenLabs client throws, the provider chain advances (or degrades to signal-only), and the app does not crash

### Requirement: Replay playback state tracks the audible clip

The replay UI's playing-state (`currentlyPlayingId`) SHALL always name the clip that is actually audible. When a live TTS clip supersedes a manual replay, the superseded replay's id is cleared immediately — not at clip end.

#### Scenario: Live clip supersedes a manual replay

- **WHEN** a manual replay is playing and a live TTS clip supersedes it
- **THEN** the replay row's stop icon reverts to play, and tapping the row does not stop the unrelated live clip
