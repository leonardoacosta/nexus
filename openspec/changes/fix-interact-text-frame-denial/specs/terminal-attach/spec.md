# Terminal Attach — Delta

## ADDED Requirements

### Requirement: Interact client text-frame denial discrimination
The Swift interact client (`PtyInteractChannel`) SHALL parse text frames received on the interact
WebSocket as JSON control messages and SHALL treat only `{"type":"error"}` payloads (in addition
to eviction close code 4009) as a writer-denial. Benign control frames — `geometry`,
`replay_done`, `writer_disconnected`, and unrecognized types — SHALL NOT mark the channel
read-only, and the receive loop SHALL continue running after any non-denial text frame, exiting
only on socket close or transport error.

#### Scenario: Geometry frame does not revoke the writer
- **GIVEN** a client has opened the interact WebSocket and the writer claim succeeded
- **WHEN** the agent sends the `{"type":"geometry",...}` text frame on the interact socket
- **THEN** the client remains writable
- **AND** subsequent keystrokes are transmitted as binary frames and produce
  `NXPTY interact binary -> pty.write()` on the agent

#### Scenario: Explicit error frame revokes the writer
- **WHEN** the agent sends `{"type":"error","message":"not the interactive writer"}` on the
  interact socket
- **THEN** the client marks the channel read-only and drops further input with a visible
  warning log

#### Scenario: Receive loop survives benign control frames
- **GIVEN** a `writer_disconnected` or `replay_done` text frame has arrived on the interact socket
- **WHEN** the agent later evicts the client (close code 4009) or sends a `{"type":"error"}` frame
- **THEN** the still-running receive loop observes it and marks the channel read-only

### Requirement: Per-platform interact diagnostics subsystem
Interact-channel diagnostics in NexusShared SHALL be emitted under the running app's
bundle-derived log subsystem (with a fallback when no bundle identifier is available) rather than
a hardcoded macOS identifier, so each platform's device-log filters surface interact warnings.

#### Scenario: iOS interact warning visible under the iOS subsystem
- **WHEN** the interact channel logs a read-only or send-failure warning on iOS
- **THEN** the entry appears under the iOS app's own log subsystem in a device log stream
