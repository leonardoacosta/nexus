# swift-menubar-client

## ADDED Requirements

### Requirement: PTY Viewer SHALL select a session from a live picker

The PTY Viewer MUST replace its free-text session-id input with a picker populated from the aggregate live-session list so users select an existing session instead of typing an id.

#### Scenario: picker lists live sessions
- **WHEN** the PTY Viewer opens and the aggregate client reports live sessions
- **THEN** the picker lists those live sessions instead of presenting a free-text field

#### Scenario: selecting a session attaches
- **WHEN** the user selects a session from the picker
- **THEN** the viewer attaches to that session's PTY

### Requirement: TTSObserver SHALL warn when the system is muted on startup

TTSObserver MUST query the system mute state on startup and log a clear warning when the Mac is muted so silent TTS is explained to the user.

#### Scenario: warning fires when muted
- **WHEN** TTSObserver starts and the system audio is muted
- **THEN** a clear warning is logged explaining that TTS will be inaudible

#### Scenario: no warning when unmuted
- **WHEN** TTSObserver starts and the system audio is not muted
- **THEN** no mute warning is logged
