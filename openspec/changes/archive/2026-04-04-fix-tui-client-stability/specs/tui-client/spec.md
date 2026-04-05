## MODIFIED Requirements

### Requirement: Panic-Safe HTTP Client Construction
The reqwest `Client` MUST be constructed once at startup and reused across the event loop. The
construction MUST NOT use `unwrap()`. Errors MUST be logged and cause the polling task to exit
gracefully without a panic.

#### Scenario: client build failure exits gracefully
- **WHEN** `reqwest::Client::builder().build()` returns `Err`
- **THEN** the error is logged with `tracing::error!` and the task returns without panicking

#### Scenario: client reused across loop iterations
- **WHEN** the polling loop iterates
- **THEN** the same `Client` instance is used for each request

### Requirement: Terminal Resize Handling
The main event loop MUST handle `crossterm::event::Event::Resize(cols, rows)` by updating the
layout dimensions and triggering a redraw.

#### Scenario: resize event updates layout
- **WHEN** the terminal is resized to 200×50
- **THEN** `Event::Resize(200, 50)` is handled and the layout recalculates

#### Scenario: resize does not crash TUI
- **WHEN** any resize event is received
- **THEN** no panic occurs and the TUI continues rendering

### Requirement: Stream Auto-Reconnect
On stream disconnect, the TUI MUST attempt reconnection with exponential backoff up to 5 attempts
before showing an error state.

#### Scenario: reconnect succeeds on second attempt
- **WHEN** a stream disconnects and reconnects successfully on retry
- **THEN** the stream resumes and no error is shown to the user

#### Scenario: error state after max retries
- **WHEN** all 5 reconnect attempts fail
- **THEN** an error message is shown in the stream pane with a manual retry prompt

### Requirement: Error States Surfaced in UI
RPC failures MUST display an error message in the relevant UI pane instead of showing empty data.

#### Scenario: project list RPC failure shown
- **WHEN** `list_projects()` fails
- **THEN** the project pane shows "Failed to load projects — retrying..." instead of empty list

### Requirement: Named Timing Constants
All tick-count magic numbers MUST be extracted to named `const` values with comments explaining
the base tick interval.

#### Scenario: constants defined for all timing values
- **WHEN** the codebase is searched for bare integer tick counts
- **THEN** no bare numbers exist; all reference named constants
