## ADDED Requirements

### Requirement: Message Visual Framing
The stream attach view SHALL visually distinguish user messages, assistant responses, and
system events using consistent framing patterns.

#### Scenario: User message framing
- **WHEN** a user prompt is displayed in the stream
- **THEN** it is preceded by a "── you ──" header in green
- **AND** each line has a green left-border accent character
- **AND** a blank separator follows the message block

#### Scenario: Assistant response framing
- **WHEN** an assistant response begins streaming
- **THEN** it is preceded by a "── assistant ──" header in turquoise (dim)
- **AND** a blank separator follows the response block (after the done summary)

### Requirement: Stream Verbosity Filtering
The stream attach view SHALL support three verbosity levels that control which event types
are displayed inline.

#### Scenario: Minimal verbosity
- **WHEN** verbosity is set to Minimal
- **THEN** only user prompts, assistant text, and done summaries are shown
- **AND** tool calls, system events, and status changes are hidden

#### Scenario: Normal verbosity (default)
- **WHEN** verbosity is set to Normal
- **THEN** user prompts, assistant text, tool calls, errors, and done summaries are shown
- **AND** system lifecycle events (status changes, heartbeats) are hidden

#### Scenario: Verbose verbosity
- **WHEN** verbosity is set to Verbose
- **THEN** all event types are shown including system events

#### Scenario: Toggle verbosity
- **WHEN** the user presses `v` in stream attach normal mode
- **THEN** verbosity cycles: Minimal → Normal → Verbose → Minimal
- **AND** the current mode is shown in the status bar
