# terminal-attach Specification Delta

## ADDED Requirements

### Requirement: PtyViewer forwards keystrokes to the agent's tmux pane

PtyViewer SHALL forward SwiftTerm keystroke events to the agent via
`POST /commands/send-text`. Read-only mode is replaced with
bidirectional input. The SwiftTerm `terminalDelegate.send()` callback
MUST invoke `NexusClient.sendText(sessionId:, text:)` instead of
discarding bytes.

#### Scenario: typing a character sends it to the tmux pane

- **GIVEN** PtyViewer is open with a managed session's stream loaded
- **WHEN** the user types `ls` followed by Enter
- **THEN** SwiftTerm captures each character event
- **AND** each event triggers an HTTP `POST /commands/send-text` with
  body `{sessionId, text}`
- **AND** the homelab tmux pane receives the keys via
  `tmux send-keys -t <target>`

#### Scenario: control characters forward correctly

- **GIVEN** PtyViewer is open
- **WHEN** the user types Ctrl-C
- **THEN** the byte `\x03` is forwarded
- **AND** the tmux pane processes the interrupt

#### Scenario: input forwarding only on managed sessions

- **WHEN** PtyViewer is opened for a session whose `sessionType` is
  not `"managed"`
- **THEN** input forwarding is disabled (SwiftTerm delegate is no-op)
- **AND** an os_log warn line documents the suppression

### Requirement: Send-text endpoint accepts session-scoped input

The agent's `POST /commands/send-text` endpoint SHALL accept
`{sessionId, text}` JSON bodies and forward via
`tmux send-keys -t <session.tmuxTarget>`.

#### Scenario: valid sessionId routes to tmux target

- **GIVEN** a managed session with `tmuxTarget="nexus:cc-1617726"`
- **WHEN** the client POSTs `{sessionId: "<id>", text: "ls\r"}`
- **THEN** the agent runs `tmux send-keys -t nexus:cc-1617726 'ls\r'`
- **AND** returns 200 with body `{ok: true}`

#### Scenario: unknown sessionId returns 404

- **WHEN** the client POSTs a sessionId that does not exist in the
  sessions table
- **THEN** the agent returns 404 with body `{error: "not found"}`
- **AND** does NOT invoke tmux
