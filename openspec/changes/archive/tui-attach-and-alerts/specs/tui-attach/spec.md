## ADDED Requirements

### Requirement: Stream Attach

The TUI SHALL provide a stream attach mode ('a' key) that subscribes to the gRPC `StreamEvents`
RPC filtered by the selected session's ID and renders incoming `SessionEvent` messages as a
scrollable log view. Stream attach SHALL work for both managed and ad-hoc sessions.

#### Scenario: Open stream attach from dashboard

- **WHEN** a session is selected on the dashboard and the user presses 'a'
- **THEN** the TUI transitions to a stream view for that session
- **AND** subscribes to `StreamEvents` with an `EventFilter` containing the session's ID
- **AND** incoming events are rendered as timestamped log lines in a scrollable list

#### Scenario: Stream assembler buffers events

- **WHEN** session events arrive faster than the render tick rate
- **THEN** events are buffered in a bounded channel (capacity 256)
- **AND** the render loop drains all pending events on each tick
- **AND** events beyond buffer capacity are dropped (backpressure)

#### Scenario: Auto-scroll with manual override

- **WHEN** new events arrive and the user has not scrolled up
- **THEN** the log view auto-scrolls to show the latest event
- **WHEN** the user scrolls up via Up/PageUp keys
- **THEN** auto-scroll is disabled until the user presses End

#### Scenario: Exit stream view

- **WHEN** the user presses 'q' in the stream view
- **THEN** the TUI returns to the previous screen (dashboard or detail)
- **AND** the gRPC stream subscription is dropped

### Requirement: Full Attach

The TUI SHALL provide a full attach mode ('A' key) that connects to a managed session's tmux
terminal via SSH. Full attach SHALL only be available for managed sessions (started via nexus).

#### Scenario: Full attach to managed session

- **WHEN** a managed session is selected and the user presses 'A'
- **THEN** the TUI disables crossterm raw mode and leaves the alternate screen
- **AND** spawns `ssh {user}@{host} -t 'tmux a -t {tmux_session}'` as a child process
- **AND** waits for the child process to exit (user detaches tmux with Ctrl-b d)
- **AND** re-enables raw mode, enters the alternate screen, and returns to the dashboard

#### Scenario: Full attach rejected for ad-hoc session

- **WHEN** an ad-hoc session is selected and the user presses 'A'
- **THEN** the TUI does NOT spawn SSH
- **AND** displays a status bar message: "ad-hoc session -- stream only (start via nexus for full attach)"

#### Scenario: SSH or tmux failure

- **WHEN** the SSH connection fails or the tmux session does not exist
- **THEN** the child process exits with a non-zero status
- **AND** the TUI re-enables raw mode, returns to the dashboard, and displays the error in the status bar

### Requirement: Alert Notifications

The TUI SHALL subscribe to `StreamEvents` (unfiltered) and display status bar notifications when
any session transitions to Stale or Errored status.

#### Scenario: Session transitions to errored

- **WHEN** a `StatusChanged` event is received with the new status Errored
- **THEN** a notification is shown in the status bar with the format "{project}#{short_id} errored"
- **AND** the notification text is colored red

#### Scenario: Session transitions to stale

- **WHEN** a `StatusChanged` event is received with the new status Stale
- **THEN** a notification is shown in the status bar with the format "{project}#{short_id} stale ({duration})"
- **AND** the notification text is colored yellow

#### Scenario: Notification auto-dismiss

- **WHEN** a notification has been displayed for 10 seconds
- **THEN** it is automatically removed from the status bar

#### Scenario: Notification dismiss on keypress

- **WHEN** any key is pressed while a notification is visible
- **THEN** all current notifications are dismissed
