## ADDED Requirements

### Requirement: Interactive PTY input MUST stream raw keystrokes over the interact WebSocket

The Swift client MUST send interactive PTY keystrokes as raw bytes over the agent's `WS /sessions/:id/interact` channel, WITHOUT appending Enter/newline. It MUST NOT route interactive typing through `POST /commands/send-text` (which is line-oriented and appends Enter). The interact channel reuses the `NWConnection` + `NWProtocolWebSocket` setup (http→ws scheme rewrite) used by the PTY stream, but is write-oriented.

#### Scenario: A single character does not submit a line

- **GIVEN** an attached managed PTY session with a TUI awaiting input
- **WHEN** the user types the character `y`
- **THEN** the byte `y` is written raw to the PTY over `/interact` and NO Enter is sent (the TUI receives `y` and does not advance/submit)

#### Scenario: Enter is only sent when the user presses Return

- **GIVEN** an attached managed PTY session
- **WHEN** the user types `run` then presses Return
- **THEN** the bytes `run` stream first, then a carriage return is sent only on the Return keypress — matching a direct tmux connection

#### Scenario: send-text is not used for interactive keystrokes

- **WHEN** a keystroke is forwarded from the SwiftTerm view
- **THEN** it is written over the `/interact` WebSocket, and `POST /commands/send-text` is NOT called for that keystroke

### Requirement: Interact channel is managed-gated with graceful single-writer fallback

The interact channel MUST only be opened for `sessionType == "managed"` sessions (non-managed input remains a no-op + one-shot warn, as today). If the agent denies the writer mutex (WS close code 4009 "interactive session already held by another client"), the client MUST degrade to read-only (the PTY stream continues) without crashing, and surface a non-fatal indicator.

#### Scenario: Non-managed session does not open interact

- **GIVEN** a non-managed (ad_hoc/raw) session
- **WHEN** the viewer attaches
- **THEN** no interact channel is opened and keystrokes are a logged no-op (unchanged from current behavior)

#### Scenario: Second writer is denied gracefully

- **GIVEN** another client already holds the interact writer mutex for the session
- **WHEN** this viewer opens its interact channel
- **THEN** the agent closes it with 4009, the client logs it, the read-only PTY stream keeps flowing, and the app does not crash

### Requirement: send-text remains the path for programmatic command-line injection

`POST /commands/send-text` (Enter-appending) MUST remain available and used for programmatic command-line injection — specifically the STT transcript routing from `airpods-stt-command`, which intends to submit a full command line. This change MUST NOT remove or alter that path.

#### Scenario: STT transcript still uses send-text

- **GIVEN** a finalized STT transcript "continue"
- **WHEN** it is routed to the target session
- **THEN** it is sent via `POST /commands/send-text` (which appends Enter to submit the command), NOT the raw interact channel
